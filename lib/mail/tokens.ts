import { createHash, createHmac, randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import { ConfigError } from "../config";

// Link tokens for confirm and unsubscribe. A token is an HMAC of a random nonce under the
// server's key, labelled with what it's for. So:
// - it can't be guessed (256 bits);
// - a confirm token can't be used to unsubscribe, or the other way round;
// - the database only holds the nonce and a hash, so reading it isn't enough to make a link.

export type Purpose = "confirm" | "unsub";

function key(): Uint8Array {
  const k = process.env.OFFER_SIGNING_KEY;
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) throw new ConfigError("OFFER_SIGNING_KEY must be 32 bytes of hex");
  return hex.decode(k.toLowerCase());
}

export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenFor(purpose: Purpose, nonce: string): string {
  return createHmac("sha256", key()).update(`lowball-mail|${purpose}|${nonce}`).digest("base64url");
}

/** What the database stores to find a row by its token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Shape check before touching the database: 43 base64url characters. */
export function looksLikeToken(t: unknown): t is string {
  return typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);
}
