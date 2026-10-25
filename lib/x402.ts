import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/next";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { address } from "@solana/kit";
import { ConfigError } from "./config";

export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// The public x402.org facilitator verifies and settles on devnet and pays the SOL fee,
// so a buyer only ever needs USDC.
const facilitator = new HTTPFacilitatorClient({
  url: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
});

export const resourceServer = new x402ResourceServer(facilitator)
  .register(SOLANA_DEVNET, new ExactSvmScheme())
  // A payment that fails says why in the server log, not just "402".
  .onAfterVerify(async ({ result }) => {
    if (!result.isValid) console.error("x402 verify invalid:", result.invalidReason, result.invalidMessage ?? "");
  })
  .onVerifyFailure(async ({ error }) => void console.error("x402 verify failed:", error.message))
  // The facilitator sometimes reports a settle as failed ("AlreadyProcessed", a timeout) when the
  // transfer did land. If the chain shows it, it's paid, and the buyer gets what they paid for.
  .onSettleFailure(async ({ error, requirements }) => {
    console.error("x402 settle failed:", error.message);
    const memo = requirements.extra?.memo;
    if (typeof memo !== "string") return;
    const { findPaymentByMemo, usdcAccount } = await import("./chain");
    const ata = await usdcAccount(address(requirements.payTo));
    for (let i = 0; i < 8; i++) {
      const found = await findPaymentByMemo(ata, memo, Number(requirements.amount)).catch(() => null);
      if (found) {
        console.error("x402 settle recovered from chain:", found.signature);
        return { recovered: true as const, result: { success: true, transaction: found.signature, network: requirements.network, payer: found.payer } };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  });

export function merchantAddress(): string {
  const a = process.env.MERCHANT_ADDRESS;
  if (!a) throw new ConfigError("MERCHANT_ADDRESS is not set");
  return a;
}
