import { beforeAll, describe, expect, it } from "vitest";
import { signOffer, verifyOffer, type Offer } from "./offer";

beforeAll(() => {
  process.env.OFFER_SIGNING_KEY = "11".repeat(32);
});

const offer = (o: Partial<Offer> = {}): Offer => ({
  v: 1,
  item: "overlords",
  deal: { kind: "cash", price: 1_570_000 },
  exp: Date.now() / 1000 + 60,
  nonce: "n1",
  ...o,
});

describe("verifyOffer", () => {
  it("accepts its own offer", () => {
    expect(verifyOffer(signOffer(offer()), "overlords").ok).toBe(true);
  });

  it("turns junk away instead of throwing", () => {
    for (const t of [null, "", "x", "abc.def", "eyJ2IjoxfQ.AA", "eyJ2IjoxfQ.", "...."]) {
      expect(verifyOffer(t, "overlords").ok).toBe(false);
    }
  });

  it("refuses a changed price", () => {
    const [, sig] = signOffer(offer()).split(".");
    const body = Buffer.from(JSON.stringify(offer({ deal: { kind: "cash", price: 1 } }))).toString("base64url");
    expect(verifyOffer(`${body}.${sig}`, "overlords")).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses the wrong item and an expired offer", () => {
    expect(verifyOffer(signOffer(offer()), "other")).toEqual({ ok: false, reason: "wrong_item" });
    expect(verifyOffer(signOffer(offer({ exp: 1 })), "overlords")).toEqual({ ok: false, reason: "expired" });
  });
});
