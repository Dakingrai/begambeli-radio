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

/* --------------------------------------------------- the daily window -- */

const DAY = 86400;

/** The same double-fold as positionAt, for the same reason: `%` keeps the sign. */
function mod(value, size) {
  return ((value % size) + size) % size;
}

function parseTimeOfDay(value, field) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  if (!m) {
    throw new Error(`Schedule: daily.${field} must look like "06:00", not ${JSON.stringify(value)}.`);
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

function parseZoneOffset(value) {
  const m = /^([+-])(\d{2}):([0-5]\d)$/.exec(String(value ?? ''));
  if (!m) {
    throw new Error(
      `Schedule: daily.zone must be a fixed offset like "+05:45", not ${JSON.stringify(value)}.`,
    );
  }
  const seconds = Number(m[2]) * 3600 + Number(m[3]) * 60;
  if (seconds > 18 * 3600) throw new Error('Schedule: daily.zone is beyond ±18:00.');
  return m[1] === '-' ? -seconds : seconds;
}

/**
 * A standing daily exception: between two times of day, one song plays on
 * repeat and the ordinary loop is set aside.
 *
 * It reduces to the arithmetic already above, because a daily window is just a
 * fixed slot in absolute time. 06:00 in Kathmandu is always 00:15 UTC — Nepal
 * has used +05:45 without interruption since 1986 and has never observed
 * daylight saving — so the window opens the same number of seconds into every
 * UTC day and runs for the same length. No timezone database, no DST table, no
 * reading of the calendar.
 *
 * That is why `zone` is a fixed offset and not an IANA name, and it is a real
 * limitation rather than a shortcut: a window written in a zone that does
 * observe daylight saving would shift by an hour twice a year and nothing here
 * would notice. Nepal is the easy case.
 *
 * Returns null when there is no window configured, so a playlist without one
 * behaves exactly as it always did.
 */
export function makeDaily(data) {
  const daily = data?.daily;
  if (daily === undefined || daily === null) return null;
  if (typeof daily !== 'object') throw new Error('Schedule: `daily` must be an object.');

  const from = parseTimeOfDay(daily.from, 'from');
  const to = parseTimeOfDay(daily.to, 'to');
  const zone = parseZoneOffset(daily.zone);

  if (from >= to) {
    throw new Error(
      `Schedule: daily.from (${daily.from}) must be earlier in the day than daily.to (${daily.to}). ` +
        'A window that crosses midnight is not supported.',
    );
  }

  const track = daily.track;
  if (!track || typeof track.id !== 'string' || track.id.length === 0) {
    throw new Error('Schedule: daily.track is missing a YouTube id.');
  }
  if (!Number.isFinite(track.duration) || track.duration <= 0) {
    throw new Error(`Schedule: daily.track (${track.id}) has a bad duration.`);
  }

  return Object.freeze({
    track,
    length: to - from,
    startOfDay: mod(from - zone, DAY), // where the window opens, into the UTC day
  });
}

/**
 * Is `nowSeconds` inside the daily window, when does the window it belongs to
 * start, and how long until the next edge?
 *
 * `start` is derived from `nowSeconds` on every call rather than stored once,
 * and that is what makes the window incapable of drifting against the clock. A
 * day is not a whole number of plays — 86400 % 1438 leaves 120 — so a schedule
 * pinned to a fixed epoch would begin the song two minutes further into itself
 * every day, and inside a month the 06:00 start would land deep in the middle
 * of it.
 *
 * `until` is always greater than zero, so it can never arm a zero-length timer.
 */
export function dailyWindowAt(daily, nowSeconds) {
  if (!daily) return null;

  const since = mod(nowSeconds - daily.startOfDay, DAY);
  const inside = since < daily.length;

  return {
    inside,
    start: nowSeconds - since,
    until: inside ? daily.length - since : DAY - since,
  };
}
