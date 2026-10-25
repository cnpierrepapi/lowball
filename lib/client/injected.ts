import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import {
  address, getTransactionDecoder, getTransactionEncoder,
  type Address, type Transaction, type TransactionModifyingSigner,
} from "@solana/kit";

// Real wallets (Phantom, Solflare, Backpack...) through Wallet Standard, bridged to the kit
// signer x402 wants. A wallet may add instructions before it signs (Phantom adds Lighthouse
// checks, which the facilitator allows), so this hands back the wallet's own transaction
// rather than bolting its signature onto ours.

export type WalletSigner = TransactionModifyingSigner & { address: Address; label: string };

export function solanaWallets(): Wallet[] {
  return getWallets().get().filter((w) => StandardConnect in w.features && SolanaSignTransaction in w.features);
}

// A stable snapshot for useSyncExternalStore; refreshed whenever an extension registers,
// which can happen after page load.
const NONE: Wallet[] = [];
let snapshot: Wallet[] | null = null;
export const walletsSnapshot = () => (snapshot ??= solanaWallets());
export const walletsServerSnapshot = () => NONE;
export function subscribeWallets(cb: () => void): () => void {
  const api = getWallets();
  const changed = () => { snapshot = solanaWallets(); cb(); };
  const offA = api.on("register", changed);
  const offB = api.on("unregister", changed);
  return () => { offA(); offB(); };
}

export async function connectWallet(wallet: Wallet): Promise<WalletSigner> {
  const { accounts } = await (wallet.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect]).connect();
  const account: WalletAccount | undefined = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error("wallet returned no account");
  const sign = (wallet.features[SolanaSignTransaction] as SolanaSignTransactionFeature[typeof SolanaSignTransaction]).signTransaction;
  const encoder = getTransactionEncoder();
  const decoder = getTransactionDecoder();

  return {
    address: address(account.address),
    label: wallet.name,
    async modifyAndSignTransactions(txs) {
      const outputs = await sign(
        ...txs.map((tx) => ({ account, transaction: new Uint8Array(encoder.encode(tx)), chain: "solana:devnet" as const })),
      );
      return outputs.map((o, i) => {
        const signed = decoder.decode(o.signedTransaction) as Transaction;
        // The bytes don't carry the lifetime object; the blockhash is the one we built with.
        return { ...signed, lifetimeConstraint: (txs[i] as { lifetimeConstraint?: unknown }).lifetimeConstraint } as never;
      });
    },
  };
}
