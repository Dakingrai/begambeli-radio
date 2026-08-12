# Begambeli Radio

A one-page internet radio station for [begambeli.com](https://begambeli.com). Every
visitor hears the same song at the same moment, the way you would tune into a real
broadcast rather than open a playlist.

Live at **radio.begambeli.com**.

## How it works

There is no server and nothing is streamed from here. The playlist is a fixed, ordered
list of YouTube videos with known durations, and the schedule is a pure function of the
clock:

```
elapsed = (now - epoch) mod totalDuration
```

Walk the track list until `elapsed` runs out, and you have the track and the offset into
it. Two browsers in different countries run that same arithmetic against the same wall
clock and land on the same second of the same song. Audio comes from the YouTube IFrame
Player API; the whole site is static files.

Three pieces:

| File | Job |
| --- | --- |
| `assets/js/schedule.js` | The maths. Pure functions, no DOM, no YouTube, never reads the clock itself. |
| `assets/js/player.js` | The YouTube IFrame API, wrapped so the rest of the code sees plain methods. |
| `assets/js/main.js` | Entry point: clock, UI, and keeping the player pointed at the schedule. |

`schedule.js` is deliberately free of everything else, because a bug in it is invisible on
your own machine and only shows up when somebody in another timezone says the songs do not
match. `node scripts/test-schedule.mjs` exercises it, including the loop wrap and the
negative-time case.

### Things that are easy to get wrong

**Clock skew.** Browser clocks are routinely minutes out, so the station does not trust
`Date.now()`. On startup it reads the `Date` header from a `HEAD` request to the page,
halves the round trip, and derives all schedule time from the corrected value. It
re-measures whenever the tab comes back to the foreground. If that fails the station
carries on with the local clock — one desynced listener beats a blank page.

**Negative modulo.** JavaScript's `%` keeps the sign of the dividend, so a listener whose
clock is set before the epoch would compute a negative index. `positionAt` folds the value
twice to pin it into range.

**Never compare offsets across tracks.** The drift check compares the player's position
against the schedule's, but only after confirming both refer to the same track. Near a
boundary those two can disagree about which track is playing, and subtracting one offset
from the other gives a meaningless number and a nonsense seek.

**Pausing is not pausing.** The broadcast keeps running while you are paused — the title and
the progress bar keep moving, and pressing play rejoins wherever the station has got to.
A tab backgrounded for an hour rejoins live rather than resuming mid-bar.

## Running it locally

No build step, no dependencies. Any static server:

```bash
python3 -m http.server 8788
```

Then open <http://localhost:8788>. ES modules need a real server; opening `index.html`
over `file://` will not work.

```bash
node scripts/test-schedule.mjs
```

`assets/js/package.json` contains nothing but `{"type": "module"}`, so Node treats the
station's scripts as ES modules and the test can import the exact code the browser runs.
It lives there rather than at the repo root deliberately — a root `package.json` makes
Cloudflare's build detection install dependencies, and anything it installs lands inside
the directory being deployed. See the deploy notes below.

## Editing the playlist

`data/ids.txt` is the source of truth — one YouTube ID or URL per line, `#` comments
allowed anywhere on a line. Then:

```bash
cp .env.example .env            # add a YouTube Data API v3 key
node scripts/build-tracks.mjs
```

To take the list from a YouTube playlist instead of maintaining it by hand:

```bash
node scripts/build-tracks.mjs --playlist https://www.youtube.com/playlist?list=PLfwITQ3WPP6U
```

That reads the playlist, **rewrites `data/ids.txt` from it**, and carries on as normal.
The playlist is an importer, not a live feed: the resolved order stays committed, so the
loop rebuilds without an API call, the diff shows exactly what moved, and re-ordering the
playlist in YouTube months later cannot silently reshuffle the station. Re-run the command
whenever you want to pull changes across. Hand edits to `ids.txt` survive a plain run and
are overwritten by a `--playlist` run.

The site cannot read a playlist directly, and this is the reason: a playlist URL gives no
durations, and durations are what make the schedule deterministic. Fetching them in the
browser would mean shipping the API key, and a key in static files is a key anyone can
lift. `--playlist` moves that work to your machine, where the key already lives.

Watch Later, Liked videos and auto-generated mixes cannot be read with an API key — the
first two need OAuth and the third is generated per viewer. Copy them into a normal
playlist (unlisted is fine). Private playlists are invisible to a key; unlisted works.

That rewrites `data/tracks.json` and downloads any missing cover art. Read the warnings,
check the diff, commit both.

- **Appending** to the end of the list is safe. It extends the loop and leaves everyone
  where they were.
- **Reordering or removing** shifts every listener's position the moment they reload.
  Nothing breaks, it is just more disruptive.
- **Never change `epoch`.** It is the fixed point the whole schedule is measured from.
  Changing it reshuffles where everybody is.

Titles from YouTube are noisy (`... (Official Video) | HD`), so they get cleaned by hand.
The script preserves whatever is already in `tracks.json` for `title` and `artist` and only
refreshes `duration` — that is what stops the next run undoing your edits. Pass
`--refresh-titles` if you actually want YouTube's version back.

`duration` must match YouTube exactly. A wrong value there is the one failure that stays
silent and drifts every listener from that point in the loop onward, so the station also
checks each track's real duration as it loads and complains in the console if they
disagree.

The API key is only ever used by that script on your machine. The deployed site reads
`data/tracks.json` and nothing else, and `.env` is gitignored.

### Tracks that will not play

Some uploads disallow embedding, and they look perfectly healthy in the API response
until a listener gets error 150. The generator requests `status` alongside the metadata
and warns about those, which is worth heeding — the alternative is finding out in
production. At runtime the station marks a failed track unavailable, says what happened,
plays the next one that works, and rejoins the schedule at the following boundary.

## Design

"Peek-a-boo Panda", shan-shui, recreated from `design_handoff_panda_radio` v2. A Chinese
landscape sits behind the station: layered karst peaks at both corners, drifting clouds,
ground mist, bamboo, and two bougainvillea petals falling past. A panda rises from behind
the station's name every seven seconds and ducks back down.

Two modes, and they are properly two scenes rather than one scene recoloured:

| | light | dark |
| --- | --- | --- |
| sky | `linear-gradient(#e2e9da, #e9ede3 60%)` | `linear-gradient(#0d120c, #121710 60%)` |
| overhead | 64px sun with a warm glow | 58px moon with craters, plus five twinkling stars |
| peaks | sage fills | fainter fills **with a moonlit rim** on the side facing the moon |
| petals | flat magenta | brighter, and glowing |
| corner logo | ink on a white face | **negative** — light ink on a dark face |
| player pill | a dark object, white text | **inverts** — a light object, dark text, dark play button |

Everything is a CSS shape; there are no image assets beyond the track covers. Fredoka 600 is
self-hosted for the display face, `system-ui` elsewhere, nothing from a third-party CDN.

The mockups live in `data/design/`, which is gitignored and never deployed.

### How the theme is chosen

Entirely client-side — there is no server and no database. Three CSS blocks, so an explicit
choice beats the system setting in both directions:

```css
:root                              /* light, the base                  */
@media (prefers-color-scheme: dark)
  :root:not([data-theme='light'])  /* dark, unless light was asked for  */
:root[data-theme='dark']           /* dark, whatever the system says    */
```

The dark palette is written once as `--d-*` and referenced from both dark selectors, so the
two cannot drift apart. The choice is a single string in `localStorage`; with nothing stored,
`data-theme` is never set at all and the media query stays in charge, so someone who has
never touched the switch keeps following their system if it changes later.

**The inline script in `<head>` is load-bearing.** It applies a stored preference before the
stylesheet, because `main.js` is a module and therefore deferred; applying it from there
would repaint after the first frame and flash the wrong theme on every load.

### Traps in here

**The pill inverts, so nothing inside it can be a literal.** Title, artist, timecode, track,
fill, thumb ring, play button, disc ring and spindle are all tokens, because every one of
them swaps ends between modes.

**The bamboo nodes are painted in the sky colour.** Those inset shadows fake the gaps between
segments, so `--node` has to track the sky — hardcode it and dark mode draws pale bars across
the stalks.

**Muted text needed raising in both modes, and for opposite reasons.** The references specify
0.55–0.6 alpha. On the light ground that measures ~3.6:1; in the *dark* pill — which is a
light surface — the timecode measures ~3.2:1. Both are raised until they clear 4.5:1 by
measurement, not by eye: two screenshots, one with the text visible and one with it hidden,
differenced to find the pixels the glyphs actually paint, then the glyph colour compared
against the lightest background any glyph sits on. Tightest is 5.00:1 in light, 5.18:1 in
dark.

### The player is hidden

The original brief made "player visible and at least 200×200" a hard constraint, because it
is what keeps a YouTube embed inside the terms of the IFrame API. This design has nowhere to
put one, and hiding it was chosen deliberately with that trade-off understood.

How it is hidden matters. `display:none`, `visibility:hidden` and 1×1 sizing all risk a
browser refusing to start the embed or throttling it silently. Instead `.stage` renders the
player at a real 356×200 and the page's own opaque sky is painted over it at a higher
stacking level, so the iframe is fully laid out and playing but never seen. **Do not "tidy"
this into `display:none`** — audio stops being reliable, and it will not fail consistently
enough to be obvious.

`opengraph.png` is rendered from `scripts/opengraph.html`, which imports the site's own
stylesheet so it cannot drift from the real thing, and is pinned to `data-theme="light"` so
link previews are always the daylight scene:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --window-size=1200,630 --virtual-time-budget=5000 \
  --screenshot="$PWD/opengraph.png" "file://$PWD/scripts/opengraph.html"
```


## Deploying

Cloudflare, connected to this repo, deploying as a static-asset Worker via
`npx wrangler deploy`. `wrangler.jsonc` pins the settings so each build does not re-guess
them. After the first setup, `git push` deploys.

`_headers` sets the cache policy: 60 seconds on `tracks.json` so playlist changes reach
listeners promptly, and a year on covers and fonts, which never change.

**The assets directory is the repo root**, which means the deploy uploads everything not
listed in `.assetsignore`. That matters more than it sounds: the build step installs
tooling for its own use, and `node_modules/workerd/bin/workerd` is about 122 MiB against a
25 MiB per-asset limit. A deploy that starts failing with *"Asset too large"* is almost
always something new appearing at the root — check `.assetsignore` first.

For the same reason, do not add a `package.json` at the repo root. It triggers a
dependency install whose output sits inside the directory being deployed.
