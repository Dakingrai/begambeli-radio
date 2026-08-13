/**
 * Begambeli Radio — entry point.
 *
 * Reads the playlist, works out what the station is playing right now, and
 * keeps a YouTube player pointed at it. All the scheduling maths lives in
 * schedule.js; all the YouTube plumbing lives in player.js. This file is the
 * part that touches the page.
 */

import {
  makeSchedule,
  positionAt,
  loopOffsetAt,
  nextPlayable,
  formatClock,
} from './schedule.js';
import { createPlayer, STATE, ERROR_REASON } from './player.js';

/**
 * The line under the station's name. Edit freely — order does not matter and
 * the list can be any length.
 *
 * Chosen from the clock rather than at random, on the same corrected time the
 * schedule uses, so everyone reading the page sees the same words at the same
 * moment. That is the whole conceit of the station, applied to its copy.
 */
const QUOTE_SECONDS = 12;
const QUOTES = [
  'Clearly misunderstood.',
  'Simplicity is difficult.',
  'Deafening silence.',
  'Alone, together.',
  'Organised chaos.',
  'Awfully good.',
  'An original copy.',
  'Found missing.',
  'A familiar surprise.',
  'Repetition never repeats.',
  'Now is already gone.',
  'Seriously funny.',
  'An open secret.',
  'Definitely maybe.',
  'Act naturally.',
  'Old news.',
  'Sweet sorrow.',
  'Same difference.',
];

const DRIFT_INTERVAL_MS = 30_000; // how often to check we are still in step
const DRIFT_TOLERANCE = 2; // seconds of slip we will live with
const SETTLE_TOLERANCE = 1; // tighter, once, to absorb buffering on load
const BOUNDARY_LEAD_MS = 350; // land just past a track change, not just before
const TICK_MS = 1000;

/* Built once. Constructing an Intl formatter is expensive and paint() runs
   every second. An empty locale list means "whatever the browser is set to",
   which is what decides 11:07 PM against 23:07. */
const TIME_FORMAT = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const VOLUME_KEY = 'begambeli:volume';
const DEFAULT_VOLUME = 70;

const el = {};
const state = {
  schedule: null,
  skewMs: 0,
  player: null,
  loadedIndex: -1, // what is actually in the player
  substitute: false, // are we off-schedule because a track would not play
  unavailable: new Set(),
  live: false, // is the listener tuned in (not paused)
  userPaused: false, // they chose silence, as opposed to the browser imposing it
  starting: false, // a player is being created right now
  loading: false, // a load is in flight; pause events from it are not the user
  settled: false, // has this load been drift-corrected once
  volume: DEFAULT_VOLUME,
};

let boundaryTimer = null;
let driftTimer = null;
let tickTimer = null;

/* ---------------------------------------------------------------- clock -- */

/**
 * Station time in seconds. Browser clocks are routinely minutes out, so
 * everything is derived from the server's clock rather than the listener's.
 */
function now() {
  return (Date.now() + state.skewMs) / 1000;
}

/**
 * Ask the server what time it is via the Date response header. One-second
 * resolution, which is plenty. The round trip is halved and subtracted so a
 * slow connection does not read as a slow clock.
 *
 * Any failure leaves the skew where it was: one desynced listener is a much
 * better outcome than a blank page.
 */
async function measureSkew() {
  try {
    const sent = Date.now();
    const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
    const received = Date.now();
    const header = res.headers.get('Date');
    if (!header) return;
    const server = new Date(header).getTime();
    if (!Number.isFinite(server)) return;
    state.skewMs = server - (sent + received) / 2;
  } catch {
    /* carry on with whatever we had */
  }
}

/* ------------------------------------------------------------- playback -- */

