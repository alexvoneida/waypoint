import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { getObjectBytes } from "@/lib/storage";

// Derivatives only, never "original": the uploaded original can carry GPS and
// camera-serial EXIF that the derive job deliberately strips out (see
// assertMetadataStripped in lib/jobs/derive-image.ts), and this route is the
// only thing standing between a public entry page and the object store.
type ServableVariant = "thumb" | "web" | "full";
const VARIANT_COLUMN: Record<ServableVariant, "key_thumb" | "key_web" | "key_full"> = {
  thumb: "key_thumb",
  web: "key_web",
  full: "key_full",
};

function isServableVariant(value: string): value is ServableVariant {
  return value === "thumb" || value === "web" || value === "full";
}

interface PhotoKeyRow {
  key_thumb: string | null;
  key_web: string | null;
  key_full: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ photoId: string; variant: string }> },
) {
  const { photoId, variant } = await params;
  if (!isServableVariant(variant)) {
    return NextResponse.json({ error: "unknown variant" }, { status: 400 });
  }

  const viewerId = await getViewer(request);

  // The select below carries no visibility check of its own: RLS is the
  // check. photos_own and photos_visible (0008_public_read_policies.sql)
  // between them are what let this row through for its owner or for anyone
  // looking at a public entry, and nobody else - the same guarantee that
  // keeps a caller from reading an arbitrary key by trying random ids.
  const row = await withUser(viewerId, async (client) => {
    const { rows } = await client.query<PhotoKeyRow>(
      "select key_thumb, key_web, key_full from photos where id = $1",
      [photoId],
    );
    return rows[0] ?? null;
  });

  const key = row?.[VARIANT_COLUMN[variant]];
  if (!key) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const bytes = await getObjectBytes(key);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/webp",
      // Content-addressed by photoId+variant in practice - a photo is
      // re-derived only by re-uploading, which is a new photo row - so a
      // long, immutable cache is safe.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
