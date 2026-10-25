import { seal, unseal } from "./seal";
import type { Offer } from "./offer";

// What a buyer keeps after paying: proof they own this purchase, good for as long as the
// purchase stands. Offers expire in minutes; a pledge can take a week to release.
export interface Claim {
  item: string;
  nonce: string;
  kind: "cash" | "pledge";
}

export function claimFor(offer: Offer): string {
  return seal<Claim>("claim", { item: offer.item, nonce: offer.nonce, kind: offer.deal.kind });
}

export function readClaim(token: string | null): Claim | undefined {
  return unseal<Claim>("claim", token);
}