/** Point the player at whatever the station is playing this second. */
function tuneToLive() {
  const pos = positionAt(state.schedule, now());
  let index = pos.index;
  let offset = pos.offset;

  if (state.unavailable.has(pos.track.id)) {
    // This listener cannot play the scheduled track. Put on the next one that
    // works, from its start, and let the boundary below pull us back in line.
    const alt = nextPlayable(state.schedule, index, state.unavailable);
    if (alt === -1) {
      goDark('Nothing in the playlist will play in this browser.');
      return;
    }
    index = alt;
    offset = 0;
    state.substitute = true;
  } else {
    state.substitute = false;
    // Back on schedule, so whatever went wrong is no longer the current story.
    // Clearing here rather than on every load is deliberate: an error notice
    // has to outlive the substitution it triggered.
    clearNotice();
  }

  // One timer owns every transition: the next scheduled boundary. If we are on
  // a substitute this is also when the station stops being unplayable for us.
  clearTimeout(boundaryTimer);
  boundaryTimer = setTimeout(() => {
    if (state.live) tuneToLive();
  }, Math.max(0, pos.remaining) * 1000 + BOUNDARY_LEAD_MS);

  loadIndex(index, offset);
}

function loadIndex(index, offset) {
  const track = state.schedule.tracks[index];
  const changed = index !== state.loadedIndex;

  state.loadedIndex = index;
  state.settled = false;
  state.loading = true;
  state.player.load(track.id, offset);

  if (changed) setMediaSessionMetadata(track);
  paint();
}

/**
 * Run once when a freshly loaded track actually starts making noise. Loading
 * and buffering take a second or two, during which the station has moved on,
 * so the offset we asked for is already slightly stale. Correcting here is what
 * keeps two people who opened the page a minute apart genuinely together.
 */
function settle() {
  if (!state.live || !state.player) return;
  state.settled = true;

  const pos = positionAt(state.schedule, now());

  // A duration that disagrees with YouTube is the one error that stays silent
  // and poisons everything after it in the loop. Say so in the console.
  const actual = Math.round(state.player.duration());
  const declared = state.schedule.tracks[state.loadedIndex]?.duration;
  if (actual > 0 && declared && Math.abs(actual - declared) >= 1) {
    console.warn(
      `[begambeli] duration mismatch for ${state.schedule.tracks[state.loadedIndex].id}: ` +
        `tracks.json says ${declared}s, YouTube says ${actual}s. ` +
        'Re-run scripts/build-tracks.mjs — every listener drifts from here on.',
    );
  }

  if (state.substitute || pos.index !== state.loadedIndex) return;
  if (Math.abs(state.player.currentTime() - pos.offset) > SETTLE_TOLERANCE) {
    state.player.seek(pos.offset);
  }
}

/**
 * The periodic check. The boundary timer handles ordinary track changes; this
 * handles the cases the timer cannot see — a laptop that was asleep, a
 * background tab whose timers were throttled to once a minute.
 */
function checkDrift() {
  if (!state.live || !state.player) return;

  const pos = positionAt(state.schedule, now());

  if (state.unavailable.has(pos.track.id)) return; // the substitute stands

  if (pos.index !== state.loadedIndex) {
    // Never compare offsets across two different tracks — that difference is
    // meaningless and would produce a nonsense seek. Reload instead.
    tuneToLive();
    return;
  }

  const playerState = state.player.state();
  if (playerState !== STATE.PLAYING) {
    if (playerState === STATE.BUFFERING) return; // already on its way

    // We believe we are on air and the audio is not running: a tab that was
    // frozen in the background, or a load that stalled. Sitting here quietly
    // is the one thing a radio must not do, so rejoin outright.
    tuneToLive();
    state.player.play();
    return;
  }

  const tolerance = state.settled ? DRIFT_TOLERANCE : SETTLE_TOLERANCE;
  if (Math.abs(state.player.currentTime() - pos.offset) > tolerance) {
    state.player.seek(pos.offset);
  }

  clearTimeout(boundaryTimer);
  boundaryTimer = setTimeout(() => {
    if (state.live) tuneToLive();
  }, Math.max(0, pos.remaining) * 1000 + BOUNDARY_LEAD_MS);
}

/**
 * Off air because the listener asked, as opposed to off air because the
 * browser froze a background tab and stopped the audio itself. Only the first
 * kind should survive coming back to the tab.
 */
