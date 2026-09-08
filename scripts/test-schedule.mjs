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
  makeOccasions,
  occasionWindowAt,
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

console.log('\noccasion window');

/* 23:59 at +05:45 is 18:14 UTC the same day. 1441 minutes carries it to
   midnight at the end of the following day: 86460 seconds. */
const PARTY_LEN = 86460;
const birthdayBlock = () => ({
  theme: 'birthday',
  on: '09-08',
  from: '23:59',
  minutes: 1441,
  zone: '+05:45',
  tracks: [
    { id: 'eeeeeeeeeee', title: 'E', artist: 'x', duration: 100 },
    { id: 'fffffffffff', title: 'F', artist: 'x', duration: 250 },
  ],
});
const partyOn = (y) => Date.UTC(y, 8, 8, 18, 14) / 1000;
const PARTY = partyOn(2026);
const PARTY_TRACKS = [
  { id: 'eeeeeeeeeee', title: 'E', artist: 'x', duration: 100 },
  { id: 'fffffffffff', title: 'F', artist: 'x', duration: 250 },
];
const occasion = makeOccasions({
  occasion: {
    theme: 'birthday',
    on: '09-08',
    from: '23:59',
    minutes: 1441,
    zone: '+05:45',
    tracks: PARTY_TRACKS,
  },
});
const [birthday] = occasion;

test('one occasion or a list of them, and a lone block is still a list of one', () => {
  assert.equal(occasion.length, 1);
  assert.equal(makeOccasions({ occasion: [] }), null);
  assert.equal(makeOccasions({ occasion: [birthdayBlock(), birthdayBlock()] }).length, 2);
});

test('23:59 Nepal on the 8th is 18:14 UTC, and the window runs to the end of the 9th', () => {
  assert.equal(birthday.month, 9);
  assert.equal(birthday.day, 8);
  assert.equal(birthday.length, PARTY_LEN);
  assert.equal(occasionWindowAt(occasion, PARTY).start, PARTY);
});

test('the occasion is half-open: it includes its start and excludes its end', () => {
  assert.equal(occasionWindowAt(occasion, PARTY - 1).inside, false);
  assert.equal(occasionWindowAt(occasion, PARTY).inside, true);
  assert.equal(occasionWindowAt(occasion, PARTY + PARTY_LEN - 1).inside, true);
  assert.equal(occasionWindowAt(occasion, PARTY + PARTY_LEN).inside, false);
});

test('outside the occasion there is no window to belong to, and it says so', () => {
  assert.equal(occasionWindowAt(occasion, PARTY - 1).start, null);
  assert.equal(occasionWindowAt(occasion, PARTY + PARTY_LEN).start, null);
});

test('the next occasion edge is always in the future, so no timer can spin', () => {
  for (let t = PARTY - 5; t < PARTY + PARTY_LEN + 5; t += 1) {
    assert.ok(occasionWindowAt(occasion, t).until > 0, `until was not positive at ${t}`);
  }
  assert.equal(occasionWindowAt(occasion, PARTY - 1).until, 1);
  assert.equal(occasionWindowAt(occasion, PARTY).until, PARTY_LEN);
  assert.equal(
    occasionWindowAt(occasion, PARTY + PARTY_LEN).until,
    partyOn(2027) - (PARTY + PARTY_LEN),
  );
});

test('the occasion lands on the date every year, leap years included', () => {
  // The whole reason this reads a calendar. A fixed period would be a day out
  // by 2028 and a month out within a lifetime: 2027 to 2028 is 31,622,400s
  // against 31,536,000s elsewhere.
  for (let y = 2020; y <= 2050; y++) {
    const open = partyOn(y);
    const w = occasionWindowAt(occasion, open);
    assert.equal(w.inside, true, `${y} was outside its own window`);
    assert.equal(w.start, open, `${y} drifted`);
    const party = makeSchedule({ epoch: w.start, tracks: birthday.tracks });
    assert.equal(positionAt(party, open).offset, 0, `${y} did not start at the top`);
  }
  assert.equal(partyOn(2028) - partyOn(2027), 366 * 86400);
});

