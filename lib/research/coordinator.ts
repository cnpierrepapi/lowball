// The coordinator: checks that run before any money is spent on a lead. All free, all shown on
// the notebook page with their reasons.

/** Words that put a lead inside the mission: tools for developers. */
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
  seenTwice: Check;
  notInvestigated: Check;
  underCap: Check;
  pass: boolean;
}

/**
 * Validated: the same need turned up on at least 2 different sites (directly or through the
 * cross-check). Applies to every investigation, including "investigate anyway".
 */
export function seenTwice(placesSeen: string[]): Check {
  return placesSeen.length >= 2
    ? { ok: true, why: `seen on ${placesSeen.join(", ")}` }
    : { ok: false, why: `only seen on ${placesSeen.join(", ") || "nothing"}; needs 2 different sites` };
}

/** Inside the mission if at least 2 developer words show up, and it isn't one app's feature request. */
export function onMission(text: string, repos: string[], postCount: number): Check {
  const words = new Set(text.toLowerCase().match(/[a-z0-9+#]+/g) ?? []);
  const found = DEV_WORDS.filter((w) => words.has(w));
  if (found.length < 2) {
    return { ok: false, why: `only ${found.length} developer word${found.length === 1 ? "" : "s"} (${found.join(", ") || "none"}); needs 2` };
  }
  if (postCount > 0 && repos.length === postCount && new Set(repos).size === 1) {
    return { ok: false, why: `every post is an issue on ${repos[0]}: a feature request for one project, not a missing tool` };
  }
  return { ok: true, why: `developer words: ${found.slice(0, 6).join(", ")}` };
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

export function checks(c: { onMission: Check; seenTwice: Check; notInvestigated: Check; underCap: Check }): Checks {
  return { ...c, pass: c.onMission.ok && c.seenTwice.ok && c.notInvestigated.ok && c.underCap.ok };
}