function pauseByListener() {
  state.userPaused = true;
  goOffAir();
}

function resumeByListener() {
  state.userPaused = false;
  goOnAir();
}

function goOnAir() {
  if (state.live) return;
  state.userPaused = false;
  state.live = true;
  tuneToLive(); // rejoin wherever the station has got to, not where you left
  state.player.play();
  updateToggle();
}

function goOffAir() {
  if (!state.live) return;
  state.live = false;
  clearTimeout(boundaryTimer);
  state.player.pause();
  updateToggle();
}

/**
 * Come back to a tab and pick the broadcast up again.
 *
 * Called several times after the tab returns, not once. Suspending a
 * background tab stops the audio, but that pause is delivered through the
 * iframe and routinely arrives *after* the tab is already visible again — so a
 * single attempt at the moment of return can be undone a beat later by an event
 * describing something that happened a minute ago. Retrying costs nothing:
 * every branch below is a no-op once the station is running again.
 */
function rejoinAfterReturn() {
  if (!state.player || state.userPaused) return;
  if (document.visibilityState !== 'visible') return;
  if (state.live) {
    checkDrift();
    return;
  }
  goOnAir();
}

/** Unrecoverable: say so plainly and stop. */
function goDark(message) {
  state.live = false;
  clearTimeout(boundaryTimer);
  clearInterval(driftTimer);
  setNotice(message);
  updateToggle();
}

function handlePlayerError(code) {
  const track = state.schedule.tracks[state.loadedIndex];
  if (!track) return;
  state.loading = false;

  // Mark it and move on. Never retry the same id — a permanently broken track
  // would spin forever. Each error rules out exactly one track, so this is
  // bounded by the length of the playlist.
  state.unavailable.add(track.id);
  setNotice(
    `${track.title} won't play here — ${ERROR_REASON[code] ?? 'the player refused it'}. ` +
      'Moving on; the schedule picks us back up at the next track.',
  );

  if (state.unavailable.size >= state.schedule.tracks.length) {
    goDark('Nothing in the playlist will play in this browser.');
    return;
  }
  if (state.live) tuneToLive();
}

function handleStateChange(playerState) {
  if (playerState === STATE.PLAYING) {
    state.loading = false;
    if (!state.settled) settle();
    if (!state.live) {
      // Started from inside the iframe rather than our button.
      state.live = true;
          updateToggle();
    }
    setMediaSessionState('playing');
  } else if (playerState === STATE.PAUSED) {
    // Swapping the video out can emit a pause of its own — notably when the
    // one being replaced was refused. Only a pause that arrives once a track
    // is actually running is the listener reaching for the button.
    if (state.loading) return;
    // Go quiet and say so, but do not record it as a decision. Suspending a
    // background tab stops the audio and emits exactly this event, and the
    // iframe delivers it late enough that no amount of inspecting timestamps
    // tells it apart from a real one. Only the station's own controls set
    // `userPaused`, which is what survives the tab going away and coming back.
    if (state.live) goOffAir();
    setMediaSessionState('paused');
  } else if (playerState === STATE.ENDED) {
    // Only reachable when a substitute runs out before the schedule moves on.
    if (state.live) tuneToLive();
  }
}

/* ------------------------------------------------------------- painting -- */

/** Write only on change, so aria-live does not re-announce every second. */
function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

/**
 * What the listener should be told they are hearing. On air, that is whatever
 * is in the player. Off air they are hearing nothing, so we show what the
 * station is putting out instead — that is the point of the whole thing.
 */
function paint() {
  const pos = positionAt(state.schedule, now());
  const showing = state.live && state.loadedIndex >= 0 ? state.loadedIndex : pos.index;
  const track = state.schedule.tracks[showing];

  setText(el.title, track.title);
  setText(el.artist, track.artist);
  setCover(track);

  paintQuote();
  paintLocalTime();
  paintRail(pos);
}

/**
 * The listener's own wall clock, in their own timezone and their own 12/24-hour
 * convention, but derived from the corrected time rather than from Date.now().
 * A listener whose laptop is five minutes fast should see the real time here,
 * for the same reason the schedule does not trust their clock either.
 *
 * No seconds: this is orientation, not the countdown. The timecode in the pill
 * is where the moving numbers belong.
 */
