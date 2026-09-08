// Pure image-derivative logic: buffer in, derivative buffers out. No storage
// client, no database, no path aliases -- so this module can be imported by
// scripts/test-pipeline.mjs (via Node's native TypeScript type-stripping)
// exactly as it is imported by the Inngest job in ./photo.ts, and the gate
// script exercises the real pixel pipeline rather than a reimplementation.
import sharp from "sharp";
import exifr from "exifr";
import { encode } from "blurhash";

export type DerivedVariantName = "full" | "web" | "thumb";

export interface DerivedVariant {
  variant: DerivedVariantName;
  bytes: Buffer;
  width: number;
  height: number;
}

export interface DeriveResult {
  width: number;
  height: number;
  blurHash: string;
  variants: DerivedVariant[];
}

const VARIANT_SPECS: Record<DerivedVariantName, { edge: number; quality: number }> = {
  full: { edge: 2560, quality: 82 },
  web: { edge: 1280, quality: 80 },
  thumb: { edge: 400, quality: 75 },
};

const BLUR_HASH_RASTER_EDGE = 32;
const BLUR_HASH_COMPONENTS_X = 4;
const BLUR_HASH_COMPONENTS_Y = 3;

// GPS coordinates, both raw and exifr's computed decimal form; the serial
// numbers that fingerprint one physical camera body across every photo it
// has ever taken; and the owner/artist fields Lightroom can carry over from
// camera settings. This is what §8 calls out by name.
const SENSITIVE_TAG_KEYS = [
  "GPSLatitude",
  "GPSLongitude",
  "GPSAltitude",
  "latitude",
  "longitude",
  "SerialNumber",
  "BodySerialNumber",
  "LensSerialNumber",
  "Artist",
  "OwnerName",
  "CameraOwnerName",
] as const;

export async function deriveVariants(original: Buffer): Promise<DeriveResult> {
  const metadata = await sharp(original).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("original image has no readable dimensions");
  }

  const variants: DerivedVariant[] = [];
  for (const name of Object.keys(VARIANT_SPECS) as DerivedVariantName[]) {
    const spec = VARIANT_SPECS[name];
    const { data, info } = await sharp(original)
      .rotate() // bake in EXIF orientation before resizing, since the derivative carries none of its own
      .resize(spec.edge, spec.edge, { fit: "inside", withoutEnlargement: true })
      // No .withMetadata() call. sharp strips EXIF/ICC/XMP from its output
      // by default, which is what actually protects the GPS block and the
      // camera's serial number here -- but a default is not a guarantee
      // against someone adding .withMetadata() later, so
      // assertMetadataStripped() below checks the real output bytes rather
      // than trusting this comment to stay true.
      .webp({ quality: spec.quality })
      .toBuffer({ resolveWithObject: true });
    await assertMetadataStripped(data, name);
    variants.push({ variant: name, bytes: data, width: info.width, height: info.height });
  }

  const blurHash = await computeBlurHash(original);

  return { width: metadata.width, height: metadata.height, blurHash, variants };
}

async function computeBlurHash(original: Buffer): Promise<string> {
  const { data, info } = await sharp(original)
    .rotate()
    .resize(BLUR_HASH_RASTER_EDGE, BLUR_HASH_RASTER_EDGE, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return encode(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    BLUR_HASH_COMPONENTS_X,
    BLUR_HASH_COMPONENTS_Y,
  );
}

async function assertMetadataStripped(derivative: Buffer, variant: DerivedVariantName): Promise<void> {
  // exifr cannot parse a WebP file's EXIF chunk directly -- it does not
  // recognize WebP as a container at all, so calling exifr.parse() on the
  // derivative buffer itself silently finds nothing regardless of what is
  // actually embedded, which would make this assertion a no-op. sharp's own
  // metadata() is WebP-aware and reports the raw EXIF payload when present;
  // that payload carries the same six-byte "Exif\0\0" prefix a JPEG APP1
  // segment does, and stripping it leaves a bare TIFF structure exifr reads
  // exactly as it would from a JPEG.
  const meta = await sharp(derivative).metadata();
  if (!meta.exif) return;

  const tags = await exifr.parse(meta.exif.subarray(6), { gps: true }).catch(() => null);
  if (!tags) return;
  const leaked = SENSITIVE_TAG_KEYS.filter((key) => tags[key] !== undefined);
  if (leaked.length > 0) {
    throw new Error(`${variant} derivative retained sensitive metadata: ${leaked.join(", ")}`);
  }
}