test('an occasion that crosses new year is still found on the far side of it', () => {
  // This is the only thing the year-before candidate exists for. Delete it and
  // the party stops at midnight on the 31st.
  const newYear = makeOccasions({
    occasion: {
      on: '12-31',
      from: '23:00',
      minutes: 120,
      zone: '+05:45',
      tracks: [PARTY_TRACKS[0]],
    },
  });
  const open = Date.UTC(2026, 11, 31, 17, 15) / 1000; // 23:00 +05:45
  const w = occasionWindowAt(newYear, open + 5400); // half past midnight, Nepal
  assert.equal(w.inside, true);
  assert.equal(w.start, open);
  assert.ok(new Date((open + 5400) * 1000).getUTCFullYear() === 2026);
});

test('a clock set before the epoch does not throw or stall the occasion', () => {
  for (const t of [-1, -86399, -1767225600]) {
    const w = occasionWindowAt(occasion, t);
    assert.ok(w.until > 0, `until was not positive at ${t}`);
    assert.equal(typeof w.inside, 'boolean');
  }
});

test('a playlist with no occasion behaves exactly as it always did', () => {
  assert.equal(makeOccasions({ epoch: EPOCH, tracks: [] }), null);
  assert.equal(makeOccasions({ occasion: null }), null);
  assert.equal(occasionWindowAt(null, PARTY), null);
  assert.equal(occasionWindowAt([], PARTY), null);
});

test('a bad occasion throws rather than turning up on the wrong day', () => {
  const bad = (over) => () => makeOccasions({ occasion: { ...birthdayBlock(), ...over } });
  assert.throws(bad({ on: '9-8' }), /occasion\.on/);
  assert.throws(bad({ on: '13-01' }), /occasion\.on/);
  // Date.UTC rolls these into the next month without a word, which would move
  // the occasion rather than fail.
  assert.throws(bad({ on: '02-29' }), /every year has/);
  assert.throws(bad({ on: '02-30' }), /every year has/);
  assert.throws(bad({ on: '04-31' }), /every year has/);
  assert.throws(bad({ from: '23:6' }), /occasion\.from/);
  assert.throws(bad({ zone: 'Asia/Kathmandu' }), /fixed offset/);
  assert.throws(bad({ minutes: 0 }), /occasion\.minutes/);
  assert.throws(bad({ minutes: 10.5 }), /occasion\.minutes/);
  assert.throws(bad({ tracks: [] }), /non-empty array/);
  assert.throws(bad({ tracks: [{ id: 'x', duration: 0 }] }), /bad duration/);
  assert.throws(bad({ tracks: [{ duration: 100 }] }), /missing a YouTube id/);
});

test('a bad window in a list says which one it was', () => {
  assert.throws(
    () => makeOccasions({ occasion: [birthdayBlock(), { ...birthdayBlock(), on: '02-30' }] }),
    /occasion\[1\]\.on/,
  );
  assert.throws(() => makeOccasions({ occasion: [null] }), /`occasion\[0\]` must be an object/);
});

/* The shape actually shipped: half an hour of one song laid over the playlist
   that runs all day, both opening at 23:59. */
const OPENER_LEN = 31 * 60;
const layered = makeOccasions({
  occasion: [
    { ...birthdayBlock(), minutes: 31, tracks: [{ id: 'ggggggggggg', duration: 248 }] },
    birthdayBlock(),
  ],
});

test('where two windows overlap the earlier one in the list wins', () => {
  const opener = occasionWindowAt(layered, PARTY);
  assert.equal(opener.inside, true);
  assert.equal(opener.occasion, layered[0]);
  assert.equal(opener.start, PARTY);

  const after = occasionWindowAt(layered, PARTY + OPENER_LEN);
  assert.equal(after.inside, true);
  assert.equal(after.occasion, layered[1]);
});

test('the window underneath is pre-empted, not restarted', () => {
  // Its own loop has been running against its own opening instant the whole
  // time, so the station rejoins it where it would have been — the half hour
  // is an interruption to a broadcast, not a delay to its start.
  const after = occasionWindowAt(layered, PARTY + OPENER_LEN);
  assert.equal(after.start, PARTY);
  const party = makeSchedule({ epoch: after.start, tracks: PARTY_TRACKS });
  assert.equal(loopOffsetAt(party, PARTY + OPENER_LEN), OPENER_LEN % party.total);
  assert.equal(positionAt(party, PARTY + OPENER_LEN).index, 1);
});

test('the close of a window on top is an edge the caller is woken for', () => {
  // Without it the boundary timer would sleep through the handover and the
  // opener would run past its own end.
  assert.equal(occasionWindowAt(layered, PARTY).until, OPENER_LEN);
  assert.equal(occasionWindowAt(layered, PARTY + OPENER_LEN).until, PARTY_LEN - OPENER_LEN);
  for (let t = PARTY - 5; t < PARTY + PARTY_LEN + 5; t += 1) {
    assert.ok(occasionWindowAt(layered, t).until > 0, `until was not positive at ${t}`);
  }
});

