// Aurora Intents' Swap API (https://docs.intents.aurora.dev), the parts the shop uses. Quotes are
// EXACT_OUTPUT: the shop says how much USDC must arrive, Aurora says how much of the buyer's own
// token to send. Real money: there is no test network.

export const API = "https://intents-api.aurora.dev";

/** USDC on Solana mainnet, as Aurora names it (mint EPjFWdd5...; 6 decimals, like micro-USDC). */
export const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string;
}

export interface Quote {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  minAmountIn?: string;
  maxAmountIn?: string;
  amountOut: string;
  deadline: string;
  timeEstimate?: number;
}

export const FINAL = ["SUCCESS", "REFUNDED", "FAILED"] as const;
export type Status = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | (typeof FINAL)[number];

export interface StatusReply {
  status: Status;
  quoteResponse?: { quoteRequest?: { recipient?: string; destinationAsset?: string; amount?: string; swapType?: string } };
  swapDetails?: { amountOut?: string; refundReason?: string; destinationChainTxHashes?: { hash: string; explorerUrl?: string }[] };
}

/** What a buyer can pay with: the common ones, so the list stays short. */
export const PAY_WITH: [string, string][] = [
  ["base", "USDC"], ["base", "ETH"], ["arb", "USDC"], ["arb", "ETH"], ["eth", "USDC"], ["eth", "ETH"], ["eth", "USDT"],
  ["sol", "USDC"], ["sol", "SOL"], ["tron", "USDT"], ["btc", "BTC"],
];

async function json<T>(r: Response, what: string): Promise<T> {
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(`aurora ${what} ${r.status}${body.message ? `: ${body.message}` : ""}`);
  }
  return (await r.json()) as T;
}

/** The tokens Aurora supports, narrowed to what the shop offers. Public: needs no real key. */
export async function payOptions(apiKey: string, f: Fetch = fetch): Promise<Token[]> {
  const j = await json<{ tokens: Token[] }>(await f(`${API}/api/tokens/${encodeURIComponent(apiKey || "public")}`), "tokens");
  return PAY_WITH.map(([chain, sym]) => j.tokens.find((t) => t.blockchain === chain && t.symbol === sym)).filter((t): t is Token => Boolean(t));
}

/** A real quote (a deposit address is reserved) for exactly `price` micro-USDC delivered to `recipient` on Solana. */
export async function quoteExactUsdc(
  apiKey: string,
  o: { originAsset: string; refundTo: string; recipient: string; price: number; deadline: Date },
  f: Fetch = fetch,
): Promise<Quote> {
  const r = await f(`${API}/api/quote/${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_OUTPUT",
      depositType: "ORIGIN_CHAIN",
      originAsset: o.originAsset,
      destinationAsset: SOL_USDC,
      amount: String(o.price),
      slippageTolerance: 100,
      refundTo: o.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: o.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: o.deadline.toISOString(),
      quoteWaitingTimeMs: 3000,
    }),
  });
  const j = await json<{ quote: Quote }>(r, "quote");
  if (!j.quote?.depositAddress) throw new Error("aurora quote: no deposit address");
  return j.quote;
}

export async function swapStatus(apiKey: string, depositAddress: string, depositMemo: string | null, f: Fetch = fetch): Promise<StatusReply> {
  const q = `depositAddress=${encodeURIComponent(depositAddress)}${depositMemo ? `&depositMemo=${encodeURIComponent(depositMemo)}` : ""}`;
  return json<StatusReply>(await f(`${API}/api/status/${encodeURIComponent(apiKey)}?${q}`), "status");
}
