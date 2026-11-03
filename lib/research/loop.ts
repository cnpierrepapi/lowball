import type { Db } from "../db";
import { shopStore, type Drop, type Pack } from "../shop/store";
import { mailStore } from "../mail/store";
import { announceDrop } from "../mail/outbox";
import type { Mailer } from "../mail/mailer";
import {
  countRepos, isBot, MISSION, PAIN_QUERIES, readDevto, readSolanaForum, recentQuestions, SE_CROSS_SITES, SE_FEEDS, searchGitHub,
  searchHN, searchReddit, searchRedditWords, searchSolanaForum, searchStackExchange, SOURCES, type Fetch, type Post, type Source,
} from "./sources";
import { readChain, type Sleep } from "./chain";
import { cluster, fullScore, isAsking, painIn, places, sharedTerms, worthNoveltyCheck, type Cluster } from "./score";
import { checks, hurts, notInvestigated, onMission, seenTwice, underCap, type Checks } from "./coordinator";
import { ResearchRefused, type ResearchModel } from "./model";
import { assemblePack } from "./pack";
import { researchStore, type Lead } from "./store";
import { recordPackHash } from "./onchain";

// Her research loop: watch, score, check, investigate, write, put it on the shelf.
// Watching and scoring are free. Only investigate and write spend money, and only after the
// coordinator's checks pass.

export interface Deps {
  db: Db;
  now?: () => Date;
  fetch?: Fetch;
  model?: ResearchModel;
  mailer?: Mailer;
  mailCap?: number;
  site?: string;
  sleep?: Sleep; // the chain reader's pauses; tests make them instant
}

const DAY = 86_400_000;
/** How far back posts count toward a lead, and how far back the watch reads (Solana sources are quiet). */
export const WINDOW_DAYS = 30;
// GitHub allows 10 searches a minute without a key: 5 phrase searches + 3 repo counts + 2
// cross-checks. Reddit throttles hard, so it gets 1 watch query and 2 cross-checks a run.
/** At most this many free GitHub repo lookups (novelty) per watch. */
export const NOVELTY_LOOKUPS = 3;
/** The best leads each run that get cross-checked on the other sites. */
export const CROSSREF_LEADS = 5;
export const CROSSREF_GITHUB = 2;
export const CROSSREF_REDDIT = 2;
/** A cross-check post must share at least this many of the lead's words. */
export const CROSSREF_MIN_SHARED = 3;
export const DEFAULT_CAP_USD = 5;
export const DROP_COPIES = 5;

export async function settings(db: Db) {
  const s = shopStore(db);
  const cap = Number(await s.setting("research_cap_usd"));
  return {
    capUsd: Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_CAP_USD,
    autoDrop: (await s.setting("auto_drop")) !== "0",
  };
}

export interface WatchResult {
  fetched: Record<Source, number>;
  errors: string[];
  leads: number;
  crossChecked: number; // leads looked up on the other sites
  crossFound: number; // posts the cross-check attached
  investigate: number;
  watch: number;
}

/**
 * Reads every source, saves the posts, groups them into leads, cross-checks the best leads on
 * the sites they weren't seen on, and scores every lead. Free: no model, just public searches.
 */
