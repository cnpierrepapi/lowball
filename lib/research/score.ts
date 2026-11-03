import type { Post } from "./sources";

// Scoring for $0: no model, just counting. Every number on the notebook page comes from here,
// with the inputs beside it, so anyone can check the maths.

const STOP = new Set(`a about above after again against all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each else even ever every few for from further get
gets got had has have having he her here hers him his how i if in into is it its itself just like make me might more most
much must my need no nor not now of off on once one only or other our out over own really same she should so some still
such than that the their them then there these they thing things this those through to too under until up us use used
using very was way we well were what when where which while who why will wish with would yes yet you your want wanted
tool tools someone build built pay paid exist exists anything something people way ways better good great lot lots time
know think see look looking feel seems actually already maybe probably sure else instead able said says going year years
day days week issue issues feature request support add added adding please thanks thank hi hello
img src alt width height http https www png jpg jpeg gif svg div span href html image screenshot com org
painful tedious waste wasted wasting hours frustrating frustrated frustration nightmare annoying hate broken manually hand
workaround cannot can't doesn't don't isn't`.split(/\s+/));

/**
 * The words that say what a post is about: lowercased, plain, no filler, singular-ish.
 * Pain words are left out here: they say how it feels, not what it's about, so they count
 * toward the pain score and never glue unrelated posts together.
 */
export function terms(text: string): string[] {
  const words = text.toLowerCase().replace(/<[^>]*>/g, " ").replace(/https?:\/\/\S+/g, " ").match(/[a-z][a-z0-9+#.-]{2,}/g) ?? [];
  const out = new Set<string>();
  for (let w of words) {
    w = w.replace(/[.-]+$/, "");
    if (w.length < 3 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.add(w);
  }
  return [...out];
}

function jaccard(a: Set<string>, b: Set<string>): { j: number; shared: number } {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return { j: shared / (a.size + b.size - shared || 1), shared };
}

export interface Cluster {
  id: string; // the earliest post's id
  posts: Post[];
  terms: string[]; // the words most posts share, most common first
}

/**
 * Groups posts about the same thing: a post joins a group when it shares at least 3 words and
 * a fifth of its words with any post already in it. Oldest first, so ids stay stable.
 */
export function cluster(posts: Post[], minShared = 3, minJ = 0.2): Cluster[] {
  const sorted = [...posts].sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.id.localeCompare(b.id));
  const groups: { posts: Post[]; sets: Set<string>[] }[] = [];
  for (const p of sorted) {
    const set = new Set(terms(`${p.title} ${p.excerpt}`));
    const home = groups.find((g) => g.sets.some((s) => { const r = jaccard(set, s); return r.shared >= minShared && r.j >= minJ; }));
    if (home) {
      home.posts.push(p);
      home.sets.push(set);
    } else groups.push({ posts: [p], sets: [set] });
  }
  // A lead's key words: the ones most of its posts use, then the ones in titles, then the rarest
  // across everything read (a word every post uses says nothing about this one). These words
  // are what the cross-check searches the other sites with.
  const df = new Map<string, number>();
  for (const g of groups) for (const set of g.sets) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const total = sorted.length || 1;
  return groups.map((g) => {
    const counts = new Map<string, number>();
    for (const s of g.sets) for (const t of s) counts.set(t, (counts.get(t) ?? 0) + 1);
    const inTitle = new Set(g.posts.flatMap((p) => terms(p.title)));
    const weight = (t: string) => counts.get(t)! * (inTitle.has(t) ? 2 : 1) * Math.log(1 + total / (df.get(t) ?? 1));
    const top = [...counts.keys()].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b)).slice(0, 8);
    return { id: g.posts[0].id, posts: g.posts, terms: top };
  });
}

/** Phrases that mean it hurts. Each distinct one found counts once. */
export const PAIN_WORDS = [
  "wish there was", "is there a tool", "someone should build", "would pay", "why is there no", "frustrat", "painful",
  "waste", "hours", "tedious", "nightmare", "annoying", "hate", "broken", "manually", "by hand", "every time", "no way to",
  "can't find", "cannot find", "doesn't exist", "workaround",
];

