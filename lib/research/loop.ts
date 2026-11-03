import type { Db } from "../db";
import { shopStore, type Drop, type Pack } from "../shop/store";
import { mailStore } from "../mail/store";
import { announceDrop } from "../mail/outbox";
import type { Mailer } from "../mail/mailer";
import { countRepos, PAIN_QUERIES, searchGitHub, searchHN, type Fetch, type Post } from "./sources";
import { cluster, fullScore, worthNoveltyCheck } from "./score";
import { checks, notInvestigated, onMission, underCap, type Checks } from "./coordinator";
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
}

const DAY = 86_400_000;
/** How far back posts count toward a lead. */
export const WINDOW_DAYS = 14;
/** At most this many free GitHub repo lookups per watch (GitHub allows 10 searches a minute without a key). */
export const NOVELTY_LOOKUPS = 4;
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
  fetched: { hn: number; github: number };
  errors: string[];
  leads: number;
  investigate: number;
  watch: number;
}

/** Reads the sources, saves the posts, groups them into leads and scores every lead. Free. */
export async function watch(d: Deps): Promise<WatchResult> {
  const now = (d.now ?? (() => new Date()))();
  const f = d.fetch ?? fetch;
  const store = researchStore(d.db);
  const since = new Date(now.getTime() - 7 * DAY);
  const found: Post[] = [];
  const errors: string[] = [];
  const fetched = { hn: 0, github: 0 };
  for (const q of PAIN_QUERIES) {
    for (const [name, search] of [["hn", searchHN], ["github", searchGitHub]] as const) {
      try {
        const posts = await search(q, since, f);
        fetched[name] += posts.length;
        found.push(...posts);
      } catch (e) {
        errors.push(`${name} "${q}": ${(e as Error).message}`);
      }
    }
  }
  await store.savePosts(found, now);

  const clusters = cluster(await store.postsSince(new Date(now.getTime() - WINDOW_DAYS * DAY)), 3, 0.2);
  let lookups = 0;
  let investigate = 0;
  let watching = 0;
  for (const c of clusters) {
    let repos: number | null = null;
    if (lookups < NOVELTY_LOOKUPS && worthNoveltyCheck(c, now)) {
      lookups++;
      try {
        repos = await countRepos(c.terms, f);
      } catch (e) {
        errors.push(`novelty ${c.id}: ${(e as Error).message}`);
      }
    }
    const score = fullScore(c, now, repos);
    if (score.verdict === "INVESTIGATE") investigate++;
    if (score.verdict === "WATCH") watching++;
    await store.upsertLead({ id: c.id, title: c.posts[0].title, terms: c.terms, postIds: c.posts.map((p) => p.id), score }, now);
  }
  return { fetched, errors, leads: clusters.length, investigate, watch: watching };
}

/** The coordinator's three checks for a step on a lead, saved so the notebook shows them. */
export async function coordinate(d: Deps, lead: Lead, step: "investigate" | "write", forced = false): Promise<Checks> {
  const now = (d.now ?? (() => new Date()))();
  const store = researchStore(d.db);
  const posts = await store.postsByIds(lead.postIds);
  const text = posts.map((p) => `${p.title} ${p.excerpt}`).join(" ");
  const repos = posts.filter((p) => p.repo).map((p) => p.repo!);
  const { capUsd } = await settings(d.db);
  const done = step === "investigate" ? await store.investigatedSince(new Date(now.getTime() - 30 * DAY)) : [];
  const c = checks({
    onMission: onMission(text, repos, posts.length),
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
  const c = await coordinate(d, lead, "investigate", Boolean(opts.force) && lead.verdict !== "INVESTIGATE");
  if (!c.pass) return { ok: false, reason: "a coordinator check failed", checks: c };
  if (!d.model) return { ok: false, reason: "no model" };

  const posts = await store.postsByIds(lead.postIds);
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

  const posts = await store.postsByIds(lead.postIds);
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
