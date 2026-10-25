import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";

// The demo wallet: a devnet keypair that lives in this browser, so anyone can try the shop
// without installing anything. Test money only.
const KEY = "lowball.demoWallet";

export async function loadDemoWallet(): Promise<KeyPairSigner | null> {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(raw)));
  } catch {
    localStorage.removeItem(KEY);
    return null;
  }
}

export async function createDemoWallet(): Promise<KeyPairSigner> {
  const seed = ed25519.utils.randomSecretKey();
  const bytes = new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]);
  localStorage.setItem(KEY, JSON.stringify([...bytes]));
  return createKeyPairSignerFromBytes(bytes);
}

export async function usdcOf(wallet: string): Promise<number> {
  const r = await fetch(`/api/balance?wallet=${wallet}`);
  return r.ok ? (await r.json()).usdc : 0;
}

/** fetch that pays 402s with this signer, capped well above anything in the shop. */
export function payingFetch(signer: KeyPairSigner): typeof fetch {
  const client = x402Client.fromConfig({
    schemes: [{ network: "solana:*", client: new ExactSvmScheme(toClientSvmSigner(signer)) }],
    spendControls: { maxAmountPerPayment: "$5" },
  });
  return wrapFetchWithPayment(fetch, client);
}
