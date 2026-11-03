import type { Fetch, Post } from "./sources";

// The chain as a source. Once a run she asks a public Solana RPC, for a handful of popular
// programs, how many of their recent transactions failed and with what error. A program where
// a big share of transactions fail the same way is pain measured from the chain itself; the
// cross-check then looks for developers complaining about it, and only that makes it a lead
// worth money (a chain number alone never passes "someone said it hurts").
//
// Public RPC, no key. It limits each address to a few requests a second, so calls are spaced
// out and a "slow down" (429) gets 3 tries with a growing wait (1s, 2s, 4s). Tested live on
// 3 Nov 2026: Jupiter's last 1,000 transactions, 532 failed, most with custom error 6001.

export const RPC_URL = "https://api.mainnet-beta.solana.com";

/** Popular mainnet programs, all checked to be deployed (3 Nov 2026). */
export const PROGRAMS: { id: string; name: string }[] = [
  { id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", name: "Jupiter v6" },
  { id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", name: "Raydium AMM v4" },
  { id: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", name: "Raydium CLMM" },
  { id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", name: "Orca Whirlpools" },
  { id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", name: "Meteora DLMM" },
  { id: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", name: "Pump.fun" },
  { id: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", name: "Marinade" },
  { id: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", name: "Metaplex Token Metadata" },
];

/** Error names only where we're sure of them; everything else is named from the logs, or by number. */
const KNOWN: Record<string, string> = { "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4:6001": "SlippageToleranceExceeded" };

/** A failing error worth a post: at least this share of the program's recent transactions. */
export const MIN_SHARE = 0.1;
/** Failed transactions opened per program to read the error's name from the logs. */
export const SAMPLES = 1;

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** One JSON-RPC call, with 3 tries and a growing wait when the RPC says slow down. */
export async function rpcCall<T>(method: string, params: unknown[], f: Fetch = fetch, sleep: Sleep = realSleep, url = RPC_URL): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429 && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    const j = (await r.json()) as { result?: T; error?: { message?: string } };
    if (j.error) throw new Error(`rpc ${j.error.message ?? "error"}`);
    return j.result as T;
  }
}

interface Sig { signature: string; err: unknown; blockTime?: number | null }

/** The program-level error behind a failed transaction: "6001", "InsufficientFunds", ... */
export function errorKey(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const ie = (err as { InstructionError?: [number, unknown] }).InstructionError;
  if (ie) {
    const inner = ie[1];
    if (inner && typeof inner === "object" && "Custom" in (inner as object)) return String((inner as { Custom: number }).Custom);
    return typeof inner === "string" ? inner : JSON.stringify(inner);
  }
  return Object.keys(err as object)[0] ?? "unknown";
}

/** A readable name from the logs: Anchor's "Error Code: X", or the program's "custom program error: 0x..". */
export function nameFromLogs(logs: string[]): string | undefined {
  for (const l of logs) {
    const m = /Error Code: (\w+)/.exec(l);
    if (m) return m[1];
  }
  for (const l of logs) {
    const m = /Program log: Error: ([^.]{3,80})/.exec(l);
    if (m) return m[1].trim();
  }
  return undefined;
}

export interface ChainResult {
  posts: Post[];
  errors: string[];
}

/**
 * Reads the chain: for each program, the share of its last 1,000 transactions that failed, and
 * the most common error. One post per program whose top error hits at least 10%.
 */
export async function readChain(now: Date, f: Fetch = fetch, sleep: Sleep = realSleep, programs = PROGRAMS): Promise<ChainResult> {
  const posts: Post[] = [];
  const errors: string[] = [];
  const day = now.toISOString().slice(0, 10);
  for (const p of programs) {
    try {
      const sigs = await rpcCall<Sig[]>("getSignaturesForAddress", [p.id, { limit: 1000 }], f, sleep);
      await sleep(250);
      if (sigs.length === 0) continue;
      const failed = sigs.filter((s) => s.err);
      const counts = new Map<string, Sig[]>();
      for (const s of failed) counts.set(errorKey(s.err), [...(counts.get(errorKey(s.err)) ?? []), s]);
      const top = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      if (!top || top[1].length / sigs.length < MIN_SHARE) continue;
      const [code, hits] = top;
      let name: string | undefined = KNOWN[`${p.id}:${code}`];
      if (!name) {
        for (const s of hits.slice(0, SAMPLES)) {
          const tx = await rpcCall<{ meta?: { logMessages?: string[] } } | null>("getTransaction", [s.signature, { maxSupportedTransactionVersion: 1, encoding: "json" }], f, sleep);
          await sleep(250);
          name = nameFromLogs(tx?.meta?.logMessages ?? []);
          if (name) break;
        }
      }
      // Plain words, so the cross-check searches with what developers actually write
      // ("jupiter slippage tolerance exceeded"), never with the address or a CamelCase blob.
      const words = (name ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
      const label = words || (/^\d+$/.test(code) ? `custom error ${code}` : code);
      const share = Math.round((hits.length / sigs.length) * 100);
      posts.push({
        id: `ch:${p.id.slice(0, 8)}:${code}:${day}`,
        source: "chain",
        url: `https://explorer.solana.com/tx/${hits[0].signature}`,
        title: `${share}% of recent ${p.name} transactions fail with ${label}`,
        excerpt: `On Solana mainnet, ${failed.length} of the last ${sigs.length} ${p.name} transactions failed, ${hits.length} of them with ${label}${name ? ` (${name})` : ""}. Counted from a public RPC on ${day}.`,
        author: p.name,
        repo: p.id,
        engagement: hits.length,
        postedAt: now.toISOString(),
      });
    } catch (e) {
      errors.push(`chain ${p.name}: ${(e as Error).message}`);
    }
  }
  return { posts, errors };
}
