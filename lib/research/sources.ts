// Where she listens. Six places, all free, no key, no model:
//   Hacker News (Algolia search), GitHub issue search, Stack Overflow and friends (Stack
//   Exchange API), Reddit (search RSS, since its JSON turns away servers), dev.to and Lobsters
//   (recent posts, filtered for pain phrases, since they have no phrase search).
// Each source is a plain function over fetch, so tests feed it saved responses instead of the
// network. All were tested live on 3 Nov 2026; Bluesky (403) and Mastodon (empty without an
// account) were tried and left out.

export interface Post {
  id: string; // "hn:123", "gh:owner/repo#45", "so:stackoverflow:123", "rd:abc", "dt:123", "lb:abc"
  source: Source;
  url: string;
  title: string;
  excerpt: string;
  author: string;
  repo?: string;
  engagement: number;
  postedAt: string; // ISO
}

export const SOURCES = ["hn", "github", "stackoverflow", "reddit", "devto", "lobsters"] as const;
export type Source = (typeof SOURCES)[number];

/** Names for the notebook. */
export const SOURCE_NAMES: Record<Source, string> = {
  hn: "Hacker News", github: "GitHub", stackoverflow: "Stack Overflow", reddit: "Reddit", devto: "dev.to", lobsters: "Lobsters",
};

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What developers say when a tool is missing. Each phrase is one search on each source. */
// Short on purpose: long exact phrases almost never match (tested live on 3 Nov 2026:
// "I wish there was a tool" had 37 HN hits ever, "wish there was" had 14 in one week).
export const PAIN_QUERIES = ["wish there was", "is there a tool", "someone should build", "would pay for", "why is there no"];

const UA = { "User-Agent": "lowball-research (https://github.com/cnpierrepapi/lowball)" };

export function plainText(html: string): string {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>[^<]*<\/a>/gi, "$1")
    .replace(/<p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface HnHit {
  objectID: string;
  created_at: string;
  author?: string;
  title?: string | null;
  story_title?: string | null;
  comment_text?: string | null;
  story_text?: string | null;
  points?: number | null;
  num_comments?: number | null;
}

/** Recent HN stories and comments matching the phrase (or, with exact off, the words), newer than `since`. */
export async function searchHN(query: string, since: Date, fetchImpl: Fetch = fetch, exact = true): Promise<Post[]> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(exact ? `"${query}"` : query)}&tags=(story,comment)&numericFilters=${encodeURIComponent(`created_at_i>${Math.floor(since.getTime() / 1000)}`)}&hitsPerPage=50`;
  const r = await fetchImpl(url, { headers: UA });
  if (!r.ok) throw new Error(`hn ${r.status}`);
  const j = (await r.json()) as { hits?: HnHit[] };
  return (j.hits ?? []).map((h) => ({
    id: `hn:${h.objectID}`,
    source: "hn" as const,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    title: clip(h.title || h.story_title || "(untitled)", 200),
    excerpt: clip(plainText(h.comment_text || h.story_text || h.title || "")),
    author: h.author || "unknown",
    engagement: (h.points ?? 0) + (h.num_comments ?? 0),
    postedAt: new Date(h.created_at).toISOString(),
  }));
}

interface GhIssue {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  user?: { login?: string } | null;
  comments?: number;
  reactions?: { total_count?: number };
  created_at: string;
  repository_url: string;
  pull_request?: unknown;
}

/** Recent GitHub issues containing the phrase (or, with exact off, the words). */
export async function searchGitHub(query: string, since: Date, fetchImpl: Fetch = fetch, exact = true): Promise<Post[]> {
  const day = since.toISOString().slice(0, 10);
  const q = `${exact ? `"${query}"` : query} is:issue created:>=${day}`;
  const r = await fetchImpl(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=50`, {
    headers: { ...UA, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`github ${r.status}`);
  const j = (await r.json()) as { items?: GhIssue[] };
  return (j.items ?? [])
    .filter((i) => !i.pull_request)
    .map((i) => {
      const repo = i.repository_url.replace("https://api.github.com/repos/", "");
      return {
        id: `gh:${repo}#${i.number}`,
        source: "github" as const,
        url: i.html_url,
        title: clip(i.title, 200),
        excerpt: clip((i.body ?? "").replace(/\r/g, "").trim()),
        author: i.user?.login ?? "unknown",
        repo,
        engagement: (i.comments ?? 0) + (i.reactions?.total_count ?? 0),
        postedAt: new Date(i.created_at).toISOString(),
      };
    });
}