function paintLocalTime() {
  const at = new Date(now() * 1000);
  setText(el.localtime, TIME_FORMAT.format(at));
  if (el.localtime) el.localtime.dateTime = at.toISOString();
}

/**
 * Cross-fades to whichever line the clock is on. Called once a second, but
 * only does anything when the answer changes.
 */
function paintQuote() {
  const next = QUOTES[Math.floor(now() / QUOTE_SECONDS) % QUOTES.length];
  if (!next || el.quote.textContent === next) return;
  if (el.quote.classList.contains('is-fading')) return; // a swap is mid-flight

  // The first one appears with the page rather than fading in from a blank.
  if (!el.quote.dataset.ready) {
    el.quote.dataset.ready = '1';
    setText(el.quote, next);
    return;
  }

  swapQuote(next);
}

/**
 * Fades out, swaps the text, fades back in — with the swap pinned to the moment
 * the fade has actually ended rather than to a hand-counted 320ms.
 *
 * The counted version assumed the transition began the instant the class was
 * added. It does not: it begins at the next style recalc, which on a busy phone
 * — decoding audio, running the panda and the clouds — can be a long way after.
 * The timer then fired mid-fade and replaced the text while the old line was
 * still visible, so for a moment both were on screen. Most obvious when a long
 * line is replaced by a short one, because the tail of the long one sticks out
 * past the end of the new one and reads as two lines printed over each other.
 */
function swapQuote(next) {
  const node = el.quote;

  const reveal = () => node.classList.remove('is-fading');

  const swap = () => {
    clearTimeout(guard);
    node.removeEventListener('transitionend', onFaded);
    setText(node, next);
    // Hold the new text at zero opacity for one frame, so it is laid out and
    // painted before anything animates it back up.
    requestAnimationFrame(reveal);
    setTimeout(reveal, 100); // requestAnimationFrame does not run in a hidden tab
  };

  const onFaded = (event) => {
    if (event.propertyName === 'opacity') swap();
  };

  node.addEventListener('transitionend', onFaded);
  // The event never arrives if the transition does not run at all — a hidden
  // tab, a fade interrupted by something else. Without this fallback the
  // `is-fading` guard above would latch and the quotes would stop changing for
  // good. Deliberately far longer than the 320ms fade: this must only ever fire
  // when there is no transition to wait for, because firing it while one is
  // still running is exactly the mid-fade swap this function exists to avoid.
  // Nothing notices the delay — the next line is not due for twelve seconds.
  // (Reduced motion does not need it: that keeps a 0.01ms transition, which
  // still fires the event, so quotes cut over promptly there too.)
  const guard = setTimeout(swap, 2000);

  node.classList.add('is-fading');
}

/** The sleeve on the disc. Only touched on a change, so it never re-fetches. */
function setCover(track) {
  const src = `assets/covers/${track.id}.jpg`;
  if (el.cover.getAttribute('src') === src) return;
  el.cover.setAttribute('src', src);
  el.cover.alt = `${track.title} — ${track.artist}`;
}

/**
 * The bar is the whole loop, not the current track: it is the position of the
 * broadcast. Display only — there is nothing to seek to.
 */
function paintRail(pos) {
  const offset = loopOffsetAt(state.schedule, now());
  const percent = `${((offset / state.schedule.total) * 100).toFixed(4)}%`;
  el.fill.style.width = percent;
  el.thumb.style.left = percent;

  setText(el.elapsed, formatClock(offset));
  setText(el.total, formatClock(state.schedule.total));

  el.rail.setAttribute(
    'aria-label',
    `The loop runs ${formatClock(state.schedule.total)}. ` +
      `The station is ${formatClock(offset)} into it, on ${pos.track.title}.`,
  );
}

function buildRail() {
  el.rail.replaceChildren();

  el.fill = document.createElement('span');
  el.fill.className = 'bar__fill';
  el.rail.append(el.fill);

  el.thumb = document.createElement('span');
  el.thumb.className = 'bar__thumb';
  el.rail.append(el.thumb);
}

