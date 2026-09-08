"use client";

import { useMemo } from "react";
import type { ElevationPoint, EntryPhoto } from "@/lib/entries";
import { formatDistance, formatElevation } from "./format";

const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 220;
const PADDING = { top: 16, right: 16, bottom: 28, left: 44 };

interface Marker {
  photoId: string;
  x: number;
  y: number;
}

interface ElevationProfileProps {
  points: ElevationPoint[];
  photos: EntryPhoto[];
  activePhotoId: string | null;
  onHoverMarker: (id: string | null) => void;
}

export function ElevationProfile({ points, photos, activePhotoId, onHoverMarker }: ElevationProfileProps) {
  const layout = useMemo(() => {
    if (points.length === 0) return null;

    const maxDistance = points[points.length - 1]!.distanceM;
    const elevations = points.map((point) => point.elevationM);
    const minElevation = Math.min(...elevations);
    const maxElevation = Math.max(...elevations);
    const elevationRange = Math.max(maxElevation - minElevation, 1);

    const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
    const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;

    const x = (distanceM: number) => PADDING.left + (distanceM / maxDistance) * plotWidth;
    const y = (elevationM: number) =>
      PADDING.top + plotHeight - ((elevationM - minElevation) / elevationRange) * plotHeight;

    const path = points
      .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.distanceM).toFixed(1)},${y(point.elevationM).toFixed(1)}`)
      .join(" ");
    const area = `${path} L${x(maxDistance).toFixed(1)},${(PADDING.top + plotHeight).toFixed(1)} L${x(0).toFixed(1)},${(PADDING.top + plotHeight).toFixed(1)} Z`;

    // Photos carry their own measured elevation (photo_locations.elevation_m)
    // rather than one interpolated from this downsampled line, so a marker's
    // height is exact even though the line under it has been thinned out.
    const markers: Marker[] = photos
      .filter((photo) => photo.location && photo.location.confidence !== "low" && photo.location.elevationM != null && photo.location.distanceAlongM != null)
      .map((photo) => ({
        photoId: photo.id,
        x: x(photo.location!.distanceAlongM!),
        y: y(photo.location!.elevationM!),
      }));

    return { path, area, minElevation, maxElevation, maxDistance, markers, plotHeight };
  }, [points, photos]);

  if (!layout) return null;

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      className="w-full"
      role="img"
      aria-label="Elevation profile"
    >
      <path d={layout.area} className="fill-zinc-900/[.05] dark:fill-zinc-50/[.06]" />
      <path d={layout.path} className="fill-none stroke-zinc-500 dark:stroke-zinc-400" strokeWidth={1.5} />

      <text x={PADDING.left - 8} y={PADDING.top + 4} textAnchor="end" className="fill-zinc-500 text-[10px] dark:fill-zinc-400">
        {formatElevation(layout.maxElevation)}
      </text>
      <text
        x={PADDING.left - 8}
        y={PADDING.top + layout.plotHeight}
        textAnchor="end"
        className="fill-zinc-500 text-[10px] dark:fill-zinc-400"
      >
        {formatElevation(layout.minElevation)}
      </text>
      <text
        x={VIEW_WIDTH - PADDING.right}
        y={VIEW_HEIGHT - 8}
        textAnchor="end"
        className="fill-zinc-500 text-[10px] dark:fill-zinc-400"
      >
        {formatDistance(layout.maxDistance)}
      </text>

      {layout.markers.map((marker) => {
        const isActive = marker.photoId === activePhotoId;
        return (
          <circle
            key={marker.photoId}
            cx={marker.x}
            cy={marker.y}
            r={isActive ? 5 : 3.5}
            className={isActive ? "fill-[var(--accent)]" : "fill-zinc-600 dark:fill-zinc-300"}
            onMouseEnter={() => onHoverMarker(marker.photoId)}
            onMouseLeave={() => onHoverMarker(null)}
          >
            <title>Photograph</title>
          </circle>
        );
      })}
    </svg>
  );
}