test('a window that opens midway through another is not slept through', () => {
  // The opener moved an hour later: at 23:59 only the long window is on, and
  // the next edge is the moment the short one takes over, not the long one's
  // own end eleven hours away.
  const later = makeOccasions({
    occasion: [
      {
        ...birthdayBlock(),
        on: '09-09',
        from: '00:59',
        minutes: 31,
        tracks: [{ id: 'ggggggggggg', duration: 248 }],
      },
      birthdayBlock(),
    ],
  });
  const w = occasionWindowAt(later, PARTY);
  assert.equal(w.occasion, later[1]);
  assert.equal(w.until, 3600);
  assert.equal(occasionWindowAt(later, PARTY + 3600).occasion, later[0]);
});

test('the occasion swallows the morning window whole, so precedence matters', () => {
  // 06:00 Nepal on the 9th is inside both. Which one wins is main.js's
  // business, but the overlap itself is pinned here so nobody "fixes" it.
  const morningOn9th = Date.UTC(2026, 8, 9, 0, 15) / 1000;
  assert.equal(dailyWindowAt(daily, morningOn9th).inside, true);
  assert.equal(occasionWindowAt(occasion, morningOn9th).inside, true);
  const closeOfChant = Date.UTC(2026, 8, 9, 3, 15) / 1000; // 09:00 Nepal
  assert.equal(occasionWindowAt(occasion, closeOfChant).inside, true);
});

console.log('\nreal playlist');

const rawReal = JSON.parse(await readFile(new URL('../data/tracks.json', import.meta.url), 'utf8'));
const real = makeSchedule(rawReal);
const realDaily = makeDaily(rawReal);
const realOccasions = makeOccasions(rawReal);
const rawOccasions = rawReal.occasion === undefined || rawReal.occasion === null
  ? []
  : Array.isArray(rawReal.occasion)
    ? rawReal.occasion
    : [rawReal.occasion];

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

test("data/tracks.json's occasions are valid", () => {
  if (!realOccasions) return void console.log('       no occasion configured');
  realOccasions.forEach((occasion, i) => {
    let total = 0;
    for (const t of occasion.tracks) {
      assert.match(t.id, /^[\w-]{11}$/, `${t.id} is not an 11-character id`);
      assert.ok(t.title && t.artist, `${t.id} is missing title or artist`);
      assert.ok(Number.isInteger(t.duration) && t.duration > 0, `${t.id} has a bad duration`);
      total += t.duration;
    }
    const ids = occasion.tracks.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'an occasion repeats a track');
    const raw = rawOccasions[i];
    console.log(
      `       ${occasion.theme}, ${raw.on} from ${raw.from} ${raw.zone} for ` +
        `${raw.minutes}m, ${ids.length} tracks, loop is ${formatClock(total)}, ` +
        `${Math.floor(occasion.length / total)} full times round then cut after ` +
        `${formatClock(occasion.length % total)}`,
    );
  });
});

test('the occasion tracks never play on any other day', () => {
  if (!realOccasions) return;
  for (const t of realOccasions.flatMap((o) => o.tracks)) {
    assert.ok(
      !real.tracks.some((loop) => loop.id === t.id),
      `${t.id} is in the ordinary loop as well as the occasion`,
    );
    assert.notEqual(t.id, realDaily?.track.id, `${t.id} is the daily track as well`);
  }
});

test('every minute of the occasion has exactly one window claiming it', () => {
  // A gap would drop the listener back to the loop mid-party without anyone
  // meaning to. Walked a minute at a time from the first opening to the last
  // close: cheap, and it checks the real file rather than a fixture.
  if (!realOccasions) return;
  const opens = realOccasions.map((o) => {
    const at = new Date(0);
    at.setUTCFullYear(2026, o.month - 1, o.day);
    at.setUTCHours(0, 0, 0, 0);
    return at.getTime() / 1000 + o.from - o.zone;
  });
  const first = Math.min(...opens);
  const last = Math.max(...opens.map((open, i) => open + realOccasions[i].length));
  for (let t = first; t < last; t += 60) {
    assert.equal(occasionWindowAt(realOccasions, t).inside, true, `nothing was on air at ${t}`);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures above' : ''}`);