/** How many public repos already match these words: the free half of "has anyone built it?". */
export async function countRepos(terms: string[], fetchImpl: Fetch = fetch): Promise<number> {
  const q = `${terms.slice(0, 3).join(" ")} in:name,description,readme`;
  const r = await fetchImpl(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=1`, {
    headers: { ...UA, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`github repos ${r.status}`);
  return Number(((await r.json()) as { total_count?: number }).total_count ?? 0);
}

// ---- Stack Exchange: recent questions on the developer sites ----
// Its exact-phrase search found nothing in a week (tested 3 Nov), so this uses the looser
// search and keeps only questions that really say one of the phrases. The free allowance is
// per network address and shared, so it's used sparingly: 2 phrases on 2 sites a run.

export const SE_SITES = ["stackoverflow", "softwareengineering"];
export const SE_QUERIES = ["is there a tool", "wish there was"];
/** What a Stack Exchange question has to say to count. */
export const SE_PHRASES = [...PAIN_QUERIES, "is there a way", "any tool", "a tool that"];

interface SeQuestion {
  question_id: number;
  title: string;
  body?: string;
  link: string;
  creation_date: number;
  score?: number;
  answer_count?: number;
  owner?: { display_name?: string; user_id?: number };
}

/**
 * Recent questions matching the words on one Stack Exchange site. With `phrases`, only the ones
 * that use a pain phrase; with null (the cross-check), all of them.
 */
export async function searchStackExchange(query: string, since: Date, site = "stackoverflow", fetchImpl: Fetch = fetch, phrases: string[] | null = SE_PHRASES): Promise<Post[]> {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation&q=${encodeURIComponent(query)}&site=${site}&fromdate=${Math.floor(since.getTime() / 1000)}&pagesize=50&filter=withbody`;
  const r = await fetchImpl(url, { headers: UA });
  if (!r.ok) throw new Error(`stackexchange ${r.status}`);
  const j = (await r.json()) as { items?: SeQuestion[] };
  return (j.items ?? [])
    .map((i) => ({ i, title: plainText(i.title), body: plainText(i.body ?? "") }))
    .filter(({ title, body }) => phrases === null || mentions(`${title} ${body}`, phrases))
    .map(({ i, title, body }) => ({
      id: `so:${site}:${i.question_id}`,
      source: "stackoverflow" as const,
      url: i.link,
      title: clip(title, 200),
      excerpt: clip(body),
      author: i.owner?.display_name ?? (i.owner?.user_id ? `user${i.owner.user_id}` : "unknown"),
      repo: site === "stackoverflow" ? undefined : site,
      engagement: Math.max(0, i.score ?? 0) + (i.answer_count ?? 0),
      postedAt: new Date(i.creation_date * 1000).toISOString(),
    }));
}

// ---- Reddit: search RSS over the developer subreddits ----

export const SUBREDDITS = ["programming", "webdev", "devops", "ExperiencedDevs", "selfhosted", "SideProject"];

function between(s: string, open: RegExp, close: string): string | undefined {
  const m = open.exec(s);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const end = s.indexOf(close, start);
  return end < 0 ? undefined : s.slice(start, end);
}

/**
 * Posts in the developer subreddits matching any of the phrases, newer than `since`. Reddit
 * throttles hard (429 after a few calls, tested 3 Nov), so all phrases go in one OR query.
 */
export async function searchReddit(phrases: string[], since: Date, fetchImpl: Fetch = fetch): Promise<Post[]> {
  return redditFeed(phrases.map((p) => `"${p}"`).join(" OR "), since, fetchImpl, "week");
}

/** The cross-check: posts in the developer subreddits using these words, this month. */
export async function searchRedditWords(words: string, since: Date, fetchImpl: Fetch = fetch): Promise<Post[]> {
  return redditFeed(words, since, fetchImpl, "month");
}

// Reddit asks for a descriptive client name; with a generic one it answers 403 or 429 more often.
const REDDIT_UA = { "User-Agent": "web:lowball-research:1.0 (by lowball shop)" };

async function redditFeed(q: string, since: Date, fetchImpl: Fetch, t: "week" | "month"): Promise<Post[]> {
  const url = `https://www.reddit.com/r/${SUBREDDITS.join("+")}/search.rss?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&t=${t}&limit=50`;
  const r = await fetchImpl(url, { headers: REDDIT_UA });
  if (!r.ok) throw new Error(`reddit ${r.status}`);
  const xml = await r.text();
  const out: Post[] = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const id = between(entry, /<id>/, "</id>");
    const link = /<link href="([^"]+)"/.exec(entry)?.[1];
    const updated = between(entry, /<(?:published|updated)>/, "<");
    if (!id || !link || !updated) continue;
    const posted = new Date(updated);
    if (Number.isNaN(posted.getTime()) || posted < since) continue;
    const sub = /<category term="([^"]+)"/.exec(entry)?.[1];
    out.push({
      id: `rd:${id.replace(/^t3_/, "")}`,
      source: "reddit",
      url: link,
      title: clip(plainText(between(entry, /<title>/, "</title>") ?? "(untitled)"), 200),
      excerpt: clip(plainText(plainText(between(entry, /<content[^>]*>/, "</content>") ?? ""))),
      author: plainText(between(entry, /<author><name>/, "</name>") ?? "unknown").replace(/^\/u\//, ""),
      repo: sub ? `r/${sub}` : undefined,
      engagement: 0, // the feed carries no votes
      postedAt: posted.toISOString(),
    });
  }
  return out;
}

