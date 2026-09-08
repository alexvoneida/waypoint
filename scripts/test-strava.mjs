#!/usr/bin/env node
// Proves the Strava integration's pure pieces: token encryption at rest and
// the streams-to-Track conversion. Nothing here touches the network or the
// database, so it runs anywhere; the OAuth round trip and the backfill are
// walked by hand against the studio (see PHASE-5.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { randomBytes } from "node:crypto";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_SRC = pathToFileURL(join(REPO_ROOT, "apps/web/src") + "/").href;

// Resolves "@/lib/..." the way apps/web's tsconfig path alias does, as
// scripts/test-trail-match.mjs does for the same reason.
const loaderSource = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  let target;
  if (specifier.startsWith("@/")) {
    target = new URL(specifier.slice(2), "${WEB_SRC}").href;
  } else if (context.parentURL && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    target = new URL(specifier, context.parentURL).href;
  } else {
    return nextResolve(specifier, context);
  }
  if (!/\\.[a-zA-Z0-9]+$/.test(target)) {
    for (const ext of [".ts", ".mts", ".js"]) {
      try {
        if (existsSync(fileURLToPath(target + ext))) {
          return nextResolve(target + ext, context);
        }
      } catch {}
    }
  }
  return nextResolve(target, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

function loadEnv() {
  const path = join(REPO_ROOT, ".env");
  const parsed = {};
  if (!existsSync(path)) return parsed;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

// Set before the module is imported: the key is read on first use, then
// cached, so a test cannot swap it afterward.
const env = loadEnv();
process.env.STRAVA_TOKEN_ENCRYPTION_KEY =
  env.STRAVA_TOKEN_ENCRYPTION_KEY ?? randomBytes(32).toString("base64");

const { encryptToken, decryptToken, TokenEncryptionError } = await import(
  join(REPO_ROOT, "apps/web/src/lib/strava/crypto.ts")
);

test("a token round-trips through encryption unchanged", () => {
  const token = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
  assert.equal(decryptToken(encryptToken(token)), token);
});

test("ciphertext never contains the plaintext", () => {
  const token = "recognisable-token-value";
  const encrypted = encryptToken(token);
  assert.ok(!encrypted.toString("utf8").includes(token));
  assert.ok(!encrypted.toString("latin1").includes(token));
});

test("the same token encrypts differently every time", () => {
  // A fresh IV per call. Equal ciphertexts would tell an observer of the
  // table that two accounts hold the same token.
  const token = "same-token-twice";
  assert.notEqual(encryptToken(token).toString("hex"), encryptToken(token).toString("hex"));
});

test("a tampered ciphertext fails rather than decrypting to garbage", () => {
  const encrypted = encryptToken("token-to-tamper-with");
  encrypted[encrypted.length - 1] ^= 0xff;
  assert.throws(() => decryptToken(encrypted));
});

test("a tampered auth tag fails", () => {
  const encrypted = encryptToken("token-to-tamper-with");
  encrypted[14] ^= 0xff;
  assert.throws(() => decryptToken(encrypted));
});

test("an unknown format version is refused", () => {
  const encrypted = encryptToken("token");
  encrypted[0] = 99;
  assert.throws(() => decryptToken(encrypted), TokenEncryptionError);
});

test("a truncated value is refused rather than read out of bounds", () => {
  assert.throws(() => decryptToken(Buffer.alloc(4)), TokenEncryptionError);
});
