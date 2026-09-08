import { trackSegments, type TrackGeometry } from "@/lib/track-geojson";

const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 400;
const PADDING = 24;
const PIN_RADIUS = 5;

const ACCENT = "#c2571a";

export interface StaticRoutePin {
  photoId: string;
  lon: number;
  lat: number;
}

interface StaticRouteMapProps {
  // A single track (the entry page's case) or several overlaid tracks (the
  // trail page's case, one per visit) - both go through the same scale-to-fit
  // projection so a clipped track never gets bridged by a straight line.
  geojson: TrackGeometry | TrackGeometry[];
  pins?: StaticRoutePin[];
  className?: string;
}

interface Projection {
  project: (lon: number, lat: number) => [number, number];
}

// Same equirectangular scale-to-fit idea as RouteThumbnail, generalized to a
// wide, non-square canvas and to multiple tracks sharing one bounding box -
// read RouteThumbnail before changing this, the two should never drift onto
// different projections.
function buildProjection(allPositions: GeoJSON.Position[]): Projection {
  const lons = allPositions.map((p) => p[0]!);
  const lats = allPositions.map((p) => p[1]!);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const spanLon = maxLon - minLon || 1;
  const spanLat = maxLat - minLat || 1;
  const scale = Math.min(
    (VIEW_WIDTH - PADDING * 2) / spanLon,
    (VIEW_HEIGHT - PADDING * 2) / spanLat,
  );
  const offsetX = (VIEW_WIDTH - spanLon * scale) / 2;
  const offsetY = (VIEW_HEIGHT - spanLat * scale) / 2;

  return {
    project: (lon, lat) => [
      offsetX + (lon - minLon) * scale,
      // SVG y grows downward; latitude grows northward, so it's flipped.
      offsetY + (maxLat - lat) * scale,
    ],
  };
}

function trackPath(segments: GeoJSON.Position[][], project: Projection["project"]): string {
  return segments
    .map((segment) =>
      segment
        .map(([lon = 0, lat = 0], index) => {
          const [x, y] = project(lon, lat);
          return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" "),
    )
    .join(" ");
}

// A presentational trace of the track(s), drawn at full width with the same
// aspect ratio the real map occupies. This is what a reader sees before they
// ask for the interactive map - a real route, not a grey placeholder box.
export function StaticRouteMap({ geojson, pins = [], className }: StaticRouteMapProps) {
  const tracks = Array.isArray(geojson) ? geojson : [geojson];
  const segmentsByTrack = tracks.map((track) => trackSegments(track).filter((segment) => segment.length >= 2));
  const allPositions = [
    ...segmentsByTrack.flat(2),
    ...pins.map((pin): GeoJSON.Position => [pin.lon, pin.lat]),
  ] as GeoJSON.Position[];

  if (allPositions.length === 0) return null;

  const { project } = buildProjection(allPositions);

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Static preview of the recorded route"
      className={className}
    >
      {segmentsByTrack.map((segments, index) => (
        <path
          key={index}
          d={trackPath(segments, project)}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={segmentsByTrack.length > 1 ? 0.55 : 1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {pins.map((pin) => {
        const [x, y] = project(pin.lon, pin.lat);
        return (
          <circle
            key={pin.photoId}
            cx={x}
            cy={y}
            r={PIN_RADIUS}
            fill={ACCENT}
            stroke="#ffffff"
            strokeWidth={1.5}
          />
        );
      })}
    </svg>
  );
}
