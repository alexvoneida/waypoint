import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts Strava's per-athlete tokens for the `bytea` columns on
 * `strava_connections`.
 *
 * §6 says "pgcrypto; never a plain text column". The second half is the
 * requirement and is met; the first is deliberately not followed. pgcrypto's
 * symmetric functions take the key as a SQL argument, which puts it in reach
 * of `pg_stat_statements`, `log_min_duration_statement`, and any error that
 * echoes a failing statement. Encrypting here keeps the key in the
 * application process and sends the database nothing but ciphertext.
 *
 * Layout, one bytea:
 *
 *   byte 0        format version
 *   bytes 1..12   IV (96 bits, the size GCM is specified for)
 *   bytes 13..28  auth tag
 *   bytes 29..    ciphertext
 *
 * The version byte exists so a key rotation or algorithm change can read old
 * rows rather than invalidating every connection.
 */
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const VERSION_OFFSET = 0;
const IV_OFFSET = 1;
const TAG_OFFSET = IV_OFFSET + IV_BYTES;
const CIPHERTEXT_OFFSET = TAG_OFFSET + TAG_BYTES;

export class TokenEncryptionError extends Error {}

// Read on first use rather than at module load: an import of this file must
// not crash a route that never touches Strava, and Next evaluates modules
// eagerly during a build where the key is legitimately absent.
let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const configured = process.env.STRAVA_TOKEN_ENCRYPTION_KEY;
  if (!configured) {
    throw new TokenEncryptionError("STRAVA_TOKEN_ENCRYPTION_KEY is not set");
  }

  const key = Buffer.from(configured, "base64");
  if (key.length !== KEY_BYTES) {
    throw new TokenEncryptionError(
      `STRAVA_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }

  cachedKey = key;
  return key;
}

export function encryptToken(plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptToken(stored: Buffer): string {
  if (stored.length < CIPHERTEXT_OFFSET) {
    throw new TokenEncryptionError("encrypted token is too short to be well-formed");
  }
  const version = stored[VERSION_OFFSET];
  if (version !== FORMAT_VERSION) {
    throw new TokenEncryptionError(`unsupported encrypted token format version ${version}`);
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    stored.subarray(IV_OFFSET, TAG_OFFSET),
  );
  decipher.setAuthTag(stored.subarray(TAG_OFFSET, CIPHERTEXT_OFFSET));
  // Throws on a tag mismatch, which is the point: a token altered in the
  // database fails loudly here rather than being sent to Strava as garbage.
  return Buffer.concat([
    decipher.update(stored.subarray(CIPHERTEXT_OFFSET)),
    decipher.final(),
  ]).toString("utf8");
}
