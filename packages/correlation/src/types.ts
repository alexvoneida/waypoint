/**
 * The correlation engine's vocabulary.
 *
 * Every time in this package is epoch seconds UTC, with one deliberate
 * exception: `Photo.capturedNaive`, which is what a camera actually writes —
 * a wall-clock reading with no zone attached. Resolving that into an instant
 * is the problem the engine exists to solve, so the type keeps the two kinds
 * of time distinguishable rather than letting a naive value be mistaken for
 * an absolute one.
 */

export type TrackPoint = {
  lat: number;
  lon: number;
  /** Metres. Null where the source recorded no elevation. */
  ele: number | null;
  /** Epoch seconds, UTC. */
  time: number;
};

export type Track = {
  /** Sorted ascending by time, guaranteed by the parser. */
  points: TrackPoint[];
  startedAt: number;
  endedAt: number;
  /** Recoverable oddities: re-sorted points, dropped duplicates, missing elevation. */
  warnings: string[];
};

/**
 * A UTC offset in seconds, in the sign convention used by EXIF and by
 * Strava's `utc_offset`: UTC-6 is -21600. An instant is recovered as
 * `naiveSecondsReadAsUtc - offsetSeconds`.
 */
export type OffsetSeconds = number;

export type Photo = {
  id: string;
  /**
   * EXIF DateTimeOriginal, verbatim: `YYYY-MM-DDTHH:MM:SS` with no zone and
   * no trailing Z. Null when the camera wrote none, which makes the photo
   * uncorrelatable rather than merely unplaced.
   */
  capturedNaive: string | null;
  /**
   * From EXIF OffsetTimeOriginal when the body writes it. A cross-check on
   * the inferred offset, never a substitute for it: the tag reports a camera
   * setting, which may never have been changed after travelling.
   */
  exifOffsetSeconds?: OffsetSeconds | null;
  /**
   * Phone photographs carry their own coordinates and skip correlation
   * entirely (P-8).
   */
  exifPosition?: { lat: number; lon: number; ele?: number | null } | null;
  /**
   * A calibrated per-body clock correction in seconds (P-5), applied before
   * the offset search. Stored apart from the zone offset so recalibrating a
   * camera does not invalidate past correlations.
   */
  cameraOffsetSeconds?: OffsetSeconds;
};

export type Confidence = 'high' | 'medium' | 'low';

export type LocateMethod = 'interpolated' | 'clamped' | 'manual' | 'exif';

export type PlacedPhoto = {
  photoId: string;
  lat: number;
  lon: number;
  /** Metres, interpolated from the bracketing points. Null if the track has none. */
  elevationM: number | null;
  method: LocateMethod;
  confidence: Confidence;
  /** Seconds between the bracketing track points. Kept raw so the confidence
   *  thresholds can be retuned later without re-running correlation. */
  gapSeconds: number | null;
  /** Zone offset plus camera offset, as actually applied. Without this a
   *  placement cannot be reproduced or explained after a profile changes. */
  appliedOffsetSeconds: OffsetSeconds;
  /** Metres from the track start, for ordering photographs along the route. */
  distanceAlongM: number;
  /** The resolved capture instant, epoch seconds UTC. */
  capturedAt: number;
};

export type UnplacedReason =
  | 'no-timestamp'
  | 'before-track'
  | 'after-track'
  | 'no-offset-resolved';

export type UnplacedPhoto = {
  photoId: string;
  reason: UnplacedReason;
  /** Null when the photo carried no parseable timestamp. */
  capturedAt: number | null;
  /** How far outside the activity window, in seconds. Null when unknown. */
  outsideBySeconds: number | null;
};

export type OffsetInference = {
  /** Null when no candidate placed a single photograph. */
  offsetSeconds: OffsetSeconds | null;
  /** IANA zones matching this offset on the activity's date, for display.
   *  Several zones share an offset, so this is never authoritative. */
  zoneNames: string[];
  placedCount: number;
  totalCount: number;
  /** Fraction of the activity window the placed photographs span, 0..1.
   *  The tiebreak that separates an adjacent-hour offset from the real one. */
  spread: number;
  /** The offset the photographs' own EXIF claimed, where they agreed on one. */
  exifOffsetSeconds: OffsetSeconds | null;
  /** Null when no EXIF offset was available to compare against. A false here
   *  is a signal worth surfacing, not an error: the search wins. */
  agreesWithExif: boolean | null;
  /**
   * Every candidate offset that scores equally best, ascending.
   *
   * The search is frequently underdetermined and this is not an edge case: a
   * handful of photographs taken in the middle of a long hike leave hours of
   * slack at both ends of the activity window, and a constant time shift moves
   * every photograph equally, so the spread tiebreak cannot separate the
   * candidates either. Measured on a real 5.5-hour hike with two photographs,
   * 24 of 105 candidates placed both. Reporting a single number there would be
   * a confident lie, so the admissible set is carried out of the search and the
   * consumer decides — a prior narrows it, and P-3's slider settles the rest.
   */
  admissibleOffsets: OffsetSeconds[];
  /** True when `admissibleOffsets` holds more than one candidate. */
  ambiguous: boolean;
  /**
   * How `offsetSeconds` was chosen from the admissible set.
   * `search` — the set had exactly one member, or a midpoint was taken.
   * `exif-prior` — the set had several and the photographs' EXIF offset was
   * among them, so it selected within the set. The tag never selects a value
   * the search ruled out.
   * `forced` — supplied by the caller.
   */
  selectedBy: 'search' | 'exif-prior' | 'forced';
};

export type CorrelationResult = {
  offset: OffsetInference;
  placed: PlacedPhoto[];
  unplaced: UnplacedPhoto[];
};

export type CorrelateOptions = {
  /** Seconds of slack either side of the activity window. Default 900. */
  graceSeconds?: number;
  /** Skip the search and use this offset. For replaying a stored correlation. */
  forceOffsetSeconds?: OffsetSeconds;
};

/** Thrown by the GPX parser. Carries the line number so a malformed file
 *  reports where it broke (P-1). */
export class GpxParseError extends Error {
  // Declared and assigned rather than written as a constructor parameter
  // property: Node runs this package by stripping types, which cannot emit the
  // assignment a parameter property implies.
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'GpxParseError';
    this.line = line;
  }
}