// Lowered on 3 Nov (owner's call): a real week of posts topped out at 31, so 60 was never reached.
export const THRESHOLDS = { WATCH: 25, INVESTIGATE: 40 } as const;
export type Verdict = "IGNORE" | "WATCH" | "INVESTIGATE";

export interface Component {
  points: number; // 0..20
  inputs: Record<string, number | string | null>;
  rule: string; // the formula, in words, for the notebook
}

export interface Score {
  velocity: Component;
  sources: Component;
  size: Component;
  pain: Component;
  novelty: Component;
  total: number; // 0..100
  verdict: Verdict;
}

const pts = (share: number) => Math.round(20 * Math.min(1, Math.max(0, share)) * 10) / 10;

/** Everything but novelty, which needs a (free) GitHub lookup and is only fetched for promising leads. */
export function partialScore(c: Cluster, now: Date) {
  const recent = c.posts.filter((p) => now.getTime() - Date.parse(p.postedAt) <= 48 * 3600_000).length;
  const authors = new Set(c.posts.map((p) => `${p.source}:${p.author}`)).size;
  const platforms = new Set(c.posts.map((p) => p.source)).size;
  const repos = new Set(c.posts.filter((p) => p.repo).map((p) => p.repo)).size;
  const engagement = c.posts.reduce((n, p) => n + Math.max(0, p.engagement), 0);
  const text = c.posts.map((p) => `${p.title} ${p.excerpt}`).join(" ").toLowerCase();
  const painFound = PAIN_WORDS.filter((w) => text.includes(w));
  return {
    velocity: { points: pts(recent / 3), inputs: { postsLast48h: recent }, rule: "20 × min(1, posts in the last 48 hours ÷ 3)" },
    sources: {
      // Agreement between different sites counts most: one site's crowd can be an echo.
      points: pts(0.6 * Math.min(1, (platforms - 1) / 2) + 0.4 * Math.min(1, (authors - 1) / 3)),
      inputs: { places: platforms, people: authors, repos },
      rule: "20 × (0.6 × min(1, (different sites − 1) ÷ 2) + 0.4 × min(1, (different people − 1) ÷ 3))",
    },
    size: { points: pts(Math.log10(1 + engagement) / 3), inputs: { engagement }, rule: "20 × min(1, log10(1 + points and comments) ÷ 3)" },
    pain: { points: pts(painFound.length / 4), inputs: { painWords: painFound.join(", ") || null }, rule: "20 × min(1, different pain phrases ÷ 4)" },
  };
}

/** Novelty from how many public repos already match the lead's words. null = not checked. */
export function novelty(repoCount: number | null): Component {
  if (repoCount === null) return { points: 10, inputs: { reposFound: null }, rule: "not checked yet: counted as 10 of 20" };
  return { points: pts(1 - Math.log10(1 + repoCount) / 4), inputs: { reposFound: repoCount }, rule: "20 × (1 − min(1, log10(1 + matching GitHub repos) ÷ 4))" };
}

export function verdictFor(total: number): Verdict {
  return total >= THRESHOLDS.INVESTIGATE ? "INVESTIGATE" : total >= THRESHOLDS.WATCH ? "WATCH" : "IGNORE";
}

export function fullScore(c: Cluster, now: Date, repoCount: number | null): Score {
  const p = partialScore(c, now);
  const n = novelty(repoCount);
  const total = Math.round(p.velocity.points + p.sources.points + p.size.points + p.pain.points + n.points);
  return { ...p, novelty: n, total, verdict: verdictFor(total) };
}

/** Worth spending a free GitHub lookup on novelty: could reach INVESTIGATE with it. */
export function worthNoveltyCheck(c: Cluster, now: Date): boolean {
  const p = partialScore(c, now);
  return p.velocity.points + p.sources.points + p.size.points + p.pain.points + 20 >= THRESHOLDS.INVESTIGATE;
}

/** How many of the lead's words a post shares: the cross-check keeps posts sharing at least 3. */
export function sharedTerms(post: Pick<Post, "title" | "excerpt">, leadTerms: string[]): number {
  const mine = new Set(terms(`${post.title} ${post.excerpt}`));
  return leadTerms.filter((t) => mine.has(t)).length;
}

/** The different sites a lead's posts come from. */
export function places(posts: Pick<Post, "source">[]): string[] {
  return [...new Set(posts.map((p) => p.source))].sort();
}
