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

function parseTimeOfDay(value, label) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  if (!m) {
    throw new Error(`Schedule: ${label} must look like "06:00", not ${JSON.stringify(value)}.`);
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

function parseZoneOffset(value, label) {
  const m = /^([+-])(\d{2}):([0-5]\d)$/.exec(String(value ?? ''));
  if (!m) {
    throw new Error(
      `Schedule: ${label} must be a fixed offset like "+05:45", not ${JSON.stringify(value)}.`,
    );
  }
  const seconds = Number(m[2]) * 3600 + Number(m[3]) * 60;
  if (seconds > 18 * 3600) throw new Error(`Schedule: ${label} is beyond ±18:00.`);
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

  const from = parseTimeOfDay(daily.from, 'daily.from');
  const to = parseTimeOfDay(daily.to, 'daily.to');
  const zone = parseZoneOffset(daily.zone, 'daily.zone');

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

/* ------------------------------------------------ the occasion window -- */

/* Days per month, with February capped at 28 deliberately — see parseMonthDay. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseMonthDay(value, label) {
  const m = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(String(value ?? ''));
  if (!m) {
    throw new Error(
      `Schedule: ${label}.on must look like "09-08", not ${JSON.stringify(value)}.`,
    );
  }

  const month = Number(m[1]);
  const day = Number(m[2]);

  // A date every year is guaranteed to have, which is what makes the fixed scan
  // in occasionWindowAt total. The alternative is worse than it sounds: an
  // impossible date does not throw anywhere in JavaScript, it rolls over
  // silently — 29 February becomes 1 March in three years out of four, and
  // 31 April becomes 1 May every year — so a birthday would quietly move.
  if (day > DAYS_IN_MONTH[month - 1]) {
    throw new Error(
      `Schedule: ${label}.on is ${JSON.stringify(value)}, which is not a day that ` +
        'every year has. Pick one that is; the calendar here stops at 28 February.',
    );
  }

  return { month, day };
}

/**
 * A dated exception, recurring every year: between an instant on one calendar
 * date and some number of minutes later, a playlist of its own takes over.
 *
 * This is the one part of the station that reads a calendar, and it has to.
 * The daily window can pretend the calendar does not exist because a day is
 * always 86400 seconds and the arithmetic closes (see makeDaily). A year is
 * not: 2027 to 2028 is 31,622,400 seconds against 31,536,000 everywhere else,
 * so an occasion pinned to a fixed epoch and a fixed period would slide a day
 * earlier every four years and within a lifetime would be in the wrong month.
 *
 * The zone is still a fixed offset for the same reason and with the same
 * limitation as the daily window: right for Nepal, wrong for anywhere that
 * observes daylight saving.
 *
 * `minutes` rather than a closing time of day, because an occasion is expected
 * to cross midnight — which is exactly the shape makeDaily refuses. Do not
 * "harmonise" the two blocks; they are different on purpose.
 *
 * `occasion` may be one window or an ordered list of them, and the list is a
 * priority order rather than a timetable: windows are allowed to overlap, and
 * where they do, the earliest one in the list that is open wins. That is what
 * lets a short window sit on top of a long one — half an hour of one song as
 * the party opens, laid over the birthday playlist that runs all day — without
 * either of them having to know about the other. The one underneath is
 * pre-empted, not restarted: its own loop goes on running against its own
 * opening instant, so when the short window closes the station rejoins it
 * where it would have been, the way a broadcast comes back from an interruption.
 *
 * Returns null when there is no occasion configured, so a playlist without one
 * behaves exactly as it always did.
 */
export function makeOccasions(data) {
  const raw = data?.occasion;
  if (raw === undefined || raw === null) return null;

  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return null;

  return Object.freeze(list.map((entry, i) => makeOccasion(entry, Array.isArray(raw) ? i : null)));
}

function makeOccasion(occasion, index) {
  // Named so a message about the second window in a list says which one it is,
  // and still reads as `occasion.on` when there is only the one.
  const at = index === null ? 'occasion' : `occasion[${index}]`;

  if (!occasion || typeof occasion !== 'object') {
    throw new Error(`Schedule: \`${at}\` must be an object.`);
  }

  const { month, day } = parseMonthDay(occasion.on, at);
  const from = parseTimeOfDay(occasion.from, `${at}.from`);
  const zone = parseZoneOffset(occasion.zone, `${at}.zone`);

  if (!Number.isInteger(occasion.minutes) || occasion.minutes <= 0) {
    throw new Error(
      `Schedule: ${at}.minutes must be a positive whole number of minutes, not ` +
        `${JSON.stringify(occasion.minutes)}.`,
    );
  }

  const tracks = occasion.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error(`Schedule: \`${at}.tracks\` must be a non-empty array.`);
  }
  for (const [i, track] of tracks.entries()) {
    if (!track || typeof track.id !== 'string' || track.id.length === 0) {
      throw new Error(`Schedule: ${at} track ${i} is missing a YouTube id.`);
    }
    if (!Number.isFinite(track.duration) || track.duration <= 0) {
      throw new Error(`Schedule: ${at} track ${i} (${track.id}) has a bad duration.`);
    }
  }

  return Object.freeze({
    theme: typeof occasion.theme === 'string' && occasion.theme ? occasion.theme : 'occasion',
    month,
    day,
    from,
    zone,
    length: occasion.minutes * 60,
    tracks,
  });
}

/** When does the occasion open in `year`, in Unix seconds? */
function occasionStart(occasion, year) {
  // Deliberately not Date.UTC, which maps years 0-99 onto 1900-1999: a listener
  // whose clock is set to the year 50 would be handed 1950 and land inside a
  // window that is nowhere near them. setUTCFullYear has no such rule.
  const at = new Date(0);
  at.setUTCFullYear(year, occasion.month - 1, occasion.day);
  at.setUTCHours(0, 0, 0, 0);
  return at.getTime() / 1000 + occasion.from - occasion.zone;
}

/**
 * One occasion's own answer: the opening instant of the run it is inside, or
 * null, and the next time it opens after `nowSeconds`.
 *
 * The four candidate years look like more than are needed and are not. Both
 * ends are load-bearing once the zone offset is taken into account: `year - 1`
 * carries a window that opened on 31 December and is still running on New
 * Year's Day, and `year + 2` is the guarantee that the search for the next
 * opening always finds one — an occasion at 00:00 on 1 January in a zone east
 * of UTC opens *before* New Year in UTC terms, so `year + 1` can already be
 * behind us on 31 December.
 */
function occasionRunAt(occasion, nowSeconds) {
  const year = new Date(nowSeconds * 1000).getUTCFullYear();
  let start = null;
  let next = Infinity;

  for (const y of [year - 1, year, year + 1, year + 2]) {
    const open = occasionStart(occasion, y);
    if (nowSeconds >= open && nowSeconds < open + occasion.length) start = open;
    else if (open > nowSeconds && open < next) next = open;
  }

  return { start, next };
}

/**
 * Is `nowSeconds` inside any occasion, which one, when did the run it belongs
 * to open, and how long until the next edge?
 *
 * Same shape as dailyWindowAt with two differences. `start` is null when we are
 * outside: a day always has a window slot to belong to, even a closed one; a
 * year does not, and inventing one would be a lie about a window that is eleven
 * months away. And `occasion` names the window that won, because with a list
 * the caller can no longer assume which playlist and which theme are in force.
 * main.js only reads `start` and `occasion` under `inside`.
 *
 * `until` counts to the close of the winning run *or* to the next opening of
 * any window in the list, whichever comes first — not just the winner's own
 * end. A window higher up the list opening midway through a longer one below it
 * changes what is playing and has to be woken for; the reverse does not, and
 * costs a wake-up that finds the schedule unchanged and returns. That asymmetry
 * is not worth the arithmetic to avoid.
 *
 * `until` is always greater than zero, so it can never arm a zero-length timer.
 * It can, however, be most of a year: callers arming a setTimeout on it must
 * clamp, because a delay past 2^31-1 ms fires immediately.
 */
export function occasionWindowAt(occasions, nowSeconds) {
  if (!occasions || occasions.length === 0) return null;

  let winner = null;
  let start = null;
  let end = Infinity;
  let next = Infinity;

  for (const occasion of occasions) {
    const run = occasionRunAt(occasion, nowSeconds);
    if (run.start !== null && winner === null) {
      winner = occasion;
      start = run.start;
      end = run.start + occasion.length;
    }
    if (run.next < next) next = run.next;
  }

  return {
    inside: winner !== null,
    occasion: winner,
    start,
    until: Math.min(end, next) - nowSeconds,
  };
}
