// Sets the shop up right after deploy, signed by the upgrade authority (the deployer).
// Run inside the container: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
//   ANCHOR_WALLET=~/.config/solana/id.json npx ts-node --transpile-only scripts/init-shop.ts <shopAuthority> <mint>
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/lowball.json";
import type { Lowball } from "../target/types/lowball";

const [authority, mint] = process.argv.slice(2).map((a) => new PublicKey(a));
if (!authority || !mint) throw new Error("usage: init-shop.ts <shopAuthority> <mint>");

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new anchor.Program<Lowball>(idl as Lowball, provider);
const [programData] = PublicKey.findProgramAddressSync(
  [program.programId.toBuffer()],
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
);
const [shopPda] = PublicKey.findProgramAddressSync([Buffer.from("shop")], program.programId);

(async () => {
  const sig = await program.methods
    .initShop(authority)
    .accounts({ program: program.programId, programData, mint, deployer: provider.wallet.publicKey } as any)
    .rpc();
  const shop = await program.account.shop.fetch(shopPda);
  console.log("shop", shopPda.toBase58(), "authority", shop.authority.toBase58(), "mint", shop.mint.toBase58());
  console.log("tx", sig);
})();
