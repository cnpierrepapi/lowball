import type { Investigation, PackDraft } from "./model";
import type { Post } from "./sources";

// Turns what the model wrote into a pack. The links to real posts come from our own data, never
// from the model, and any link the model wrote that isn't a post or a search result is removed.

/** A pack id: lowercase letters, digits and hyphens, 3 to 32 characters (the onchain receipt holds 32 bytes). */
export function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return s.length >= 3 ? s : `pack-${s || "x"}`.slice(0, 32);
}

/** A slug that isn't taken: adds -2, -3... and stays within 32 characters. */
export function uniqueSlug(raw: string, taken: Set<string>): string {
  const base = slugify(raw);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const tail = `-${i}`;
    const s = `${base.slice(0, 32 - tail.length).replace(/-+$/, "")}${tail}`;
    if (!taken.has(s)) return s;
  }
}

const URL_RE = /https?:\/\/[^\s)<>\]"']+/g;
const norm = (u: string) => u.replace(/[.,;:!?]+$/, "").replace(/\/$/, "");

/** Keeps only links in `allowed`. A markdown link to anything else keeps its words and loses the link. */
export function guardLinks(md: string, allowed: Set<string>): string {
  const ok = (u: string) => allowed.has(norm(u));
  return md
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (m, text: string, url: string) => (ok(url) ? m : text))
    .replace(URL_RE, (u) => (ok(u) ? u : ""))
    .replace(/[ \t]{2,}/g, " ");
}

/** A code fence longer than any run of backticks inside, so the prompt can't break out of it. */
export function fence(text: string, lang = "text"): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text.trim()}\n${f}`;
}

const clean = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

export interface Assembled {
  id: string;
  title: string;
  blurb: string;
  teaser: string;
  body: string;
}

export function assemblePack(posts: Post[], inv: Investigation, draft: PackDraft, sources: string[], taken: Set<string>): Assembled {
  const allowed = new Set([...posts.map((p) => p.url), ...sources].map(norm));
  const g = (md: string) => guardLinks(md.trim(), allowed);

  const where = posts
    .map((p, i) => `${i + 1}. [${p.title.replace(/[[\]]/g, "")}](${p.url}), ${p.source === "hn" ? "Hacker News" : `GitHub, ${p.repo}`}, ${p.postedAt.slice(0, 10)}`)
    .join("\n");
  const existing = inv.existing.length
    ? inv.existing
        .map((e) => (allowed.has(norm(e.url)) ? `- [${e.name.replace(/[[\]]/g, "")}](${e.url}): ${clean(e.gap, 300)}` : `- ${e.name}: ${clean(e.gap, 300)}`))
        .join("\n")
    : "- Nothing close turned up.";

  const teaser = `## The problem

${g(draft.problem)}

### Where developers said it

${where}

## Has anyone built it?

${g(draft.whitespace)}

${existing}

Who tried: ${clean(g(inv.attempts), 600)}

How big the need is: ${clean(g(inv.demand), 600)}`;

  const body = `## The plan

${g(draft.plan)}

## The build prompt

Paste this into your AI coding tool.

${fence(guardLinks(draft.buildPrompt, allowed))}

## Tests that prove it works

${g(draft.tests)}

## Risks

${g(draft.risks)}`;

  return { id: uniqueSlug(draft.slug || draft.title, taken), title: clean(draft.title, 60), blurb: clean(draft.blurb, 140), teaser, body };
}
