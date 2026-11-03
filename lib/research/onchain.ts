import type { Pack } from "../shop/store";

// The hook for putting a pack's fingerprint onchain, so anyone can check the pack sold is the
// pack she wrote on the day she wrote it.
//
// Not wired yet: it needs a new instruction in the Solana program (a program upgrade, done from
// a local machine with the upgrade key). When that exists, this function sends the transaction
// with pack.hash and calls shopStore(db).setOnchainTx(pack.id, signature). Until then it does
// nothing, and packs.onchain_tx stays empty, which the notebook shows as "not onchain yet".
export async function recordPackHash(pack: Pick<Pack, "id" | "hash">): Promise<string | null> {
  void pack;
  return null;
}
