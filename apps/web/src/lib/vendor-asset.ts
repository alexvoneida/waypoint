import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

// Cached per resolved path rather than per call, so a hot-reloaded route
// module in dev doesn't re-read the file on every request.
const cache = new Map<string, Promise<Buffer>>();

function loadFile(resolvedPath: string): Promise<Buffer> {
  let pending = cache.get(resolvedPath);
  if (!pending) {
    pending = readFile(resolvedPath);
    cache.set(resolvedPath, pending);
  }
  return pending;
}

// node_modules is hoisted to the workspace root (npm workspaces), two levels
// above apps/web, and `next dev`/`next build` always run with apps/web as
// process.cwd(). Plain path arithmetic rather than require.resolve or
// import.meta.resolve: both of those are statically analyzed by Turbopack
// (it needs to decide at build time whether to bundle the target), and for a
// prebuilt dist file like maplibre-gl's worker bundle that analysis either
// fails outright ("expression is too dynamic") or resolves to a
// Turbopack-internal module id instead of a real path on disk - there is no
// module graph to join here, just a file to hand to fs.readFile.
const WORKSPACE_NODE_MODULES = path.join(process.cwd(), "..", "..", "node_modules");

// Serves one file straight out of an installed package's node_modules as a
// same-origin static asset. Exists for maplibre-gl's worker bundle (see
// EntryMap.tsx for why): Turbopack does not resolve the
// `new Worker(new URL(..., import.meta.url))` reference inside that prebuilt
// dist file, so the library needs its worker script handed to it as a plain
// URL instead.
export async function serveVendorModule(packageRelativePath: string): Promise<NextResponse> {
  const resolvedPath = path.join(WORKSPACE_NODE_MODULES, packageRelativePath);
  const bytes = await loadFile(resolvedPath);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Tied to the installed package version, not to anything that changes
      // without a redeploy.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
