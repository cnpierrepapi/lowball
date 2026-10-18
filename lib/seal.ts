import { ed25519 } from "@noble/curves/ed25519.js";
import { base64urlnopad, hex } from "@scure/base";

// Server-signed blobs for things the browser carries between requests (haggle state,
// voice lines). The client can read them but can't change a byte without breaking the seal.
const enc = new TextEncoder();
const dec = new TextDecoder();

function key(): Uint8Array {
  const k = process.env.OFFER_SIGNING_KEY;
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) throw new Error("OFFER_SIGNING_KEY must be 32 bytes of hex");
  return hex.decode(k.toLowerCase());
}

export function seal<T>(purpose: string, value: T): string {
  const body = enc.encode(JSON.stringify({ p: purpose, v: value }));
  return `${base64urlnopad.encode(body)}.${base64urlnopad.encode(ed25519.sign(body, key()))}`;
}

export function unseal<T>(purpose: string, token: string | undefined | null): T | undefined {
  if (!token) return undefined;
  try {
    const [b, s] = token.split(".");
    const body = base64urlnopad.decode(b);
    if (!ed25519.verify(base64urlnopad.decode(s), body, ed25519.getPublicKey(key()))) return undefined;
    const parsed = JSON.parse(dec.decode(body));
    return parsed.p === purpose ? (parsed.v as T) : undefined;
  } catch {
    return undefined;
  }
}
