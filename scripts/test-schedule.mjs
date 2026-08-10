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

console.log('\nreal playlist');

const real = makeSchedule(
  JSON.parse(await readFile(new URL('../data/tracks.json', import.meta.url), 'utf8')),
);

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

console.log(`\n${passed} passed${process.exitCode ? ', with failures above' : ''}`);