/**
 * The "On air" badge is about the station, which is always broadcasting, so it
 * never changes. This is only about whether the listener has it in their ears:
 * the glyph on the button, and whether the record turns.
 */
function updateToggle() {
  // The button holds two SVG glyphs and CSS picks one off aria-pressed, so the
  // label is set as an accessible name rather than as text that would wipe them.
  el.toggle.setAttribute('aria-pressed', String(state.live));
  el.toggle.setAttribute('aria-label', state.live ? 'Pause' : 'Play');
  document.body.classList.toggle('is-playing', state.live);
}

function setNotice(message) {
  setText(el.notice, message);
  el.notice.hidden = false;
}

function clearNotice() {
  if (el.notice.hidden) return;
  el.notice.hidden = true;
  setText(el.notice, '');
}

/* -------------------------------------------------------- media session -- */

function setMediaSessionMetadata(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: 'Begambeli Radio',
      artwork: [{ src: `assets/covers/${track.id}.jpg`, type: 'image/jpeg' }],
    });
  } catch {
    /* not fatal — the lock screen just shows less */
  }
}

function setMediaSessionState(value) {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = value;
}

function wireMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, handler) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* unsupported action */
    }
  };
  set('play', resumeByListener);
  set('pause', pauseByListener);
  // There is no next. Clearing these stops the OS offering skip buttons.
  set('nexttrack', null);
  set('previoustrack', null);
  set('seekto', null);
  set('seekforward', null);
  set('seekbackward', null);
}

/* --------------------------------------------------------------- volume -- */

function readStoredVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const value = Number(raw);
    if (raw !== null && Number.isFinite(value) && value >= 0 && value <= 100) return value;
  } catch {
    /* private mode, blocked storage — the default is fine */
  }
  return DEFAULT_VOLUME;
}

function applyVolume(value) {
  state.volume = value;
  el.volume.value = String(value);
  state.player?.setVolume(value);
  try {
    localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    /* nothing to do */
  }
}

/* ---------------------------------------------------------------- theme -- */

const THEME_KEY = 'begambeli:theme';

/** What is on screen right now, whether chosen or inherited from the system. */
function activeTheme() {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * An explicit choice, which outranks the system setting in both directions and
 * survives a reload. The inline script in the document head applies it before
 * the first paint; this only has to handle the click.
 */
function setTheme(value) {
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem(THEME_KEY, value);
  } catch {
    /* storage blocked — the choice just will not outlive the tab */
  }
  paintThemeToggle();
}

function paintThemeToggle() {
  const dark = activeTheme() === 'dark';
  // A switch, not a button: its label names the setting and aria-checked says
  // whether it is on, rather than the label changing to name the next state.
  el.theme.setAttribute('aria-checked', String(dark));

  // Keep the browser chrome in step. The two <meta media=...> tags cover the
  // system setting; an explicit choice has to be applied by hand.
  //
  // Read which tag is which from data-scheme, not from its media attribute —
  // the first toggle overwrites media, and deriving identity from a value this
  // function itself rewrites leaves both tags disabled on the second press.
  const chosen = document.documentElement.dataset.theme;
  for (const tag of document.querySelectorAll('meta[name="theme-color"]')) {
    const forDark = tag.dataset.scheme === 'dark';
    tag.media = chosen
      ? (forDark === (chosen === 'dark') ? 'all' : 'not all')
      : `(prefers-color-scheme: ${forDark ? 'dark' : 'light'})`;
  }
}

/* ---------------------------------------------------------------- entry -- */

/**
 * There is no front door any more — the page is one screen and shows what is
 * on air from the moment it loads. But a browser will not start audio without
 * a gesture, so the first press of play is where the player gets built. It
 * also means anyone who never presses play never loads YouTube at all.
 */
