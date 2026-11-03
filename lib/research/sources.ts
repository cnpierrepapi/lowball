// Where she listens: Hacker News (Algolia's public search) and GitHub issue search.
// Both are free and need no key. Each source is a plain function over fetch, so tests feed
// it saved responses instead of the network.

export interface Post {
  id: string; // "hn:123" or "gh:owner/repo#45"
  source: "hn" | "github";
  url: string;
  title: string;
  excerpt: string;
  author: string;
  repo?: string;
  engagement: number;
  postedAt: string; // ISO
}

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

/** Recent HN stories and comments matching the phrase, newer than `since`. */
export async function searchHN(query: string, since: Date, fetchImpl: Fetch = fetch): Promise<Post[]> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(`"${query}"`)}&tags=(story,comment)&numericFilters=${encodeURIComponent(`created_at_i>${Math.floor(since.getTime() / 1000)}`)}&hitsPerPage=50`;
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

/** Recent GitHub issues containing the phrase. */
export async function searchGitHub(query: string, since: Date, fetchImpl: Fetch = fetch): Promise<Post[]> {
  const day = since.toISOString().slice(0, 10);
  const q = `"${query}" is:issue created:>=${day}`;
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
