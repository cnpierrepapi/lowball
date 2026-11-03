import type { Db } from "../db";
import { shopStore } from "../shop/store";
import { FINAL, quoteExactUsdc, SOL_USDC, swapStatus, type Fetch, type Status } from "./api";

// Paying a signed offer with any crypto, through Aurora Intents. The price comes only from the
// signed offer (checked by the caller); Aurora is asked for exactly that much USDC on Solana,
// delivered to the shop. The copy's hold is stretched while the payment travels. On SUCCESS the
// server checks what arrived and where, writes the usual onchain receipt, and the copy counts as
// sold. On a refund or failure, the copy goes back on the shelf.

/** How long the buyer has to send: Aurora refunds anything that arrives after this. */
export const DEADLINE_MS = 20 * 60_000;
/** A held copy waits for the deadline plus this margin before going back on the shelf. */
export const HOLD_MARGIN_MS = 10 * 60_000;

export interface PayDeps {
  db: Db;
  apiKey: string;
  merchant: string; // the shop's Solana address (the same on mainnet)
  fetch?: Fetch;
  now?: () => Date;
  /** Writes the onchain receipt for a paid offer. True once it exists. */
  writeReceipt: (p: { nonce: string; item: string; price: number; payer: string | null }) => Promise<boolean>;
}

export interface IntentRow {
  nonce: string;
  item: string;
  price: number;
  originAsset: string;
  refundTo: string;
  depositAddress: string;
  depositMemo: string | null;
  amountIn: string;
  amountInText: string;
  deadline: string;
  status: Status;
  amountOut: string | null;
  receiptWritten: boolean;
}

const row = (r: Record<string, unknown>): IntentRow => ({
  nonce: String(r.nonce), item: String(r.item), price: Number(r.price), originAsset: String(r.origin_asset), refundTo: String(r.refund_to),
  depositAddress: String(r.deposit_address), depositMemo: (r.deposit_memo as string) ?? null, amountIn: String(r.amount_in),
  amountInText: String(r.amount_in_text), deadline: new Date(r.deadline as string).toISOString(), status: r.status as Status,
  amountOut: (r.amount_out as string) ?? null, receiptWritten: Boolean(r.receipt_written),
});

export async function intentFor(db: Db, nonce: string): Promise<IntentRow | undefined> {
  const r = (await db.query("SELECT * FROM intent_payments WHERE nonce = $1", [nonce]))[0];
  return r ? row(r) : undefined;
}

/** A Solana address, so the receipt can name the buyer when they refund to Solana. */
const isSolanaAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

/**
 * Starts (or returns the existing) cross-chain payment for a signed cash offer. One per offer:
 * asking again returns the same deposit address, never a second quote.
 */
export async function startIntent(
  d: PayDeps,
  o: { nonce: string; item: string; price: number; originAsset: string; refundTo: string; dropHold: boolean },
): Promise<IntentRow> {
  const existing = await intentFor(d.db, o.nonce);
  if (existing) return existing;
  const now = (d.now ?? (() => new Date()))();
  const deadline = new Date(now.getTime() + DEADLINE_MS);
  if (o.dropHold && !(await shopStore(d.db).extendHold(o.nonce, new Date(deadline.getTime() + HOLD_MARGIN_MS)))) {
    throw new Error("copy_gone");
  }
  const q = await quoteExactUsdc(d.apiKey, { originAsset: o.originAsset, refundTo: o.refundTo, recipient: d.merchant, price: o.price, deadline }, d.fetch);
  await d.db.query(
    `INSERT INTO intent_payments (nonce, item, price, origin_asset, refund_to, deposit_address, deposit_memo, amount_in, amount_in_text, deadline, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING_DEPOSIT', $11, $11)
     ON CONFLICT (nonce) DO NOTHING`,
    [o.nonce, o.item, o.price, o.originAsset, o.refundTo, q.depositAddress, q.depositMemo ?? null, q.amountIn, q.amountInFormatted, q.deadline || deadline.toISOString(), now],
  );
  return (await intentFor(d.db, o.nonce))!;
}

export type Checked = { row: IntentRow; paid: boolean };

/**
 * Asks Aurora how the payment is going and acts on a final answer. Paid means: SUCCESS, at least
 * the price in USDC, to the shop, on Solana, for this deposit address; and the receipt is written.
 */
export async function checkIntent(d: PayDeps, nonce: string): Promise<Checked | undefined> {
  const now = (d.now ?? (() => new Date()))();
  let r = await intentFor(d.db, nonce);
  if (!r) return undefined;
  if (!(FINAL as readonly string[]).includes(r.status)) {
    const s = await swapStatus(d.apiKey, r.depositAddress, r.depositMemo, d.fetch);
    let status: Status = s.status;
    let amountOut: string | null = s.swapDetails?.amountOut ?? null;
    if (status === "SUCCESS") {
      const req = s.quoteResponse?.quoteRequest;
      const right =
        req?.recipient === d.merchant && req?.destinationAsset === SOL_USDC && amountOut !== null && /^\d+$/.test(amountOut) && BigInt(amountOut) >= BigInt(r.price);
      if (!right) {
        console.error(`intent ${nonce}: SUCCESS but it doesn't match the offer`, { recipient: req?.recipient, asset: req?.destinationAsset, amountOut });
        status = "FAILED";
        amountOut = amountOut ?? null;
      }
    }
    await d.db.query("UPDATE intent_payments SET status = $2, amount_out = $3, updated_at = $4 WHERE nonce = $1", [nonce, status, amountOut, now]);
    if (status === "REFUNDED" || status === "FAILED") await shopStore(d.db).releaseHold(nonce, now);
    r = (await intentFor(d.db, nonce))!;
  }
  if (r.status !== "SUCCESS") return { row: r, paid: false };
  if (!r.receiptWritten) {
    const ok = await d.writeReceipt({ nonce, item: r.item, price: r.price, payer: isSolanaAddress(r.refundTo) ? r.refundTo : null }).catch((e) => {
      console.error(`intent ${nonce}: receipt not written yet:`, (e as Error).message);
      return false;
    });
    if (ok) {
      await d.db.query("UPDATE intent_payments SET receipt_written = true, updated_at = $2 WHERE nonce = $1", [nonce, now]);
      await shopStore(d.db).markSold(nonce, now);
      r = (await intentFor(d.db, nonce))!;
    }
  }
  return { row: r, paid: r.receiptWritten };
}
