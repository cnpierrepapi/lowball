import type { Db } from "../db";
import type { Post } from "./sources";
import type { Score, Verdict } from "./score";
import type { Checks } from "./coordinator";
import type { Investigation } from "./model";
import { CRYPTO_WORDS } from "./coordinator";

// The notebook's tables. Only the server reads and writes them.

export type LeadStatus = "new" | "investigated" | "skipped" | "packed" | "failed";

export interface Lead {
  id: string;
  title: string;
  terms: string[];
  postIds: string[];
  crossIds: string[]; // posts the cross-check found on other sites
  score: Score;
  total: number;
  verdict: Verdict;
  status: LeadStatus;
  checks: (Checks & { forced?: boolean; at?: string }) | null;
  investigation: (Investigation & { sources?: string[]; error?: string }) | null;
  packId: string | null;
  firstSeen: string;
  updatedAt: string;
}

const json = <T,>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

function leadFrom(r: Record<string, unknown>): Lead {
  return {
    id: String(r.id), title: String(r.title), terms: r.terms as string[], postIds: r.post_ids as string[], crossIds: (r.cross_ids as string[] | null) ?? [],
    score: json<Score>(r.score), total: Number(r.total), verdict: r.verdict as Verdict, status: r.status as LeadStatus,
    checks: r.checks == null ? null : json(r.checks), investigation: r.investigation == null ? null : json(r.investigation),
    packId: (r.pack_id as string) ?? null,
    firstSeen: new Date(r.first_seen as string).toISOString(), updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

function postFrom(r: Record<string, unknown>): Post {
  return {
    id: String(r.id), source: r.source as Post["source"], url: String(r.url), title: String(r.title), excerpt: String(r.excerpt),
    author: String(r.author), repo: (r.repo as string) ?? undefined, engagement: Number(r.engagement),
    postedAt: new Date(r.posted_at as string).toISOString(),
  };
}

export function researchStore(db: Db) {
  return {
    /** Saves posts. foundBy says how: the daily watch, or the cross-check for a lead (kept from the first time). */
    async savePosts(posts: Post[], now: Date, foundBy: "watch" | "crossref" = "watch"): Promise<void> {
      for (const p of posts) {
        await db.query(
          `INSERT INTO posts (id, source, url, title, excerpt, author, repo, engagement, posted_at, seen_at, found_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO UPDATE SET engagement = EXCLUDED.engagement, seen_at = EXCLUDED.seen_at`,
          [p.id, p.source, p.url, p.title, p.excerpt, p.author, p.repo ?? null, p.engagement, p.postedAt, now, foundBy],
        );
      }
    },

    /** Posts the watch found since `since` (cross-check finds stay with the lead they were found for). */
    async postsSince(since: Date): Promise<Post[]> {
      return (await db.query("SELECT * FROM posts WHERE posted_at >= $1 AND found_by = 'watch' ORDER BY posted_at", [since])).map(postFrom);
    },

    /** The cross-check posts already attached to these leads. */
    async crossIds(leadIds: string[]): Promise<Map<string, string[]>> {
      const rows = await db.query<{ id: string; cross_ids: string[] }>("SELECT id, cross_ids FROM leads WHERE id = ANY($1::text[])", [leadIds]);
      return new Map(rows.map((r) => [r.id, r.cross_ids ?? []]));
    },

    async postsByIds(ids: string[]): Promise<Post[]> {
      return (await db.query("SELECT * FROM posts WHERE id = ANY($1::text[]) ORDER BY posted_at", [ids])).map(postFrom);
    },

    /** New leads start as 'new'; a known lead gets its posts and score refreshed, keeping what was done with it. */
    async upsertLead(l: { id: string; title: string; terms: string[]; postIds: string[]; crossIds?: string[]; score: Score }, now: Date): Promise<void> {
      await db.query(
        `INSERT INTO leads (id, title, terms, post_ids, cross_ids, score, total, verdict, first_seen, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, terms = EXCLUDED.terms, post_ids = EXCLUDED.post_ids,
           cross_ids = EXCLUDED.cross_ids, score = EXCLUDED.score, total = EXCLUDED.total, verdict = EXCLUDED.verdict,
           updated_at = EXCLUDED.updated_at`,
        [l.id, l.title, l.terms, l.postIds, l.crossIds ?? [], JSON.stringify(l.score), l.score.total, l.score.verdict, now],
      );
    },

    async lead(id: string): Promise<Lead | undefined> {
      const r = (await db.query("SELECT * FROM leads WHERE id = $1", [id]))[0];
      return r ? leadFrom(r) : undefined;
    },

    async leads(limit = 100): Promise<Lead[]> {
      return (await db.query("SELECT * FROM leads ORDER BY total DESC, updated_at DESC LIMIT $1", [limit])).map(leadFrom);
    },

    /** Leads already looked into in the last 30 days, for the "not already investigated" check. */
    async investigatedSince(since: Date): Promise<{ id: string; terms: string[] }[]> {
      return db.query<{ id: string; terms: string[] }>(
        "SELECT id, terms FROM leads WHERE status <> 'new' AND updated_at >= $1",
        [since],
      );
    },

    async setChecks(id: string, checks: Lead["checks"]): Promise<void> {
      await db.query("UPDATE leads SET checks = $2::jsonb WHERE id = $1", [id, JSON.stringify(checks)]);
    },

    async setInvestigation(id: string, inv: Lead["investigation"], status: LeadStatus, now: Date): Promise<void> {
      await db.query("UPDATE leads SET investigation = $2::jsonb, status = $3, updated_at = $4 WHERE id = $1", [id, JSON.stringify(inv), status, now]);
    },

    async setPacked(id: string, packId: string, now: Date): Promise<void> {
      await db.query("UPDATE leads SET status = 'packed', pack_id = $2, updated_at = $3 WHERE id = $1", [id, packId, now]);
    },

    async setStatus(id: string, status: LeadStatus, now: Date): Promise<void> {
      await db.query("UPDATE leads SET status = $2, updated_at = $3 WHERE id = $1", [id, status, now]);
    },

    async spend(leadId: string | null, step: string, costUsd: number, detail: Record<string, number>, now: Date): Promise<void> {
      await db.query("INSERT INTO research_spend (lead_id, step, cost_usd, detail, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)", [leadId, step, costUsd, JSON.stringify(detail), now]);
    },

    /** Dollars spent on model calls in the UTC calendar month of `now`. */
    async spentThisMonth(now: Date): Promise<number> {
      const rows = await db.query<{ usd: string | number }>(
        `SELECT coalesce(sum(cost_usd), 0) AS usd FROM research_spend
         WHERE date_trunc('month', created_at AT TIME ZONE 'UTC') = date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC')`,
        [now],
      );
      return Number(rows[0]?.usd ?? 0);
    },

    /**
     * Deletes leads that have nothing to do with Solana or crypto (no post mentions a word from the
     * mission's list), and the posts only they use, so the next watch can't rebuild them. Leads she
     * already spent money on, or worked on, are kept: the spending trail stays whole.
     */
    async clearOffMission(): Promise<{ leads: number; posts: number }> {
      const leads = (await db.query("SELECT * FROM leads")).map(leadFrom);
      const all = new Map((await db.query("SELECT * FROM posts")).map((r) => [String(r.id), postFrom(r)]));
      const spent = new Set((await db.query<{ lead_id: string }>("SELECT DISTINCT lead_id FROM research_spend WHERE lead_id IS NOT NULL")).map((r) => r.lead_id));
      const crypto = new Set(CRYPTO_WORDS);
      const offMission = (l: Lead) => {
        const text = [...l.postIds, ...l.crossIds].map((id) => all.get(id)).filter(Boolean).map((p) => `${p!.title} ${p!.excerpt}`).join(" ").toLowerCase();
        return !(text.match(/[a-z0-9+#.-]+/g) ?? []).some((w) => crypto.has(w));
      };
      const gone = leads.filter((l) => l.status === "new" && !spent.has(l.id) && offMission(l));
      const keep = leads.filter((l) => !gone.includes(l));
      const kept = new Set(keep.flatMap((l) => [...l.postIds, ...l.crossIds]));
      const posts = [...new Set(gone.flatMap((l) => [...l.postIds, ...l.crossIds]))].filter((id) => !kept.has(id));
      if (gone.length) {
        await db.transaction([
          ["DELETE FROM leads WHERE id = ANY($1::text[])", [gone.map((l) => l.id)]],
          ["DELETE FROM posts WHERE id = ANY($1::text[])", [posts]],
        ]);
      }
      return { leads: gone.length, posts: posts.length };
    },

    async spendLog(limit = 50) {
      return db.query<{ lead_id: string | null; step: string; cost_usd: string; created_at: string }>(
        "SELECT lead_id, step, cost_usd, created_at FROM research_spend ORDER BY created_at DESC LIMIT $1",
        [limit],
      );
    },
  };
}

