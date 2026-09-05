#!/usr/bin/env node
// Phase 0 environment gate. Zero dependencies by design — this needs to run
// before `npm install` has necessarily succeeded.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let requiredFailures = 0;

function pass(label, detail = '') {
  console.log(`PASS ${label}${detail ? ' - ' + detail : ''}`);
}

function fail(label, detail = '') {
  console.log(`FAIL ${label}${detail ? ' - ' + detail : ''}`);
  requiredFailures += 1;
}

function skip(label, detail = '') {
  console.log(`SKIP ${label}${detail ? ' - ' + detail : ''}`);
}

function loadEnv() {
  const envPath = join(REPO_ROOT, '.env');
  const defaults = { POSTGRES_USER: 'waypoint', POSTGRES_PASSWORD: 'waypoint', POSTGRES_DB: 'waypoint' };
  if (!existsSync(envPath)) return defaults;

  const parsed = { ...defaults };
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
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

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) {
    pass('node version', `v${process.versions.node}`);
  } else {
    fail('node version', `v${process.versions.node} - need >= 20`);
  }
}

function checkDockerAndDb(env) {
  try {
    execFileSync('docker', ['--version'], { stdio: 'pipe' });
  } catch {
    fail('docker binary', 'docker not found on PATH');
    return;
  }
  pass('docker binary');

  const user = env.POSTGRES_USER;
  const db = env.POSTGRES_DB;

  try {
    const output = execFileSync(
      'docker',
      ['exec', 'waypoint-db', 'psql', '-U', user, '-d', db, '-tAc', 'select postgis_full_version()'],
      { stdio: 'pipe' },
    ).toString().trim();
    pass('waypoint-db reachable', output);
  } catch {
    fail('waypoint-db reachable', 'container not running - start it with: docker compose up -d db');
    return;
  }

  try {
    const output = execFileSync(
      'docker',
      ['exec', 'waypoint-db', 'psql', '-U', user, '-d', db, '-tAc', 'select gen_random_uuid()'],
      { stdio: 'pipe' },
    ).toString().trim();
    pass('pgcrypto (gen_random_uuid)', output);
  } catch {
    fail('pgcrypto (gen_random_uuid)', 'select gen_random_uuid() failed');
  }
}

function checkExiftool() {
  try {
    const output = execFileSync('exiftool', ['-ver'], { stdio: 'pipe' }).toString().trim();
    pass('exiftool present', `v${output}`);
    return true;
  } catch {
    fail('exiftool present', 'not found - install with: brew install exiftool');
    return false;
  }
}

function findPhotos(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /\.(jpe?g)$/i.test(name));
}

function checkExifFixtures(exiftoolAvailable) {
  const photosDir = join(REPO_ROOT, 'fixtures', 'photos');
  const photos = findPhotos(photosDir);

  if (photos.length === 0) {
    skip('EXIF fixtures', 'fixtures/photos/ is empty - export a JPG through your real Lightroom preset into fixtures/photos/');
    return;
  }
  if (!exiftoolAvailable) {
    skip('EXIF fixtures', 'exiftool unavailable, cannot inspect fixtures/photos/');
    return;
  }

  let withTimestamp = 0;
  let withOffset = 0;
  const unreadable = [];
  for (const name of photos) {
    const filePath = join(photosDir, name);
    // One tag per call: exiftool prints values in its own tag order, not the
    // order they were requested, so a single multi-tag call cannot be indexed.
    const dateTimeOriginal = readTag(filePath, '-DateTimeOriginal');
    if (dateTimeOriginal === null) {
      unreadable.push(name);
      continue;
    }
    if (dateTimeOriginal) withTimestamp += 1;
    if (readTag(filePath, '-OffsetTimeOriginal')) withOffset += 1;
  }
  if (unreadable.length > 0) {
    console.log(`     exiftool could not read: ${unreadable.join(', ')}`);
  }
  const label = `${withTimestamp} of ${photos.length} photos carry DateTimeOriginal`;
  if (withTimestamp === photos.length) {
    pass('EXIF fixtures', label);
  } else {
    skip('EXIF fixtures', label);
  }
  // OffsetTimeOriginal states the UTC offset the correlation engine infers by
  // search, so a photo carrying it is a free labelled case for offset inference.
  console.log(`     ${withOffset} of ${photos.length} also carry OffsetTimeOriginal`);
}

// Returns the trimmed tag value, '' when the tag is absent, null when the file
// could not be read at all.
function readTag(filePath, tag) {
  try {
    return execFileSync('exiftool', ['-s', '-s', '-s', tag, filePath], { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function checkGpxFixtures() {
  const gpxDir = join(REPO_ROOT, 'fixtures', 'gpx');
  if (!existsSync(gpxDir)) {
    skip('GPX fixtures', 'fixtures/gpx/ does not exist');
    return;
  }
  const files = readdirSync(gpxDir).filter((name) => name.toLowerCase().endsWith('.gpx'));
  if (files.length === 0) {
    skip('GPX fixtures', 'fixtures/gpx/ is empty');
    return;
  }

  const scenarios = ['hike', 'gap', 'paused', 'multiday'];
  const present = scenarios.filter((keyword) =>
    files.some((name) => name.toLowerCase().includes(keyword)),
  );
  const missing = scenarios.filter((keyword) => !present.includes(keyword));

  const detail = `${files.length} file(s) found, scenarios present: ${present.join(', ') || 'none'}`;
  if (missing.length === 0) {
    pass('GPX fixtures', detail);
    return;
  }
  skip('GPX fixtures', detail);
  console.log(`     TODO: missing scenarios - ${missing.join(', ')}`);
}

// Reports presence only. Values are never printed: this output gets pasted into
// issues and shared terminals.
function checkStravaCredentials(env) {
  const required = ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REDIRECT_URI'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length === required.length) {
    skip('Strava credentials', 'not configured yet - needed from Phase 5');
    return;
  }
  if (missing.length > 0) {
    skip('Strava credentials', `set: ${required.filter((k) => env[k]).join(', ')} - missing: ${missing.join(', ')}`);
    return;
  }
  pass('Strava credentials', 'client id, secret and redirect URI all set');

  for (const key of ['STRAVA_ACCESS_TOKEN', 'STRAVA_REFRESH_TOKEN']) {
    if (env[key]) {
      console.log(`     WARNING: ${key} is set. Per-athlete tokens belong in the database, encrypted.`);
      console.log('     A development-only refresh token should be named STRAVA_DEV_REFRESH_TOKEN.');
    }
  }
}

function main() {
  const env = loadEnv();
  checkNodeVersion();
  checkDockerAndDb(env);
  const exiftoolAvailable = checkExiftool();
  checkExifFixtures(exiftoolAvailable);
  checkGpxFixtures();
  checkStravaCredentials(env);

  console.log('');
  if (requiredFailures > 0) {
    console.log(`${requiredFailures} required check(s) failed.`);
    process.exit(1);
  }
  console.log('All required checks passed.');
}

main();
