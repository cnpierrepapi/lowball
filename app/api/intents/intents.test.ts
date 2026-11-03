import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import tokens from "@/lib/intents/fixtures/tokens-2026-11-03.json";
import type { StatusReply } from "@/lib/intents/api";

// The intents route end to end: real signed offers, a test database, a fake Aurora (global
// fetch) and the chain mocked (receipts are kept in a set).

const receipts = new Set<string>();
const written: { nonce: string; paid: number; listPrice: number }[] = [];
vi.mock("@/lib/chain", () => ({
  dealExists: vi.fn(async (nonce: string) => receipts.has(nonce)),
  shopSigner: vi.fn(async () => ({ address: "Shop1111111111111111111111111111111111111111" })),
  recordDealIx: vi.fn(async (d: { nonce: string; paid: number; listPrice: number }) => { written.push(d); return d; }),
  send: vi.fn(async (ixs: { nonce: string }[]) => { for (const ix of ixs) receipts.add(ix.nonce); return "sig"; }),
}));

// Outside a real request, Next's connection() throws; here it just returns.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => undefined }));

process.env.OFFER_SIGNING_KEY = "55".repeat(32);
process.env.MERCHANT_ADDRESS = "Shop1111111111111111111111111111111111111111";

const { GET, POST } = await import("./route");
const { testDb, wipe } = await import("@/lib/testing/pglite");
const { setDb } = await import("@/lib/db");
const { shopStore } = await import("@/lib/shop/store");
const { signOffer } = await import("@/lib/offer");
const { readClaim } = await import("@/lib/claim");
const { SOL_USDC } = await import("@/lib/intents/api");

const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const quotes: { amount: string; recipient: string }[] = [];
let status: StatusReply = { status: "PENDING_DEPOSIT" };

vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
  if (url.includes("/api/tokens/")) return Response.json(tokens);
  if (url.includes("/api/quote/")) {
    const b = JSON.parse(String(init?.body));
    quotes.push(b);
    return Response.json({ quote: { depositAddress: `0xdep${quotes.length}`, amountIn: "1", amountInFormatted: "1.76", amountOut: b.amount, deadline: b.deadline } });
  }
  if (url.includes("/api/status/")) return Response.json(status);
  return new Response("{}", { status: 404 });
});

const db = await testDb();
let ip = 0;
beforeAll(() => setDb(db));
beforeEach(async () => {
  await wipe(db);
  receipts.clear();
  written.length = 0;
  quotes.length = 0;
  status = { status: "PENDING_DEPOSIT" };
  ip++;
});

const withKey = () => shopStore(db).setSetting("intents_api_key", "test-key");
const offer = (price = 1_500_000, nonce = crypto.randomUUID(), kind: "cash" | "pledge" = "cash") =>
  ({ nonce, token: signOffer({ v: 1, item: "overlords", deal: kind === "cash" ? { kind, price } : { kind, price, referrals: 2 }, exp: Math.floor(Date.now() / 1000) + 300, nonce }) });
const post = (body: unknown) =>
  POST(new NextRequest("https://shop.test/api/intents", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": `10.9.0.${ip}` } }))
    .then(async (r) => ({ status: r.status, j: await r.json() }));
const startBody = (token: string, over: Record<string, unknown> = {}) =>
  ({ action: "start", item: "overlords", offer: token, originAsset: BASE_USDC, refundTo: "Buyer111111111111111111111111111111111111111", ...over });

describe("the pay-with-any-crypto route", () => {
  it("no key saved: the button stays hidden, and payments are off", async () => {
    expect(await (await GET()).json()).toEqual({ enabled: false, tokens: [] });
    expect((await post(startBody(offer().token))).j.error).toBe("intents_off");
  });

  it("with a key: the short list of tokens", async () => {
    await withKey();
    const j = await (await GET()).json();
    expect(j.enabled).toBe(true);
    expect(j.tokens).toHaveLength(11);
    expect(j.tokens[0]).toMatchObject({ assetId: BASE_USDC, symbol: "USDC", chain: "base" });
  });

  it("the price comes only from the signed offer", async () => {
    await withKey();
    const o = offer(1_500_000);
    const r = await post(startBody(o.token, { price: 10_000 }));
    expect(r.status).toBe(200);
    expect(r.j).toMatchObject({ nonce: o.nonce, depositAddress: "0xdep1", amount: "1.76", symbol: "USDC", chain: "base", status: "PENDING_DEPOSIT" });
    expect(quotes[0]).toMatchObject({ amount: "1500000", recipient: process.env.MERCHANT_ADDRESS, destinationAsset: SOL_USDC });
  });

  it("a forged offer is refused, and Aurora is never asked", async () => {
    await withKey();
    const t = offer().token;
    const r = await post(startBody(t.slice(0, -4) + (t.endsWith("AAAA") ? "BBBB" : "AAAA")));
    expect(r.status).toBe(410);
    expect(quotes).toHaveLength(0);
  });

  it("an offer for another item is refused", async () => {
    await withKey();
    const r = await post(startBody(offer().token, { item: "no-such-thing" }));
    expect(r.status).toBe(404);
    expect(quotes).toHaveLength(0);
  });

  it("a pledge can't be paid this way", async () => {
    await withKey();
    expect(await post(startBody(offer(1_000_000, crypto.randomUUID(), "pledge").token))).toMatchObject({ status: 400, j: { error: "cash_only" } });
  });

  it("an offer already paid can't be paid again", async () => {
    await withKey();
    const o = offer();
    receipts.add(o.nonce);
    expect(await post(startBody(o.token))).toMatchObject({ status: 409, j: { error: "offer_used" } });
    expect(quotes).toHaveLength(0);
  });

  it("a refund address and a listed token are needed", async () => {
    await withKey();
    expect((await post(startBody(offer().token, { refundTo: "" }))).j.error).toBe("bad_refund_address");
    expect((await post(startBody(offer().token, { refundTo: "two words" }))).j.error).toBe("bad_refund_address");
    expect((await post(startBody(offer().token, { originAsset: "nep141:aptos.omft.near" }))).j.error).toBe("bad_token");
    expect(quotes).toHaveLength(0);
  });

  it("status: waiting has no claim; paid writes the receipt and gives the claim", async () => {
    await withKey();
    const o = offer(1_500_000);
    await post(startBody(o.token));
    const waiting = await post({ action: "status", nonce: o.nonce });
    expect(waiting.j).toEqual({ status: "PENDING_DEPOSIT", paid: false });

    status = { status: "SUCCESS", quoteResponse: { quoteRequest: { recipient: process.env.MERCHANT_ADDRESS, destinationAsset: SOL_USDC } }, swapDetails: { amountOut: "1500000" } };
    const paid = await post({ action: "status", nonce: o.nonce });
    expect(paid.j).toMatchObject({ status: "SUCCESS", paid: true });
    expect(readClaim(paid.j.claim)).toEqual({ item: "overlords", nonce: o.nonce, kind: "cash" });
    expect(written).toEqual([expect.objectContaining({ nonce: o.nonce, paid: 1_500_000, listPrice: 2_000_000 })]);
  });

  it("status for a payment that doesn't exist", async () => {
    await withKey();
    expect((await post({ action: "status", nonce: crypto.randomUUID() })).status).toBe(404);
    expect((await post({ action: "status", nonce: "../x" })).status).toBe(404);
  });
});
