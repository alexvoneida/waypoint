"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { TrackGeometry } from "@/lib/track-geojson";
import { StaticRouteMap } from "./StaticRouteMap";

// The trail page is a server component (it has no interaction of its own to
// justify being a client component), but the map still needs to be deferred
// the same way the entry page defers EntryMap: maplibre-gl is the single
// largest asset either page loads, and a reader who never touches the map
// should never pay to download and parse it. Isolating the dynamic import in
// this small client wrapper keeps the page itself server-rendered.
const TrailMap = dynamic(() => import("./TrailMap").then((mod) => mod.TrailMap), {
  ssr: false,
});

interface TrailMapClientProps {
  tracks: TrackGeometry[];
}

export function TrailMapClient({ tracks }: TrailMapClientProps) {
  const [mapActivated, setMapActivated] = useState(false);

  return (
    <div className="relative h-80 w-full overflow-hidden rounded-md sm:h-[28rem]">
      {mapActivated ? (
        <TrailMap tracks={tracks} />
      ) : (
        <>
          <StaticRouteMap
            geojson={tracks}
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
  );
}
