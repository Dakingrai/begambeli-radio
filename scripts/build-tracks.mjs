#!/usr/bin/env node
/**
 * Build data/tracks.json from data/ids.txt.
 *
 * Local only. This never runs in production — the site is static files and
 * knows nothing about the YouTube Data API. Run it by hand, check the diff,
 * commit the result.
 *
 *   node scripts/build-tracks.mjs
 *   node scripts/build-tracks.mjs --refresh-titles   # let YouTube overwrite titles
 *   node scripts/build-tracks.mjs --force-covers     # re-download every cover
 *
 * Needs YT_API_KEY, from the environment or from .env at the repo root.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDS_FILE = join(ROOT, 'data', 'ids.txt');
const TRACKS_FILE = join(ROOT, 'data', 'tracks.json');
const COVERS_DIR = join(ROOT, 'assets', 'covers');

/** 2026-01-01T00:00:00Z. Only used when there is no tracks.json to inherit from. */
const DEFAULT_EPOCH = 1767225600;

const flags = new Set(process.argv.slice(2));
const REFRESH_TITLES = flags.has('--refresh-titles');
const FORCE_COVERS = flags.has('--force-covers');

let warnings = 0;
const warn = (message) => {
  warnings++;
  console.warn(`\n  !!  ${message}\n`);
};

/* ------------------------------------------------------------------ key -- */

/**
 * Minimal .env reader. No dependency for six lines of parsing, and the file
 * only ever holds one key.
 */
async function loadDotEnv() {
  try {
    const text = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(line);
      if (!match) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
      if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
  } catch {
    /* no .env is fine if the key is already in the environment */
  }
}

/* ---------------------------------------------------------------- input -- */

/** One id or URL per line. Blank lines, whole-line and trailing # comments. */
function parseIds(text) {
  const ids = [];
  const seen = new Set();

  for (const [i, rawLine] of text.split('\n').entries()) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const id = extractId(line);
    if (!id) {
      warn(`data/ids.txt line ${i + 1}: could not find a video id in "${line}"`);
      continue;
    }
    if (seen.has(id)) {
      warn(`data/ids.txt line ${i + 1}: ${id} is listed more than once — keeping the first`);
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function extractId(value) {
  if (/^[\w-]{11}$/.test(value)) return value;
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /\/(?:embed|shorts|live|v)\/([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return match[1];
  }
  return null;
}

/* ------------------------------------------------------------- duration -- */

/**
 * ISO 8601 durations as YouTube emits them: PT5M12S, PT47S, PT3M, PT1H2M3S,
 * and P1DT4H for the occasional very long upload.
 */
export function parseIsoDuration(iso) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso ?? '');
  if (!match) return null;
  const [, d, h, m, s] = match;
  if (d === undefined && h === undefined && m === undefined && s === undefined) return null;
  return (
    Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Math.round(Number(s ?? 0))
  );
}

/* -------------------------------------------------------------- youtube -- */

async function fetchMetadata(ids, key) {
  const byId = new Map();

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet,contentDetails,status');
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('key', key);

    console.log(`  fetching ${batch.length} video${batch.length === 1 ? '' : 's'}`);
    const res = await fetch(url);

    if (!res.ok) {
      const body = await res.text();
      let detail = body.slice(0, 400);
      try {
        detail = JSON.parse(body).error?.message ?? detail;
      } catch {
        /* keep the raw body */
      }
      throw new Error(`YouTube API returned ${res.status}: ${detail}`);
    }

    const payload = await res.json();
    for (const item of payload.items ?? []) byId.set(item.id, item);
  }

  return byId;
}