export async function watch(d: Deps): Promise<WatchResult> {
  const now = (d.now ?? (() => new Date()))();
  const f = d.fetch ?? fetch;
  const store = researchStore(d.db);
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const found: Post[] = [];
  const errors: string[] = [];
  const fetched = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>;
  const gather = async (source: Source, label: string, run: () => Promise<Post[]>) => {
    try {
      // Bots and AI agents filing tickets aren't people with a problem.
      const posts = (await run()).filter((p) => !isBot(p.author));
      fetched[source] += posts.length;
      found.push(...posts);
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  };
  for (const q of PAIN_QUERIES) {
    await gather("hn", `hn "${q}"`, () => searchHN(q, since, f, true, MISSION));
    await gather("github", `github "${q}"`, () => searchGitHub(q, since, f, true, MISSION));
  }
  for (const [site, tag] of SE_FEEDS) await gather("stackoverflow", `${site}${tag ? ` [${tag}]` : ""}`, () => recentQuestions(site, since, tag, f));
  await gather("forum", "solana forum", () => readSolanaForum(new Date(now.getTime() - 30 * DAY), f));
  await gather("reddit", "reddit", () => searchReddit(PAIN_QUERIES, since, f));
  await gather("devto", "dev.to", () => readDevto(PAIN_QUERIES, since, f));
  const chain = await readChain(now, f, d.sleep);
  fetched.chain += chain.posts.length;
  found.push(...chain.posts);
  errors.push(...chain.errors);
  await store.savePosts(found, now);

  // Group, and bring along what earlier cross-checks attached to each lead.
  const clusters = cluster(await store.postsSince(new Date(now.getTime() - WINDOW_DAYS * DAY)), 3, 0.2);
  const cross = await store.crossIds(clusters.map((c) => c.id));
  const attached = new Map<string, Post[]>();
  const allCross = [...new Set([...cross.values()].flat())];
  const crossPosts = new Map((await store.postsByIds(allCross)).map((p) => [p.id, p]));
  for (const c of clusters) attached.set(c.id, (cross.get(c.id) ?? []).map((id) => crossPosts.get(id)).filter((p): p is Post => Boolean(p)));
  const withCross = (c: Cluster): Cluster => {
    const extra = (attached.get(c.id) ?? []).filter((p) => !c.posts.some((q) => q.id === p.id));
    return { ...c, posts: [...c.posts, ...extra] };
  };

  // Cross-check the best leads on the sites they haven't turned up on yet. Only leads that could
  // ever be investigated are worth the searches: on mission, and not one project's to-do list.
  const budget = { github: CROSSREF_GITHUB, reddit: CROSSREF_REDDIT };
  const eligible = clusters.filter((c) => {
    const posts = withCross(c).posts;
    return onMission(posts.map((p) => `${p.title} ${p.excerpt}`).join(" "), posts.filter((p) => p.repo).map((p) => p.repo!), posts.length).ok;
  });
  const best = eligible.sort((a, b) => fullScore(withCross(b), now, null).total - fullScore(withCross(a), now, null).total).slice(0, CROSSREF_LEADS);
  const since30 = new Date(now.getTime() - 30 * DAY);
  let crossChecked = 0;
  let crossFound = 0;
  for (const c of best) {
    const lead = withCross(c);
    const have = new Set(places(lead.posts));
    const words = c.terms.slice(0, 3).join(" ");
    if (c.terms.length < 3) continue;
    crossChecked++;
    const hits: Post[] = [];
    const look = async (source: Source, run: () => Promise<Post[]>) => {
      if (have.has(source)) return;
      try {
        hits.push(...(await run()));
      } catch (e) {
        errors.push(`cross-check ${source} for ${c.id}: ${(e as Error).message}`);
      }
    };
    await look("hn", () => searchHN(words, since30, f, false));
    await look("stackoverflow", async () => (await Promise.all(SE_CROSS_SITES.map((site) => searchStackExchange(words, since30, site, f)))).flat());
    await look("forum", () => searchSolanaForum(words, since30, f));
    if (budget.github > 0 && !have.has("github")) {
      budget.github--;
      await look("github", () => searchGitHub(words, since30, f, false));
    }
    if (budget.reddit > 0 && !have.has("reddit")) {
      budget.reddit--;
      await look("reddit", () => searchRedditWords(words, since30, f));
    }
    // A match must share 3 of the lead's words AND be someone asking (a question or a complaint),
    // not an announcement or a bot.
    const known = new Set(lead.posts.map((p) => p.id));
    const keep = [
      ...new Map(
        hits
          .filter((p) => !known.has(p.id) && !isBot(p.author) && isAsking(p) && sharedTerms(p, c.terms) >= CROSSREF_MIN_SHARED)
          .map((p) => [p.id, p]),
      ).values(),
    ];
    if (keep.length) {
      await store.savePosts(keep, now, "crossref");
      attached.set(c.id, [...(attached.get(c.id) ?? []), ...keep]);
      crossFound += keep.length;
    }
  }

  // Score every lead, cross-check finds included.
  let lookups = 0;
  let investigate = 0;
  let watching = 0;
  for (const c of clusters) {
    const lead = withCross(c);
    let repos: number | null = null;
    if (lookups < NOVELTY_LOOKUPS && worthNoveltyCheck(lead, now)) {
      lookups++;
      try {
        repos = await countRepos(c.terms, f);
      } catch (e) {
        errors.push(`novelty ${c.id}: ${(e as Error).message}`);
      }
    }
    const score = fullScore(lead, now, repos);
    if (score.verdict === "INVESTIGATE") investigate++;
    if (score.verdict === "WATCH") watching++;
    await store.upsertLead(
      { id: c.id, title: c.posts[0].title, terms: c.terms, postIds: c.posts.map((p) => p.id), crossIds: (attached.get(c.id) ?? []).map((p) => p.id), score },
      now,
    );
  }
  return { fetched, errors, leads: clusters.length, crossChecked, crossFound, investigate, watch: watching };
}

/** Every post behind a lead: the ones grouped into it, and the ones the cross-check found. */
export async function leadPosts(d: Deps, lead: Pick<Lead, "postIds" | "crossIds">): Promise<Post[]> {
  return researchStore(d.db).postsByIds([...new Set([...lead.postIds, ...lead.crossIds])]);
}

/** The coordinator's checks for a step on a lead, saved so the notebook shows them. */
export async function coordinate(d: Deps, lead: Lead, step: "investigate" | "write", forced = false): Promise<Checks> {
  const now = (d.now ?? (() => new Date()))();
  const store = researchStore(d.db);
  const posts = await leadPosts(d, lead);
  const text = posts.map((p) => `${p.title} ${p.excerpt}`).join(" ");
  const repos = posts.filter((p) => p.repo).map((p) => p.repo!);
  const { capUsd } = await settings(d.db);
  const done = step === "investigate" ? await store.investigatedSince(new Date(now.getTime() - 30 * DAY)) : [];
  const c = checks({
    onMission: onMission(text, repos, posts.length),
    hurts: hurts(painIn(posts)),
    seenTwice: seenTwice(places(posts), new Set(posts.filter((p) => p.source !== "chain").map((p) => `${p.source}:${p.author}`)).size),
    notInvestigated: step === "investigate" ? notInvestigated(lead.terms, done, lead.id) : { ok: true, why: "investigated, ready to write" },
    underCap: underCap(await store.spentThisMonth(now), capUsd, step),
  });
  await store.setChecks(lead.id, { ...c, forced, at: now.toISOString() });
  return c;
}

export type StepResult =
  | { ok: true; lead: Lead; pack?: Pack; drop?: Drop; costUsd: number }
  | { ok: false; reason: string; checks?: Checks };

/**
 * Looks into one lead with the model and web search. Needs INVESTIGATE, or WATCH with `force`
 * (the dashboard's "investigate anyway"); IGNORE never. The coordinator's checks always apply.
 */
export async function investigate(d: Deps, leadId: string, opts: { force?: boolean } = {}): Promise<StepResult> {
  const now = (d.now ?? (() => new Date()))();
  const store = researchStore(d.db);
  const lead = await store.lead(leadId);
  if (!lead) return { ok: false, reason: "no such lead" };
  if (lead.status !== "new") return { ok: false, reason: `lead is already ${lead.status}` };
  if (lead.verdict === "IGNORE" || (lead.verdict === "WATCH" && !opts.force)) return { ok: false, reason: `score ${lead.total} is ${lead.verdict}` };
  // Novelty counted as a placeholder 10 until checked. Before any money, check it for real
  // (a free GitHub lookup) and rescore; if that drops it below the bar, stop here.
  if (lead.score.novelty.inputs.reposFound === null) {
    const all = await leadPosts(d, lead);
    let repos: number | null = null;
    try {
      repos = await countRepos(lead.terms, d.fetch ?? fetch);
    } catch {
      return { ok: false, reason: "couldn't check whether it's been built (GitHub didn't answer); try again later" };
    }
    const score = fullScore({ id: lead.id, posts: all, terms: lead.terms }, now, repos);
    await store.upsertLead({ id: lead.id, title: lead.title, terms: lead.terms, postIds: lead.postIds, crossIds: lead.crossIds, score }, now);
    if (score.verdict === "IGNORE" || (score.verdict === "WATCH" && !opts.force)) {
      return { ok: false, reason: `with novelty checked (${repos} similar repos) the score is ${score.total}, ${score.verdict}` };
    }
  }
  const c = await coordinate(d, lead, "investigate", Boolean(opts.force) && lead.verdict !== "INVESTIGATE");
  if (!c.pass) return { ok: false, reason: "a coordinator check failed", checks: c };
  if (!d.model) return { ok: false, reason: "no model" };

  const posts = await leadPosts(d, lead);
  try {
    const r = await d.model.investigate({ id: lead.id, title: lead.title, terms: lead.terms, posts });
    await store.spend(lead.id, "investigate", r.costUsd, r.detail, now);
    const worth = r.result.exists !== "yes" && r.result.verdict === "build";
    await store.setInvestigation(lead.id, { ...r.result, sources: r.sources }, worth ? "investigated" : "skipped", now);
    return { ok: true, lead: (await store.lead(lead.id))!, costUsd: r.costUsd };
  } catch (e) {
    // The model said no: the lead is closed. Anything else (a timeout, a network hiccup) leaves
    // it as it was, so it can be tried again.
    if (e instanceof ResearchRefused) {
      await store.setInvestigation(lead.id, { error: e.message } as Lead["investigation"], "failed", now);
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

/** The next drop slot: 18:00 UTC, at least 12 hours away, so the email goes out well before. */
export function nextOpening(now: Date): Date {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18));
  while (t.getTime() - now.getTime() < 12 * 3600_000) t.setUTCDate(t.getUTCDate() + 1);
  return t;
}

/** Writes the pack for an investigated lead, puts it on the shelf, and (if auto drop is on) schedules its drop. */
export async function write(d: Deps, leadId: string): Promise<StepResult> {
  const now = (d.now ?? (() => new Date()))();
  const store = researchStore(d.db);
  const shop = shopStore(d.db);
  const lead = await store.lead(leadId);
  if (!lead) return { ok: false, reason: "no such lead" };
  if (lead.status !== "investigated" || !lead.investigation) return { ok: false, reason: `lead is ${lead.status}, not investigated` };
  const c = await coordinate(d, lead, "write");
  if (!c.pass) return { ok: false, reason: "a coordinator check failed", checks: c };
  if (!d.model) return { ok: false, reason: "no model" };

  const posts = await leadPosts(d, lead);
  const { sources = [], ...inv } = lead.investigation;
  const r = await d.model.writePack({ id: lead.id, title: lead.title, terms: lead.terms, posts }, inv);
  await store.spend(lead.id, "write", r.costUsd, r.detail, now);

  const taken = new Set((await shop.packs()).map((p) => p.id));
  const a = assemblePack(posts, inv, r.draft, sources, taken);
  const pack = await shop.addPack({ ...a, score: lead.total, leadId: lead.id });
  await store.setPacked(lead.id, pack.id, now);
  await recordPackHash(pack);

  let drop: Drop | undefined;
  if ((await settings(d.db)).autoDrop) drop = await scheduleDrop(d, pack.id, DROP_COPIES, nextOpening(now), 48);
  return { ok: true, lead: (await store.lead(lead.id))!, pack, drop, costUsd: r.costUsd };
}

/** Puts a pack on sale and emails confirmed subscribers right away, with the opening time in it. */
export async function scheduleDrop(d: Deps, packId: string, copies: number, opensAt: Date, hoursOpen: number): Promise<Drop> {
  const shop = shopStore(d.db);
  const drop = await shop.schedule({ packId, copies, opensAt, closesAt: new Date(opensAt.getTime() + hoursOpen * 3600_000) });
  if (d.mailer) {
    await announceDrop(
      mailStore(d.db),
      d.mailer,
      { id: drop.id, name: drop.title, blurb: drop.blurb, copies: drop.copies, opensAt: drop.opensAt },
      { cap: d.mailCap ?? 40, now: d.now, site: d.site },
    );
  }
  return drop;
}

/** The daily run: watch, then at most one investigation and one pack, best lead first. */
export async function daily(d: Deps) {
  const watched = await watch(d);
  const store = researchStore(d.db);
  const leads = await store.leads(200);
  const out: { watched: WatchResult; investigated?: string; wrote?: string; notes: string[] } = { watched, notes: [] };
  for (const l of leads.filter((x) => x.status === "new" && x.verdict === "INVESTIGATE")) {
    const r: StepResult = await investigate(d, l.id).catch((e: Error) => ({ ok: false as const, reason: e.message }));
    out.notes.push(`investigate ${l.id}: ${r.ok ? "done" : r.reason}`);
    if (r.ok) {
      out.investigated = l.id;
      break;
    }
    if (r.checks && !r.checks.underCap.ok) break; // out of money this month: stop trying
  }
  const ready = (await store.leads(200)).find((x) => x.status === "investigated");
  if (ready) {
    const r: StepResult = await write(d, ready.id).catch((e: Error) => ({ ok: false as const, reason: e.message }));
    out.notes.push(`write ${ready.id}: ${r.ok ? `pack ${r.pack?.id}` : r.reason}`);
    if (r.ok) out.wrote = r.pack?.id;
  }
  return out;
}
