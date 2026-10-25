import { dealExists, fetchPledge, pledgeOutcome } from "./chain";
import type { Claim } from "./claim";

export type Standing = "delivered" | "pledged" | "no_receipt" | "refunded" | "cancelled" | "unknown";

/** What a claim is worth right now, read from the chain: paid in cash, released pledge, or not (yet). */
export async function standing(claim: Claim): Promise<Standing> {
  if (claim.kind === "cash") return (await dealExists(claim.nonce)) ? "delivered" : "no_receipt";
  if (await fetchPledge(claim.nonce)) return "pledged";
  const outcome = await pledgeOutcome(claim.nonce);
  return outcome === "released" ? "delivered" : outcome;
}
