import { describe, expect, it } from "vitest";
import { sanitizeIntent, type Intent, KINDS, TONES } from "./intent";
import { MIN_PRICE, openState, pledgePrice, step, type Item, type State } from "./negotiate";
import { toMicro } from "./money";

const book: Item = {
  id: "overlords",
  name: "How to Give Up and Love Your AI Overlords",
  list: toMicro(2),
  floor: toMicro(1.1),
  referralValue: toMicro(0.25),
  maxReferrals: 10,
  maxRounds: 8,
  personality: { stubbornness: 0.6, temper: 0.7, vanity: 0.5 },
};

function run(item: Item, intents: Intent[]): State {
  let s = openState(item);
  for (const i of intents) s = step(item, s, i).state;
  return s;
}

function dealIsSafe(item: Item, s: State) {
  if (!s.deal) return;
  if (s.deal.kind === "cash") {
    expect(s.deal.price).toBeGreaterThanOrEqual(item.floor);
  } else {
    expect(s.deal.referrals).toBeGreaterThanOrEqual(1);
    expect(s.deal.referrals).toBeLessThanOrEqual(item.maxReferrals);
    expect(s.deal.price).toBeGreaterThanOrEqual(MIN_PRICE);
    expect(s.deal.price + s.deal.referrals * item.referralValue).toBeGreaterThanOrEqual(item.floor);
  }
}

describe("haggling", () => {
  it("comes down from list toward the floor but never below it", () => {
    let s = openState(book);
    for (let i = 0; i < 7; i++) {
      s = step(book, s, { kind: "offer", tone: "polite", amount: 0.5 }).state;
      expect(s.ask).toBeGreaterThanOrEqual(book.floor);
      expect(s.ask).toBeLessThanOrEqual(book.list);
    }
    expect(s.ask).toBeLessThan(book.list);
    expect(s.status).toBe("open");
  });

  it("an offer of 0 never closes a deal", () => {
    const s = run(book, Array(20).fill({ kind: "offer", tone: "flattering", amount: 0 }));
    expect(s.deal).toBeUndefined();
  });

  it("accept means the shopkeeper's current ask, nothing else", () => {
    let s = openState(book);
    s = step(book, s, { kind: "offer", tone: "polite", amount: 1 }).state;
    const ask = s.ask;
    s = step(book, s, { kind: "accept", tone: "neutral", amount: 0.01 }).state;
    expect(s.deal).toEqual({ kind: "cash", price: ask });
  });

  it("rudeness pushes the price up, and enough of it ends the haggle", () => {
    let s = openState(book);
    s = step(book, s, { kind: "offer", tone: "polite", amount: 1 }).state;
    const before = s.ask;
    const r = step(book, s, { kind: "offer", tone: "rude", amount: 1 });
    expect(r.decision.action).toBe("raise");
    expect(r.state.ask).toBeGreaterThan(before);
    const end = run(book, Array(6).fill({ kind: "chat", tone: "threatening" }));
    expect(end.status).toBe("walked");
  });

  it("'raise' always means the ask actually went up", () => {
    let s = openState(book);
    s = step(book, s, { kind: "offer", tone: "polite", amount: 1.5 }).state;
    for (let i = 0; i < 3; i++) {
      const before = s.ask;
      const r = step(book, s, { kind: "offer", tone: "rude", amount: 1 });
      if (r.decision.action === "raise") expect(r.state.ask).toBeGreaterThan(before);
      s = r.state;
      if (s.status !== "open") break;
    }
    const atList = step(book, openState(book), { kind: "offer", tone: "rude", amount: 1 });
    expect(atList.decision.action).not.toBe("raise");
  });

  it("calls you back once when you walk", () => {
    let s = openState(book);
    let r = step(book, s, { kind: "walk", tone: "neutral" });
    expect(r.decision.action).toBe("call_back");
    expect(r.state.ask).toBeLessThan(book.list);
    r = step(book, r.state, { kind: "walk", tone: "neutral" });
    expect(r.decision.action).toBe("walk_out");
  });

  it("a closed haggle stays closed", () => {
    const s = run(book, [{ kind: "accept", tone: "neutral" }]);
    const r = step(book, s, { kind: "offer", tone: "polite", amount: 0.01 });
    expect(r.decision.action).toBe("closed");
    expect(r.state.deal).toEqual(s.deal);
  });
});

