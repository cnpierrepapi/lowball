import { z } from "zod";

// What the LLM is allowed to tell the engine. Nothing in here sets a price:
// "amount" is only the number the buyer offered, and the engine decides what to do with it.
export const TONES = ["polite", "neutral", "rude", "flattering", "threatening", "joking"] as const;
export const KINDS = ["offer", "accept", "referral", "chat", "walk"] as const;

export type Tone = (typeof TONES)[number];
export type IntentKind = (typeof KINDS)[number];

export interface Intent {
  kind: IntentKind;
  tone: Tone;
  amount?: number; // USDC the buyer offered
  referrals?: number; // friends the buyer promised
}

export const MAX_OFFER_USDC = 1_000_000;
export const MAX_REFERRALS_SAID = 1_000;

const raw = z.object({
  kind: z.string().optional(),
  tone: z.string().optional(),
  amount: z.unknown().optional(),
  referrals: z.unknown().optional(),
});

function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    // ASCII digits only. Fullwidth or other script digits get dropped, not reinterpreted.
    const s = v.trim().replace(/[$,\s]|usdc/gi, "");
    if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Turns whatever the model returned into a safe Intent. Unknown kinds become chat,
// impossible numbers are dropped, and extra fields (a "price" or "floor" the model
// was talked into adding) are ignored because they are never read.
export function sanitizeIntent(input: unknown): Intent {
  const parsed = raw.safeParse(input);
  const r = parsed.success ? parsed.data : {};

  const kind = (KINDS as readonly string[]).includes(r.kind ?? "") ? (r.kind as IntentKind) : "chat";
  const tone = (TONES as readonly string[]).includes(r.tone ?? "") ? (r.tone as Tone) : "neutral";

  const out: Intent = { kind, tone };

  const amount = asFiniteNumber(r.amount);
  if (amount !== undefined && amount >= 0 && amount <= MAX_OFFER_USDC) out.amount = amount;

  const refs = asFiniteNumber(r.referrals);
  if (refs !== undefined && Number.isInteger(refs) && refs >= 1 && refs <= MAX_REFERRALS_SAID) {
    out.referrals = refs;
  }

  if (out.kind === "offer" && out.amount === undefined) out.kind = "chat";
  return out;
}
