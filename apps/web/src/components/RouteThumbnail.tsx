const VIEW_SIZE = 64;
const PADDING = 4;

// A small, static SVG trace of the track - not a live MapLibre instance.
// The discovery page renders one of these per card (a few dozen on a single
// page load), and forty live map instances is exactly the failure mode the
// product is trying to avoid; an inline path costs nothing to paint and
// nothing to tear down.
//
// Projection is a plain equirectangular scale-to-fit: at thumbnail size
// (a few dozen pixels) no hiking track spans enough latitude for that
// approximation to visibly distort its shape.
function projectPath(coordinates: GeoJSON.Position[]): string {
  const lons = coordinates.map((c) => c[0]!);
  const lats = coordinates.map((c) => c[1]!);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const spanLon = maxLon - minLon || 1;
  const spanLat = maxLat - minLat || 1;
  const scale = (VIEW_SIZE - PADDING * 2) / Math.max(spanLon, spanLat);
  const offsetX = (VIEW_SIZE - spanLon * scale) / 2;
  const offsetY = (VIEW_SIZE - spanLat * scale) / 2;

  return coordinates
    .map(([lon = 0, lat = 0], index) => {
      const x = offsetX + (lon - minLon) * scale;
      // SVG y grows downward; latitude grows northward, so it's flipped.
      const y = offsetY + (maxLat - lat) * scale;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function RouteThumbnail({ geojson }: { geojson: GeoJSON.LineString }) {
  if (geojson.coordinates.length < 2) return null;
  const d = projectPath(geojson.coordinates);

  return (
    <svg
      viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
      width={VIEW_SIZE}
      height={VIEW_SIZE}
      aria-hidden
      className="shrink-0 text-zinc-400 dark:text-zinc-600"
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
