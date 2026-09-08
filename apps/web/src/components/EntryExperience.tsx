"use client";

import { useState } from "react";
import type { ElevationPoint, EntryPhoto } from "@/lib/entries";
import type { TrackGeometry } from "@/lib/track-geojson";
import { EntryMap, type FlyToRequest } from "./EntryMap";
import { ElevationProfile } from "./ElevationProfile";
import { PhotoStrip } from "./PhotoStrip";

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

  const pins = photos
    .filter((photo) => photo.location && photo.location.confidence !== "low")
    .map((photo) => ({ photoId: photo.id, lon: photo.location!.lon, lat: photo.location!.lat }));

  return (
    <div className="flex flex-col gap-8">
      <div className="h-80 overflow-hidden rounded-md sm:h-[28rem]">
        <EntryMap
          geojson={trackGeojson}
          pins={pins}
          activePhotoId={activePhotoId}
          onHoverPin={setActivePhotoId}
          flyTo={flyTo}
        />
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
        onClickPhoto={(id) => setFlyTo({ photoId: id, nonce: Date.now() })}
      />
    </div>
  );
}