// ---- dev.to and Lobsters: no phrase search, so recent posts filtered for the phrases ----

/** True if the text contains any of the phrases. */
export function mentions(text: string, phrases: string[]): boolean {
  const t = text.toLowerCase();
  return phrases.some((p) => t.includes(p.toLowerCase()));
}

interface DevtoArticle {
  id: number;
  title: string;
  description?: string;
  url: string;
  published_at: string;
  comments_count?: number;
  public_reactions_count?: number;
  user?: { username?: string };
  tag_list?: string[];
}

/** Recent dev.to posts tagged discuss or help that use one of the phrases. */
export async function readDevto(phrases: string[], since: Date, fetchImpl: Fetch = fetch): Promise<Post[]> {
  const out: Post[] = [];
  for (const tag of ["discuss", "help"]) {
    const r = await fetchImpl(`https://dev.to/api/articles?tag=${tag}&per_page=100&state=fresh`, { headers: UA });
    if (!r.ok) throw new Error(`devto ${r.status}`);
    for (const a of (await r.json()) as DevtoArticle[]) {
      const posted = new Date(a.published_at);
      if (posted < since || !mentions(`${a.title} ${a.description ?? ""}`, phrases)) continue;
      out.push({
        id: `dt:${a.id}`, source: "devto", url: a.url, title: clip(a.title, 200), excerpt: clip(a.description ?? ""),
        author: a.user?.username ?? "unknown", engagement: (a.comments_count ?? 0) + (a.public_reactions_count ?? 0), postedAt: posted.toISOString(),
      });
    }
  }
  return [...new Map(out.map((p) => [p.id, p])).values()];
}

interface LobstersStory {
  short_id: string;
  title: string;
  description_plain?: string;
  comments_url: string;
  created_at: string;
  score?: number;
  comment_count?: number;
  submitter_user?: string | { username?: string };
}

/** Lobsters' newest stories that use one of the phrases. */
export async function readLobsters(phrases: string[], since: Date, fetchImpl: Fetch = fetch): Promise<Post[]> {
  const r = await fetchImpl("https://lobste.rs/newest.json", { headers: UA });
  if (!r.ok) throw new Error(`lobsters ${r.status}`);
  return ((await r.json()) as LobstersStory[])
    .filter((s) => new Date(s.created_at) >= since && mentions(`${s.title} ${s.description_plain ?? ""}`, phrases))
    .map((s) => ({
      id: `lb:${s.short_id}`, source: "lobsters" as const, url: s.comments_url, title: clip(s.title, 200), excerpt: clip(s.description_plain ?? ""),
      author: typeof s.submitter_user === "string" ? s.submitter_user : s.submitter_user?.username ?? "unknown",
      engagement: (s.score ?? 0) + (s.comment_count ?? 0), postedAt: new Date(s.created_at).toISOString(),
    }));
}
