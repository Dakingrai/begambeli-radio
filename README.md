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

**Pausing is not pausing.** The broadcast keeps running while you are paused — the display
and the loop rail keep moving, and pressing play rejoins wherever the station has got to.
A tab backgrounded for an hour rejoins live rather than resuming mid-bar.

## Running it locally

No build step, no dependencies. Any static server:

```bash
python3 -m http.server 8788     # or: npm run serve
```

Then open <http://localhost:8788>. ES modules need a real server; opening `index.html`
over `file://` will not work.

```bash
node scripts/test-schedule.mjs  # or: npm test
```

`package.json` exists only so Node treats `assets/js/*.js` as ES modules, which is what
lets the test import the exact code the browser runs. There are no dependencies and
nothing to install. **Cloudflare Pages must be configured with no build command.**

## Editing the playlist

`data/ids.txt` is the source of truth — one YouTube ID or URL per line, `#` comments
allowed anywhere on a line. Then:

```bash
cp .env.example .env            # add a YouTube Data API v3 key
node scripts/build-tracks.mjs   # or: npm run tracks
```

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

Newari lattice-window carving at dusk, which is where the palette comes from: violet-black
timber (`#141018`), dull brass hairlines held deliberately low-chroma (`#7A6A4C`), and one
live colour — bougainvillea magenta (`#E0407A`), which is what *begambeli* means. The
magenta is rationed to three jobs: the on-air dot, the position mark, and the focus ring,
so it always means something is happening.

Anton for the ident and track titles, IBM Plex Mono for everything else. The mono carries a
timecode-and-rebate register that keeps the page from reading as a music player. Both are
self-hosted in `assets/fonts/`; nothing loads from a third-party CDN at runtime.

The signature element is the **loop rail** — the entire playlist as one bar, each track a
segment sized to its duration, with a magenta mark riding across it. It is not a scrubber
and is deliberately not interactive, because you cannot scrub a broadcast. It makes the
loop visible instead of hiding it, including while you are paused.

YouTube's terms require the player to stay visible and at least 200×200, so the layout is
built around it rather than apologising for it: a 16:9 pane recessed into a carved frame
with brass corner brackets. Below about 360px the 200px floor takes over from the ratio and
a little letterboxing returns, which is the correct trade.

`opengraph.png` is rendered from `scripts/opengraph.html` so it shares the site's fonts and
palette:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --window-size=1200,630 --virtual-time-budget=4000 \
  --screenshot="$PWD/opengraph.png" "file://$PWD/scripts/opengraph.html"
```

## Deploying

Cloudflare Pages, connected to this repo. Framework preset **None**, build command
**empty**, output directory `/`. `_headers` sets the cache policy: 60 seconds on
`tracks.json` so playlist changes reach listeners promptly, and a year on covers and fonts,
which never change. After the first setup, `git push` deploys.
