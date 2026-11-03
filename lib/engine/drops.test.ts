import { describe, expect, it } from "vitest";
import { dropFloor, dropPhase, FLOOR_RISE, liftAsk, packFloor, packList } from "./drops";
import { openState, step, type Item, type State } from "./negotiate";
import { toMicro } from "./money";
import { packItem } from "../catalog";
import { KINDS, TONES, type Intent } from "./intent";

describe("pack prices", () => {
  it("list is 1.50 plus a cent a point, held to 0..100", () => {
    expect(packList(0)).toBe(toMicro(1.5));
    expect(packList(50)).toBe(toMicro(2));
    expect(packList(100)).toBe(toMicro(2.5));
    expect(packList(250)).toBe(toMicro(2.5));
    expect(packList(-5)).toBe(toMicro(1.5));
    expect(packList(NaN)).toBe(toMicro(1.5));
  });
  it("floor is 55% of list, to the cent", () => {
    expect(packFloor(toMicro(2))).toBe(toMicro(1.1));
    expect(packFloor(toMicro(1.77))).toBe(toMicro(0.97));
  });
  it("a pack item takes its numbers from the rule, and is cash only", () => {
    const i = packItem({ id: "p", title: "P", blurb: "b", score: 80 });
    expect(i).toMatchObject({ list: toMicro(2.3), floor: packFloor(toMicro(2.3)), maxReferrals: 0, kind: "pack" });
  });
});

describe("the floor climbs as copies go", () => {
  const item = { floor: toMicro(1.1), list: toMicro(2) };
  it("starts at the floor and ends halfway to list", () => {
    expect(dropFloor(item, 0, 5)).toBe(item.floor);
    expect(dropFloor(item, 5, 5)).toBe(item.floor + FLOOR_RISE * (item.list - item.floor));
    expect(dropFloor(item, 5, 5)).toBe(toMicro(1.55));
  });
  it("only ever goes up, never under the floor, never over list", () => {
    for (const copies of [1, 2, 5, 7, 100]) {
      let last = 0;
      for (let taken = -1; taken <= copies + 2; taken++) {
        const f = dropFloor(item, taken, copies);
        expect(f).toBeGreaterThanOrEqual(item.floor);
        expect(f).toBeLessThanOrEqual(item.list);
        expect(f).toBeGreaterThanOrEqual(last);
        last = f;
      }
    }
  });
  it("her ask is lifted if the floor rose past it mid-haggle, and left alone otherwise", () => {
    const s: State = { ...openState({ list: toMicro(2) } as Item), ask: toMicro(1.2) };
    expect(liftAsk(s, toMicro(1.3)).ask).toBe(toMicro(1.3));
    expect(liftAsk(s, toMicro(1.1)).ask).toBe(toMicro(1.2));
  });
});

describe("drop phases", () => {
  const d = { copies: 5, taken: 0, opensAt: 1000, closesAt: 2000, cancelled: false };
  it("upcoming, open, sold out, closed, cancelled", () => {
    expect(dropPhase(d, 999)).toBe("upcoming");
    expect(dropPhase(d, 1000)).toBe("open");
    expect(dropPhase({ ...d, taken: 5 }, 1500)).toBe("sold_out");
    expect(dropPhase(d, 2000)).toBe("closed");
    expect(dropPhase({ ...d, cancelled: true }, 1500)).toBe("cancelled");
  });
});

describe("cash only", () => {
  it("a pack never makes a friends deal, whatever the buyer says", () => {
    const item = packItem({ id: "p", title: "P", blurb: "b", score: 50 });
    for (let i = 0; i < 3000; i++) {
      let s = openState(item);
      for (let t = 0; t < 10 && s.status === "open"; t++) {
        const kind = KINDS[Math.floor(Math.random() * KINDS.length)];
        const intent: Intent = { kind, tone: TONES[Math.floor(Math.random() * TONES.length)] };
        if (kind === "referral" && Math.random() < 0.7) intent.referrals = 1 + Math.floor(Math.random() * 10);
        if (kind === "offer") intent.amount = Math.random() * 3;
        const r = step(item, s, intent);
        expect(r.decision.action).not.toMatch(/referral|pledge/);
        s = r.state;
      }
      if (s.deal) {
        expect(s.deal.kind).toBe("cash");
        expect(s.deal.price).toBeGreaterThanOrEqual(item.floor);
      }
    }
  });
});
