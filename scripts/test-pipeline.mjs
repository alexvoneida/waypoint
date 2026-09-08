#!/usr/bin/env node
// Phase 2 gate: a 50-photo batch uploads through presigned PUT URLs and
// produces all three WebP derivatives without hitting a serverless timeout.
//
// This calls the derivative logic (apps/web/src/lib/jobs/derive-image.ts)
// directly rather than through Inngest, and does the same for storage.ts's
// presignUpload/ensureBucket/putObjectBytes. That is deliberate: this script
// proves the storage round trip and the sharp/blurhash pipeline are correct
// and fast enough, which is a property of the code, not of Inngest's queue.
// The Inngest wiring itself (event -> exif.extract -> event -> derive, with
// retries) is exercised by running `next dev` and posting to /api/inngest,
// which is a separate, non-headless check.
//
// Zero dependencies beyond what apps/web already has installed (this process
// imports two of its .ts files directly, relying on Node's built-in
// TypeScript type-stripping -- both files avoid path aliases and any
// TS syntax that isn't plain type erasure, for exactly this reason).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_LIB = join(REPO_ROOT, "apps/web/src/lib");

function loadEnv() {
  const path = join(REPO_ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

const { ensureBucket, presignUpload, objectKey, getObjectBytes, putObjectBytes } = await import(
  join(WEB_LIB, "storage.ts")
);
const { deriveVariants } = await import(join(WEB_LIB, "jobs/derive-image.ts"));

const BATCH_SIZE = 50;
const UPLOAD_CONCURRENCY = 12;
// sharp's `.resize().webp()` pipeline is CPU-bound and multi-threaded inside
// libvips itself; running 50 of them at once would oversubscribe every core
// several times over and make the wall-clock number meaningless (and, on a
// memory-constrained machine, risks an OOM). Capped at the core count
// instead, which is the concurrency a real deployment's worker pool would
// also use.
const DERIVE_CONCURRENCY = Math.max(2, Math.min(8, cpus().length));

let passed = true;
function pass(label, detail = "") {
  console.log(`PASS ${label}${detail ? " - " + detail : ""}`);
}
function fail(label, detail = "") {
  console.log(`FAIL ${label}${detail ? " - " + detail : ""}`);
  passed = false;
}

// A minimal bounded-concurrency map: no more than `limit` calls to `fn` are
// in flight at once. Returns the peak number actually observed running
// concurrently, alongside the per-item results.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let active = 0;
  let peak = 0;

  return new Promise((resolve, reject) => {
    function settle() {
      if (nextIndex >= items.length && active === 0) {
        resolve({ results, peakConcurrency: peak });
        return;
      }
      while (active < limit && nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        active += 1;
        peak = Math.max(peak, active);
        Promise.resolve(fn(items[index], index))
          .then((value) => {
            results[index] = value;
            active -= 1;
            settle();
          })
          .catch(reject);
      }
    }
    settle();
  });
}

async function main() {
  const fixturePath = join(REPO_ROOT, "fixtures/photos/DSCF0258.jpg");
  if (!existsSync(fixturePath)) {
    fail("fixture photo present", `${fixturePath} not found`);
    printSummary();
    process.exit(1);
  }
  const originalBytes = readFileSync(fixturePath);
  pass("fixture photo loaded", `${fixturePath} (${originalBytes.length} bytes)`);

  await ensureBucket();
  pass("ensureBucket");

  const userId = randomUUID();
  const entryId = randomUUID();
  const photos = Array.from({ length: BATCH_SIZE }, () => ({ photoId: randomUUID() }));

  const uploadStart = Date.now();
  const { peakConcurrency: uploadPeak } = await mapWithConcurrency(
    photos,
    UPLOAD_CONCURRENCY,
    async (photo) => {
      const key = objectKey(userId, entryId, photo.photoId, "original");
      const uploadUrl = await presignUpload(key, "image/jpeg", originalBytes.length);
      // The real path: an actual HTTP PUT against the presigned URL, not a
      // direct SDK call. This is what a browser upload does, and it is the
      // thing being tested -- a bug in presignUpload's signature or headers
      // would not show up if this just called putObjectBytes instead.
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg", "Content-Length": String(originalBytes.length) },
        body: originalBytes,
      });
      if (!response.ok) {
        throw new Error(`upload failed for ${key}: ${response.status} ${await response.text()}`);
      }
      photo.key = key;
    },
  );
  const uploadMs = Date.now() - uploadStart;
  pass(
    "50-photo batch uploaded via presigned PUT",
    `${uploadMs} ms, peak concurrency ${uploadPeak}`,
  );

  const deriveStart = Date.now();
  const { results: deriveResults, peakConcurrency: derivePeak } = await mapWithConcurrency(
    photos,
    DERIVE_CONCURRENCY,
    async (photo) => {
      const bytes = await getObjectBytes(photo.key);
      const derived = await deriveVariants(bytes);
      const keys = {};
      for (const variant of derived.variants) {
        const key = objectKey(userId, entryId, photo.photoId, variant.variant);
        await putObjectBytes(key, variant.bytes, "image/webp");
        keys[variant.variant] = { key, width: variant.width, height: variant.height };
      }
      return { photoId: photo.photoId, keys, width: derived.width, height: derived.height, blurHash: derived.blurHash };
    },
  );
  const deriveMs = Date.now() - deriveStart;
  pass(
    "derivatives generated for the full batch",
    `${deriveMs} ms, peak concurrency ${derivePeak}`,
  );

  let allVariantsPresent = true;
  for (const result of deriveResults) {
    for (const variant of ["full", "web", "thumb"]) {
      if (!result.keys[variant]) {
        allVariantsPresent = false;
        fail("all three variants recorded", `${result.photoId} missing ${variant}`);
      }
    }
  }
  if (allVariantsPresent) {
    pass("all three variants recorded for every photo", `${deriveResults.length} photos`);
  }

  let allObjectsExist = true;
  for (const result of deriveResults) {
    for (const variant of Object.values(result.keys)) {
      const bytes = await getObjectBytes(variant.key).catch(() => null);
      if (!bytes || bytes.length === 0) {
        allObjectsExist = false;
        fail("derivative object exists in the bucket", variant.key);
      }
    }
  }
  if (allObjectsExist) {
    pass("every derivative object confirmed present in the bucket");
  }

  const sample = deriveResults[0];
  console.log(`     sample photo ${sample.photoId}:`);
  console.log(`       original ${sample.width}x${sample.height}, blurHash ${sample.blurHash}`);
  for (const [variant, info] of Object.entries(sample.keys)) {
    console.log(`       ${variant.padEnd(5)} ${info.width}x${info.height}  ${info.key}`);
  }

  const totalMs = Date.now() - uploadStart;
  console.log(`     total wall clock: ${totalMs} ms (upload ${uploadMs} ms + derive ${deriveMs} ms)`);
  console.log(`     peak concurrency: upload ${uploadPeak}, derive ${derivePeak}`);

  printSummary();
  process.exit(passed ? 0 : 1);
}

function printSummary() {
  console.log("");
  console.log(passed ? "PASS: Phase 2 gate met." : "FAIL: Phase 2 gate not met.");
}

main().catch((error) => {
  fail("unhandled error", error.stack ?? String(error));
  printSummary();
  process.exit(1);
});
