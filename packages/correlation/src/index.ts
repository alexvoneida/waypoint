export { parseGpx } from './gpx.ts';
export { correlate } from './correlate.ts';
export { inferOffset, CANDIDATE_OFFSETS } from './offset.ts';
export { scoreConfidence } from './confidence.ts';

export type {
  TrackPoint,
  Track,
  OffsetSeconds,
  Photo,
  Confidence,
  LocateMethod,
  PlacedPhoto,
  UnplacedReason,
  UnplacedPhoto,
  OffsetInference,
  CorrelationResult,
  CorrelateOptions,
} from './types.ts';
export { GpxParseError } from './types.ts';
