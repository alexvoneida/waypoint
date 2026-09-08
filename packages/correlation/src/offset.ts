/**
 * Recovering the camera's UTC offset by search.
 *
 * Cameras write a wall-clock reading with no timezone attached. The offset
 * that turns that reading into a real instant is not knowable from the
 * photo alone, so the engine tries every plausible offset against the GPS
 * track and keeps whichever one explains the most photographs.
 */

import type { OffsetInference, OffsetSeconds, Photo, Track } from './types.ts';

const MIN_OFFSET_SECONDS = -12 * 3600;
const MAX_OFFSET_SECONDS = 14 * 3600;
const OFFSET_STEP_SECONDS = 15 * 60;

const DEFAULT_GRACE_SECONDS = 900;

/** Every real-world UTC offset from -12:00 to +14:00 in 15-minute steps. */
export const CANDIDATE_OFFSETS: number[] = (() => {
  const offsets: number[] = [];
  for (let s = MIN_OFFSET_SECONDS; s <= MAX_OFFSET_SECONDS; s += OFFSET_STEP_SECONDS) {
    offsets.push(s);
  }
  return offsets;
})();

export type InferOffsetOptions = {
  graceSeconds?: number;
};

/** Parses an EXIF-style naive timestamp as if its digits were UTC. */
export function naiveToUtcSeconds(naive: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(naive);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return ms / 1000;
}

type ScorablePhoto = {
  photo: Photo;
  naiveUtcSeconds: number;
};

function scorablePhotos(photos: Photo[]): ScorablePhoto[] {
  const result: ScorablePhoto[] = [];
  for (const photo of photos) {
    if (photo.capturedNaive === null) continue;
    if (photo.exifPosition) continue;
    const naiveUtcSeconds = naiveToUtcSeconds(photo.capturedNaive);
    if (naiveUtcSeconds === null) continue;
    result.push({ photo, naiveUtcSeconds });
  }
  return result;
}

function instantFor(entry: ScorablePhoto, candidateOffset: OffsetSeconds): number {
  const cameraOffset = entry.photo.cameraOffsetSeconds ?? 0;
  return entry.naiveUtcSeconds - (candidateOffset + cameraOffset);
}

/**
 * Resolves a single photo's capture instant given a resolved zone offset,
 * applying its camera clock correction in addition. Null when the photo has
 * no parseable naive timestamp.
 */
export function resolvePhotoInstant(photo: Photo, offsetSeconds: OffsetSeconds): number | null {
  if (photo.capturedNaive === null) return null;
  const naiveUtcSeconds = naiveToUtcSeconds(photo.capturedNaive);
  if (naiveUtcSeconds === null) return null;
  const cameraOffset = photo.cameraOffsetSeconds ?? 0;
  return naiveUtcSeconds - (offsetSeconds + cameraOffset);
}

type CandidateScore = {
  offsetSeconds: OffsetSeconds;
  placedCount: number;
  spread: number;
};

function scoreCandidate(
  candidateOffset: OffsetSeconds,
  entries: ScorablePhoto[],
  windowStart: number,
  windowEnd: number,
  grace: number,
): CandidateScore {
  const placedInstants: number[] = [];
  for (const entry of entries) {
    const instant = instantFor(entry, candidateOffset);
    if (instant >= windowStart - grace && instant <= windowEnd + grace) {
      placedInstants.push(instant);
    }
  }

  let spread = 0;
  if (placedInstants.length >= 2) {
    const span = Math.max(...placedInstants) - Math.min(...placedInstants);
    const windowSpan = windowEnd - windowStart;
    spread = windowSpan > 0 ? span / windowSpan : 0;
  }

  return { offsetSeconds: candidateOffset, placedCount: placedInstants.length, spread };
}

/**
 * Every candidate that ties for best, rather than one winner. Ordering by
 * "closest to zero" — the obvious way to break a tie deterministically — is a
 * bias toward Greenwich that silently returns a wrong answer for a hike in
 * Colorado, so no tiebreak is applied here at all.
 */
/**
 * The offset the photographs themselves claim, when they claim one at all and
 * agree about it. Photographs from two bodies set to different zones disagree,
 * and a disagreement is no evidence, so it collapses to null rather than to a
 * majority vote.
 */
function resolveExifAgreement(entries: ScorablePhoto[]): { exifOffsetSeconds: OffsetSeconds | null } {
  let claimed: OffsetSeconds | null = null;
  for (const entry of entries) {
    const offset = entry.photo.exifOffsetSeconds;
    if (offset === undefined || offset === null) continue;
    if (claimed === null) {
      claimed = offset;
    } else if (claimed !== offset) {
      return { exifOffsetSeconds: null };
    }
  }
  return { exifOffsetSeconds: claimed };
}

export function inferOffset(
  photos: Photo[],
  track: Track,
  options: InferOffsetOptions = {},
): OffsetInference {
  const grace = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const entries = scorablePhotos(photos);
  const { exifOffsetSeconds } = resolveExifAgreement(entries);

  const scores = CANDIDATE_OFFSETS.map((offset) =>
    scoreCandidate(offset, entries, track.startedAt, track.endedAt, grace),
  );
  const admissible = admissibleCandidates(scores);

  return buildInference(admissible, entries.length, exifOffsetSeconds, track.startedAt);
}

function admissibleCandidates(scores: CandidateScore[]): CandidateScore[] {
  let bestPlaced = 0;
  let bestSpread = 0;
  for (const score of scores) {
    if (score.placedCount > bestPlaced) {
      bestPlaced = score.placedCount;
      bestSpread = score.spread;
    } else if (score.placedCount === bestPlaced && score.spread > bestSpread) {
      bestSpread = score.spread;
    }
  }
  if (bestPlaced === 0) return [];
  return scores
    .filter((score) => score.placedCount === bestPlaced && score.spread === bestSpread)
    .sort((a, b) => a.offsetSeconds - b.offsetSeconds);
}

