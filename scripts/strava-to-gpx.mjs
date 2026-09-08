#!/usr/bin/env node
// Writes GPX fixtures from Strava activity streams, so the correlation engine
// has real geometry to run against.
//
// These are NOT a substitute for exports from Garmin Connect. The GPX this
// writes is this script's own output, so parsing it proves nothing about how
// the parser handles a real device's file. Use these to exercise the engine;
// use Garmin exports to exercise the parser.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV_PATH = join(REPO_ROOT, '.env');
const GPX_DIR = join(REPO_ROOT, 'fixtures', 'gpx');
const REQUEST_TIMEOUT_MS = 20_000;

function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const parsed = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

async function refreshAccessToken(env) {
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: env.STRAVA_DEV_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.log(`FAIL refreshing access token - HTTP ${response.status}`);
    console.log(await response.text());
    process.exit(1);
  }
  return (await response.json()).access_token;
}

async function getJson(accessToken, url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.log(`FAIL GET ${url} - HTTP ${response.status}`);
    console.log(await response.text());
    process.exit(1);
  }
  return response.json();
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}

function buildGpx(activity, streams) {
  const startMs = Date.parse(activity.start_date);
  const latlng = streams.latlng.data;
  const time = streams.time.data;
  const altitude = streams.altitude?.data;

  const points = latlng.map((pair, i) => {
    const iso = new Date(startMs + time[i] * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const elevation = altitude ? `<ele>${altitude[i]}</ele>` : '';
    return `      <trkpt lat="${pair[0]}" lon="${pair[1]}">${elevation}<time>${iso}</time></trkpt>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="waypoint strava-to-gpx" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(activity.name)}</name>
    <time>${new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}</time>
  </metadata>
  <trk>
    <name>${escapeXml(activity.name)}</name>
    <type>${escapeXml(activity.sport_type)}</type>
    <trkseg>
${points.join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
}

// Filenames drive the scenario inventory in verify-environment.mjs, so a
// keyword in the name is functional rather than cosmetic.
function fixtureName(activity, scenario) {
  const date = activity.start_date_local.slice(0, 10);
  const slug = activity.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${date}-${slug}-${scenario}.gpx`;
}

// Only properties actually measurable from a stream get to name a file.
// "Paused" is deliberately absent: a Garmin export represents a pause as a
// separate <trkseg>, and Strava's streams flatten segments into one array, so
// a paused-activity fixture cannot be produced from this source at all.
function classify(activity, streams) {
  const time = streams.time.data;
  let longestGap = 0;
  for (let i = 1; i < time.length; i++) {
    const gap = time[i] - time[i - 1];
    if (gap > longestGap) longestGap = gap;
  }
  const scenario =
    activity.elapsed_time > 22 * 3600 ? 'multiday' : longestGap > 120 ? 'gap' : 'hike';
  return { scenario, longestGap };
}

async function main() {
  const env = loadEnv();
  for (const key of ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_DEV_REFRESH_TOKEN']) {
    if (!env[key]) {
      console.log(`FAIL missing from .env: ${key} - run scripts/strava-probe.mjs first`);
      process.exit(1);
    }
  }

  const requestedIds = process.argv.slice(2).filter((arg) => /^\d+$/.test(arg));
  const accessToken = await refreshAccessToken(env);
  console.log('PASS access token refreshed');

  let activities;
  if (requestedIds.length > 0) {
    activities = [];
    for (const id of requestedIds) {
      activities.push(await getJson(accessToken, `https://www.strava.com/api/v3/activities/${id}`));
    }
  } else {
    const listed = await getJson(
      accessToken,
      'https://www.strava.com/api/v3/athlete/activities?per_page=30',
    );
    activities = listed.filter((activity) => activity.sport_type === 'Hike');
  }
  console.log(`${activities.length} activity/activities to convert`);

  if (!existsSync(GPX_DIR)) mkdirSync(GPX_DIR, { recursive: true });

  for (const activity of activities) {
    const streams = await getJson(
      accessToken,
      `https://www.strava.com/api/v3/activities/${activity.id}/streams?keys=latlng,time,altitude&key_by_type=true`,
    );
    if (!streams.latlng || !streams.time) {
      console.log(`SKIP ${activity.id} "${activity.name}" - no latlng or time stream`);
      continue;
    }
    const { scenario, longestGap } = classify(activity, streams);
    const name = fixtureName(activity, scenario);
    writeFileSync(join(GPX_DIR, name), buildGpx(activity, streams));
    console.log(
      `PASS ${name.padEnd(46)} ${String(streams.latlng.data.length).padStart(6)} pts  ` +
        `${String(Math.round(activity.elapsed_time / 60)).padStart(4)} min  longest gap ${longestGap}s`,
    );
  }
}

main().catch((err) => {
  console.log(`FAIL unexpected error - ${err.message}`);
  process.exit(1);
});
