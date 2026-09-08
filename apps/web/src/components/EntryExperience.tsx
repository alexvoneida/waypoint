"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { ElevationPoint, EntryPhoto } from "@/lib/entries";
import type { TrackGeometry } from "@/lib/track-geojson";
import type { FlyToRequest } from "./EntryMap";
import { ElevationProfile } from "./ElevationProfile";
import { PhotoStrip } from "./PhotoStrip";
import { StaticRouteMap } from "./StaticRouteMap";

// maplibre-gl is by far the heaviest thing an entry page loads. Most readers
// never touch the map - they scroll the photographs - so it is loaded only
// once they ask for it, via a dynamic import with ssr:false (MapLibre reaches
// for `window` at construction time and cannot render on the server anyway).
// A reader who never clicks "Show interactive map" never downloads or parses
// it.
const EntryMap = dynamic(() => import("./EntryMap").then((mod) => mod.EntryMap), {
  ssr: false,
});

interface EntryExperienceProps {
  trackGeojson: TrackGeometry;
  elevation: ElevationPoint[];
  photos: EntryPhoto[];
}

// The one client wrapper that owns activePhotoId, so hovering a photograph,
// its pin, or its elevation marker highlights all three together - the
// single interaction the design direction spends its boldness on. Everything
// else on the page is a plain server-rendered read.
export function EntryExperience({ trackGeojson, elevation, photos }: EntryExperienceProps) {
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<FlyToRequest | null>(null);
  const [mapActivated, setMapActivated] = useState(false);

  const pins = photos
    .filter((photo) => photo.location && photo.location.confidence !== "low")
    .map((photo) => ({ photoId: photo.id, lon: photo.location!.lon, lat: photo.location!.lat }));

  return (
    <div className="flex flex-col gap-8">
      {/* Fixed height on the wrapper, not on either child, so swapping the
          static trace for the live map never shifts anything below it. */}
      <div className="relative h-80 overflow-hidden rounded-md sm:h-[28rem]">
        {mapActivated ? (
          <EntryMap
            geojson={trackGeojson}
            pins={pins}
            activePhotoId={activePhotoId}
            onHoverPin={setActivePhotoId}
            flyTo={flyTo}
          />
        ) : (
          <>
            <StaticRouteMap
              geojson={trackGeojson}
              pins={pins}
              className="h-full w-full bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/5 dark:bg-black/20">
              <button
                type="button"
                onClick={() => setMapActivated(true)}
                className="rounded-full bg-[var(--background)] px-4 py-2 text-sm font-medium text-zinc-900 shadow-md transition hover:bg-[var(--accent)] hover:text-white dark:text-zinc-50"
              >
                Show interactive map
              </button>
            </div>
          </>
        )}
      </div>

      {elevation.length > 0 && (
        <ElevationProfile
          points={elevation}
          photos={photos}
          activePhotoId={activePhotoId}
          onHoverMarker={setActivePhotoId}
        />
      )}

      <PhotoStrip
        photos={photos}
        activePhotoId={activePhotoId}
        onHoverPhoto={setActivePhotoId}
        // Clicking a photograph flies the map to it (V-1), which means the
        // click has to wake the map first when it is still the static trace.
        // The request is recorded either way: the live map reads flyTo on
        // mount, so the fly happens once it arrives rather than being lost.
        onClickPhoto={(id) => {
          setMapActivated(true);
          setFlyTo({ photoId: id, nonce: Date.now() });
        }}
      />
    </div>
  );
}
