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

A photograph, and glass floating on top of it. A fixed full-bleed background, a masthead of
frosted pills, the video in the middle, and one glass panel at the bottom holding everything
you can actually do. No webfonts — `system-ui` throughout, so the page carries no type
payload at all.

Colour is almost entirely white at 100 / 70 / 55% over a scrimmed image. The exception is
bougainvillea magenta (`#e0407a`), which is what *begambeli* means: it is the live dot, the
focus ring, and the hot end of the loop gradient, and it is the only hue in the interface
that carries information.

### Swapping the background

`assets/bg.jpg` is the photograph. Replace the file and nothing else needs to change.

**Resize it first.** A full-resolution scan is 10–15MB, which is a miserable thing to put
in front of someone on a phone and is the single heaviest asset on the site by two orders
of magnitude. 2048px on the long edge at quality 55 lands around 400KB and is
indistinguishable once the scrim is over it:

```bash
sips -Z 2048 --setProperty format jpeg --setProperty formatOptions 55 \
  your-scan.jpg --out assets/bg.jpg
```

**Legibility is handled, within reason.** Everything in the bottom bar sits on frosted glass
rather than on the image, so it stays readable whatever the photograph does. The one thing
standing on the bare picture is the station's name, and `.stage::before` lays a soft pool of
shade under the middle of the page for exactly that reason — a bright frame will otherwise
put white text on sunlit stone.

Contrast is measured rather than eyeballed, and measured properly: two screenshots, one
with the text visible and one with it hidden, differenced to find the pixels the glyphs
actually paint, then the glyph colour compared against the lightest background any glyph
sits on. Against the current photograph the name reads 12.1:1 and the tightest pairing
anywhere is the caption text at 6.1:1. Worth re-running if you swap in something much
brighter.

### The loop rail

The signature element: the entire playlist as one bar, each track a segment sized to its
duration, hairlines at the boundaries, a warm gradient filling to the current position and a
white marker riding across it. It is not a scrubber and is deliberately not interactive,
because you cannot scrub a broadcast. It keeps moving while you are paused, which is the
clearest way to show that the station has not stopped just because you have.

### The player

YouTube's terms require the player to stay visible and at least 200×200, so it is the hero
of the composition rather than something tucked away — the artwork is simply the thing
itself, moving. Below about 360px the 200px floor takes over from the 16:9 ratio and a
little letterboxing returns, which is the correct trade.

`opengraph.png` is rendered from `scripts/opengraph.html`, which imports the site's own
stylesheet so it cannot drift from the real thing:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --window-size=1200,630 --virtual-time-budget=4000 \
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
