#!/usr/bin/env node
// Phase 0 de-risking probe for the Strava integration. Zero dependencies by
// design, matching verify-environment.mjs: node builtins only.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV_PATH = join(REPO_ROOT, '.env');
const REQUEST_TIMEOUT_MS = 15_000;
const CALLBACK_TIMEOUT_MS = 3 * 60 * 1000;
const SAVE_REFRESH_TOKEN = !process.argv.includes('--no-save-refresh-token');
const GRACE_PERIOD_MS = 15 * 60 * 1000;
const SHORT_GAP_THRESHOLD_S = 15;
const LONG_GAP_THRESHOLD_S = 120;

function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const parsed = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    parsed[key] = value;
  }
  return parsed;
}

function requireEnvKeys(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    console.log(`FAIL missing from .env: ${missing.join(', ')} - set them before running this probe`);
    process.exit(1);
  }
}

function buildAuthorizationUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'force',
    scope: 'read,activity:read_all',
    state,
  });
  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

function waitForCallback(redirectUri, state) {
  const url = new URL(redirectUri);
  const port = Number(url.port) || 80;
  const path = url.pathname;

  return new Promise((resolve, reject) => {
    let timer;
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url, `http://${req.headers.host}`);
      if (requestUrl.pathname !== path) {
        res.writeHead(404, { Connection: 'close' }).end('Not found');
        return;
      }
      const params = requestUrl.searchParams;
      const error = params.get('error');
      const returnedState = params.get('state');
      const code = params.get('code');
      const scope = params.get('scope');

      const finish = (result, failure) => {
        clearTimeout(timer);
        // Plain text, and the browser's message is never built from Strava's
        // query parameters — those are reported in the terminal instead.
        res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' }).end(
          failure
            ? 'Authorization failed. Check the terminal for details.'
            : 'Authorization complete. Check the terminal for results.',
        );
        // close() alone waits on keep-alive sockets the browser is still
        // holding, which would leave this promise pending indefinitely.
        server.closeAllConnections();
        server.close(() => {
          if (failure) reject(new Error(failure));
          else resolve(result);
        });
      };

      // Browsers fire speculative and bare-path requests at a localhost URL.
      // Only a request actually carrying code or error is the OAuth callback;
      // anything else is noise and must not end the wait.
      if (!code && !error) {
        console.log(`     ignoring request to ${requestUrl.pathname} with no code or error parameter`);
        res.writeHead(204, { Connection: 'close' }).end();
        return;
      }

      if (error) {
        finish(null, `Strava denied the request: ${error}`);
        return;
      }
      // A stale authorization link from an earlier run of this script lands here
      // with a code and the wrong nonce. Reject it, but keep waiting: killing the
      // run would mean regenerating the link and inviting the same mistake again.
      if (returnedState !== state) {
        console.log(`     rejected a callback whose state was ${returnedState || '(absent)'}, expected ${state}`);
        console.log('     that is a link from an earlier run - use the most recent URL printed above');
        res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' }).end(
          'Stale authorization link. Use the most recent URL from the terminal.',
        );
        return;
      }
      finish({ code, scope });
    });

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`local callback server failed to start on port ${port}: ${err.message}`));
    });

    server.listen(port, '127.0.0.1', () => {
      timer = setTimeout(() => {
        server.close(() => reject(new Error('timed out waiting 3 minutes for the OAuth callback - open the URL above and grant access')));
      }, CALLBACK_TIMEOUT_MS);
    });

    process.once('SIGINT', () => {
      clearTimeout(timer);
      server.close(() => process.exit(1));
    });
  });
}

async function exchangeCodeForTokens(clientId, clientSecret, code) {
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    console.log(`FAIL token exchange - HTTP ${response.status}`);
    console.log(body);
    process.exit(1);
  }
  return JSON.parse(body);
}

