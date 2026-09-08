import { serveVendorModule } from "@/lib/vendor-asset";

// See lib/vendor-asset.ts and EntryMap.tsx (setWorkerUrl) for why this
// exists: maplibre-gl's own worker bundle, re-served same-origin so the
// library can load it without Turbopack needing to resolve its
// import.meta.url-relative Worker construction.
export async function GET() {
  return serveVendorModule("maplibre-gl/dist/maplibre-gl-worker.mjs");
}
