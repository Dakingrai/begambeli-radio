/**
 * Local sanity checks for the scheduling maths. Not shipped.
 *
 *   node scripts/test-schedule.mjs
 *
 * The sync logic is the one place a bug hides until someone in another timezone
 * reports it, so it is worth being able to check it in a second.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  makeSchedule,
  makeDaily,
  dailyWindowAt,
  positionAt,
  loopOffsetAt,
  nextPlayable,
  formatClock,
} from '../assets/js/schedule.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

const EPOCH = 1767225600;
const fixture = makeSchedule({
  epoch: EPOCH,
  tracks: [
    { id: 'aaaaaaaaaaa', title: 'A', artist: 'x', duration: 100 },
    { id: 'bbbbbbbbbbb', title: 'B', artist: 'x', duration: 200 },
    { id: 'ccccccccccc', title: 'C', artist: 'x', duration: 300 },
  ],
});

console.log('schedule');

test('total is the sum of durations', () => {
  assert.equal(fixture.total, 600);
  assert.deepEqual(fixture.starts, [0, 100, 300]);
});

test('at the epoch we are at the top of track 0', () => {
  const p = positionAt(fixture, EPOCH);
  assert.equal(p.index, 0);
  assert.equal(p.offset, 0);
  assert.equal(p.remaining, 100);
});

test('boundaries belong to the track that is starting', () => {
  assert.equal(positionAt(fixture, EPOCH + 99.999).index, 0);
  assert.equal(positionAt(fixture, EPOCH + 100).index, 1);
  assert.equal(positionAt(fixture, EPOCH + 100).offset, 0);
  assert.equal(positionAt(fixture, EPOCH + 299).index, 1);
  assert.equal(positionAt(fixture, EPOCH + 300).index, 2);
});

test('the loop wraps cleanly', () => {
  const p = positionAt(fixture, EPOCH + 600);
  assert.equal(p.index, 0);
  assert.equal(p.offset, 0);
  assert.deepEqual(
    positionAt(fixture, EPOCH + 650).index,
    positionAt(fixture, EPOCH + 50).index,
  );
});

test('a clock set before the epoch does not go negative', () => {
  // This is the double-modulo guard. A single % would return a negative
  // elapsed here and the for-loop would fall straight through.
  for (const t of [EPOCH - 1, EPOCH - 250, EPOCH - 600, EPOCH - 6001]) {
    const p = positionAt(fixture, t);
    assert.ok(p.index >= 0 && p.index < 3, `index out of range at ${t}`);
    assert.ok(p.offset >= 0, `negative offset at ${t}`);
    assert.ok(p.offset < p.track.duration, `offset past the end at ${t}`);
  }
  assert.equal(positionAt(fixture, EPOCH - 600).index, 0);
  assert.equal(positionAt(fixture, EPOCH - 1).index, 2);
  assert.equal(positionAt(fixture, EPOCH - 1).offset, 299);
});

test('offset and remaining always sum to the track duration', () => {
  for (let t = -1000; t < 2000; t += 7.3) {
    const p = positionAt(fixture, EPOCH + t);
    assert.ok(Math.abs(p.offset + p.remaining - p.track.duration) < 1e-9);
  }
});

test('walking the loop second by second never skips or repeats a track', () => {
  const seen = [];
  let last = -1;
  for (let t = 0; t < 600; t++) {
    const p = positionAt(fixture, EPOCH + t);
    if (p.index !== last) {
      seen.push(p.index);
      last = p.index;
    }
  }
  assert.deepEqual(seen, [0, 1, 2]);
});

test('loopOffsetAt agrees with start + offset', () => {
  for (let t = 0; t < 600; t += 11) {
    const p = positionAt(fixture, EPOCH + t);
    assert.ok(
      Math.abs(loopOffsetAt(fixture, EPOCH + t) - (fixture.starts[p.index] + p.offset)) < 1e-9,
    );
  }
});

test('fractional seconds are carried through', () => {
  const p = positionAt(fixture, EPOCH + 10.25);
  assert.equal(p.index, 0);
  assert.ok(Math.abs(p.offset - 10.25) < 1e-9);
});

test('two clients a minute apart agree on absolute position', () => {
  // The actual claim the station makes.
  const a = positionAt(fixture, EPOCH + 1234.5);
  const b = positionAt(fixture, EPOCH + 1234.5);
  assert.deepEqual({ i: a.index, o: a.offset }, { i: b.index, o: b.offset });
});

test('nextPlayable skips unavailable tracks and reports exhaustion', () => {
  assert.equal(nextPlayable(fixture, 0), 1);
  assert.equal(nextPlayable(fixture, 2), 0);
  assert.equal(nextPlayable(fixture, 0, new Set(['bbbbbbbbbbb'])), 2);
  assert.equal(
    nextPlayable(fixture, 0, new Set(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])),
    -1,
  );
});

test('a one-track playlist is a valid, if dull, station', () => {
  const single = makeSchedule({ epoch: EPOCH, tracks: [{ id: 'z'.repeat(11), duration: 60 }] });
  assert.equal(positionAt(single, EPOCH + 61).index, 0);
  assert.equal(positionAt(single, EPOCH + 61).offset, 1);
});

test('bad playlists throw rather than drift', () => {
  assert.throws(() => makeSchedule({ epoch: EPOCH, tracks: [] }), /non-empty/);
  assert.throws(() => makeSchedule({ epoch: 'soon', tracks: [] }), /epoch/);
  assert.throws(
    () => makeSchedule({ epoch: EPOCH, tracks: [{ id: 'a', duration: 0 }] }),
    /duration/,
  );
  assert.throws(
    () => makeSchedule({ epoch: EPOCH, tracks: [{ duration: 10 }] }),
    /youtube id/i,
  );
});

test('formatClock', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(9), '0:09');
  assert.equal(formatClock(69), '1:09');
  assert.equal(formatClock(3600), '1:00:00');
  assert.equal(formatClock(3661), '1:01:01');
  assert.equal(formatClock(-5), '0:00');
});

console.log('\ndaily window');

/* EPOCH is exactly a UTC midnight (1767225600 / 86400 is a whole number), which
   makes the absolute times below readable: the window opens 900s into the day,
   because 06:00 at +05:45 is 00:15 UTC. D is deliberately not a factor of a day. */
