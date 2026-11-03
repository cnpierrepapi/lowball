import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import tokens from "./fixtures/tokens-2026-11-03.json";
import { testDb, wipe } from "../testing/pglite";
import type { Db } from "../db";
import { shopStore } from "../shop/store";
import { payOptions, SOL_USDC, type StatusReply } from "./api";
import { checkIntent, DEADLINE_MS, HOLD_MARGIN_MS, intentFor, startIntent, type PayDeps } from "./pay";

// The cross-chain payment against a fake Aurora built from the documented response shapes.

const MERCHANT = "Shop1111111111111111111111111111111111111111";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL_BUYER = "Buyer111111111111111111111111111111111111111";
const EVM_BUYER = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-11-03T12:00:00Z");

/** A fake Aurora: records quote requests, answers status from `status`. */
function aurora() {
  const quotes: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let n = 0;
  const state = { status: { status: "PENDING_DEPOSIT" } as StatusReply };
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes("/api/tokens/")) return Response.json(tokens);
    if (url.includes("/api/quote/")) {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      n++;
      return Response.json({ quote: { depositAddress: `0xdeposit${n}`, amountIn: "1760000", amountInFormatted: "1.76", amountOut: body.amount, deadline: body.deadline } });
    }
    if (url.includes("/api/status/")) return Response.json(state.status);
    return new Response("{}", { status: 404 });
  };
  return { fetch, quotes, calls, state };
}

/** A correct SUCCESS for `price` micro-USDC. */
const success = (amountOut: string, over: { recipient?: string; destinationAsset?: string } = {}): StatusReply => ({
  status: "SUCCESS",
  quoteResponse: { quoteRequest: { recipient: MERCHANT, destinationAsset: SOL_USDC, ...over } },
  swapDetails: { amountOut },
});

let db: Db;
let a: ReturnType<typeof aurora>;
let receipts: { nonce: string; item: string; price: number; payer: string | null }[];
let receiptOk: boolean;
let deps: PayDeps;

beforeAll(async () => { db = await testDb(); }, 30_000);
beforeEach(async () => {
  await wipe(db);
  a = aurora();
  receipts = [];
  receiptOk = true;
  deps = {
    db, apiKey: "test-key", merchant: MERCHANT, fetch: a.fetch, now: () => NOW,
    writeReceipt: async (p) => { if (!receiptOk) throw new Error("rpc down"); receipts.push(p); return true; },
  };
});

const shop = () => shopStore(db);
const start = (nonce = "n1", over: Partial<Parameters<typeof startIntent>[1]> = {}) =>
  startIntent(deps, { nonce, item: "pk1", price: 1_750_000, originAsset: BASE_USDC, refundTo: SOL_BUYER, dropHold: false, ...over });

/** A one-copy drop with a copy held under `nonce`. */
async function heldCopy(nonce: string) {
  await shop().addPack({ id: "pk1", title: "Pack", blurb: "b", teaser: "t", body: "x", score: 50, leadId: null });
  const d = await shop().schedule({ packId: "pk1", copies: 1, opensAt: new Date(NOW.getTime() - 60_000), closesAt: new Date(NOW.getTime() + 86_400_000) });
  expect(await shop().hold(d.id, nonce, 1_750_000, NOW, async () => false)).toBe(true);
  return d;
}
const holdRow = async (nonce: string) =>
  (await db.query<{ expires_at: string; sold_at: string | null; released_at: string | null }>("SELECT expires_at, sold_at, released_at FROM holds WHERE nonce = $1", [nonce]))[0];

describe("what buyers can pay with", () => {
  it("only the short list, in its order", async () => {
    const t = await payOptions("k", a.fetch);
    expect(t.map((x) => `${x.blockchain} ${x.symbol}`)).toEqual([
      "base USDC", "base ETH", "arb USDC", "arb ETH", "eth USDC", "eth ETH", "eth USDT", "sol USDC", "sol SOL", "tron USDT", "btc BTC",
    ]);
  });
});

describe("starting a payment", () => {
  it("asks for exactly the offer's price in USDC on Solana, delivered to the shop", async () => {
    const r = await start();
    expect(a.quotes).toHaveLength(1);
    expect(a.quotes[0]).toMatchObject({
      dry: false, swapType: "EXACT_OUTPUT", amount: "1750000", destinationAsset: SOL_USDC, recipient: MERCHANT,
      originAsset: BASE_USDC, refundTo: SOL_BUYER, deadline: new Date(NOW.getTime() + DEADLINE_MS).toISOString(),
    });
    expect(r).toMatchObject({ nonce: "n1", depositAddress: "0xdeposit1", amountInText: "1.76", status: "PENDING_DEPOSIT", price: 1_750_000 });
  });

  it("one payment per offer: asking again gives the same address, no second quote", async () => {
    await start();
    const again = await start("n1", { originAsset: "nep141:btc.omft.near" });
    expect(a.quotes).toHaveLength(1);
    expect(again.depositAddress).toBe("0xdeposit1");
  });

  it("a drop copy's hold is stretched past the deadline", async () => {
    await heldCopy("n1");
    await start("n1", { dropHold: true });
    expect(new Date((await holdRow("n1")).expires_at).getTime()).toBe(NOW.getTime() + DEADLINE_MS + HOLD_MARGIN_MS);
  });

  it("no live hold: 'copy_gone', and Aurora is never asked", async () => {
    await heldCopy("n1");
    await shop().releaseHold("n1", NOW);
    await expect(start("n1", { dropHold: true })).rejects.toThrow("copy_gone");
    expect(a.quotes).toHaveLength(0);
    expect(await intentFor(db, "n1")).toBeUndefined();
  });
});

