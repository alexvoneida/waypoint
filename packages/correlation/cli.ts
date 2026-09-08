#!/usr/bin/env node
/**
 * Places a folder of photographs on a GPX track and prints a GeoJSON
 * FeatureCollection.
 *
 *   node cli.ts <track.gpx> <photo-directory> [--grace 900] [--offset -21600]
 *
 * EXIF extraction lives here rather than in the library on purpose. The
 * library takes timestamps and returns positions, with no opinion about where
 * the timestamps came from, which is what keeps it testable without fixtures
 * on disk and portable to a native client. This layer shells out to exiftool,
 * already a required development tool.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseGpx } from './src/gpx.ts';
import { correlate } from './src/correlate.ts';
import type { Photo, CorrelationResult, Track } from './src/types.ts';

const EXIF_TAGS = ['-DateTimeOriginal', '-OffsetTimeOriginal', '-GPSLatitude#', '-GPSLongitude#'];

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArguments(argv: string[]) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const [trackPath, photoDirectory] = positional;
  if (!trackPath || !photoDirectory) {
    fail('usage: cli.ts <track.gpx> <photo-directory> [--grace <seconds>] [--offset <seconds>]');
  }

  const flagValue = (name: string): number | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const raw = argv[index + 1];
    const value = Number(raw);
    if (raw === undefined || Number.isNaN(value)) fail(`--${name} needs a number`);
    return value;
  };

  return {
    trackPath,
    photoDirectory,
    graceSeconds: flagValue('grace'),
    forceOffsetSeconds: flagValue('offset'),
  };
}

/** exiftool's `-OffsetTimeOriginal` reads like `-06:00`. */
function parseExifOffset(raw: string): number | null {
  const match = raw.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, sign, hours, minutes] = match;
  const magnitude = Number(hours) * 3600 + Number(minutes) * 60;
  return sign === '-' ? -magnitude : magnitude;
}

/** exiftool prints `2026:08:22 09:30:36`; the engine wants an ISO-shaped naive value. */
function parseNaiveTimestamp(raw: string): string | null {
  const match = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (!match) return null;
  const [, year, month, day, clock] = match;
  return `${year}-${month}-${day}T${clock}`;
}

function readPhotos(directory: string): Photo[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    fail(`not a directory: ${directory}`);
  }
  const names = readdirSync(directory)
    .filter((name) => /\.(jpe?g)$/i.test(name))
    .sort();
  if (names.length === 0) fail(`no JPGs in ${directory}`);

  return names.map((name) => {
    const path = join(directory, name);
    let output: string;
    try {
      output = execFileSync('exiftool', ['-s', '-s', '-s', ...EXIF_TAGS, path], {
        stdio: 'pipe',
      }).toString();
    } catch {
      fail(`exiftool could not read ${name} (is exiftool installed?)`);
    }
    // One tag per line, in the order requested, with absent tags printed as
    // a blank line only when -f is passed; without it lines are omitted, so
    // each value is matched by shape rather than by position.
    const lines = output.split('\n').map((line) => line.trim());
    const naive = lines.map(parseNaiveTimestamp).find((value) => value !== null) ?? null;
    const offset = lines.map(parseExifOffset).find((value) => value != null) ?? null;
    const coordinates = lines.filter((line) => /^-?\d+\.\d+$/.test(line)).map(Number);

    const photo: Photo = { id: name, capturedNaive: naive, exifOffsetSeconds: offset };
    if (coordinates.length >= 2) {
      photo.exifPosition = { lat: coordinates[0]!, lon: coordinates[1]! };
    }
    return photo;
  });
}

function toGeoJson(track: Track, result: CorrelationResult) {
  const placedFeatures = result.placed.map((placed) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [placed.lon, placed.lat] },
    properties: {
      photoId: placed.photoId,
      capturedAt: new Date(placed.capturedAt * 1000).toISOString(),
      method: placed.method,
      confidence: placed.confidence,
      gapSeconds: placed.gapSeconds,
      elevationM: placed.elevationM,
      distanceAlongM: Math.round(placed.distanceAlongM),
      appliedOffsetSeconds: placed.appliedOffsetSeconds,
    },
  }));

  const trackFeature = {
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: track.points.map((point) => [point.lon, point.lat]),
    },
    properties: { role: 'track', pointCount: track.points.length },
  };

  return {
    type: 'FeatureCollection' as const,
    features: [trackFeature, ...placedFeatures],
    properties: {
      offset: result.offset,
      unplaced: result.unplaced,
      trackWarnings: track.warnings,
    },
  };
}

function reportToStderr(result: CorrelationResult, photoCount: number) {
  const { offset } = result;
  if (offset.offsetSeconds === null) {
    console.error('no offset placed a single photograph - is this the right track?');
  } else {
    const hours = offset.offsetSeconds / 3600;
    const label = `UTC${hours >= 0 ? '+' : ''}${hours}`;
    const zones = offset.zoneNames.length > 0 ? ` (${offset.zoneNames.join(', ')})` : '';
    console.error(
      `detected ${label}${zones} - ${offset.placedCount} of ${offset.totalCount} photographs on track`,
    );
    if (offset.ambiguous) {
      const range = offset.admissibleOffsets;
      const low = (range[0] as number) / 3600;
      const high = (range[range.length - 1] as number) / 3600;
      console.error(
        `  ambiguous: ${range.length} offsets place the same photographs (UTC${low} to UTC${high})`,
      );
      console.error(
        offset.selectedBy === 'exif-prior'
          ? '  resolved by the photographs\' own EXIF offset, which the search admits'
          : '  no usable EXIF offset; took the midpoint - confirm this one by hand',
      );
    }
    if (offset.agreesWithExif === false) {
      console.error(
        `  note: EXIF claimed UTC${(offset.exifOffsetSeconds as number) / 3600}, which the track rules out; the search wins`,
      );
    }
  }
  const byConfidence = { high: 0, medium: 0, low: 0 };
  for (const placed of result.placed) byConfidence[placed.confidence] += 1;
  console.error(
    `placed ${result.placed.length} of ${photoCount} - ` +
      `high ${byConfidence.high}, medium ${byConfidence.medium}, low ${byConfidence.low}`,
  );
  for (const unplaced of result.unplaced) {
    console.error(`unplaced: ${unplaced.photoId} (${unplaced.reason})`);
  }
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const track = parseGpx(readFileSync(args.trackPath, 'utf8'));
  const photos = readPhotos(args.photoDirectory);

  const result = correlate(track, photos, {
    ...(args.graceSeconds !== undefined ? { graceSeconds: args.graceSeconds } : {}),
    ...(args.forceOffsetSeconds !== undefined
      ? { forceOffsetSeconds: args.forceOffsetSeconds }
      : {}),
  });

  reportToStderr(result, photos.length);
  console.log(JSON.stringify(toGeoJson(track, result), null, 2));
}

main();
