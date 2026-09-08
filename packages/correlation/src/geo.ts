/**
 * Geometry helpers for the correlation engine.
 */

const EARTH_RADIUS_M = 6371008.8;

export type LatLon = { lat: number; lon: number };

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMetres(a: LatLon, b: LatLon): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

export function cumulativeDistances(points: LatLon[]): number[] {
  const distances: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous === undefined || current === undefined) continue;
    const segment = haversineMetres(previous, current);
    distances.push((distances[i - 1] ?? 0) + segment);
  }
  return distances;
}
