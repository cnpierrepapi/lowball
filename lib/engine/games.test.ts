import { describe, expect, it } from "vitest";
import { askAfterGame, GAME_MAX_SHARE, GAME_TARGET, gamePlan, gameResult, gameToOffer, offerGame } from "./games";
import { openState, type Decision, type Item, type State } from "./negotiate";
import { toMicro } from "./money";
import { GAMES } from "../games/replay";
import { allowedNumbers, fallbackLine, lineIsHonest } from "../shopkeeper";

const book: Item = {
  id: "overlords", name: "Book", list: toMicro(2), floor: toMicro(1.1), referralValue: toMicro(0.25),
  maxReferrals: 6, maxRounds: 8, personality: { stubbornness: 0.6, temper: 0.7, vanity: 0.5 },
};

const counter = (s: State): Decision => ({ action: "counter", ask: s.ask, mood: s.mood, insulted: false });
// A haggle id whose game comes up at round 3.
const early = Array.from({ length: 100 }, (_, i) => `h${i}`).find((h) => gamePlan(h).round === 3)!;
const ready = (over: Partial<State> = {}): State => ({ ...openState(book), round: 3, ask: toMicro(1.8), ...over });

describe("when she gets bored", () => {
  it("offers a game once the planned round comes, after a counter", () => {
    expect(gameToOffer(book, ready(), counter(ready()), early)).toBe(gamePlan(early).kind);
  });
  it("not before the planned round", () => {
    const s = ready({ round: 2 });
    expect(gameToOffer(book, s, counter(s), early)).toBeUndefined();
  });
  it("only once per haggle", () => {
    const s = ready({ gameOffered: true });
    expect(gameToOffer(book, s, counter(s), early)).toBeUndefined();
  });
  it("not when she's angry", () => {
    const s = ready({ mood: -0.5 });
    expect(gameToOffer(book, s, counter(s), early)).toBeUndefined();
  });
  it("not when her ask is already near the floor", () => {
    const s = ready({ ask: book.floor + toMicro(0.05) });
    expect(gameToOffer(book, s, counter(s), early)).toBeUndefined();
  });
  it("not after a deal, a walk-out or a raise", () => {
    for (const action of ["deal", "walk_out", "raise", "pledge_deal", "final_offer"] as const) {
      expect(gameToOffer(book, ready(), { ...counter(ready()), action }, early)).toBeUndefined();
    }
    expect(gameToOffer(book, ready({ status: "deal" }), counter(ready()), early)).toBeUndefined();
  });
  it("the plan is fixed per haggle: asking again doesn't reroll it", () => {
    expect(gamePlan("abc")).toEqual(gamePlan("abc"));
    const plans = Array.from({ length: 200 }, (_, i) => gamePlan(`id-${i}`));
    expect(new Set(plans.map((p) => p.round))).toEqual(new Set([3, 4, 5]));
    expect(new Set(plans.map((p) => p.kind))).toEqual(new Set(GAMES));
  });
  it("offering keeps her ask and marks the game as used up", () => {
    const s = ready();
    const r = offerGame(s, counter(s), "snake");
    expect(r.state.gameOffered).toBe(true);
    expect(r.decision).toMatchObject({ action: "entertain_me", ask: s.ask, game: "snake" });
  });
});

describe("what a score is worth", () => {
  const ask = toMicro(1.8);
  it("a score of zero changes nothing", () => {
    for (const k of GAMES) expect(askAfterGame(book, ask, k, 0)).toBe(ask);
  });
  it("a perfect game takes half the gap to the floor off", () => {
    for (const k of GAMES) {
      expect(askAfterGame(book, ask, k, GAME_TARGET[k])).toBe(ask - (ask - book.floor) * GAME_MAX_SHARE);
    }
  });
  it("beating the target earns no more than a perfect game", () => {
    for (const k of GAMES) expect(askAfterGame(book, ask, k, 10_000)).toBe(askAfterGame(book, ask, k, GAME_TARGET[k]));
  });
  it("a better score never costs more", () => {
    for (const k of GAMES) {
      for (let s = 1; s <= GAME_TARGET[k]; s++) expect(askAfterGame(book, ask, k, s)).toBeLessThanOrEqual(askAfterGame(book, ask, k, s - 1));
    }
  });
  it("never goes under the floor or over the ask, whatever the score", () => {
    const odd = [NaN, Infinity, -Infinity, -5, 1e12, 0.5];
    for (let i = 0; i < 5000; i++) {
      const a = book.floor + Math.floor(Math.random() * (book.list - book.floor + 1));
      const score = i < odd.length ? odd[i] : Math.floor(Math.random() * 60) - 10;
      for (const k of GAMES) {
        const out = askAfterGame(book, a, k, score);
        expect(out).toBeGreaterThanOrEqual(book.floor);
        expect(out).toBeLessThanOrEqual(a);
      }
    }
  });
  it("an ask already at the floor stays at the floor", () => {
    expect(askAfterGame(book, book.floor, "snake", 15)).toBe(book.floor);
  });
  it("a game on a closed haggle moves nothing", () => {
    const s = ready({ status: "deal", deal: { kind: "cash", price: toMicro(1.5) } });
    expect(gameResult(book, s, "snake", 15).decision.action).toBe("closed");
    expect(gameResult(book, s, "snake", 15).state.ask).toBe(s.ask);
  });
  it("after a game, 'deal' means her new cash price, not an old friends offer", () => {
    const s = ready({ referralOnTable: true, referralCounter: 3 });
    const r = gameResult(book, s, "stack", 20);
    expect(r.state.referralOnTable).toBe(false);
    expect(r.decision).toMatchObject({ action: "game_result", score: 20, ask: r.state.ask });
    expect(r.state.ask).toBeLessThan(s.ask);
  });
});

describe("her lines about games stay honest", () => {
  it("she may say the score the server worked out", () => {
    const s = ready();
    const d = gameResult(book, s, "snake", 7).decision;
    expect(allowedNumbers(book, d, { kind: "chat", tone: "neutral" }).has("7")).toBe(true);
    expect(allowedNumbers(book, counter(s), { kind: "chat", tone: "neutral" }).has("7")).toBe(false);
  });
  it("the safe fallback lines pass the honesty guard", () => {
    const s = ready();
    const chat = { kind: "chat", tone: "neutral" } as const;
    const offered = offerGame(s, counter(s), "stack").decision;
    const scored = gameResult(book, s, "snake", 9).decision;
    for (const d of [offered, scored]) expect(lineIsHonest(fallbackLine(d), allowedNumbers(book, d, chat))).toBe(true);
  });
});