async function startListening() {
  if (state.starting) return;
  state.starting = true;
  el.toggle.disabled = true;

  try {
    state.player = await createPlayer({
      elementId: 'player',
      onStateChange: handleStateChange,
      onError: handlePlayerError,
    });
  } catch (err) {
    goDark(err.message);
    return;
  } finally {
    state.starting = false;
    el.toggle.disabled = false;
  }

  applyVolume(state.volume);
  wireMediaSession();

  state.live = true;
  state.userPaused = false;
  updateToggle();
  tuneToLive();

  driftTimer = setInterval(checkDrift, DRIFT_INTERVAL_MS);
}

async function start() {
  const ids = ['title', 'artist', 'cover', 'elapsed', 'total', 'rail', 'notice',
    'toggle', 'volume', 'theme', 'quote', 'localtime'];
  for (const id of ids) el[id] = document.getElementById(id);

  // Ahead of the fetch below, so the header is never briefly missing a clock.
  // Skew is still zero here; the next tick corrects it.
  paintLocalTime();

  paintThemeToggle();
  el.theme.addEventListener('click', () =>
    setTheme(activeTheme() === 'dark' ? 'light' : 'dark'));

  // Someone who has never pressed the button keeps following their system, so
  // the label has to keep up if that changes underneath us.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) paintThemeToggle();
  });

  state.volume = readStoredVolume();
  el.volume.value = String(state.volume);

  const [data] = await Promise.all([
    fetch('data/tracks.json', { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`tracks.json returned ${res.status}`);
      return res.json();
    }),
    measureSkew(),
  ]).catch((err) => {
    setNotice(`The playlist would not load — ${err.message}`);
    throw err;
  });

  state.schedule = makeSchedule(data);
  buildRail();
  updateToggle();

  // The page is complete from the first paint: what is on air, how far into
  // the loop, and the sleeve — all of it from the schedule, none of it needing
  // a player to exist.
  paint();
  tickTimer = setInterval(paint, TICK_MS);

  el.toggle.addEventListener('click', () => {
    if (!state.player) return void startListening();
    return state.live ? pauseByListener() : resumeByListener();
  });
  el.volume.addEventListener('input', (e) => applyVolume(Number(e.target.value)));

  // A tab that was backgrounded for an hour must rejoin the broadcast, not
  // pick up where it left off. Re-measure the clock first: a sleeping machine
  // often wakes with a stale one.
  async function handleReturn() {
    if (document.visibilityState !== 'visible') return;

    // Get the audio back first, on whatever clock we already have. measureSkew
    // is a network round trip with no timeout, and a phone waking on a poor
    // connection can leave it hanging for a long time — everything after an
    // `await` on it would never run. Silence is the worse failure; the passes
    // below correct the position once the fresh measurement lands.
    rejoinAfterReturn();
    paint();

    await measureSkew();

    // An hour in a background tab must come back to the live broadcast, not to
    // the bar of music it was suspended on. The later passes are there to
    // outlast the stale pause the freeze emits on its way out.
    rejoinAfterReturn();
    setTimeout(rejoinAfterReturn, 1500);
    setTimeout(rejoinAfterReturn, 4000);

    paint();
  }

  document.addEventListener('visibilitychange', handleReturn);

  // Phones are the reason there are three of these. Locking the screen and
  // unlocking it is the ordinary visibilitychange case, but a browser that
  // restored the page from the back/forward cache — iOS Safari especially —
  // can come back on pageshow without one, and returning from another app can
  // arrive as a plain focus. rejoinAfterReturn guards on visibility and on
  // userPaused and is idempotent, so overlapping triggers cost nothing.
  window.addEventListener('pageshow', handleReturn);

  // No skew request of its own: focus fires often, and a HEAD per click would
  // be a lot of noise for a check that is only worth making when we were away.
  window.addEventListener('focus', () => rejoinAfterReturn());
}

start().catch((err) => {
  console.error('[begambeli]', err);
  const notice = document.getElementById('notice');
  if (notice && !notice.textContent.trim()) {
    notice.textContent = 'The station could not start. Reload to try again.';
    notice.hidden = false;
  }
  const button = document.getElementById('toggle');
  if (button) button.disabled = true;
});