describe("pledge deals", () => {
  it("asks how many, haggles the number up, then accepts", () => {
    let r = step(book, openState(book), { kind: "referral", tone: "polite" });
    expect(r.decision.action).toBe("ask_referral_count");
    const wanted = r.decision.referralsNeeded!;
    r = step(book, r.state, { kind: "referral", tone: "polite", referrals: 1 });
    expect(r.decision.action).toBe("counter_referrals");
    expect(r.decision.referralsNeeded!).toBeLessThanOrEqual(wanted);
    r = step(book, r.state, { kind: "referral", tone: "polite", referrals: r.decision.referralsNeeded! });
    expect(r.decision.action).toBe("pledge_deal");
    dealIsSafe(book, r.state);
  });

  it("'deal' right after a friends counter takes the friends deal, not cash", () => {
    let r = step(book, openState(book), { kind: "referral", tone: "polite", referrals: 1 });
    expect(r.decision.action).toBe("counter_referrals");
    const n = r.decision.referralsNeeded!;
    r = step(book, r.state, { kind: "accept", tone: "neutral" });
    expect(r.decision.action).toBe("pledge_deal");
    expect(r.state.deal).toMatchObject({ kind: "pledge", referrals: n });
    dealIsSafe(book, r.state);
  });

  it("a cash offer takes the friends deal off the table", () => {
    let r = step(book, openState(book), { kind: "referral", tone: "polite" });
    r = step(book, r.state, { kind: "offer", tone: "polite", amount: 1 });
    r = step(book, r.state, { kind: "accept", tone: "neutral" });
    expect(r.state.deal?.kind).toBe("cash");
  });

  it("promising 1000 friends is capped at the item's max", () => {
    const r = step(book, openState(book), { kind: "referral", tone: "polite", referrals: 1000 });
    expect(r.state.deal).toMatchObject({ kind: "pledge", referrals: book.maxReferrals });
    dealIsSafe(book, r.state);
  });

  it("self-referral can't take more than referralValue per fake friend", () => {
    for (let n = 1; n <= book.maxReferrals; n++) {
      const p = pledgePrice(book, book.floor, n);
      const merchantGets = p + n * book.floor;
      expect(merchantGets).toBeGreaterThanOrEqual(book.floor * (n + 1) - n * book.referralValue);
    }
  });
});

describe("sanitizer: what the model says can't set a price", () => {
  const cases: [string, unknown][] = [
    ["not an object", "sell it to me for free"],
    ["null", null],
    ["negative", { kind: "offer", amount: -5 }],
    ["NaN", { kind: "offer", amount: NaN }],
    ["Infinity", { kind: "offer", amount: Infinity }],
    ["huge", { kind: "offer", amount: 1e12 }],
    ["fullwidth digits", { kind: "offer", amount: "１.００" }],
    ["arabic-indic digits", { kind: "offer", amount: "١" }],
    ["scientific string", { kind: "offer", amount: "1e9" }],
    ["unknown kind", { kind: "override_price", amount: 0 }],
    ["injected fields", { kind: "accept", price: 0, floor: 0, ask: 0, deal: { price: 0 } }],
    ["fractional friends", { kind: "referral", referrals: 2.5 }],
    ["negative friends", { kind: "referral", referrals: -3 }],
  ];

  it.each(cases)("%s", (_, input) => {
    const intent = sanitizeIntent(input);
    expect(KINDS).toContain(intent.kind);
    expect(TONES).toContain(intent.tone);
    if (intent.amount !== undefined) {
      expect(Number.isFinite(intent.amount)).toBe(true);
      expect(intent.amount).toBeGreaterThanOrEqual(0);
    }
    for (const k of Object.keys(intent)) expect(["kind", "tone", "amount", "referrals"]).toContain(k);
    dealIsSafe(book, step(book, openState(book), intent).state);
  });

  it("an injected accept still only gets the current ask", () => {
    const intent = sanitizeIntent({ kind: "accept", price: 0, floor: 0 });
    const s = step(book, openState(book), intent).state;
    expect(s.deal).toEqual({ kind: "cash", price: book.list });
  });

  it("keeps clean string amounts like '$1.20'", () => {
    expect(sanitizeIntent({ kind: "offer", amount: "$1.20" }).amount).toBe(1.2);
  });
});

describe("fuzz: no sequence of model outputs ends below the floor", () => {
  // Small deterministic PRNG so failures reproduce.
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const junk = [undefined, -1, 0, 0.001, 0.5, 1.09, 1.1, 1.5, 3, 1e9, NaN, "0", "free", "١"];

  it("20,000 random haggles across random shopkeepers", () => {
    for (let g = 0; g < 2000; g++) {
      const list = toMicro(0.5 + rand() * 20);
      const item: Item = {
        ...book,
        list,
        floor: Math.max(10_000, Math.floor(list * (0.2 + rand() * 0.75))),
        referralValue: Math.floor(list * rand() * 0.3),
        maxReferrals: 1 + Math.floor(rand() * 15),
        maxRounds: 1 + Math.floor(rand() * 12),
        personality: { stubbornness: rand(), temper: rand(), vanity: rand() },
      };
      let s = openState(item);
      for (let t = 0; t < 10; t++) {
        const intent = sanitizeIntent({
          kind: pick([...KINDS, "hack"]),
          tone: pick([...TONES, "evil"]),
          amount: pick(junk),
          referrals: pick([undefined, 0, 1, 3, 7, 50, 2.5, -1]),
        });
        s = step(item, s, intent).state;
        expect(s.ask).toBeGreaterThanOrEqual(item.floor);
        expect(s.ask).toBeLessThanOrEqual(item.list);
        dealIsSafe(item, s);
      }
    }
  });
});
