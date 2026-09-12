import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

// Cached on globalThis for the same reason as the database pool in db.ts:
// Next's dev server hot-reloads this module on every edit, and a fresh
// S3Client (and its socket pool) on every edit would eventually exhaust
// file descriptors.
const globalForStorage = globalThis as unknown as { waypointS3Client?: S3Client };

function createClient(): S3Client {
  return new S3Client({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: requireEnv("S3_REGION"),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

function getClient(): S3Client {
  if (process.env.NODE_ENV === "production") {
    return createClient();
  }
  if (!globalForStorage.waypointS3Client) {
    globalForStorage.waypointS3Client = createClient();
  }
  return globalForStorage.waypointS3Client;
}

function getBucket(): string {
  return requireEnv("S3_BUCKET");
}

const UPLOAD_URL_TTL_SECONDS = 10 * 60;

export type PhotoVariant = "original" | "full" | "web" | "thumb";

// Deterministic and derivable from ids alone, so nothing needs to look a key
// up before it can be built: `originals/<user>/<entry>/<photo>.jpg` for the
// browser-uploaded original, `derived/<user>/<entry>/<photo>-<variant>.webp`
// for each generated size.
export function objectKey(
  userId: string,
  entryId: string,
  photoId: string,
  variant: PhotoVariant,
): string {
  if (variant === "original") {
    return `originals/${userId}/${entryId}/${photoId}.jpg`;
  }
  return `derived/${userId}/${entryId}/${photoId}-${variant}.webp`;
}

export async function presignUpload(
  key: string,
  contentType: string,
  contentLength: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(getClient(), command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
}

export async function getObjectBytes(key: string): Promise<Buffer> {
  const result = await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  const body = result.Body;
  if (!body) {
    throw new Error(`object has no body: ${key}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function putObjectBytes(
  key: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  await getClient().send(
    new PutObjectCommand({ Bucket: getBucket(), Key: key, Body: bytes, ContentType: contentType }),
  );
}

// For the health check: proves the bucket is reachable with these
// credentials without creating anything, unlike ensureBucket below.
export async function pingBucket(): Promise<void> {
  await getClient().send(new HeadBucketCommand({ Bucket: getBucket() }));
}

// Lets a fresh developer machine (or this repo's own test-pipeline.mjs) work
// against MinIO with no manual bucket-creation step. Production R2 buckets
// are created once, out of band, so this is a no-op there after the first run.
export async function ensureBucket(): Promise<void> {
  const client = getClient();
  const bucket = getBucket();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