const D = 1000;
const OPEN = EPOCH + 900;
const daily = makeDaily({
  daily: {
    from: '06:00',
    to: '09:00',
    zone: '+05:45',
    track: { id: 'ddddddddddd', title: 'D', artist: 'x', duration: D },
  },
});

/** The one-track schedule main.js builds for whichever window `t` falls in. */
const morningAt = (t) =>
  makeSchedule({ epoch: dailyWindowAt(daily, t).start, tracks: [daily.track] });

test('06:00 Nepal is 00:15 UTC', () => {
  assert.equal(daily.startOfDay, 900);
  assert.equal(daily.length, 10800);
});

test('the window is half-open: it includes its start and excludes its end', () => {
  assert.equal(dailyWindowAt(daily, OPEN - 1).inside, false);
  assert.equal(dailyWindowAt(daily, OPEN).inside, true);
  assert.equal(dailyWindowAt(daily, OPEN + 10799).inside, true);
  assert.equal(dailyWindowAt(daily, OPEN + 10800).inside, false);
});

test('the song restarts from the top at every repeat inside the window', () => {
  const offsetAt = (t) => positionAt(morningAt(t), t).offset;
  assert.equal(offsetAt(OPEN), 0);
  assert.equal(offsetAt(OPEN + D - 1), D - 1);
  assert.equal(offsetAt(OPEN + D), 0); // second play
  assert.equal(offsetAt(OPEN + 10799), 10799 % D);
});

test('the window is cut at its end, not run to the end of the song', () => {
  // The last play starts before the close and would finish after it.
  const last = OPEN + Math.floor(10800 / D) * D;
  assert.ok(last + D > OPEN + 10800, 'fixture no longer straddles the close');
  assert.equal(dailyWindowAt(daily, last).inside, true);
  assert.equal(dailyWindowAt(daily, OPEN + 10800).inside, false);
});

test('the next edge is always in the future, so no timer can spin', () => {
  for (let t = OPEN - 5; t < OPEN + 10805; t += 1) {
    assert.ok(dailyWindowAt(daily, t).until > 0, `until was not positive at ${t}`);
  }
  assert.equal(dailyWindowAt(daily, OPEN).until, 10800); // to the close
  assert.equal(dailyWindowAt(daily, OPEN + 10799).until, 1);
  assert.equal(dailyWindowAt(daily, OPEN + 10800).until, 86400 - 10800); // to the next open
});

