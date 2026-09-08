/**
 * GPX parsing for the correlation engine.
 *
 * This is a focused scanner for `<trkpt>` elements, not a general XML parser.
 * A real XML parser is out of reach under this package's zero-dependency
 * budget (it must run unchanged inside React Native later), and GPX track
 * points are a rigidly-shaped subset of XML: a flat run of `<trkpt lat=".."
 * lon="..">` elements with only `<ele>` and `<time>` children. Scanning for
 * that shape directly is simpler and safer than a general parser would be.
 */

import { GpxParseError, type Track, type TrackPoint } from './types.ts';

const TRKPT_OPEN = /<(?:\w+:)?trkpt\b([^>]*?)(\/?)>/g;
const ATTR = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Track points are scanned in document order, so line numbers are counted
 * incrementally from wherever the last one left off. Rescanning from the start
 * of the file for each point is quadratic, which on a 15,000-point track costs
 * seconds rather than milliseconds.
 */
function createLineCounter(xml: string) {
  let countedTo = 0;
  let line = 1;
  return (offset: number): number => {
    if (offset < countedTo) throw new Error('line counter moved backwards');
    for (let i = countedTo; i < offset; i++) {
      if (xml.charCodeAt(i) === 10) line++;
    }
    countedTo = offset;
    return line;
  };
}

function parseAttrs(attrText: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(attrText)) !== null) {
    // Group 1 (the attribute name) always matches when the regex matches at
    // all; only one of groups 2/3 (double- vs single-quoted value) does.
    const name = match[1] as string;
    attrs.set(name, match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function parseCoordinate(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function findChildText(body: string, tagName: string): string | null {
  const pattern = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([^<]*)</(?:\\w+:)?${tagName}>`);
  const match = pattern.exec(body);
  return match ? (match[1] as string).trim() : null;
}

// ISO 8601 UTC, e.g. "2026-08-22T12:50:29Z" or with fractional seconds or a
// numeric offset ("+00:00"). Date.parse already handles both forms; we only
// need to round to the nearest whole second, consistently.
function parseTimeSeconds(raw: string): number | null {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 1000);
}

type LinedPoint = TrackPoint & { line: number };

export function parseGpx(xml: string): Track {
  const points: LinedPoint[] = [];
  let sawMissingElevation = false;
  const lineAt = createLineCounter(xml);

  TRKPT_OPEN.lastIndex = 0;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = TRKPT_OPEN.exec(xml)) !== null) {
    const fullOpenTag = openMatch[0];
    const attrText = openMatch[1] as string;
    const selfClosingSlash = openMatch[2];
    const startOffset = openMatch.index;
    const line = lineAt(startOffset);

    let body = '';
    if (!selfClosingSlash) {
      const closeTagPattern = /<\/(?:\w+:)?trkpt\s*>/g;
      closeTagPattern.lastIndex = startOffset + fullOpenTag.length;
      const closeMatch = closeTagPattern.exec(xml);
      if (closeMatch) {
        body = xml.slice(startOffset + fullOpenTag.length, closeMatch.index);
      }
    }

    const attrs = parseAttrs(attrText);
    const lat = parseCoordinate(attrs.get('lat'), -90, 90);
    const lon = parseCoordinate(attrs.get('lon'), -180, 180);
    if (lat === null || lon === null) {
      throw new GpxParseError('track point has a missing or invalid lat/lon', line);
    }

    const timeText = findChildText(body, 'time');
    if (timeText === null) {
      throw new GpxParseError('track point has no <time> child', line);
    }
    const time = parseTimeSeconds(timeText);
    if (time === null) {
      throw new GpxParseError(`track point has an unparseable <time> value: ${timeText}`, line);
    }

    const eleText = findChildText(body, 'ele');
    let ele: number | null = null;
    if (eleText === null) {
      sawMissingElevation = true;
    } else {
      const parsedEle = Number(eleText);
      ele = Number.isFinite(parsedEle) ? parsedEle : null;
      if (ele === null) sawMissingElevation = true;
    }

    points.push({ lat, lon, ele, time, line });
  }

  if (points.length === 0) {
    throw new GpxParseError('no <trkpt> elements found', 1);
  }

  const warnings: string[] = [];
  if (sawMissingElevation) {
    warnings.push('one or more track points have no elevation');
  }

  const isMonotonic = points.every((point, i) => {
    if (i === 0) return true;
    const previous = points[i - 1] as LinedPoint;
    return point.time >= previous.time;
  });
  let ordered = points;
  if (!isMonotonic) {
    const indexed = points.map((point, i) => ({ point, i }));
    indexed.sort((a, b) => a.point.time - b.point.time || a.i - b.i);
    ordered = indexed.map((entry) => entry.point);
    const outOfOrderCount = points.filter((point, i) => point.time !== (ordered[i] as LinedPoint).time).length;
    warnings.push(`${outOfOrderCount} track point(s) were out of chronological order and have been sorted`);
  }

  const deduped: LinedPoint[] = [];
  let duplicateCount = 0;
  for (const point of ordered) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.time === point.time) {
      duplicateCount++;
      continue;
    }
    deduped.push(point);
  }
  if (duplicateCount > 0) {
    warnings.push(`${duplicateCount} track point(s) had duplicate timestamps and were dropped`);
  }

  if (deduped.length < 2) {
    const line = deduped.length === 1 ? (deduped[0] as LinedPoint).line : (ordered[0] as LinedPoint).line;
    throw new GpxParseError(
      'track has fewer than 2 distinct track points after normalisation; cannot interpolate along a single point',
      line,
    );
  }

  const finalPoints: TrackPoint[] = deduped.map(({ lat, lon, ele, time }) => ({ lat, lon, ele, time }));
  const first = finalPoints[0] as TrackPoint;
  const last = finalPoints[finalPoints.length - 1] as TrackPoint;

  return {
    points: finalPoints,
    startedAt: first.time,
    endedAt: last.time,
    warnings,
  };
}
