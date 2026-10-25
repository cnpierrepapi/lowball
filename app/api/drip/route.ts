import { NextRequest, NextResponse } from "next/server";
import { address, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { readFileSync } from "node:fs";
import { send, shopSigner, usdcAccount, usdcBalance } from "@/lib/chain";
import { allow, clientIp } from "@/lib/limits";
import { USDC_DEVNET } from "@/lib/x402";

// Test money for demo wallets, so a judge can buy without hunting for a devnet faucet.
// The merchant is the tap: every sale refills it. Devnet only.
const DRIP = 2_000_000;

let tap: Promise<KeyPairSigner> | undefined;
function merchantSigner(): Promise<KeyPairSigner> {
  tap ??= (() => {
    const raw = process.env.MERCHANT_KEYPAIR ??
      (process.env.NODE_ENV !== "production" ? readFileSync(".keys/merchant.json", "utf8") : undefined);
    if (!raw) throw new Error("MERCHANT_KEYPAIR is not set");
    try {
      return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(raw)));
    } catch {
      throw new Error("MERCHANT_KEYPAIR is not a JSON array of 64 bytes");
    }
  })();
  return tap;
}

export async function POST(req: NextRequest) {
  if (process.env.SOLANA_CLUSTER === "mainnet") return NextResponse.json({ error: "devnet_only" }, { status: 404 });
  const { wallet } = await req.json().catch(() => ({}));
  let to;
  try {
    to = address(String(wallet));
  } catch {
    return NextResponse.json({ error: "bad_wallet" }, { status: 400 });
  }
  if (!allow(`drip:${clientIp(req)}`, 3, 24 * 3_600_000) || !allow(`drip-w:${to}`, 2, 24 * 3_600_000)) {
    return NextResponse.json({ error: "drip_limited" }, { status: 429 });
  }
  const ata = await usdcAccount(to);
  if ((await usdcBalance(ata)) >= 1_000_000) return NextResponse.json({ error: "drip_limited" }, { status: 429 });

  try {
    const [shop, merchant] = await Promise.all([shopSigner(), merchantSigner()]);
    if ((await usdcBalance(await usdcAccount(merchant.address))) < DRIP) {
      console.error("drip: the tap is dry, top up the merchant with devnet USDC");
      return NextResponse.json({ error: "tap_dry" }, { status: 503 });
    }
    const mint = address(USDC_DEVNET);
    const tx = await send([
      getCreateAssociatedTokenIdempotentInstruction({ payer: shop, owner: to, mint, ata }),
      getTransferCheckedInstruction({
        source: await usdcAccount(merchant.address), mint, destination: ata, authority: merchant, amount: BigInt(DRIP), decimals: 6,
      }),
    ]);
    return NextResponse.json({ ok: true, amount: DRIP, tx });
  } catch (e) {
    console.error("drip:", (e as Error).message);
    return NextResponse.json({ error: "chain_busy" }, { status: 503 });
  }
}