function reportGrantedScopes(scopeParam) {
  console.log('');
  console.log(`Scope string returned by Strava: ${scopeParam || '(none)'}`);
  const granted = new Set((scopeParam || '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const scope of ['read', 'activity:read', 'activity:read_all']) {
    console.log(`  ${granted.has(scope) ? 'GRANTED' : 'NOT GRANTED'} - ${scope}`);
  }
  if (granted.has('activity:read_all')) {
    console.log('activity:read_all was granted - private historical activities should be visible.');
  } else {
    console.log('activity:read_all was NOT granted - private historical activities will be missing or restricted.');
  }
}

async function fetchActivities(accessToken) {
  const response = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=30', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401) {
    console.log('FAIL fetching activities - HTTP 401 unauthorized. The access token may be malformed or expired; re-run the probe to get a fresh one.');
    process.exit(1);
  }
  if (response.status === 429) {
    console.log('FAIL fetching activities - HTTP 429 rate limited. Wait for the 15-minute or daily Strava rate limit window to reset, then retry.');
    process.exit(1);
  }
  if (!response.ok) {
    console.log(`FAIL fetching activities - HTTP ${response.status}`);
    console.log(await response.text());
    process.exit(1);
  }
  return response.json();
}

async function fetchActivityDetail(accessToken, id) {
  const response = await fetch(`https://www.strava.com/api/v3/activities/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.log(`FAIL fetching activity detail - HTTP ${response.status}`);
    console.log(await response.text());
    process.exit(1);
  }
  return response.json();
}

function chooseActivityToProbe(activities) {
  const hike = activities.find((activity) => activity.sport_type === 'Hike');
  if (hike) {
    console.log(`Chose activity ${hike.id} "${hike.name}" - first activity with sport_type Hike.`);
    return hike;
  }
  const first = activities[0];
  console.log(`Chose activity ${first.id} "${first.name}" - no activity had sport_type Hike, falling back to the first activity.`);
  return first;
}

// key_by_type=true returns an object keyed by stream type rather than an
// array, which is what makes named lookups like streams.time below possible.
async function fetchStreams(accessToken, id) {
  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${id}/streams?keys=latlng,time,altitude&key_by_type=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (response.status === 401) {
    console.log('FAIL fetching streams - HTTP 401 unauthorized. The access token may be malformed or expired; re-run the probe to get a fresh one.');
    return null;
  }
  if (response.status === 429) {
    console.log('FAIL fetching streams - HTTP 429 rate limited. Wait for the 15-minute or daily Strava rate limit window to reset, then retry.');
    return null;
  }
  if (response.status === 404 || response.status === 410) {
    console.log(`FAIL fetching streams - HTTP ${response.status}. The streams endpoint appears unavailable or removed for this activity.`);
    console.log('This is the finding that gates Phase 0: if streams are unavailable, the Strava import path cannot supply timestamped track points.');
    return null;
  }
  if (!response.ok) {
    console.log(`FAIL fetching streams - HTTP ${response.status}`);
    console.log(await response.text());
    return null;
  }
  return response.json();
}

// Math.min(...array) throws on a track-length array: a multi-day activity has
// more points than the argument limit allows.
function extent(numbers) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of numbers) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function analyseStreams(streams, activity) {
  console.log('');
  console.log('Streams endpoint analysis:');
  if (!streams) {
    console.log('FAIL streams endpoint did not return usable data - see error above.');
    return;
  }
  console.log('PASS streams endpoint reachable');

  const keys = ['latlng', 'time', 'altitude'];
  for (const key of keys) {
    const stream = streams[key];
    if (!stream) {
      console.log(`  absent - ${key}`);
      continue;
    }
    console.log(
      `  present - ${key}: data length ${stream.data.length}, original_size ${stream.original_size}, resolution ${stream.resolution}`,
    );
  }

  const presentKeys = keys.filter((key) => streams[key]);
  const lengths = presentKeys.map((key) => streams[key].data.length);
  const allEqual = lengths.every((len) => len === lengths[0]);
  if (presentKeys.length > 1) {
    console.log(
      allEqual
        ? `PASS all present streams have equal data length (${lengths[0]})`
        : `FAIL data length mismatch across streams: ${presentKeys.map((k, i) => `${k}=${lengths[i]}`).join(', ')} - index-wise correlation is NOT valid`,
    );
  }

  const time = streams.time?.data;
  if (time && time.length > 0) {
    const first = time[0];
    const last = time[time.length - 1];
    const elapsed = activity.elapsed_time;
    const diff = Math.abs(last - elapsed);
    console.log('');
    console.log(`  time[0] = ${first} (expected 0)`);
    console.log(`  time[last] = ${last}`);
    console.log(`  activity.elapsed_time = ${elapsed}`);
    console.log(
      diff <= 5
        ? `PASS time[last] matches elapsed_time within ${diff}s - confirms time is seconds elapsed since start, not absolute epoch`
        : `FAIL time[last] differs from elapsed_time by ${diff}s - semantics of the time stream are unclear`,
    );

    const startMs = Date.parse(activity.start_date);
    const firstUtc = new Date(startMs + first * 1000).toISOString();
    const lastUtc = new Date(startMs + last * 1000).toISOString();
    console.log(`  first track point (UTC): ${firstUtc}`);
    console.log(`  last track point (UTC):  ${lastUtc}`);

    const gaps = [];
    for (let i = 1; i < time.length; i++) gaps.push(time[i] - time[i - 1]);
    if (gaps.length > 0) {
      const { min, max } = extent(gaps);
      const med = median(gaps);
      const shortGaps = gaps.filter((g) => g > SHORT_GAP_THRESHOLD_S).length;
      const longGaps = gaps.filter((g) => g > LONG_GAP_THRESHOLD_S).length;
      console.log('');
      console.log(`  sampling interval (seconds) - min ${min}, median ${med}, max ${max}`);
      console.log(`  gaps over ${SHORT_GAP_THRESHOLD_S}s (short-gap confidence band): ${shortGaps}`);
      console.log(`  gaps over ${LONG_GAP_THRESHOLD_S}s (long-gap confidence band): ${longGaps}`);
    }
  }

  const latlng = streams.latlng?.data;
  if (latlng && latlng.length > 0) {
    console.log('');
    console.log(`  first latlng: ${JSON.stringify(latlng[0])}`);
    console.log(`  last latlng:  ${JSON.stringify(latlng[latlng.length - 1])}`);
  }

  const altitude = streams.altitude?.data;
  if (altitude && altitude.length > 0) {
    const altitudeExtent = extent(altitude);
    console.log(`  altitude range: min ${altitudeExtent.min}, max ${altitudeExtent.max}`);
  }
}

function findPhotos(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /\.(jpe?g)$/i.test(name));
}

// Returns the trimmed tag value, '' when the tag is absent, null when the
// file could not be read at all. One tag per call: exiftool prints values in
// its own tag order, not the order requested, so a multi-tag call cannot be
// indexed reliably.
function readTag(filePath, tag) {
  try {
    return execFileSync('exiftool', ['-s', '-s', '-s', tag, filePath], { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// DateTimeOriginal is naive local time with no zone; OffsetTimeOriginal, when
// present, supplies the zone that turns it into an absolute instant. Photos
// without an offset are deliberately excluded rather than guessed at - the
// offset is exactly what this product exists to infer, so a fixture that
// already has one is not interesting to fake.
function photoCaptureInstant(dateTimeOriginal, offsetTimeOriginal) {
  if (!dateTimeOriginal || !offsetTimeOriginal) return null;
  const match = dateTimeOriginal.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const isoLocal = `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetTimeOriginal}`;
  const ms = Date.parse(isoLocal);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function matchPhotosToActivities(activities) {
  console.log('');
  console.log('Photo fixture matching:');
  const photosDir = join(REPO_ROOT, 'fixtures', 'photos');
  const photoNames = findPhotos(photosDir);
  if (photoNames.length === 0) {
    console.log('SKIP photo matching - fixtures/photos/ is missing or empty');
    return;
  }
  try {
    execFileSync('exiftool', ['-ver'], { stdio: 'pipe' });
  } catch {
    console.log('SKIP photo matching - exiftool not found on PATH');
    return;
  }

  const matchable = [];
  let unmatchableWithoutInference = 0;
  for (const name of photoNames) {
    const filePath = join(photosDir, name);
    const dateTimeOriginal = readTag(filePath, '-DateTimeOriginal');
    const offsetTimeOriginal = readTag(filePath, '-OffsetTimeOriginal');
    const instant = photoCaptureInstant(dateTimeOriginal, offsetTimeOriginal);
    if (!instant) {
      unmatchableWithoutInference += 1;
      continue;
    }
    matchable.push({ name, instant });
  }
  console.log(`  ${matchable.length} of ${photoNames.length} photos have an absolute capture instant (OffsetTimeOriginal present)`);
  console.log(`  ${unmatchableWithoutInference} photo(s) skipped - no OffsetTimeOriginal, unmatchable without inferring an offset`);

  const rows = [];
  const unmatchedPhotos = new Set(matchable.map((p) => p.name));
  for (const activity of activities) {
    const startMs = Date.parse(activity.start_date);
    if (Number.isNaN(startMs)) continue;
    const windowStart = startMs - GRACE_PERIOD_MS;
    const windowEnd = startMs + activity.elapsed_time * 1000 + GRACE_PERIOD_MS;
    let count = 0;
    for (const photo of matchable) {
      const t = photo.instant.getTime();
      if (t >= windowStart && t <= windowEnd) {
        count += 1;
        unmatchedPhotos.delete(photo.name);
      }
    }
    if (count > 0) {
      rows.push({ activity, count });
    }
  }

  console.log('');
  if (rows.length === 0) {
    console.log('  no activity matched any photo');
  } else {
    console.log('  activities matching at least one photo:');
    console.log('  id            name                           start_date_local         photos');
    for (const { activity, count } of rows) {
      console.log(
        [
          String(activity.id).padEnd(13),
          String(activity.name ?? '').slice(0, 30).padEnd(31),
          String(activity.start_date_local ?? '').padEnd(25),
          String(count),
        ].join(' '),
      );
    }
  }

  console.log('');
  if (unmatchedPhotos.size === 0) {
    console.log('  every matchable photo fell within an activity window');
  } else {
    console.log('  photos matching no activity:');
    for (const photo of matchable) {
      if (unmatchedPhotos.has(photo.name)) {
        console.log(`    ${photo.name}  ${photo.instant.toISOString()}`);
      }
    }
  }
}

function printActivityTable(activities) {
  console.log('');
  console.log('Activities returned by GET /athlete/activities (summary):');
  console.log('id            name                           sport_type      start_date_local        distance  elev_gain  moving_time  elapsed_time');
  for (const activity of activities) {
    const has = (key) => (activity[key] !== undefined && activity[key] !== null ? 'yes' : 'no');
    console.log(
      [
        String(activity.id).padEnd(13),
        String(activity.name ?? '').slice(0, 30).padEnd(31),
        String(activity.sport_type ?? '').padEnd(15),
        String(activity.start_date_local ?? '').padEnd(24),
        has('distance').padEnd(9),
        has('total_elevation_gain').padEnd(10),
        has('moving_time').padEnd(12),
        has('elapsed_time'),
      ].join(' '),
    );
  }
}

function fieldsOfInterest(activity) {
  return {
    distance: activity.distance,
    total_elevation_gain: activity.total_elevation_gain,
    moving_time: activity.moving_time,
    elapsed_time: activity.elapsed_time,
    start_date: activity.start_date,
    start_date_local: activity.start_date_local,
    timezone: activity.timezone,
    utc_offset: activity.utc_offset,
    sport_type: activity.sport_type,
    type: activity.type,
    start_latlng: JSON.stringify(activity.start_latlng ?? null),
    'map.summary_polyline': activity.map?.summary_polyline
      ? `present, length ${activity.map.summary_polyline.length}`
      : 'absent',
  };
}

function printComparison(summary, detail) {
  console.log('');
  console.log('Field-by-field comparison, summary endpoint vs detail endpoint:');
  const summaryFields = fieldsOfInterest(summary);
  const detailFields = fieldsOfInterest(detail);
  for (const key of Object.keys(summaryFields)) {
    console.log(`  ${key}`);
    console.log(`    summary: ${summaryFields[key]}`);
    console.log(`    detail:  ${detailFields[key]}`);
  }
}

function printConclusion(summary, detail, streams) {
  console.log('');
  console.log('Conclusion:');
  const summaryHasBoth = summary.total_elevation_gain !== undefined && summary.moving_time !== undefined;
  console.log(
    summaryHasBoth
      ? '  total_elevation_gain and moving_time are BOTH present on the summary list endpoint.'
      : '  total_elevation_gain and/or moving_time are MISSING from the summary list endpoint.',
  );
  console.log(
    detail.total_elevation_gain !== undefined && detail.moving_time !== undefined
      ? '  Both fields are present on the detail endpoint.'
      : '  One or both fields are missing even from the detail endpoint.',
  );
  console.log(
    summaryHasBoth
      ? '  The summary list endpoint alone is sufficient for these two fields; the extra detail call is not required for them.'
      : '  The detail endpoint is required to get these fields reliably; the summary list endpoint alone is not sufficient.',
  );

  console.log('');
  const streamsFull = streams && streams.latlng && streams.time && streams.altitude
    && streams.latlng.data.length === streams.time.data.length
    && streams.time.data.length === streams.altitude.data.length;
  if (streamsFull) {
    console.log('  The streams endpoint returned latlng, time and altitude at full, matching resolution.');
    console.log('  Importing a Strava activity into the same internal representation as an uploaded GPX file is VIABLE.');
  } else {
    console.log('  The streams endpoint did NOT return latlng, time and altitude at full, matching resolution.');
    console.log('  Importing a Strava activity into the same internal representation as an uploaded GPX file is NOT confirmed viable.');
    console.log('  Documented fallback: drop the Strava import path and use direct FIT-file upload instead.');
  }
}

// Rewrites the whole file rather than appending, so a prior run's token gets
// replaced instead of duplicated.
function saveRefreshToken(refreshToken) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const withoutExisting = lines.filter((line) => !line.trim().startsWith('STRAVA_DEV_REFRESH_TOKEN='));
  while (withoutExisting.length > 0 && withoutExisting[withoutExisting.length - 1] === '') {
    withoutExisting.pop();
  }
  withoutExisting.push(`STRAVA_DEV_REFRESH_TOKEN=${refreshToken}`);
  writeFileSync(ENV_PATH, withoutExisting.join('\n') + '\n');
}

async function main() {
  const env = loadEnv();
  requireEnvKeys(env, ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET']);
  const clientId = env.STRAVA_CLIENT_ID;
  const clientSecret = env.STRAVA_CLIENT_SECRET;
  const redirectUri = env.STRAVA_REDIRECT_URI || 'http://localhost:3000/api/strava/callback';

  const state = randomBytes(16).toString('hex');
  const authorizationUrl = buildAuthorizationUrl(clientId, redirectUri, state);

  console.log('Open this URL in a browser and authorize the app:');
  console.log(authorizationUrl);
  console.log('');
  console.log(`Waiting up to 3 minutes for the callback at ${redirectUri} ...`);

  let callback;
  try {
    callback = await waitForCallback(redirectUri, state);
  } catch (err) {
    console.log(`FAIL ${err.message}`);
    process.exit(1);
  }

  console.log('PASS callback received with matching state');

  const tokens = await exchangeCodeForTokens(clientId, clientSecret, callback.code);
  console.log('PASS token exchange succeeded (access token and refresh token received, not printed)');

  reportGrantedScopes(callback.scope);

  const expiryUtc = new Date(tokens.expires_at * 1000).toISOString();
  console.log('');
  console.log(`Athlete id: ${tokens.athlete?.id ?? '(not returned)'}`);
  console.log(`Access token expires at: ${expiryUtc}`);

  console.log('');
  console.log('Refresh token was received. Not printed.');
  if (SAVE_REFRESH_TOKEN) {
    saveRefreshToken(tokens.refresh_token);
    console.log('PASS refresh token saved to .env as STRAVA_DEV_REFRESH_TOKEN (value not printed)');
  } else {
    console.log('Not saved - re-run without --no-save-refresh-token to store it in .env as STRAVA_DEV_REFRESH_TOKEN.');
  }

  const activities = await fetchActivities(tokens.access_token);
  if (activities.length === 0) {
    console.log('');
    console.log('No activities returned. This likely means the account has no activities yet, or the granted scope was insufficient to see any.');
    process.exit(0);
  }

  printActivityTable(activities);

  const chosen = chooseActivityToProbe(activities);
  const detail = await fetchActivityDetail(tokens.access_token, chosen.id);
  printComparison(chosen, detail);

  const streams = await fetchStreams(tokens.access_token, chosen.id);
  analyseStreams(streams, detail);

  matchPhotosToActivities(activities);

  printConclusion(chosen, detail, streams);
}

main().catch((err) => {
  console.log(`FAIL unexpected error - ${err.message}`);
  process.exit(1);
});