/**
 * Picks within the admissible set. The photographs' own EXIF offset selects
 * only when the search already admits it, so a camera whose zone was never
 * changed after travelling cannot drag the result somewhere the track rules
 * out. With no usable prior the midpoint is taken and the result is flagged
 * ambiguous: it is the choice that minimises worst-case error across the set,
 * and the flag is what stops it being mistaken for a determination.
 */
function selectOffset(
  admissible: CandidateScore[],
  exifOffsetSeconds: OffsetSeconds | null,
): { chosen: CandidateScore; selectedBy: 'search' | 'exif-prior' } {
  if (admissible.length === 1) {
    return { chosen: admissible[0] as CandidateScore, selectedBy: 'search' };
  }
  if (exifOffsetSeconds !== null) {
    const match = admissible.find((score) => score.offsetSeconds === exifOffsetSeconds);
    if (match) return { chosen: match, selectedBy: 'exif-prior' };
  }
  const midpoint = admissible[Math.floor(admissible.length / 2)] as CandidateScore;
  return { chosen: midpoint, selectedBy: 'search' };
}

function buildInference(
  admissible: CandidateScore[],
  totalCount: number,
  exifOffsetSeconds: OffsetSeconds | null,
  atInstant: number,
): OffsetInference {
  if (admissible.length === 0) {
    return {
      offsetSeconds: null,
      zoneNames: [],
      placedCount: 0,
      totalCount,
      spread: 0,
      exifOffsetSeconds,
      agreesWithExif: null,
      admissibleOffsets: [],
      ambiguous: false,
      selectedBy: 'search',
    };
  }

  const { chosen, selectedBy } = selectOffset(admissible, exifOffsetSeconds);
  const admissibleOffsets = admissible.map((score) => score.offsetSeconds);

  // The tag agrees when the search admits it, not only when the search would
  // have landed on it unaided: inside the admissible set the two are consistent.
  const agreesWithExif =
    exifOffsetSeconds === null ? null : admissibleOffsets.includes(exifOffsetSeconds);

  return {
    offsetSeconds: chosen.offsetSeconds,
    zoneNames: zoneNamesForOffset(chosen.offsetSeconds, atInstant),
    placedCount: chosen.placedCount,
    totalCount,
    spread: chosen.spread,
    exifOffsetSeconds,
    agreesWithExif,
    admissibleOffsets,
    ambiguous: admissibleOffsets.length > 1,
    selectedBy,
  };
}


/**
 * Reports on a caller-chosen offset (e.g. `forceOffsetSeconds`) using the
 * same scoring as the search, without running the search itself. Unlike a
 * searched result, `offsetSeconds` is always the given value - it was
 * specified, not inferred, so it is reported even when it happens to place
 * nothing.
 */
function buildForcedInference(
  offsetSeconds: OffsetSeconds,
  score: CandidateScore,
  totalCount: number,
  exifOffsetSeconds: OffsetSeconds | null,
  atInstant: number,
): OffsetInference {
  const agreesWithExif = exifOffsetSeconds === null ? null : exifOffsetSeconds === offsetSeconds;
  return {
    offsetSeconds,
    zoneNames: zoneNamesForOffset(offsetSeconds, atInstant),
    placedCount: score.placedCount,
    totalCount,
    spread: score.spread,
    exifOffsetSeconds,
    agreesWithExif,
    admissibleOffsets: [offsetSeconds],
    ambiguous: false,
    selectedBy: 'forced',
  };
}

export function evaluateOffset(offsetSeconds: OffsetSeconds, photos: Photo[], track: Track, graceSeconds?: number): OffsetInference {
  const grace = graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const entries = scorablePhotos(photos);
  const { exifOffsetSeconds } = resolveExifAgreement(entries);
  const score = scoreCandidate(offsetSeconds, entries, track.startedAt, track.endedAt, grace);
  return buildForcedInference(offsetSeconds, score, entries.length, exifOffsetSeconds, track.startedAt);
}

const CANDIDATE_ZONES = [
  'America/Denver',
  'America/Los_Angeles',
  'America/New_York',
  'America/Chicago',
  'Europe/London',
  'Europe/Paris',
  'Asia/Kathmandu',
  'Pacific/Chatham',
  'UTC',
];

function longOffsetToSeconds(formatted: string): number | null {
  const match = /^(?:GMT|UTC)([+-])(\d{2}):(\d{2})$/.exec(formatted);
  if (match === null) {
    return formatted === 'GMT' || formatted === 'UTC' ? 0 : null;
  }
  const [, sign, hours, minutes] = match;
  const magnitude = Number(hours) * 3600 + Number(minutes) * 60;
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * IANA zone names matching this offset on this date, for display only.
 * Several zones share an offset (and one zone's offset shifts with DST), so
 * this is never authoritative - it is looked up against a small hardcoded
 * table rather than treated as the source of truth for the offset itself.
 */
export function zoneNamesForOffset(offsetSeconds: OffsetSeconds, atInstant: number): string[] {
  const date = new Date(atInstant * 1000);
  const matches: string[] = [];
  for (const zone of CANDIDATE_ZONES) {
    let formatted: string;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        timeZoneName: 'longOffset',
      }).formatToParts(date);
      const offsetPart = parts.find((part) => part.type === 'timeZoneName');
      if (offsetPart === undefined) continue;
      formatted = offsetPart.value;
    } catch {
      continue;
    }
    const zoneOffsetSeconds = longOffsetToSeconds(formatted);
    if (zoneOffsetSeconds === offsetSeconds) {
      matches.push(zone);
    }
  }
  return matches;
}
