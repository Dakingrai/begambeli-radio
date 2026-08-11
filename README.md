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

"Peek-a-boo Panda", recreated from a design handoff. Warm sage ground `#e9ede3`, ink
`#1a1f18`, a monochrome panda that rises from behind the station's name every seven seconds
and ducks back down, bamboo in the corner, two bougainvillea petals drifting past, and a dark
pill player docked at the bottom. Bougainvillea magenta `#e0407a` is the only accent — the
on-air dot, the position marker, the flower at the panda's ear, and the focus ring.

Panda, flower, petals and bamboo are all CSS shapes; there are no image assets beyond the
track covers. Fredoka 600 is self-hosted in `assets/fonts/` for the display face, and
everything else is `system-ui`; nothing loads from a third-party CDN at runtime.

The mockups live in `data/design/`, which is gitignored and never deployed.

### Two departures from the handoff, on purpose

**Muted ink is darker.** The prototype specifies `rgba(26,31,24,0.55)` for the subline and
`0.6` for the header link. On this ground those measure about 3.6:1 and 4.3:1, under the
4.5:1 body text needs. Both are `0.66` here, the smallest change that clears it — measured by
differencing a text-visible against a text-hidden screenshot, so the numbers come from real
glyph coverage rather than from an element box. They now read 5.03:1 and 4.95:1.

**Prev and next are gone.** They were drawn in the mockup, but there is nothing to skip to —
the brief ruled them out and non-functional controls would be worse than none.

Volume was not in the mockup either, but with the player hidden there is no fallback, so a
speaker glyph sits in the pill and slides open on hover or focus.

### The progress bar

It is the position of the whole loop, not of the current track, which is why it reads
`9:54 / 41:16`. Display only — a broadcast has nothing to seek to, so it is not a control.

### The player is hidden

The original brief made "player visible and at least 200×200" a hard constraint, because it
is what keeps a YouTube embed inside the terms of the IFrame API. This design has nowhere to
put one, and hiding it was chosen deliberately with that trade-off understood.

How it is hidden matters. `display:none`, `visibility:hidden` and 1×1 sizing all risk a
browser refusing to start the embed or throttling it silently. Instead `.stage` renders the
player at a real 356×200 and the page's own opaque ground is painted over it at a higher
stacking level, so the iframe is fully laid out and playing but never seen. **Do not "tidy"
this into `display:none`** — audio stops being reliable, and it will not fail consistently
enough to be obvious.

`opengraph.png` is rendered from `scripts/opengraph.html`, which imports the site's own
stylesheet so it cannot drift from the real thing:

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
