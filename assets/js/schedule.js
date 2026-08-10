/**
 * The broadcast schedule.
 *
 * Pure functions only — no DOM, no YouTube, no reading of the clock. Time is
 * always an argument. That is deliberate: this is the one part of the station
 * where a bug is invisible on your own machine and only surfaces as somebody in
 * another country telling you they are hearing a different song.
 *
 * The whole idea: the playlist is a fixed, ordered loop of known durations, so
 * the position in it is a function of wall-clock time alone. No server, no
 * coordination, no state. Everyone computes the same answer.
 */

/**
 * Validate the raw tracks.json payload and precompute what the UI needs.
 * Throws with a legible message rather than returning something half-formed —
 * a malformed playlist should fail loudly at startup, not drift silently.
 */
export function makeSchedule(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Schedule: expected an object with `epoch` and `tracks`.');
  }

  const { epoch, tracks } = data;

  if (!Number.isFinite(epoch)) {
    throw new Error('Schedule: `epoch` must be a Unix timestamp in seconds.');
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('Schedule: `tracks` must be a non-empty array.');
  }

  const starts = [];
  let total = 0;

  for (const [i, track] of tracks.entries()) {
    if (!track || typeof track.id !== 'string' || track.id.length === 0) {
      throw new Error(`Schedule: track ${i} is missing a YouTube id.`);
    }
    if (!Number.isFinite(track.duration) || track.duration <= 0) {
      throw new Error(`Schedule: track ${i} (${track.id}) has a bad duration.`);
    }
    starts.push(total);
    total += track.duration;
  }

  return Object.freeze({ epoch, tracks, starts, total });
}

/**
 * Where is the station at `nowSeconds`?
 *
 * Returns the track index, how far into it we are, and how long is left.
 */
export function positionAt(schedule, nowSeconds) {
  const { epoch, tracks, total } = schedule;

  // JavaScript's % keeps the sign of the dividend: (-30 % 100) is -30, not 70.
  // A listener whose clock is set before the epoch would otherwise land on a
  // negative index. Adding `total` and folding again pins the result into
  // [0, total) for any input, past or future.
  let elapsed = (((nowSeconds - epoch) % total) + total) % total;

  for (let i = 0; i < tracks.length; i++) {
    const duration = tracks[i].duration;
    if (elapsed < duration) {
      return {
        index: i,
        offset: elapsed,
        remaining: duration - elapsed,
        track: tracks[i],
      };
    }
    elapsed -= duration;
  }

  // Not reachable for finite inputs — the modulo above guarantees the loop
  // finds a home. Kept so that a float edge case degrades to the last track
  // instead of returning undefined and taking the player down with it.
  const last = tracks.length - 1;
  return {
    index: last,
    offset: 0,
    remaining: tracks[last].duration,
    track: tracks[last],
  };
}

/**
 * How far into the loop, in seconds, does a given track begin?
 * Used to lay out the loop rail.
 */
export function startOfTrack(schedule, index) {
  return schedule.starts[index];
}

/**
 * Seconds into the loop at `nowSeconds`, i.e. the position of the rail marker.
 */
export function loopOffsetAt(schedule, nowSeconds) {
  const { epoch, total } = schedule;
  return (((nowSeconds - epoch) % total) + total) % total;
}

/**
 * The next playable index after `index`, skipping anything in `unavailable`.
 * Returns -1 when every track has been ruled out, so the caller can stop
 * rather than spin.
 */
export function nextPlayable(schedule, index, unavailable = new Set()) {
  const n = schedule.tracks.length;
  for (let step = 1; step <= n; step++) {
    const candidate = (index + step) % n;
    if (!unavailable.has(schedule.tracks[candidate].id)) return candidate;
  }
  return -1;
}

/**
 * Seconds as m:ss, or h:mm:ss once it runs past an hour.
 */
export function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
