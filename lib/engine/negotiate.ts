import { CENT, clamp, toCents, toMicro } from "./money";
import type { Intent, Tone } from "./intent";

export interface Personality {
  stubbornness: number; // 0..1, how slowly the ask comes down
  temper: number; // 0..1, how hard rudeness lands
  vanity: number; // 0..1, how much flattery works
}

export interface Item {
  id: string;
  name: string;
  list: number; // micro-USDC
  floor: number; // micro-USDC, secret, never sold below in cash
  referralValue: number; // micro-USDC a new customer is worth to the merchant
  maxReferrals: number;
  maxRounds: number;
  personality: Personality;
}

export type Deal =
  | { kind: "cash"; price: number }
  | { kind: "pledge"; price: number; referrals: number };

export interface State {
  ask: number;
  round: number;
  mood: number; // -1..1
  status: "open" | "deal" | "walked";
  calledBack: boolean;
  referralCounter?: number; // friends the shopkeeper is currently asking for
  referralOnTable?: boolean; // the last thing he said was a friends number, so "deal" means that deal
  deal?: Deal;
}

export type Action =
  | "counter"
  | "raise" // rudeness pushed the ask up
  | "final_offer"
  | "deal"
  | "ask_referral_count"
  | "counter_referrals"
  | "pledge_deal"
  | "call_back"
  | "hold"
  | "walk_out"
  | "closed";

// What the LLM gets back to phrase. Every number here came from the engine.
export interface Decision {
  action: Action;
  ask: number;
  mood: number;
  insulted: boolean; // offer under half the floor, the namesake lowball
  referralsNeeded?: number;
  deal?: Deal;
}

export const MIN_PRICE = CENT; // nothing sells for less than 0.01

const TONE_MOOD: Record<Tone, (p: Personality) => number> = {
  polite: () => 0.05,
  neutral: () => 0,
  joking: () => 0.03,
  flattering: (p) => 0.02 + 0.12 * p.vanity,
  rude: (p) => -0.25 * (0.5 + p.temper),
  threatening: (p) => -0.35 * (0.5 + p.temper),
};

export function openState(item: Item): State {
  return { ask: item.list, round: 0, mood: 0, status: "open", calledBack: false };
}

// The price for a pledge of n friends. Each promised friend is worth referralValue off.
// Even if every "friend" is the buyer's own wallet paying at least the floor, the merchant
// collects price + n * floor >= floor * (n + 1) - n * referralValue, i.e. it never gives away
// more than it said a new customer is worth.
export function pledgePrice(item: Item, ask: number, n: number): number {
  return Math.max(MIN_PRICE, toCents(ask - n * item.referralValue));
}

function referralTarget(item: Item, mood: number): number {
  const t = Math.round(2 + 4 * item.personality.stubbornness - 2 * Math.max(mood, 0));
  return clamp(t, 1, item.maxReferrals);
}

function concede(item: Item, s: State, toward: number): number {
  const p = item.personality;
  const rate = clamp(0.35 * (1 - p.stubbornness) + 0.15 * s.mood, 0.05, 0.5);
  const next = toCents(s.ask - rate * (s.ask - toward));
  return clamp(next, item.floor, s.ask);
}

export function step(item: Item, prev: State, intent: Intent): { state: State; decision: Decision } {
  const s: State = { ...prev };
  const decide = (action: Action, extra: Partial<Decision> = {}) => ({
    state: s,
    decision: { action, ask: s.ask, mood: s.mood, insulted: false, ...extra },
  });

  if (s.status !== "open") return decide("closed", { deal: s.deal });

  s.mood = clamp(s.mood + TONE_MOOD[intent.tone](item.personality), -1, 1);
  const angry = intent.tone === "rude" || intent.tone === "threatening";

  if (s.mood <= -0.9) {
    s.status = "walked";
    return decide("walk_out");
  }

  switch (intent.kind) {
    case "accept": {
      s.status = "deal";
      if (s.referralOnTable && s.referralCounter) {
        const n = s.referralCounter;
        s.deal = { kind: "pledge", price: pledgePrice(item, s.ask, n), referrals: n };
        return decide("pledge_deal", { deal: s.deal });
      }
      s.deal = { kind: "cash", price: s.ask };
      return decide("deal", { deal: s.deal });
    }

    case "walk": {
      if (!s.calledBack && s.mood > -0.3 && s.ask > item.floor) {
        s.calledBack = true;
        s.ask = clamp(toCents(s.ask - 0.3 * (s.ask - item.floor)), item.floor, s.ask);
        return decide("call_back");
      }
      s.status = "walked";
      return decide("walk_out");
    }

    case "referral": {
      s.round += 1;
      const target = referralTarget(item, s.mood);
      if (intent.referrals === undefined) {
        s.referralCounter = s.referralCounter ?? Math.min(target + 1, item.maxReferrals);
        s.referralOnTable = true;
        return decide("ask_referral_count", { referralsNeeded: s.referralCounter });
      }
      const offered = Math.min(intent.referrals, item.maxReferrals);
      const asking = s.referralCounter ?? Math.min(target + 1, item.maxReferrals);
      if (offered >= asking || offered >= target) {
        s.status = "deal";
        s.deal = { kind: "pledge", price: pledgePrice(item, s.ask, offered), referrals: offered };
        return decide("pledge_deal", { deal: s.deal });
      }
      s.referralCounter = Math.max(target, asking - 1);
      s.referralOnTable = true;
      return decide("counter_referrals", { referralsNeeded: s.referralCounter });
    }

    case "offer": {
      s.round += 1;
      s.referralOnTable = false;
      const offer = toCents(toMicro(intent.amount ?? 0));
      const insulted = offer < item.floor / 2;
      if (insulted) s.mood = clamp(s.mood - 0.1, -1, 1);

      if (offer >= s.ask) {
        s.status = "deal";
        s.deal = { kind: "cash", price: s.ask };
        return decide("deal", { deal: s.deal, insulted });
      }

      const zone = 0.15 * (1 - item.personality.stubbornness) + 0.1 * Math.max(s.mood, 0);
      const threshold = s.ask - (s.ask - item.floor) * zone;
      if (offer >= item.floor && offer >= threshold) {
        s.status = "deal";
        s.deal = { kind: "cash", price: offer };
        return decide("deal", { deal: s.deal, insulted });
      }

      if (angry) {
        const raised = clamp(toCents(s.ask + Math.max((item.list - s.ask) * 0.15, 5 * CENT)), item.floor, item.list);
        if (raised > s.ask) {
          s.ask = raised;
          return decide("raise", { insulted });
        }
        return decide("hold", { insulted }); // already at list, nowhere higher to go
      }

      if (s.round >= item.maxRounds) return decide("final_offer", { insulted });

      s.ask = concede(item, s, Math.max(offer, item.floor));
      return decide("counter", { insulted });
    }

    default:
      return decide("hold");
  }
}