/* --------------------------------------------------------------- covers -- */

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** maxresdefault where it exists, hqdefault everywhere else. */
async function downloadCover(id) {
  const target = join(COVERS_DIR, `${id}.jpg`);
  if (!FORCE_COVERS && (await exists(target))) return 'kept';

  for (const name of ['maxresdefault', 'hqdefault']) {
    const res = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`);
    if (!res.ok) continue;
    const bytes = Buffer.from(await res.arrayBuffer());
    // YouTube answers 200 with a tiny grey placeholder for some sizes.
    if (bytes.length < 2048) continue;
    await writeFile(target, bytes);
    return name;
  }

  warn(`no thumbnail available for ${id} — the lock screen will have no artwork`);
  return null;
}

/* ------------------------------------------------------------------ run -- */

async function main() {
  await loadDotEnv();
  const key = process.env.YT_API_KEY;

  if (!key) {
    console.error(
      '\nYT_API_KEY is not set.\n\n' +
        '  cp .env.example .env\n' +
        '  # then put your YouTube Data API v3 key in it\n\n' +
        'Get one at https://console.cloud.google.com/apis/library/youtube.googleapis.com\n',
    );
    process.exit(1);
  }

  let idsText;
  try {
    idsText = await readFile(IDS_FILE, 'utf8');
  } catch {
    console.error(`\nNo ${IDS_FILE}. Create it with one YouTube id or URL per line.\n`);
    process.exit(1);
  }

  const ids = parseIds(idsText);
  if (ids.length === 0) {
    console.error('\ndata/ids.txt has no usable ids.\n');
    process.exit(1);
  }

  // Whatever is already committed wins for the human-facing fields. Titles come
  // off YouTube full of "(Official Video) | HD | 4K" and get cleaned by hand;
  // this is what stops the next run undoing that work.
  let previous = { epoch: DEFAULT_EPOCH, tracks: [] };
  try {
    previous = JSON.parse(await readFile(TRACKS_FILE, 'utf8'));
  } catch {
    console.log('  no existing tracks.json — starting fresh');
  }
  const existing = new Map((previous.tracks ?? []).map((t) => [t.id, t]));

  const epoch = Number.isFinite(previous.epoch) ? previous.epoch : DEFAULT_EPOCH;
  if (epoch !== previous.epoch) {
    console.log(`  setting epoch to ${epoch} — never change this again`);
  }

  await mkdir(COVERS_DIR, { recursive: true });
  const metadata = await fetchMetadata(ids, key);

  const tracks = [];
  for (const id of ids) {
    const item = metadata.get(id);

    if (!item) {
      warn(
        `${id} returned nothing. It is private, deleted, or the id is wrong. ` +
          'Dropping it from tracks.json.',
      );
      continue;
    }

    const duration = parseIsoDuration(item.contentDetails?.duration);
    if (!duration) {
      warn(
        `${id} has no usable duration (${item.contentDetails?.duration}) — ` +
          'live streams and premieres cannot be scheduled. Dropping it.',
      );
      continue;
    }

    // Not asked for in the spec, but worth the extra field on the request: an
    // embed-disabled video looks perfectly healthy here and then throws error
    // 150 for every listener.
    if (item.status?.embeddable === false) {
      warn(`${id} ("${item.snippet?.title}") cannot be embedded — it will fail for listeners.`);
    }

    const held = existing.get(id);
    const keepHuman = held && !REFRESH_TITLES;

    if (held && held.duration !== duration) {
      console.log(`  ${id} duration corrected: ${held.duration}s -> ${duration}s`);
    }

    const cover = await downloadCover(id);
    const title = keepHuman && held.title ? held.title : (item.snippet?.title ?? id);
    const artist = keepHuman && held.artist ? held.artist : (item.snippet?.channelTitle ?? 'Unknown');

    console.log(`  ${id}  ${String(duration).padStart(4)}s  ${cover ?? 'no cover'}  ${title}`);

    // Fixed key order so diffs stay about content.
    tracks.push({ id, title, artist, duration });
  }

  if (tracks.length === 0) {
    console.error('\nNothing usable to write. tracks.json left alone.\n');
    process.exit(1);
  }

  const dropped = [...existing.keys()].filter((id) => !tracks.some((t) => t.id === id));
  if (dropped.length) {
    console.log(`\n  no longer in ids.txt: ${dropped.join(', ')}`);
  }

  await writeFile(TRACKS_FILE, `${JSON.stringify({ epoch, tracks }, null, 2)}\n`, 'utf8');

  const total = tracks.reduce((sum, t) => sum + t.duration, 0);
  const mins = Math.floor(total / 60);
  console.log(
    `\nWrote data/tracks.json — ${tracks.length} tracks, ` +
      `${mins}m ${String(total % 60).padStart(2, '0')}s end to end.`,
  );
  if (warnings) {
    console.log(`${warnings} warning${warnings === 1 ? '' : 's'} above. Read them before committing.`);
  }
  console.log('Reordering or removing tracks moves every listener. Appending is safe.\n');
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
