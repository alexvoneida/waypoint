/**
 * A published track is a LineString until the privacy radius (A-4) bites into
 * it, at which point ST_Difference hands back a MultiLineString. Every public
 * read can therefore return either, and nothing that draws a track may assume
 * one contiguous run of coordinates.
 *
 * Normalising to a list of segments -- one for a whole track, several for a
 * clipped one -- is what keeps the gap visible on the map instead of drawn
 * across.
 */
export type TrackGeometry = GeoJSON.LineString | GeoJSON.MultiLineString;

export function trackSegments(geometry: TrackGeometry): GeoJSON.Position[][] {
  return geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
}

export function trackPositions(geometry: TrackGeometry): GeoJSON.Position[] {
  return trackSegments(geometry).flat();
}
