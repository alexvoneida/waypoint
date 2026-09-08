"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { LngLatBoundsLike, Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { trackPositions, type TrackGeometry } from "@/lib/track-geojson";

const TRACKS_SOURCE = "trail-tracks";
const TRACKS_LAYER = "trail-tracks-line";

// Same worker-URL workaround as EntryMap - see that file for why it is
// necessary. Calling this twice (once per map instance on a page that never
// renders both) is harmless; setWorkerUrl just records the URL for the next
// map to construct.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

interface TrailMapProps {
  tracks: TrackGeometry[];
}

function tracksBounds(tracks: TrackGeometry[]): LngLatBoundsLike {
  const bounds = new maplibregl.LngLatBounds();
  for (const track of tracks) {
    for (const position of trackPositions(track)) {
      bounds.extend([position[0]!, position[1]!]);
    }
  }
  return bounds;
}

function tracksGeojson(tracks: TrackGeometry[]): GeoJSON.FeatureCollection<TrackGeometry> {
  return {
    type: "FeatureCollection",
    features: tracks.map((geometry) => ({ type: "Feature", properties: {}, geometry })),
  };
}

// Every visible visit to a trail is, by definition, close to the same
// physical route - overlaying them with one muted stroke rather than a
// rainbow of per-author colours is what keeps the restraint the design
// direction asks for, and it draws a second reading for free: where visits
// diverge (a trailhead reroute, a shortcut), the line thins back down to a
// single pass; where they coincide, repeated low-opacity strokes compositing
// on top of each other read as the well-trodden line.
export function TrailMap({ tracks }: TrailMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || tracks.length === 0) return;

    const apiKey = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;
    const map = new maplibregl.Map({
      container,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${apiKey}`,
      bounds: tracksBounds(tracks),
      fitBoundsOptions: { padding: 32 },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource(TRACKS_SOURCE, { type: "geojson", data: tracksGeojson(tracks) });
      map.addLayer({
        id: TRACKS_LAYER,
        type: "line",
        source: TRACKS_SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#3f3f46",
          "line-width": 3,
          "line-opacity": 0.55,
        },
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The overlay is built once from the full visit list; a trail page never
    // adds visits after its first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
