import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Drops through the real haggle route. The model calls are stubbed: "deal" accepts her ask,
// anything else offers the amount in the message.
vi.mock("@/lib/shopkeeper", async (orig) => {
  const real = await orig<typeof import("@/lib/shopkeeper")>();
  return {
    ...real,
    readIntent: vi.fn(async (_i: unknown, _a: unknown, _h: unknown, msg: string) =>
      msg === "deal" ? { kind: "accept", tone: "neutral" } : msg === "friends" ? { kind: "referral", tone: "neutral", referrals: 3 } : { kind: "offer", tone: "polite", amount: Number(msg) }),
    speak: vi.fn(async (_i: unknown, d: import("@/lib/engine/negotiate").Decision) => real.fallbackLine(d)),
  };
});

process.env.OFFER_SIGNING_KEY = "77".repeat(32);

const { POST: haggle } = await import("./route");
const { testDb, wipe } = await import("@/lib/testing/pglite");
const { setDb } = await import("@/lib/db");
const { shopStore } = await import("@/lib/shop/store");
const { setPaidCheck } = await import("@/lib/shop/service");
const { setGameStore } = await import("@/lib/games/store");
const { itemById } = await import("@/lib/catalog");
const { dropFloor } = await import("@/lib/engine/drops");
const { verifyOffer } = await import("@/lib/offer");

const db = await testDb();
setDb(db);
setPaidCheck(async () => false);
setGameStore(null); // no games here, so every turn is plain haggling
const shop = shopStore(db);
let ip = 0;

const post = (body: unknown) =>
  haggle(new NextRequest("http://shop/api/haggle", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": `10.2.0.${ip}` } }))
    .then(async (r) => ({ status: r.status, j: await r.json() }));

async function packWithDrop(copies: number, opensInMs = -60_000) {
  await shop.addPack({ id: "drop-pack", title: "Pack", blurb: "b", teaser: "t", body: "x", score: 50, leadId: null });
  return shop.schedule({ packId: "drop-pack", copies, opensAt: new Date(Date.now() + opensInMs), closesAt: new Date(Date.now() + 86_400_000) });
}

/** Walks in and shakes on her opening ask. */
async function buyOne() {
  const open = await post({ item: "drop-pack" });
  return post({ session: open.j.session, message: "deal" });
}

beforeEach(async () => {
  await wipe(db);
  ip++;
});

describe("drops through the haggle route", () => {
  it("before it opens: her line with the opening time, and no haggle", async () => {
    await packWithDrop(3, 3_600_000);
    const r = await post({ item: "drop-pack" });
    expect(r.status).toBe(410);
    expect(r.j.error).toBe("upcoming");
    expect(r.j.line).toMatch(/^Not open yet\. Come back \w{3} \d{1,2} \w{3}, \d\d:\d\d UTC\.$/);
    expect(r.j.session).toBeUndefined();
  });

  it("a handshake sets a copy aside under the signed offer's own nonce", async () => {
    const d = await packWithDrop(3);
    const r = await buyOne();
    expect(r.status).toBe(200);
    const check = verifyOffer(r.j.offer, "drop-pack");
    expect(check.ok).toBe(true);
    const holds = await db.query<{ nonce: string }>("SELECT nonce FROM holds WHERE drop_id = $1", [d.id]);
    expect(holds.map((h) => h.nonce)).toEqual([check.ok ? check.offer.nonce : ""]);
  });

  it("when the copies are gone, the next handshake gets 'beaten to it' and no offer", async () => {
    await packWithDrop(1);
    const open = await post({ item: "drop-pack" }); // walked in while one was left
    expect((await buyOne()).j.offer).toBeTruthy();
    const late = await post({ session: open.j.session, message: "deal" });
    expect(late).toMatchObject({ status: 410, j: { error: "sold_out", line: "Sold out. I don't restock." } });
    expect((await post({ item: "drop-pack" })).j.error).toBe("sold_out");
  });

  it("the last copy is beaten to at the handshake itself", async () => {
    const d = await packWithDrop(1);
    const open = await post({ item: "drop-pack" });
    await shop.hold(d.id, "someone-else", 1, new Date(), async () => false);
    // The drop is now sold out, so the route stops her before the handshake.
    expect((await post({ session: open.j.session, message: "deal" })).j.error).toBe("sold_out");
  });

  it("two handshakes at once for the last copy: exactly one gets an offer", async () => {
    await packWithDrop(1);
    const a = await post({ item: "drop-pack" });
    const b = await post({ item: "drop-pack" });
    const both = await Promise.all([post({ session: a.j.session, message: "deal" }), post({ session: b.j.session, message: "deal" })]);
    expect(both.filter((r) => r.j.offer)).toHaveLength(1);
    const loser = both.find((r) => !r.j.offer)!;
    expect(loser.status).toBe(410);
    expect([ "That one's gone. Someone beat you to it.", "Sold out. I don't restock." ]).toContain(loser.j.line);
  });

  it("her floor climbs as copies go, and no deal lands under it", async () => {
    const d = await packWithDrop(5);
    for (let i = 0; i < 4; i++) await shop.hold(d.id, `h${i}`, 1, new Date(), async () => false);
    const item = (await itemById("drop-pack"))!;
    const floor = dropFloor(item, 4, 5);
    expect(floor).toBeGreaterThan(item.floor);
    let r = await post({ item: "drop-pack" });
    for (let i = 0; i < 12 && !r.j.deal; i++) r = await post({ session: r.j.session, message: (item.floor / 1e6).toFixed(2) });
    r = r.j.deal ? r : await post({ session: r.j.session, message: "deal" });
    expect(r.j.deal.price).toBeGreaterThanOrEqual(floor);
  });

  it("no friends deal on a drop", async () => {
    await packWithDrop(3);
    const open = await post({ item: "drop-pack" });
    const r = await post({ session: open.j.session, message: "friends" });
    expect(r.j.action).toBe("hold");
    expect(r.j.offer).toBeUndefined();
  });

  it("the old book is off the shelf, except through a friend's link", async () => {
    expect((await post({ item: "overlords" })).status).toBe(404);
    expect((await post({ item: "overlords", ref: "123e4567-e89b-12d3-a456-426614174000" })).status).toBe(200);
  });

  it("a pack with no drop can't be haggled", async () => {
    await shop.addPack({ id: "nodrop", title: "P", blurb: "b", teaser: "t", body: "x", score: 50, leadId: null });
    expect((await post({ item: "nodrop" })).status).toBe(404);
  });
});