describe("checking a payment", () => {
  it("while it travels: the status is saved, nothing is paid", async () => {
    await start();
    a.state.status = { status: "PROCESSING" };
    const c = await checkIntent(deps, "n1");
    expect(c).toMatchObject({ paid: false, row: { status: "PROCESSING" } });
    expect(receipts).toHaveLength(0);
  });

  it("unknown payment: nothing", async () => {
    expect(await checkIntent(deps, "nope")).toBeUndefined();
  });

  it("SUCCESS that matches: receipt written once, copy sold, paid", async () => {
    await heldCopy("n1");
    await start("n1", { dropHold: true });
    a.state.status = success("1750000");
    const c = await checkIntent(deps, "n1");
    expect(c?.paid).toBe(true);
    expect(receipts).toEqual([{ nonce: "n1", item: "pk1", price: 1_750_000, payer: SOL_BUYER }]);
    expect((await holdRow("n1")).sold_at).not.toBeNull();
    // Final: Aurora isn't asked again, and the receipt isn't written twice.
    const asked = a.calls.length;
    expect((await checkIntent(deps, "n1"))?.paid).toBe(true);
    expect(a.calls.length).toBe(asked);
    expect(receipts).toHaveLength(1);
  });

  it("refund address on another chain: the receipt names no buyer", async () => {
    await start("n1", { refundTo: EVM_BUYER });
    a.state.status = success("1750000");
    await checkIntent(deps, "n1");
    expect(receipts[0].payer).toBeNull();
  });

  it("SUCCESS to someone else's address is not paid, and the copy goes back", async () => {
    await heldCopy("n1");
    await start("n1", { dropHold: true });
    a.state.status = success("1750000", { recipient: "Other111111111111111111111111111111111111111" });
    expect(await checkIntent(deps, "n1")).toMatchObject({ paid: false, row: { status: "FAILED" } });
    expect(receipts).toHaveLength(0);
    expect((await holdRow("n1")).released_at).not.toBeNull();
  });

  it("SUCCESS in some other token is not paid", async () => {
    await start();
    a.state.status = success("1750000", { destinationAsset: BASE_USDC });
    expect(await checkIntent(deps, "n1")).toMatchObject({ paid: false, row: { status: "FAILED" } });
  });

  it("SUCCESS for less than the price is not paid; the exact price is", async () => {
    await start("n1");
    a.state.status = success("1749999");
    expect(await checkIntent(deps, "n1")).toMatchObject({ paid: false, row: { status: "FAILED" } });
    await start("n2");
    a.state.status = success("1750000");
    expect((await checkIntent(deps, "n2"))?.paid).toBe(true);
  });

  it("SUCCESS with no amount is not paid", async () => {
    await start();
    a.state.status = { ...success("0"), swapDetails: {} };
    expect(await checkIntent(deps, "n1")).toMatchObject({ paid: false, row: { status: "FAILED" } });
  });

  it("REFUNDED: not paid, and the copy goes back on the shelf", async () => {
    await heldCopy("n1");
    await start("n1", { dropHold: true });
    a.state.status = { status: "REFUNDED" };
    expect(await checkIntent(deps, "n1")).toMatchObject({ paid: false, row: { status: "REFUNDED" } });
    expect((await holdRow("n1")).released_at).not.toBeNull();
    expect(receipts).toHaveLength(0);
  });

  it("still waiting: the copy stays held", async () => {
    await heldCopy("n1");
    await start("n1", { dropHold: true });
    a.state.status = { status: "PENDING_DEPOSIT" };
    await checkIntent(deps, "n1");
    expect(await holdRow("n1")).toMatchObject({ sold_at: null, released_at: null });
  });

  it("the receipt can't be written yet: not paid, not sold, tried again next time", async () => {
    await heldCopy("n1");
    await start("n1", { dropHold: true });
    a.state.status = success("1750000");
    receiptOk = false;
    expect(await checkIntent(deps, "n1")).toMatchObject({ paid: false, row: { status: "SUCCESS", receiptWritten: false } });
    expect((await holdRow("n1")).sold_at).toBeNull();
    receiptOk = true;
    expect((await checkIntent(deps, "n1"))?.paid).toBe(true);
    expect((await holdRow("n1")).sold_at).not.toBeNull();
  });
});
