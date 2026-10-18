import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint, getAccount, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo, transfer,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { Lowball } from "../target/types/lowball";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Lowball as Program<Lowball>;
const conn = provider.connection;
const authority = (provider.wallet as anchor.Wallet).payer;

const USDC = 1_000_000;
const item = Buffer.alloc(32);
item.write("overlords");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nonce = () => Array.from(Keypair.generate().publicKey.toBytes().slice(0, 16));
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const shopPda = pda([Buffer.from("shop")]);
const pledgePda = (n: number[]) => pda([Buffer.from("pledge"), Buffer.from(n)]);

// Capture first, assert after: an assert.fail inside try/catch can match its own message.
async function expectError(p: Promise<unknown>, code: string) {
  let err: any;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected ${code}, but it succeeded`);
  const s = String(err?.error?.errorCode?.code ?? err?.message ?? err);
  assert.include(s + " " + JSON.stringify(err?.logs ?? []), code);
}

async function funded(sol = 2) {
  const k = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL));
  return k;
}

describe("lowball", () => {
  let mint: PublicKey;
  let merchant: Keypair, buyer: Keypair;
  let merchantAta: PublicKey, buyerAta: PublicKey;

  before(async () => {
    mint = await createMint(conn, authority, authority.publicKey, null, 6);
    merchant = await funded();
    buyer = await funded();
    merchantAta = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, merchant.publicKey)).address;
    buyerAta = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, buyer.publicKey)).address;
    await mintTo(conn, authority, mint, buyerAta, authority, 100 * USDC);
    await program.methods.initShop().accounts({ mint, authority: authority.publicKey } as any).rpc();
  });

  async function openPledge(opts: { price: number; full: number; required: number; deadlineIn: number }) {
    const n = nonce();
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + opts.deadlineIn);
    await program.methods
      .openPledge(n, Array.from(item), merchant.publicKey, new anchor.BN(opts.price), new anchor.BN(opts.full), opts.required, deadline)
      .accounts({ mint, authority: authority.publicKey } as any)
      .rpc();
    const pledge = pledgePda(n);
    const vault = getAssociatedTokenAddressSync(mint, pledge, true);
    return { n, pledge, vault };
  }

  const pay = (vault: PublicKey, amount: number) => transfer(conn, buyer, buyerAta, vault, buyer, amount);
  const fund = (pledge: PublicKey) =>
    program.methods.fundPledge(buyer.publicKey).accounts({ pledge, authority: authority.publicKey } as any).rpc();
  const refer = (pledge: PublicKey, who: PublicKey) =>
    program.methods.recordReferral(who).accounts({ pledge, authority: authority.publicKey } as any).rpc();
  const release = (pledge: PublicKey) =>
    program.methods.release().accounts({ pledge, merchantAta, rentTo: authority.publicKey } as any).rpc();
  const refund = (pledge: PublicKey) =>
    program.methods.refund().accounts({ pledge, buyerAta, rentTo: authority.publicKey } as any).rpc();
  const balance = async (a: PublicKey) => Number((await getAccount(conn, a)).amount);

  describe("deal receipts", () => {
    it("records a cash deal once per offer", async () => {
      const n = nonce();
      await program.methods
        .recordDeal(n, Array.from(item), buyer.publicKey, new anchor.BN(2 * USDC), new anchor.BN(1.57 * USDC))
        .accounts({ authority: authority.publicKey } as any)
        .rpc();
      const d = await program.account.deal.fetch(pda([Buffer.from("deal"), Buffer.from(n)]));
      assert.equal(d.paid.toNumber(), 1.57 * USDC);
      assert.ok(d.buyer.equals(buyer.publicKey));
      await expectError(
        program.methods
          .recordDeal(n, Array.from(item), buyer.publicKey, new anchor.BN(2 * USDC), new anchor.BN(1 * USDC))
          .accounts({ authority: authority.publicKey } as any)
          .rpc(),
        "already in use",
      );
    });

    it("refuses a receipt from anyone but the shop", async () => {
      const impostor = await funded();
      await expectError(
        program.methods
          .recordDeal(nonce(), Array.from(item), buyer.publicKey, new anchor.BN(2 * USDC), new anchor.BN(1))
          .accounts({ authority: impostor.publicKey } as any)
          .signers([impostor])
          .rpc(),
        "ConstraintHasOne",
      );
    });

    it("refuses paid above list", async () => {
      await expectError(
        program.methods
          .recordDeal(nonce(), Array.from(item), buyer.publicKey, new anchor.BN(1 * USDC), new anchor.BN(2 * USDC))
          .accounts({ authority: authority.publicKey } as any)
          .rpc(),
        "BadAmounts",
      );
    });
  });

  describe("pledges", () => {
    it("friends show up: the merchant gets paid and the vault closes", async () => {
      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 2, deadlineIn: 600 });
      await expectError(fund(pledge), "NotFunded"); // nothing paid yet
      await pay(vault, 1 * USDC);
      await fund(pledge);

      await expectError(release(pledge), "NotYet");
      await expectError(refer(pledge, buyer.publicKey), "SelfReferral");
      const friend1 = Keypair.generate().publicKey;
      await refer(pledge, friend1);
      await expectError(refer(pledge, friend1), "already in use"); // same friend twice
      await expectError(release(pledge), "NotYet");
      await refer(pledge, Keypair.generate().publicKey);

      const before = await balance(merchantAta);
      await release(pledge);
      assert.equal((await balance(merchantAta)) - before, 1 * USDC);
      assert.isNull(await conn.getAccountInfo(vault), "vault closed");
      const p = await program.account.pledge.fetch(pledge);
      assert.deepEqual(p.status, { released: {} });
      // The vault is gone, so a second release can't even load its accounts.
      await expectError(release(pledge), "AccountNotInitialized");
    });

    it("no friends by the deadline: the buyer gets everything back", async () => {
      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 3, deadlineIn: 4 });
      await pay(vault, 1 * USDC);
      await fund(pledge);
      await refer(pledge, Keypair.generate().publicKey);
      await expectError(refund(pledge), "NotYet"); // too early
      await sleep(6000);
      await expectError(refer(pledge, Keypair.generate().publicKey), "DeadlinePassed");
      await expectError(release(pledge), "NotYet");
      const before = await balance(buyerAta);
      await refund(pledge);
      assert.equal((await balance(buyerAta)) - before, 1 * USDC);
      assert.isNull(await conn.getAccountInfo(vault), "vault closed");
      assert.deepEqual((await program.account.pledge.fetch(pledge)).status, { refunded: {} });
    });

    it("topping up to the full price releases without the friends, and can't be refunded", async () => {
      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 4, deadlineIn: 4 });
      await pay(vault, 1 * USDC);
      await fund(pledge);
      await pay(vault, 1 * USDC); // the gap
      await sleep(6000);
      await expectError(refund(pledge), "NotRefundable");
      const before = await balance(merchantAta);
      await release(pledge);
      assert.equal((await balance(merchantAta)) - before, 2 * USDC);
      assert.deepEqual((await program.account.pledge.fetch(pledge)).status, { toppedUp: {} });
    });

    it("rejects bad pledges and outsiders", async () => {
      await expectError(openPledge({ price: 2 * USDC, full: 2 * USDC, required: 1, deadlineIn: 600 }), "BadAmounts");
      await expectError(openPledge({ price: 1 * USDC, full: 2 * USDC, required: 0, deadlineIn: 600 }), "BadReferrals");
      await expectError(openPledge({ price: 1 * USDC, full: 2 * USDC, required: 1, deadlineIn: -5 }), "DeadlinePassed");
      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 1, deadlineIn: 600 });
      await pay(vault, 1 * USDC);
      const impostor = await funded();
      await expectError(
        program.methods.fundPledge(impostor.publicKey).accounts({ pledge, authority: impostor.publicKey } as any).signers([impostor]).rpc(),
        "ConstraintHasOne",
      );
      await fund(pledge);
      await expectError(
        program.methods.recordReferral(Keypair.generate().publicKey).accounts({ pledge, authority: impostor.publicKey } as any).signers([impostor]).rpc(),
        "ConstraintHasOne",
      );
      // Paying the release to someone who isn't the merchant fails.
      const otherAta = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, impostor.publicKey)).address;
      await refer(pledge, Keypair.generate().publicKey);
      await expectError(
        program.methods.release().accounts({ pledge, merchantAta: otherAta, rentTo: authority.publicKey } as any).rpc(),
        "ConstraintTokenOwner",
      );
      await release(pledge);
    });
  });
});
