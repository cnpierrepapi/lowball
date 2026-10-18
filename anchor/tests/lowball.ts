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
const itemId = (s: string) => {
  const b = Buffer.alloc(32);
  b.write(s);
  return Array.from(b);
};
const item = itemId("overlords");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nonce = () => Array.from(Keypair.generate().publicKey.toBytes().slice(0, 16));
const pda = (seeds: (Buffer | Uint8Array)[], programId = program.programId) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];
const pledgePda = (n: number[]) => pda([Buffer.from("pledge"), Buffer.from(n)]);
const dealPda = (n: number[]) => pda([Buffer.from("deal"), Buffer.from(n)]);
const programData = pda([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));

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
  });

  const initShop = (deployer: Keypair) =>
    program.methods
      .initShop(authority.publicKey)
      .accounts({ program: program.programId, programData, mint, deployer: deployer.publicKey } as any)
      .signers(deployer === authority ? [] : [deployer])
      .rpc();

  describe("shop", () => {
    it("only the upgrade authority can set the shop up", async () => {
      await expectError(initShop(await funded()), "NotAdmin");
      await initShop(authority);
      const shop = await program.account.shop.fetch(pda([Buffer.from("shop")]));
      assert.ok(shop.authority.equals(authority.publicKey));
      assert.ok(shop.mint.equals(mint));
    });
  });

  // A cash purchase the shop saw settle.
  async function recordDeal(who: PublicKey, opts: { item?: number[]; list?: number; paid?: number } = {}) {
    const n = nonce();
    await program.methods
      .recordDeal(n, opts.item ?? item, who, new anchor.BN(opts.list ?? 2 * USDC), new anchor.BN(opts.paid ?? 1.2 * USDC))
      .accounts({ authority: authority.publicKey } as any)
      .rpc();
    return dealPda(n);
  }

  async function openPledge(opts: { price: number; full: number; required: number; deadlineIn: number; buyer?: PublicKey }) {
    const n = nonce();
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + opts.deadlineIn);
    await program.methods
      .openPledge(
        n, item, merchant.publicKey, opts.buyer ?? buyer.publicKey,
        new anchor.BN(opts.price), new anchor.BN(opts.full), opts.required, deadline,
      )
      .accounts({ mint, authority: authority.publicKey } as any)
      .rpc();
    const pledge = pledgePda(n);
    const vault = getAssociatedTokenAddressSync(mint, pledge, true);
    return { n, pledge, vault };
  }

  const pay = (vault: PublicKey, amount: number) => transfer(conn, buyer, buyerAta, vault, buyer, amount);
  const refer = (pledge: PublicKey, deal: PublicKey) =>
    program.methods.recordReferral().accounts({ pledge, deal, authority: authority.publicKey } as any).rpc();
  const release = (pledge: PublicKey) =>
    program.methods.release().accounts({ pledge, merchantAta, rentTo: authority.publicKey } as any).rpc();
  const refund = (pledge: PublicKey) =>
    program.methods.refund().accounts({ pledge, buyerAta, rentTo: authority.publicKey } as any).rpc();
  const cancel = (pledge: PublicKey) =>
    program.methods.cancelPledge().accounts({ pledge, authority: authority.publicKey } as any).rpc();
  const balance = async (a: PublicKey) => Number((await getAccount(conn, a)).amount);
  const gone = async (...accounts: PublicKey[]) => {
    for (const a of accounts) assert.isNull(await conn.getAccountInfo(a), `${a.toBase58()} should be closed`);
  };

  describe("deal receipts", () => {
    it("records a cash deal once per offer", async () => {
      const n = nonce();
      const record = (paid: number) =>
        program.methods
          .recordDeal(n, item, buyer.publicKey, new anchor.BN(2 * USDC), new anchor.BN(paid))
          .accounts({ authority: authority.publicKey } as any)
          .rpc();
      await record(1.57 * USDC);
      const d = await program.account.deal.fetch(dealPda(n));
      assert.equal(d.paid.toNumber(), 1.57 * USDC);
      assert.ok(d.buyer.equals(buyer.publicKey));
      assert.isFalse(d.counted);
      await expectError(record(1 * USDC), "already in use");
    });

    it("refuses a receipt from anyone but the shop", async () => {
      const impostor = await funded();
      await expectError(
        program.methods
          .recordDeal(nonce(), item, buyer.publicKey, new anchor.BN(2 * USDC), new anchor.BN(1))
          .accounts({ authority: impostor.publicKey } as any)
          .signers([impostor])
          .rpc(),
        "ConstraintHasOne",
      );
    });

    it("refuses paid above list", async () => {
      await expectError(recordDeal(buyer.publicKey, { list: 1 * USDC, paid: 2 * USDC }), "BadAmounts");
    });

    it("the shop can close a receipt and get its rent back", async () => {
      const deal = await recordDeal(buyer.publicKey);
      const impostor = await funded();
      await expectError(
        program.methods.closeDeal().accounts({ deal, authority: impostor.publicKey } as any).signers([impostor]).rpc(),
        "ConstraintHasOne",
      );
      await program.methods.closeDeal().accounts({ deal, authority: authority.publicKey } as any).rpc();
      await gone(deal);
    });
  });

  describe("pledges", () => {
    it("friends show up: the merchant gets paid, vault and pledge close", async () => {
      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 2, deadlineIn: 600 });
      const friend1 = Keypair.generate().publicKey;
      const early = await recordDeal(friend1);
      await expectError(refer(pledge, early), "NotFunded"); // nothing paid yet
      await pay(vault, 1 * USDC);

      await expectError(release(pledge), "NotYet");
      await expectError(refer(pledge, await recordDeal(buyer.publicKey)), "SelfReferral");
      await refer(pledge, early);
      assert.isTrue((await program.account.deal.fetch(early)).counted);
      await expectError(refer(pledge, early), "AlreadyCounted"); // same receipt twice
      await expectError(refer(pledge, await recordDeal(friend1)), "AlreadyCounted"); // same friend, new receipt
      await expectError(release(pledge), "NotYet");
      await refer(pledge, await recordDeal(Keypair.generate().publicKey));
      assert.equal((await program.account.pledge.fetch(pledge)).referred.length, 2);

      const before = await balance(merchantAta);
      const rentBefore = await conn.getBalance(authority.publicKey);
      await release(pledge);
      assert.equal((await balance(merchantAta)) - before, 1 * USDC);
      await gone(vault, pledge);
      assert.isAbove(await conn.getBalance(authority.publicKey), rentBefore, "rent came home");
      await expectError(release(pledge), "AccountNotInitialized");
    });

    it("a friend's own pledge, an old purchase, or another item can't count", async () => {
      const old = await recordDeal(Keypair.generate().publicKey);
      await sleep(1000); // let the slot move on
      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 2, deadlineIn: 600 });
      await pay(vault, 1 * USDC);
      await expectError(refer(pledge, old), "OldReceipt");
      await expectError(refer(pledge, await recordDeal(Keypair.generate().publicKey, { item: itemId("other") })), "WrongItem");
      // A pledge account is not a receipt, so it fails the deal's seeds and type.
      const friendsPledge = await openPledge({ price: 1, full: 2 * USDC, required: 1, deadlineIn: 600, buyer: Keypair.generate().publicKey });
      await expectError(refer(pledge, friendsPledge.pledge), "AccountDiscriminatorMismatch");
      // Both pledges are open when the friend buys, so only the one-use rule can stop a double count.
      const second = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 1, deadlineIn: 600 });
      await pay(second.vault, 1 * USDC);
      const shared = await recordDeal(Keypair.generate().publicKey);
      await refer(pledge, shared);
      await refer(pledge, await recordDeal(Keypair.generate().publicKey));
      await expectError(refer(pledge, await recordDeal(Keypair.generate().publicKey)), "Enough");
      await release(pledge);
      await cancel(friendsPledge.pledge);

      // One friend's purchase can't count for two different pledgers.
      await expectError(refer(second.pledge, shared), "AlreadyCounted");
      await refer(second.pledge, await recordDeal(Keypair.generate().publicKey));
      await release(second.pledge);
    });

    it("no friends by the deadline: the buyer gets everything back, no server step needed", async () => {
      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 3, deadlineIn: 4 });
      await pay(vault, 1 * USDC); // the server never hears about this payment
      await refer(pledge, await recordDeal(Keypair.generate().publicKey));
      await expectError(refund(pledge), "NotYet"); // too early
      await sleep(6000);
      await expectError(refer(pledge, await recordDeal(Keypair.generate().publicKey)), "DeadlinePassed");
      await expectError(release(pledge), "NotYet");
      const before = await balance(buyerAta);
      await refund(pledge);
      assert.equal((await balance(buyerAta)) - before, 1 * USDC);
      await gone(vault, pledge);
    });

    it("topping up to the full price releases without the friends, and can't be refunded", async () => {
      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 4, deadlineIn: 4 });
      await pay(vault, 1 * USDC);
      await pay(vault, 1 * USDC); // the gap
      await sleep(6000);
      await expectError(refund(pledge), "NotRefundable");
      const before = await balance(merchantAta);
      await release(pledge);
      assert.equal((await balance(merchantAta)) - before, 2 * USDC);
      await gone(vault, pledge);
    });

    it("a payment that never settled can be cancelled, a paid one can't", async () => {
      const unpaid = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 1, deadlineIn: 600 });
      const impostor = await funded();
      await expectError(
        program.methods.cancelPledge().accounts({ pledge: unpaid.pledge, authority: impostor.publicKey } as any).signers([impostor]).rpc(),
        "ConstraintHasOne",
      );
      const rentBefore = await conn.getBalance(authority.publicKey);
      await cancel(unpaid.pledge);
      await gone(unpaid.vault, unpaid.pledge);
      assert.isAbove(await conn.getBalance(authority.publicKey), rentBefore);

      const paid = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 1, deadlineIn: 600 });
      await pay(paid.vault, 1);
      await expectError(cancel(paid.pledge), "NotEmpty");
    });

    it("rejects bad pledges and outsiders", async () => {
      await expectError(openPledge({ price: 2 * USDC, full: 2 * USDC, required: 1, deadlineIn: 600 }), "BadAmounts");
      await expectError(openPledge({ price: 1 * USDC, full: 2 * USDC, required: 0, deadlineIn: 600 }), "BadReferrals");
      await expectError(openPledge({ price: 1 * USDC, full: 2 * USDC, required: 11, deadlineIn: 600 }), "BadReferrals");
      await expectError(openPledge({ price: 1 * USDC, full: 2 * USDC, required: 1, deadlineIn: -5 }), "DeadlinePassed");
      await expectError(openPledge({ price: 1 * USDC, full: 2 * USDC, required: 1, deadlineIn: 600, buyer: merchant.publicKey }), "BadBuyer");

      const { pledge, vault } = await openPledge({ price: 1 * USDC, full: 2 * USDC, required: 1, deadlineIn: 600 });
      await pay(vault, 1 * USDC);
      const impostor = await funded();
      const deal = await recordDeal(Keypair.generate().publicKey);
      await expectError(
        program.methods.recordReferral().accounts({ pledge, deal, authority: impostor.publicKey } as any).signers([impostor]).rpc(),
        "ConstraintHasOne",
      );
      await refer(pledge, deal);
      // Paying the release to someone who isn't the merchant fails.
      const otherAta = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, impostor.publicKey)).address;
      await expectError(
        program.methods.release().accounts({ pledge, merchantAta: otherAta, rentTo: authority.publicKey } as any).rpc(),
        "ConstraintTokenOwner",
      );
      // And so does sending the rent anywhere but the shop.
      await expectError(
        program.methods.release().accounts({ pledge, merchantAta, rentTo: impostor.publicKey } as any).rpc(),
        "ConstraintAddress",
      );
      await release(pledge);
    });
  });
});
