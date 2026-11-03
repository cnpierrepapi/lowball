// The coordinator: checks that run before any money is spent on a lead. All free, all shown on
// the notebook page with their reasons.

/**
 * The mission: tools for developers building on Solana. A lead needs one of these words, which
 * only show up when the talk is about Solana or crypto...
 */
export const CRYPTO_WORDS = [
  "solana", "anchor", "spl", "lamport", "lamports", "pda", "cpi", "idl", "devnet", "mainnet", "testnet", "validator", "validators",
  "phantom", "jupiter", "raydium", "orca", "meteora", "metaplex", "jito", "pump.fun", "helius", "agave", "blockhash", "keypair",
  "pubkey", "onchain", "on-chain", "blockchain", "crypto", "defi", "nft", "nfts", "usdc", "slippage", "x402", "web3",
];

/**
 * ...these everyday words count toward the 2, but never make a lead Solana on their own: they
 * turn up in ordinary programming talk too (the first clear, 3 Nov, kept "Check that the Store
 * build finds the data" because it said "program").
 */
export const CHAIN_WORDS = ["rpc", "wallet", "wallets", "mint", "swap", "transaction", "transactions", "program", "programs", "token", "tokens"];

/** ...and, with it, at least 2 words from either list. */
export const DEV_WORDS = [
  "api", "cli", "sdk", "git", "github", "gitlab", "repo", "commit", "branch", "merge", "deploy", "deployment", "ci", "pipeline",
  "build", "compile", "compiler", "test", "tests", "testing", "debug", "debugger", "log", "logs", "logging", "trace", "monitor",
  "docker", "container", "kubernetes", "k8s", "terraform", "database", "sql", "postgres", "schema", "migration", "query",
  "editor", "ide", "vscode", "vim", "terminal", "shell", "bash", "script", "library", "package", "npm", "pip", "cargo",
  "dependency", "dependencies", "typescript", "javascript", "python", "rust", "golang", "java", "code", "codebase",
  "refactor", "lint", "linter", "framework", "server", "endpoint", "webhook", "json", "yaml", "config", "env", "secret",
  "auth", "oauth", "token", "llm", "model", "prompt", "agent", "mcp", "benchmark", "profiler", "performance", "regex",
];

export interface Check {
  ok: boolean;
  why: string;
}

export interface Checks {
  onMission: Check;
  hurts: Check;
  seenTwice: Check;
  notInvestigated: Check;
  underCap: Check;
  pass: boolean;
}

/**
 * Validated: the same need came from at least 2 different sites, or 2 different people (owner's
 * call, 3 Nov: Solana's sources are quiet, so two people on the same site also count). Applies to
 * every investigation, including "investigate anyway". Chain numbers aren't people.
 */
export function seenTwice(placesSeen: string[], people = 0): Check {
  if (placesSeen.length >= 2) return { ok: true, why: `seen on ${placesSeen.join(", ")}` };
  if (people >= 2) return { ok: true, why: `${people} different people asked, on ${placesSeen.join(", ")}` };
  return { ok: false, why: `only 1 person on ${placesSeen.join(", ") || "nothing"}; needs 2 people or 2 sites` };
}

/** "owner/repo" -> "owner": issues from one account or organisation are one project. */
export const ownerOf = (repo: string) => repo.split("/")[0].toLowerCase();

/**
 * Inside the mission: at least one Solana or crypto word, at least 2 developer or crypto words
 * in all, and not every post an issue from one GitHub owner (that's one project's to-do list).
 */
export function onMission(text: string, repos: string[], postCount: number): Check {
  const words = new Set(text.toLowerCase().match(/[a-z0-9+#.-]+/g) ?? []);
  const crypto = CRYPTO_WORDS.filter((w) => words.has(w));
  const dev = [...CHAIN_WORDS, ...DEV_WORDS].filter((w, i, all) => words.has(w) && !crypto.includes(w) && all.indexOf(w) === i);
  if (crypto.length === 0) return { ok: false, why: "nothing about Solana or crypto" };
  if (crypto.length + dev.length < 2) return { ok: false, why: `only 1 developer word (${crypto[0]}); needs 2` };
  const ghRepos = repos.filter((r) => r.includes("/"));
  if (postCount > 0 && ghRepos.length === postCount && new Set(ghRepos.map(ownerOf)).size === 1) {
    return { ok: false, why: `every post is an issue from ${ownerOf(ghRepos[0])}: one project's to-do list, not a missing tool` };
  }
  return { ok: true, why: `about ${[...crypto, ...dev].slice(0, 6).join(", ")}` };
}

/** Someone said it hurts: at least one post uses a pain phrase. A chain number alone doesn't count. */
export function hurts(painFound: string[]): Check {
  return painFound.length > 0
    ? { ok: true, why: `said: ${painFound.slice(0, 4).join(", ")}` }
    : { ok: false, why: "nobody said it hurts (no pain phrase in any post)" };
}

/** Not already looked into: same lead, or one sharing half its words, investigated in the last 30 days. */
export function notInvestigated(terms: string[], done: { id: string; terms: string[] }[], id: string): Check {
  const mine = new Set(terms);
  for (const d of done) {
    if (d.id === id) return { ok: false, why: "already investigated" };
    const shared = d.terms.filter((t) => mine.has(t)).length;
    if (shared / Math.max(1, Math.min(mine.size, d.terms.length)) >= 0.5) {
      return { ok: false, why: `too close to lead ${d.id}, already investigated` };
    }
  }
  return { ok: true, why: "nothing like it investigated in the last 30 days" };
}

/** What a step may cost at most, used before spending (the real cost is recorded after). */
export const STEP_ESTIMATE_USD = { investigate: 0.6, write: 0.5 } as const;

export function underCap(spentThisMonth: number, capUsd: number, step: keyof typeof STEP_ESTIMATE_USD): Check {
  const est = STEP_ESTIMATE_USD[step];
  const line = `$${spentThisMonth.toFixed(2)} spent this month + up to $${est.toFixed(2)}`;
  return spentThisMonth + est <= capUsd
    ? { ok: true, why: `${line} ≤ $${capUsd.toFixed(2)} cap` }
    : { ok: false, why: `${line} would pass the $${capUsd.toFixed(2)} cap` };
}

export function checks(c: { onMission: Check; hurts: Check; seenTwice: Check; notInvestigated: Check; underCap: Check }): Checks {
  return { ...c, pass: c.onMission.ok && c.hurts.ok && c.seenTwice.ok && c.notInvestigated.ok && c.underCap.ok };
}
