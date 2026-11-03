import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, wipe } from "../testing/pglite";
import type { Db } from "../db";
import { HOLD_MS, packHash, shopStore, type ShopStore } from "./store";

let db: Db;
let shop: ShopStore;
const T = new Date("2026-11-06T18:00:00Z");
const at = (ms: number) => new Date(T.getTime() + ms);
const unpaid = async () => false;
const H = 3_600_000;

beforeAll(async () => { db = await testDb(); shop = shopStore(db); }, 30_000);
beforeEach(async () => { await wipe(db); });

const pack = (id = "flaky-tests") => shop.addPack({ id, title: "Flaky Tests", blurb: "b", teaser: "t", body: "x", score: 60, leadId: null });
const drop = async (copies = 2) => {
  await pack();
  return shop.schedule({ packId: "flaky-tests", copies, opensAt: T, closesAt: at(24 * H) });
};

describe("packs", () => {
  it("ids are short lowercase slugs (the onchain receipt holds 32 bytes)", async () => {
    await expect(pack("a".repeat(33))).rejects.toThrow();
    await expect(pack("Has-Caps")).rejects.toThrow();
    await expect(pack("ok-slug-1")).resolves.toMatchObject({ id: "ok-slug-1" });
  });
  it("each pack gets a fingerprint for the onchain record, and the hook records the tx once", async () => {
    const p = await pack();
    expect(p.hash).toBe(packHash(p));
    expect(p.hash).not.toBe(packHash({ ...p, body: "y" }));
    expect(p.onchainTx).toBeNull();
    await shop.setOnchainTx(p.id, "tx1");
    await shop.setOnchainTx(p.id, "tx2");
    expect((await shop.pack(p.id))!.onchainTx).toBe("tx1");
  });
});

describe("drops", () => {
  it("a pack drops once; a cancelled drop frees it", async () => {
    const d = await drop();
    await expect(shop.schedule({ packId: "flaky-tests", copies: 3, opensAt: at(H), closesAt: at(2 * H) })).rejects.toThrow();
    expect(await shop.cancel(d.id, at(-H))).toBe(true);
    await expect(shop.schedule({ packId: "flaky-tests", copies: 3, opensAt: at(H), closesAt: at(2 * H) })).resolves.toBeTruthy();
  });
  it("closing must come after opening, and copies are 1 to 100", async () => {
    await pack();
    await expect(shop.schedule({ packId: "flaky-tests", copies: 2, opensAt: T, closesAt: T })).rejects.toThrow();
    await expect(shop.schedule({ packId: "flaky-tests", copies: 0, opensAt: T, closesAt: at(H) })).rejects.toThrow();
  });
  it("can't be cancelled once open", async () => {
    const d = await drop();
    expect(await shop.cancel(d.id, at(1))).toBe(false);
  });
  it("only a pack that exists can drop", async () => {
    await expect(shop.schedule({ packId: "nope", copies: 2, opensAt: T, closesAt: at(H) })).rejects.toThrow();
  });
});

describe("holding copies", () => {
  it("no more holds than copies", async () => {
    const d = await drop(2);
    expect(await shop.hold(d.id, "n1", 1, at(1), unpaid)).toBe(true);
    expect(await shop.hold(d.id, "n2", 1, at(2), unpaid)).toBe(true);
    expect(await shop.hold(d.id, "n3", 1, at(3), unpaid)).toBe(false);
    expect(await shop.drop(d.id, at(4).getTime())).toMatchObject({ held: 2, sold: 0, phase: "sold_out" });
  });
  it("not before it opens, not after it closes, not when cancelled", async () => {
    const d = await drop(2);
    expect(await shop.hold(d.id, "early", 1, at(-1), unpaid)).toBe(false);
    expect(await shop.hold(d.id, "late", 1, at(24 * H), unpaid)).toBe(false);
    await pack("other");
    const c = await shop.schedule({ packId: "other", copies: 2, opensAt: at(H), closesAt: at(2 * H) });
    await shop.cancel(c.id, T);
    expect(await shop.hold(c.id, "c", 1, at(H + 1), unpaid)).toBe(false);
  });
  it("an unpaid hold goes back on the shelf once its time is up", async () => {
    const d = await drop(1);
    expect(await shop.hold(d.id, "n1", 1, at(1), unpaid)).toBe(true);
    expect(await shop.hold(d.id, "n2", 1, at(HOLD_MS), unpaid)).toBe(false); // not quite up
    expect(await shop.hold(d.id, "n2", 1, at(HOLD_MS + 1), unpaid)).toBe(true);
  });
  it("a paid hold becomes sold and stays gone", async () => {
    const d = await drop(1);
    await shop.hold(d.id, "n1", 1, at(1), unpaid);
    const paid = async (n: string) => n === "n1";
    expect(await shop.hold(d.id, "n2", 1, at(HOLD_MS + 5), paid)).toBe(false);
    expect(await shop.drop(d.id, at(HOLD_MS + 6).getTime())).toMatchObject({ sold: 1, held: 0, phase: "sold_out" });
  });
  it("if the chain can't be asked, the hold stays taken (never oversell)", async () => {
    const d = await drop(1);
    await shop.hold(d.id, "n1", 1, at(1), unpaid);
    const down = async () => { throw new Error("rpc down"); };
    expect(await shop.hold(d.id, "n2", 1, at(HOLD_MS + 5), down)).toBe(false);
  });
  it("two handshakes for the last copy: one gets it", async () => {
    const d = await drop(1);
    const r = await Promise.all([shop.hold(d.id, "a", 1, at(1), unpaid), shop.hold(d.id, "b", 1, at(1), unpaid)]);
    expect(r.filter(Boolean)).toHaveLength(1);
  });
  it("the same nonce can't hold twice", async () => {
    const d = await drop(2);
    expect(await shop.hold(d.id, "n1", 1, at(1), unpaid)).toBe(true);
    expect(await shop.hold(d.id, "n1", 1, at(2), unpaid)).toBe(false);
  });
});

describe("settings", () => {
  it("set-once only works the first time", async () => {
    expect(await shop.setSettingOnce("admin", "a")).toBe(true);
    expect(await shop.setSettingOnce("admin", "b")).toBe(false);
    expect(await shop.setting("admin")).toBe("a");
  });
});
