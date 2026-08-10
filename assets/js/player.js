/**
 * A thin wrapper over the YouTube IFrame Player API.
 *
 * Everything here is about getting a player object and normalising its
 * callback-and-globals interface into promises and plain functions. No
 * scheduling decisions are made in this file.
 */

const API_SRC = 'https://www.youtube.com/iframe_api';

/** YT.PlayerState, restated so callers do not depend on the global. */
export const STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
};

/**
 * What each onError code actually means, in words a listener can read.
 * 2 — malformed id. 5 — the HTML5 player could not play it.
 * 100 — removed or private. 101 / 150 — the uploader disallows embedding.
 */
export const ERROR_REASON = {
  2: 'the video id is not valid',
  5: 'the player could not load it',
  100: 'it has been removed or made private',
  101: 'the uploader does not allow it off YouTube',
  150: 'the uploader does not allow it off YouTube',
};

let apiPromise = null;

/**
 * Load the IFrame API once. Resolves with the global `YT` namespace.
 * The API insists on calling a global callback, so we hand it one and
 * immediately forget about it.
 */
export function loadApi() {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };

    const script = document.createElement('script');
    script.src = API_SRC;
    script.async = true;
    script.onerror = () =>
      reject(new Error('Could not reach YouTube. Check the connection and reload.'));
    document.head.append(script);
  });

  return apiPromise;
}

/**
 * Create a player in place of the element with the given id.
 * Resolves once the player reports ready.
 *
 * The iframe stays visible and full size inside its container — it is the
 * artwork panel, not a hidden audio source.
 */
export async function createPlayer({ elementId, onStateChange, onError }) {
  const YT = await loadApi();

  return new Promise((resolve, reject) => {
    let settled = false;

    const player = new YT.Player(elementId, {
      width: '100%',
      height: '100%',
      playerVars: {
        // No controls of our own inside the frame: this is a broadcast, so
        // there is nothing to seek to. disablekb stops arrow keys scrubbing.
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3,
        cc_load_policy: 0,
        fs: 0,
      },
      events: {
        onReady: () => {
          if (settled) return;
          settled = true;
          resolve(wrap(player));
        },
        onStateChange: (event) => onStateChange?.(event.data),
        onError: (event) => onError?.(event.data),
      },
    });

    // If YouTube never calls onReady — blocked, offline, extension in the way —
    // fail with something the UI can show rather than hanging on the gate.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('YouTube did not respond. It may be blocked on this network.'));
    }, 15000);
  });
}

/**
 * Wrap the raw player so callers get plain methods and no exceptions when the
 * iframe is mid-teardown (getCurrentTime in particular throws if called too
 * early, and it is called on a timer).
 */
function wrap(player) {
  const safe = (fn, fallback) => (...args) => {
    try {
      return fn(...args);
    } catch {
      return fallback;
    }
  };

  return {
    raw: player,
    load: safe((videoId, startSeconds) =>
      player.loadVideoById({ videoId, startSeconds: Math.max(0, startSeconds) })),
    play: safe(() => player.playVideo()),
    pause: safe(() => player.pauseVideo()),
    seek: safe((seconds) => player.seekTo(Math.max(0, seconds), true)),
    currentTime: safe(() => player.getCurrentTime(), 0),
    duration: safe(() => player.getDuration(), 0),
    state: safe(() => player.getPlayerState(), STATE.UNSTARTED),
    setVolume: safe((v) => {
      player.unMute();
      player.setVolume(Math.round(v));
    }),
  };
}
