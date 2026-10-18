import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/next";
import { ExactSvmScheme } from "@x402/svm/exact/server";

export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// The public x402.org facilitator verifies and settles on devnet and pays the SOL fee,
// so a buyer only ever needs USDC.
const facilitator = new HTTPFacilitatorClient({
  url: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
});

export const resourceServer = new x402ResourceServer(facilitator).register(
  SOLANA_DEVNET,
  new ExactSvmScheme(),
);

export function merchantAddress(): string {
  const a = process.env.MERCHANT_ADDRESS;
  if (!a) throw new Error("MERCHANT_ADDRESS is not set");
  return a;
}