test('the window does not drift against the clock, day after day', () => {
  // A day is not a whole number of plays (86400 % 1000 = 400), so a schedule
  // pinned to one fixed epoch would start the song 400s further into itself
  // every day. Deriving the epoch per window is what stops that.
  for (let day = 0; day < 400; day++) {
    const t = OPEN + day * 86400;
    const w = dailyWindowAt(daily, t);
    assert.equal(w.inside, true, `day ${day} was outside its own window`);
    assert.equal(w.start, t, `day ${day} start drifted`);
    assert.equal(positionAt(morningAt(t), t).offset, 0, `day ${day} did not start at 0:00`);
  }
});

test('a clock set before the epoch still lands in a sane window', () => {
  for (const t of [-1, -86399, -86400, -1767225600]) {
    const w = dailyWindowAt(daily, t);
    assert.ok(w.until > 0);
    assert.ok(t - w.start >= 0 && t - w.start < 86400);
    if (w.inside) assert.ok(positionAt(morningAt(t), t).offset >= 0);
  }
});

test('a playlist with no window behaves exactly as it always did', () => {
  assert.equal(makeDaily({ epoch: EPOCH, tracks: [] }), null);
  assert.equal(makeDaily({ daily: null }), null);
  assert.equal(dailyWindowAt(null, OPEN), null);
});

test('a bad window throws rather than misfiring at 6am', () => {
  const ok = { from: '06:00', to: '09:00', zone: '+05:45', track: daily.track };
  const bad = (over) => () => makeDaily({ daily: { ...ok, ...over } });
  assert.throws(bad({ from: '22:00', to: '02:00' }), /crosses midnight/);
  assert.throws(bad({ from: '09:00', to: '09:00' }), /crosses midnight/);
  assert.throws(bad({ from: '6:00' }), /daily\.from/);
  assert.throws(bad({ to: '24:00' }), /daily\.to/);
  assert.throws(bad({ zone: 'Asia/Kathmandu' }), /fixed offset/);
  assert.throws(bad({ track: { id: 'x', duration: 0 } }), /bad duration/);
  assert.throws(bad({ track: { duration: 100 } }), /missing a YouTube id/);
});

console.log('\nreal playlist');

const rawReal = JSON.parse(await readFile(new URL('../data/tracks.json', import.meta.url), 'utf8'));
const real = makeSchedule(rawReal);
const realDaily = makeDaily(rawReal);

test('data/tracks.json is a valid schedule', () => {
  assert.ok(real.total > 0);
  console.log(
    `       ${real.tracks.length} tracks, loop is ${formatClock(real.total)}`,
  );
});

test('every id looks like a YouTube id', () => {
  for (const t of real.tracks) {
    assert.match(t.id, /^[\w-]{11}$/, `${t.id} is not an 11-character id`);
    assert.ok(t.title && t.artist, `${t.id} is missing title or artist`);
    assert.ok(Number.isInteger(t.duration), `${t.id} duration is not an integer`);
  }
});

test('no duplicate ids', () => {
  const ids = real.tracks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("data/tracks.json's daily window is valid", () => {
  if (!realDaily) return void console.log('       no daily window configured');
  const { id, title, artist, duration } = realDaily.track;
  assert.match(id, /^[\w-]{11}$/, `${id} is not an 11-character id`);
  assert.ok(title && artist, `${id} is missing title or artist`);
  assert.ok(Number.isInteger(duration) && duration > 0);
  console.log(
    `       ${rawReal.daily.from}-${rawReal.daily.to} ${rawReal.daily.zone}, ` +
      `${formatClock(duration)} on repeat, ${Math.floor(realDaily.length / duration)} full ` +
      `plays then cut after ${formatClock(realDaily.length % duration)}`,
  );
});

test('the daily track never plays at any other hour', () => {
  if (!realDaily) return;
  assert.ok(
    !real.tracks.some((t) => t.id === realDaily.track.id),
    `${realDaily.track.id} is in the ordinary loop as well as the window`,
  );
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures above' : ''}`);
