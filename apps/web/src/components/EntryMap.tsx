"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { LngLatBoundsLike, Map, MapLayerMouseEvent, Popup, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { trackPositions, type TrackGeometry } from "@/lib/track-geojson";

const TRACK_SOURCE = "track";
const TRACK_LAYER = "track-line";
const PINS_SOURCE = "photo-pins";
const PINS_LAYER = "photo-pins-circle";

const ACCENT = "#c2571a";
const DEFAULT_PIN_COLOR = "#3f3f46";

// maplibre-gl v6 ships its tile-parsing worker as a second ES module that it
// loads via `new Worker(new URL('maplibre-gl-worker.mjs', import.meta.url))`.
// Turbopack (as of Next 16.3.4) doesn't resolve that relative-to-module-url
// reference inside a prebuilt node_modules bundle, so the URL comes out
// empty, the worker fails to start, and the map style never finishes loading
// - no error surfaces anywhere, it just never paints past a blank canvas.
// Pointing the library at a copy of its own worker files served as static
// assets (apps/web/public/maplibre-gl-{worker,shared}.mjs) sidesteps the
// bundler entirely. Must run before the first `new maplibregl.Map(...)`.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export interface MapPin {
  photoId: string;
  lon: number;
  lat: number;
}

export interface FlyToRequest {
  photoId: string;
  nonce: number;
}

interface EntryMapProps {
  geojson: TrackGeometry;
  pins: MapPin[];
  activePhotoId: string | null;
  onHoverPin: (id: string | null) => void;
  flyTo: FlyToRequest | null;
}

// Positions, not coordinates: a track clipped by the privacy radius arrives
// as a MultiLineString, and reading .coordinates off one would iterate
// segments rather than points.
function trackBounds(geojson: TrackGeometry): LngLatBoundsLike {
  const bounds = new maplibregl.LngLatBounds();
  for (const position of trackPositions(geojson)) {
    bounds.extend([position[0]!, position[1]!]);
  }
  return bounds;
}

function pinsGeojson(pins: MapPin[]): GeoJSON.FeatureCollection<GeoJSON.Point, { photoId: string }> {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      properties: { photoId: pin.photoId },
      geometry: { type: "Point", coordinates: [pin.lon, pin.lat] },
    })),
  };
}

export function EntryMap({ geojson, pins, activePhotoId, onHoverPin, flyTo }: EntryMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const pinsRef = useRef(pins);

  useEffect(() => {
    pinsRef.current = pins;
  }, [pins]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const apiKey = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;
    const map = new maplibregl.Map({
      container,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${apiKey}`,
      bounds: trackBounds(geojson),
      fitBoundsOptions: { padding: 32 },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource(TRACK_SOURCE, {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: geojson },
      });
      map.addLayer({
        id: TRACK_LAYER,
        type: "line",
        source: TRACK_SOURCE,
        paint: { "line-color": ACCENT, "line-width": 3 },
      });

      map.addSource(PINS_SOURCE, { type: "geojson", data: pinsGeojson(pinsRef.current) });
      map.addLayer({
        id: PINS_LAYER,
        type: "circle",
        source: PINS_SOURCE,
        paint: {
          "circle-radius": 6,
          "circle-color": DEFAULT_PIN_COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.on("mouseenter", PINS_LAYER, (event: MapLayerMouseEvent) => {
        map.getCanvas().style.cursor = "pointer";
        const photoId = event.features?.[0]?.properties?.photoId as string | undefined;
        if (photoId) onHoverPin(photoId);
      });
      map.on("mouseleave", PINS_LAYER, () => {
        map.getCanvas().style.cursor = "";
        onHoverPin(null);
      });
      map.on("click", PINS_LAYER, (event: MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        const photoId = feature?.properties?.photoId as string | undefined;
        if (!photoId || feature?.geometry.type !== "Point") return;
        const [lon, lat] = feature.geometry.coordinates as [number, number];
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({ closeButton: true, offset: 12 })
          .setLngLat([lon, lat])
          .setHTML(
            `<img src="/i/${photoId}/thumb" alt="" style="display:block;width:160px;height:auto;border-radius:2px" />`,
          )
          .addTo(map);
      });
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
    // The map is built once; geojson/pins for a single entry page never
    // change after the first render, so this intentionally does not react to
    // prop changes the way the effects below do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource(PINS_SOURCE) as GeoJSONSource | undefined;
    source?.setData(pinsGeojson(pins));
  }, [pins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer(PINS_LAYER)) return;
    map.setPaintProperty(PINS_LAYER, "circle-color", [
      "case",
      ["==", ["get", "photoId"], activePhotoId ?? ""],
      ACCENT,
      DEFAULT_PIN_COLOR,
    ]);
    map.setPaintProperty(PINS_LAYER, "circle-radius", [
      "case",
      ["==", ["get", "photoId"], activePhotoId ?? ""],
      9,
      6,
    ]);
  }, [activePhotoId]);

  useEffect(() => {
    if (!flyTo) return;
    const map = mapRef.current;
    const pin = pinsRef.current.find((candidate) => candidate.photoId === flyTo.photoId);
    if (!map || !pin) return;
    map.flyTo({ center: [pin.lon, pin.lat], zoom: Math.max(map.getZoom(), 14) });
  }, [flyTo]);

  return <div ref={containerRef} className="h-full w-full" />;
}
