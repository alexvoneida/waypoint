import { serveVendorModule } from "@/lib/vendor-asset";

// maplibre-gl-worker.mjs imports this as a sibling ("./maplibre-gl-shared.mjs"),
// so it has to be reachable at exactly this path alongside the worker route.
export async function GET() {
  return serveVendorModule("maplibre-gl/dist/maplibre-gl-shared.mjs");
}
