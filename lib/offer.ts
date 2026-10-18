import { ed25519 } from "@noble/curves/ed25519.js";
import { base64urlnopad, hex } from "@scure/base";
import type { Deal } from "./engine/negotiate";

// A signed offer is the only thing that can turn a haggle into a price on the payment route.
// The engine decides the deal, the server signs it, and the item route trusts nothing else.
export interface Offer {
  v: 1;
  item: string;
  deal: Deal;
  exp: number; // unix seconds
  nonce: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function secretKey(): Uint8Array {
  const k = process.env.OFFER_SIGNING_KEY;
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) throw new Error("OFFER_SIGNING_KEY must be 32 bytes of hex");
  return hex.decode(k.toLowerCase());
}

export function offerPublicKey(): Uint8Array {
  return ed25519.getPublicKey(secretKey());
}

export function signOffer(o: Offer): string {
  const body = enc.encode(JSON.stringify(o));
  const sig = ed25519.sign(body, secretKey());
  return `${base64urlnopad.encode(body)}.${base64urlnopad.encode(sig)}`;
}

export type OfferCheck =
  | { ok: true; offer: Offer }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_item" };

export function verifyOffer(token: string | null, itemId: string, now = Date.now() / 1000): OfferCheck {
  if (!token) return { ok: false, reason: "malformed" };
  const [b, s] = token.split(".");
  let body: Uint8Array, sig: Uint8Array, offer: Offer;
  try {
    body = base64urlnopad.decode(b);
    sig = base64urlnopad.decode(s);
    offer = JSON.parse(dec.decode(body));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!ed25519.verify(sig, body, offerPublicKey())) return { ok: false, reason: "bad_signature" };
  if (offer.item !== itemId) return { ok: false, reason: "wrong_item" };
  if (!(offer.exp > now)) return { ok: false, reason: "expired" };
  return { ok: true, offer };
}
