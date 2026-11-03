import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, wipe } from "../testing/pglite";
import type { Db } from "../db";
import realPosts from "./fixtures/posts-2026-11-03.json";
import { countRepos, readDevto, readLobsters, searchGitHub, searchHN, searchReddit, searchStackExchange, type Fetch, type Post } from "./sources";
import { cluster, fullScore, novelty, partialScore, terms, THRESHOLDS, verdictFor } from "./score";
import { notInvestigated, onMission, seenTwice, STEP_ESTIMATE_USD, underCap } from "./coordinator";
import { assemblePack, fence, guardLinks, slugify, uniqueSlug } from "./pack";
import { costOf, ResearchRefused, type Investigation, type PackDraft, type ResearchModel } from "./model";
import { daily, investigate, nextOpening, scheduleDrop, watch, write } from "./loop";
import { researchStore } from "./store";
import { shopStore } from "../shop/store";
import { mailStore } from "../mail/store";
import { packList } from "../engine/drops";
import type { Mailer } from "../mail/mailer";
import type { Email } from "../mail/templates";
import type Anthropic from "@anthropic-ai/sdk";

process.env.OFFER_SIGNING_KEY = "88".repeat(32);
const NOW = new Date("2026-11-03T09:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

// Four developers, on both sites, hitting the same wall: flaky tests in CI.
const flaky: Post[] = [
  { id: "hn:1", source: "hn", url: "https://news.ycombinator.com/item?id=1", title: "Flaky tests", excerpt: "I wish there was a tool that finds flaky tests in our CI pipeline and quarantines them. We waste hours rerunning builds every time.", author: "ana", engagement: 120, postedAt: hoursAgo(5) },
  { id: "hn:2", source: "hn", url: "https://news.ycombinator.com/item?id=2", title: "Ask HN: flaky test detection?", excerpt: "Is there a tool for flaky tests in CI? Our pipeline reruns failing tests manually and it's painful.", author: "bo", engagement: 90, postedAt: hoursAgo(20) },
  { id: "gh:acme/ci#7", source: "github", url: "https://github.com/acme/ci/issues/7", title: "Detect flaky tests in CI pipeline", excerpt: "Someone should build a flaky tests detector for the CI pipeline. Rerunning builds by hand is tedious.", author: "cy", repo: "acme/ci", engagement: 40, postedAt: hoursAgo(30) },
  { id: "gh:zed/run#3", source: "github", url: "https://github.com/zed/run/issues/3", title: "Quarantine flaky tests", excerpt: "Would pay for something that tracks flaky tests across CI pipeline runs and quarantines them automatically.", author: "di", repo: "zed/run", engagement: 25, postedAt: hoursAgo(40) },
];
// One person wanting a watch with a heart-rate sensor: nothing to do with developer tools.
const offMission: Post = { id: "hn:9", source: "hn", url: "https://news.ycombinator.com/item?id=9", title: "Watches", excerpt: "I wish there was a minimal Casio watch with only heart rate tracking.", author: "ed", engagement: 3, postedAt: hoursAgo(2) };

const atom = (posts: Post[]) => `<?xml version="1.0"?><feed>${posts.map((p) => `<entry><author><name>/u/${p.author}</name></author><category term="${(p.repo ?? "r/programming").slice(2)}" /><content type="html">${p.excerpt.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</content><id>t3_${p.id.slice(3)}</id><link href="${p.url}" /><updated>${p.postedAt}</updated><published>${p.postedAt}</published><title>${p.title}</title></entry>`).join("")}</feed>`;
const seItems = (posts: Post[]) => ({ items: posts.map((p) => ({ question_id: Number(p.id.split(":").pop()), title: p.title, body: `<p>${p.excerpt}</p>`, link: p.url, creation_date: Math.floor(Date.parse(p.postedAt) / 1000), score: p.engagement, answer_count: 0, owner: { display_name: p.author } })) });

/**
 * A pretend internet: HN and GitHub return their posts for the first pain phrase only; Stack
 * Overflow returns `so` and Reddit returns `rd` for every search; dev.to and Lobsters are empty.
 */
function fakeFetch(hn: Post[], gh: Post[], repos = 0, so: Post[] = [], rd: Post[] = []): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const first = url.includes(encodeURIComponent('"wish there was"'));
    if (url.startsWith("https://hn.algolia.com/")) {
      const hits = first ? hn.map((p) => ({ objectID: p.id.slice(3), created_at: p.postedAt, author: p.author, story_title: p.title, comment_text: p.excerpt, points: p.engagement, num_comments: 0 })) : [];
      return Response.json({ hits });
    }
    if (url.startsWith("https://api.github.com/search/issues")) {
      const items = first ? gh.map((p) => ({ number: Number(p.id.split("#")[1]), html_url: p.url, title: p.title, body: p.excerpt, user: { login: p.author }, comments: p.engagement, reactions: { total_count: 0 }, created_at: p.postedAt, repository_url: `https://api.github.com/repos/${p.repo}` })) : [];
      return Response.json({ items });
    }
    if (url.startsWith("https://api.github.com/search/repositories")) return Response.json({ total_count: repos });
    if (url.startsWith("https://api.stackexchange.com/")) return Response.json(seItems(so));
    if (url.startsWith("https://www.reddit.com/")) return new Response(atom(rd), { headers: { "content-type": "application/atom+xml" } });
    if (url.startsWith("https://dev.to/") || url.startsWith("https://lobste.rs/")) return Response.json([]);
    return new Response("not found", { status: 404 });
  }) as Fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

const inv: Investigation = {
  exists: "partly",
  existing: [{ name: "FlakeHunter", url: "https://flakehunter.example/", gap: "Only works on Jenkins." }],
  attempts: "Two open source tries stalled in 2025.",
  demand: "Dozens of threads a month.",
  verdict: "build",
  reason: "Small, clear, needed.",
};
const draft: PackDraft = {
  slug: "Flaky Test Quarantine!!",
  title: "Flaky Test Quarantine",
  blurb: "Find flaky tests in CI and park them until fixed.",
  problem: "CI reruns waste hours [1][2]. See https://evil.example/phish and [this](https://evil.example/x).",
  whitespace: "FlakeHunter only covers Jenkins: https://flakehunter.example/",
  plan: "1. Parse JUnit XML. 2. Track pass and fail per test. 3. Quarantine.",
  buildPrompt: "Build a CLI. Example:\n```\nflaky scan\n```",
  tests: "- A test that fails then passes is flagged.",
  risks: "- Real failures marked flaky.",
};

function fakeModel(over: Partial<ResearchModel> = {}): ResearchModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    investigate: async (l) => { calls.push(`investigate ${l.id}`); return { result: inv, sources: ["https://flakehunter.example/"], costUsd: 0.31, detail: { webSearches: 4 } }; },
    writePack: async (l) => { calls.push(`write ${l.id}`); return { draft, costUsd: 0.22, detail: { outputTokens: 5000 } }; },
    ...over,
  };
}

function inbox(): Mailer & { box: { to: string; email: Email }[] } {
  const box: { to: string; email: Email }[] = [];
  return { live: false, box, send: async (to, email) => { box.push({ to, email }); } };
}

let db: Db;
beforeAll(async () => { db = await testDb(); }, 30_000);
beforeEach(async () => { await wipe(db); });

describe("sources", () => {
  it("HN: reads hits into posts, and the date filter is encoded (a bare '>' silently returned nothing)", async () => {
    const f = fakeFetch(flaky.filter((p) => p.source === "hn"), []);
    const posts = await searchHN("wish there was", new Date(hoursAgo(168)), f);
    expect(posts.map((p) => p.id)).toEqual(["hn:1", "hn:2"]);
    expect(posts[0]).toMatchObject({ url: "https://news.ycombinator.com/item?id=1", author: "ana", engagement: 120 });
    expect(f.calls[0]).toContain("numericFilters=created_at_i%3E");
  });
  it("GitHub: reads issues, keeps the repo, skips pull requests", async () => {
    const f: Fetch = async () => Response.json({ items: [
      { number: 7, html_url: "https://github.com/acme/ci/issues/7", title: "t", body: "b", user: { login: "cy" }, comments: 2, reactions: { total_count: 3 }, created_at: hoursAgo(1), repository_url: "https://api.github.com/repos/acme/ci" },
      { number: 8, html_url: "https://github.com/acme/ci/pull/8", title: "pr", body: "", user: { login: "x" }, comments: 0, created_at: hoursAgo(1), repository_url: "https://api.github.com/repos/acme/ci", pull_request: {} },
    ] });
    expect(await searchGitHub("q", new Date(hoursAgo(168)), f)).toEqual([expect.objectContaining({ id: "gh:acme/ci#7", repo: "acme/ci", engagement: 5 })]);
  });
  it("Stack Overflow: keeps only questions that use a pain phrase (the watch), or all of them (the cross-check)", async () => {
    const qs: Post[] = [
      { id: "so:stackoverflow:1", source: "stackoverflow", url: "https://stackoverflow.com/q/1", title: "Is there a tool that finds flaky tests?", excerpt: "In our CI pipeline.", author: "x", engagement: 3, postedAt: hoursAgo(5) },
      { id: "so:stackoverflow:2", source: "stackoverflow", url: "https://stackoverflow.com/q/2", title: "Python list sort", excerpt: "How do I sort a list?", author: "y", engagement: 1, postedAt: hoursAgo(6) },
    ];
    const f: Fetch = async () => Response.json(seItems(qs));
    expect((await searchStackExchange("is there a tool", new Date(hoursAgo(168)), "stackoverflow", f)).map((p) => p.id)).toEqual(["so:stackoverflow:1"]);
    expect(await searchStackExchange("flaky tests ci", new Date(hoursAgo(168)), "stackoverflow", f, null)).toHaveLength(2);
  });
  it("Reddit: reads the search feed, all phrases in one request (Reddit throttles)", async () => {
    const calls: string[] = [];
    const post: Post = { id: "rd:abc", source: "reddit", url: "https://www.reddit.com/r/devops/comments/abc/x/", title: "Flaky CI", excerpt: "I wish there was a <b>tool</b>", author: "zed", repo: "r/devops", engagement: 0, postedAt: hoursAgo(3) };
    const f: Fetch = async (u) => { calls.push(u); return new Response(atom([post, { ...post, id: "rd:old", postedAt: hoursAgo(24 * 30) }])); };
    const got = await searchReddit(["wish there was", "would pay for"], new Date(hoursAgo(168)), f);
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0])).toContain('"wish there was" OR "would pay for"');
    expect(got).toEqual([expect.objectContaining({ id: "rd:abc", author: "zed", repo: "r/devops", url: post.url, excerpt: "I wish there was a tool" })]);
  });
  it("dev.to and Lobsters: recent posts, only those using a phrase", async () => {
    const dev: Fetch = async () => Response.json([
      { id: 1, title: "Someone should build a better log viewer", description: "", url: "https://dev.to/a/1", published_at: hoursAgo(2), user: { username: "a" } },
      { id: 2, title: "My week", description: "nothing", url: "https://dev.to/b/2", published_at: hoursAgo(2), user: { username: "b" } },
    ]);
    expect((await readDevto(["someone should build"], new Date(hoursAgo(168)), dev)).map((p) => p.id)).toEqual(["dt:1"]);
    const lob: Fetch = async () => Response.json([
      { short_id: "k1", title: "Why is there no good diff tool for SQL?", comments_url: "https://lobste.rs/s/k1", created_at: hoursAgo(1), submitter_user: "c" },
      { short_id: "k2", title: "Rust 2.0", comments_url: "https://lobste.rs/s/k2", created_at: hoursAgo(1), submitter_user: "d" },
    ]);
    expect((await readLobsters(["why is there no"], new Date(hoursAgo(168)), lob)).map((p) => p.id)).toEqual(["lb:k1"]);
  });
  it("a source that answers with an error throws, so watch can report it", async () => {
    const down: Fetch = async () => new Response("rate limited", { status: 403 });
    await expect(searchGitHub("q", new Date(), down)).rejects.toThrow("github 403");
    await expect(searchHN("q", new Date(), down)).rejects.toThrow("hn 403");
    await expect(countRepos(["a"], down)).rejects.toThrow();
  });
});

describe("free scoring", () => {
  it("words: lowercase, no filler, no links or HTML", () => {
    expect(terms('<img src="x.png"> I wish there was a CLI for flaky Tests https://x.com/y')).toEqual(["cli", "flaky", "test"]);
  });
  it("groups posts about the same thing and keeps the rest apart; the id is the oldest post", () => {
    const cs = cluster([...flaky, offMission]);
    const big = cs.find((c) => c.posts.length > 1)!;
    expect(big.posts.map((p) => p.id).sort()).toEqual(flaky.map((p) => p.id).sort());
    expect(big.id).toBe("gh:zed/run#3");
    expect(cs.find((c) => c.id === "hn:9")!.posts).toHaveLength(1);
  });
  it("each component follows its stated rule", () => {
    const c = cluster(flaky)[0];
    const p = partialScore(c, NOW);
    expect(p.velocity).toMatchObject({ points: 20, inputs: { postsLast48h: 4 } });
    // 2 sites of the 3 that give full marks, and 4 people: 20 × (0.6 × 1/2 + 0.4 × 1) = 14.
    expect(p.sources).toMatchObject({ points: 14, inputs: { places: 2, people: 4 } });
    expect(p.size.points).toBeCloseTo(20 * Math.log10(1 + 275) / 3, 0);
    expect(p.pain.points).toBe(20);
    expect(novelty(0).points).toBe(20);
    expect(novelty(9999).points).toBe(0);
    expect(novelty(null)).toMatchObject({ points: 10, inputs: { reposFound: null } });
  });
  it("one quiet post scores low", () => {
    const s = fullScore(cluster([offMission])[0], NOW, 500);
    expect(s.velocity.points).toBeCloseTo(6.7, 1);
    expect(s.sources.points).toBe(0);
    expect(s.verdict).toBe("IGNORE");
  });
  it("thresholds: under 25 ignore, 25 to 39 watch, 40 and up investigate", () => {
    expect([24, 25, 39, 40, 100].map(verdictFor)).toEqual(["IGNORE", "WATCH", "WATCH", "INVESTIGATE", "INVESTIGATE"]);
    expect(THRESHOLDS).toEqual({ WATCH: 25, INVESTIGATE: 40 });
  });
  it("on a real week of posts (3 Nov 2026): every score is 0 to 100 and adds up", () => {
    for (const c of cluster(realPosts as Post[])) {
      const s = fullScore(c, NOW, null);
      const sum = s.velocity.points + s.sources.points + s.size.points + s.pain.points + s.novelty.points;
      expect(s.total).toBe(Math.round(sum));
      expect(s.total).toBeGreaterThanOrEqual(0);
      expect(s.total).toBeLessThanOrEqual(100);
    }
  });
});

describe("coordinator checks", () => {
  it("seen in 2 places: one site isn't enough", () => {
    expect(seenTwice(["hn"])).toMatchObject({ ok: false });
    expect(seenTwice(["hn", "stackoverflow"])).toMatchObject({ ok: true, why: "seen on hn, stackoverflow" });
  });
  it("on mission needs developer words", () => {
    expect(onMission("flaky tests in our CI pipeline", [], 1).ok).toBe(true);
    expect(onMission("a minimal watch with heart rate", [], 1)).toMatchObject({ ok: false });
  });
  it("issues all from one repo are a feature request, not a missing tool", () => {
    expect(onMission("api cli broken", ["a/b", "a/b"], 2)).toMatchObject({ ok: false, why: expect.stringContaining("a/b") });
    expect(onMission("api cli broken", ["a/b", "c/d"], 2).ok).toBe(true);
  });
  it("not already investigated: same lead, or half its words", () => {
    expect(notInvestigated(["a", "b"], [{ id: "x", terms: [] }], "x").ok).toBe(false);
    expect(notInvestigated(["flaky", "test", "ci", "pipeline"], [{ id: "y", terms: ["flaky", "test", "other"] }], "x").ok).toBe(false);
    expect(notInvestigated(["flaky", "test", "ci", "pipeline"], [{ id: "y", terms: ["flaky", "watch", "other"] }], "x").ok).toBe(true);
  });
  it("spend cap counts the most the next step could cost", () => {
    expect(underCap(5 - STEP_ESTIMATE_USD.investigate, 5, "investigate").ok).toBe(true);
    expect(underCap(5 - STEP_ESTIMATE_USD.investigate + 0.01, 5, "investigate").ok).toBe(false);
  });
});

describe("writing the pack", () => {
  it("slugs: lowercase, 3 to 32 characters, never taken twice", () => {
    expect(slugify("Flaky Test Quarantine!!")).toBe("flaky-test-quarantine");
    expect(slugify("x".repeat(50))).toHaveLength(32);
    expect(slugify("!")).toBe("pack-x");
    const taken = new Set(["a".repeat(32)]);
    const s = uniqueSlug("a".repeat(40), taken);
    expect(s).toHaveLength(32);
    expect(s.endsWith("-2")).toBe(true);
  });
  it("links: only real posts and search results survive", () => {
    const allowed = new Set(["https://ok.example/a"]);
    expect(guardLinks("see [here](https://evil.example/x) and https://evil.example/y and https://ok.example/a.", allowed)).toBe("see here and and https://ok.example/a.");
  });
  it("the build prompt can't break out of its code block", () => {
    const f = fence("a\n````\nb");
    expect(f.startsWith("`````text\n")).toBe(true);
    expect(f.endsWith("\n`````")).toBe(true);
  });
  it("the teaser links the real posts from our own data; the model's made-up links are gone", () => {
    const a = assemblePack(flaky, inv, draft, ["https://flakehunter.example/"], new Set());
    expect(a.id).toBe("flaky-test-quarantine");
    for (const p of flaky) expect(a.teaser).toContain(`](${p.url})`);
    expect(a.teaser + a.body).not.toContain("evil.example");
    expect(a.teaser).toContain("[FlakeHunter](https://flakehunter.example/)");
    expect(a.body).toContain("## The build prompt");
    expect(a.body).not.toContain("flakehunter"); // the paid part has no teaser content
  });
});

describe("what research costs", () => {
  it("Opus 5.5 at $4 / $20 per million tokens, searches at a cent each", () => {
    const u = { input_tokens: 100_000, output_tokens: 10_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 5 } } as unknown as Anthropic.Usage;
    const c = costOf([u]);
    expect(c.costUsd).toBeCloseTo(0.4 + 0.2 + 0.05, 6);
    expect(c.detail.webSearches).toBe(5);
  });
});

describe("the loop", () => {
  const deps = (over: Partial<Omit<Parameters<typeof watch>[0], "model">> & { model?: ReturnType<typeof fakeModel> } = {}) => ({
    db, now: () => NOW, fetch: fakeFetch(flaky.filter((p) => p.source === "hn"), flaky.filter((p) => p.source === "github")),
    site: "https://shop.test", ...over, model: over.model ?? fakeModel(),
  });

  it("watch: saves posts, groups and scores them, and only spends free lookups", async () => {
    const d = deps();
    const r = await watch(d);
    expect(r).toMatchObject({ fetched: { hn: 2, github: 2, stackoverflow: 0, reddit: 0, devto: 0, lobsters: 0 }, errors: [], leads: 1, investigate: 1, crossChecked: 1 });
    const [lead] = await researchStore(db).leads();
    expect(lead).toMatchObject({ verdict: "INVESTIGATE", status: "new" });
    expect(lead.score.novelty.inputs.reposFound).toBe(0);
    expect(d.model.calls).toEqual([]);
    // Seen on HN and GitHub already: the cross-check only asks the other sites.
    const cross = (d.fetch as ReturnType<typeof fakeFetch>).calls.filter((u) => /hn\.algolia|search\/issues/.test(u) && !u.includes("%22"));
    expect(cross).toEqual([]);
  });

  it("free repo lookups: none for a weak lead, at most 3 a run however many strong ones", async () => {
    const weak = deps({ fetch: fakeFetch([offMission], []) });
    await watch(weak);
    expect((weak.fetch as ReturnType<typeof fakeFetch>).calls.filter((u) => u.includes("search/repositories"))).toEqual([]);
    // Off mission, so it can never be investigated: no cross-check searches spent on it either.
    expect((weak.fetch as ReturnType<typeof fakeFetch>).calls.filter((u) => u.startsWith("https://api.stackexchange.com/") && !u.includes("q=is%20there") && !u.includes("q=wish"))).toEqual([]);

    await wipe(db);
    const topics = ["kafka", "grafana", "prisma", "webpack", "jenkins", "redis"];
    const dev = [["api", "cli"], ["docker", "sql"], ["git", "deploy"], ["npm", "debug"], ["terraform", "schema"], ["webhook", "yaml"]];
    const strong: Post[] = topics.flatMap((t, i) => [0, 1, 2].map((j) => ({
      id: `hn:${100 + i * 10 + j}`, source: "hn" as const, url: `https://news.ycombinator.com/item?id=${100 + i * 10 + j}`, title: `${t} ${t}x ${t}y`,
      excerpt: `I wish there was a ${t} ${t}x ${t}y ${t}z for ${dev[i][0]} and ${dev[i][1]}. Painful and tedious, we waste hours.`, author: `${t}${j}`, engagement: 200, postedAt: hoursAgo(3 + j),
    })));
    const many = deps({ fetch: fakeFetch(strong, []) });
    const r = await watch(many);
    expect(r.leads).toBe(6);
    const calls = (many.fetch as ReturnType<typeof fakeFetch>).calls;
    expect(calls.filter((u) => u.includes("search/repositories"))).toHaveLength(3);
    // GitHub's 10 searches a minute: 5 phrases + 3 repo counts + at most 2 cross-checks.
    expect(calls.filter((u) => u.startsWith("https://api.github.com/search/"))).toHaveLength(10);
    // Reddit: 1 watch query + at most 2 cross-checks.
    expect(calls.filter((u) => u.startsWith("https://www.reddit.com/"))).toHaveLength(3);
  });

  it("a source being down is reported, and the rest still runs", async () => {
    const d = deps({ fetch: (async (u: string) => (u.includes("algolia") ? new Response("", { status: 500 }) : fakeFetch([], flaky.filter((p) => p.source === "github"))(u))) as Fetch });
    const r = await watch(d);
    expect(r.errors.filter((e) => e.includes("hn 500")).length).toBeGreaterThanOrEqual(5);
    expect(r.errors.every((e) => e.includes("hn 500"))).toBe(true);
    expect(r.fetched.github).toBe(2);
  });

  it("cross-check: a lead seen only on HN is looked up on Stack Overflow, and a matching question joins it", async () => {
    const hnOnly = flaky.filter((p) => p.source === "hn");
    const match: Post = { id: "so:stackoverflow:77", source: "stackoverflow", url: "https://stackoverflow.com/q/77", title: "Quarantine flaky tests in a CI pipeline?", excerpt: "Our CI pipeline reruns flaky tests and builds. How do we track them?", author: "sam", engagement: 4, postedAt: hoursAgo(50) };
    const unrelated: Post = { id: "so:stackoverflow:78", source: "stackoverflow", url: "https://stackoverflow.com/q/78", title: "Python list sort", excerpt: "How do I sort a list of tuples?", author: "kim", engagement: 1, postedAt: hoursAgo(50) };
    const d = deps({ fetch: fakeFetch(hnOnly, [], 0, [match, unrelated]) });
    const r = await watch(d);
    expect(r.crossFound).toBe(1);
    const [lead] = await researchStore(db).leads();
    expect(lead.crossIds).toEqual(["so:stackoverflow:77"]);
    expect(lead.score.sources.inputs.places).toBe(2);
    // It stays attached on the next run, even when the cross-check finds nothing new.
    await watch(deps({ fetch: fakeFetch(hnOnly, []) }));
    expect((await researchStore(db).lead(lead.id))!.crossIds).toEqual(["so:stackoverflow:77"]);
    // And it counts for the "seen in 2 places" check.
    expect((await investigate(d, lead.id)).ok).toBe(true);
  });

  it("a lead seen on one site only is never investigated, even by hand", async () => {
    const d = deps({ fetch: fakeFetch(flaky.filter((p) => p.source === "hn"), []) });
    await watch(d);
    const [lead] = await researchStore(db).leads();
    const r = await investigate(d, lead.id, { force: true });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.checks?.seenTwice.ok).toBe(false);
    expect(d.model.calls).toEqual([]);
  });

  it("investigate: checks pass, the model runs once, the cost is recorded", async () => {
    const d = deps();
    await watch(d);
    const [lead] = await researchStore(db).leads();
    const r = await investigate(d, lead.id);
    expect(r.ok).toBe(true);
    expect(d.model.calls).toEqual([`investigate ${lead.id}`]);
    expect(await researchStore(db).spentThisMonth(NOW)).toBeCloseTo(0.31);
    expect((await researchStore(db).lead(lead.id))!.status).toBe("investigated");
    // Not twice.
    expect(await investigate(d, lead.id)).toMatchObject({ ok: false });
    expect(d.model.calls).toHaveLength(1);
  });

  it("a lead that was already worked on is never investigated again, even after 30 days", async () => {
    const d = deps();
    await watch(d);
    const [lead] = await researchStore(db).leads();
    await db.query("UPDATE leads SET status = 'packed', updated_at = $2 WHERE id = $1", [lead.id, new Date(NOW.getTime() - 40 * 86_400_000)]);
    expect(await investigate(d, lead.id)).toMatchObject({ ok: false, reason: "lead is already packed" });
    expect(d.model.calls).toEqual([]);
  });

  it("no money is spent when a check fails: off mission", async () => {
    const d = deps({ fetch: fakeFetch([offMission, { ...offMission, id: "hn:10", author: "fi", excerpt: "I wish there was a minimal Casio watch with heart rate tracking only." }], []) });
    await watch(d);
    const [lead] = await researchStore(db).leads();
    expect(lead.postIds.sort()).toEqual(["hn:10", "hn:9"]);
    const r = await investigate(d, lead.id, { force: true });
    expect(r).toMatchObject({ ok: false });
    expect(d.model.calls).toEqual([]);
  });

  it("no money is spent when the monthly cap would be passed", async () => {
    const d = deps();
    await watch(d);
    await shopStore(db).setSetting("research_cap_usd", "0.5");
    const [lead] = await researchStore(db).leads();
    const r = await investigate(d, lead.id);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.checks?.underCap.ok).toBe(false);
    expect(d.model.calls).toEqual([]);
  });

  it("WATCH only goes ahead when forced from the dashboard; IGNORE never", async () => {
    const d = deps();
    await watch(d);
    const store = researchStore(db);
    const [lead] = await store.leads();
    await db.query("UPDATE leads SET verdict = 'WATCH' WHERE id = $1", [lead.id]);
    expect((await investigate(d, lead.id)).ok).toBe(false);
    expect((await investigate(d, lead.id, { force: true })).ok).toBe(true);
    expect((await store.lead(lead.id))!.checks?.forced).toBe(true);
    await db.query("UPDATE leads SET verdict = 'IGNORE', status = 'new' WHERE id = $1", [lead.id]);
    expect((await investigate(d, lead.id, { force: true })).ok).toBe(false);
  });

  it("if it already exists, the lead is skipped and no pack is written", async () => {
    const d = deps({ model: fakeModel({ investigate: async () => ({ result: { ...inv, exists: "yes" }, sources: [], costUsd: 0.1, detail: {} }) }) });
    await watch(d);
    const [lead] = await researchStore(db).leads();
    await investigate(d, lead.id);
    expect((await researchStore(db).lead(lead.id))!.status).toBe("skipped");
    expect(await write(d, lead.id)).toMatchObject({ ok: false });
  });

  it("a refusal closes the lead; a network error leaves it to try again", async () => {
    const refusing = deps({ model: fakeModel({ investigate: async () => { throw new ResearchRefused("declined"); } }) });
    await watch(refusing);
    const [lead] = await researchStore(db).leads();
    expect(await investigate(refusing, lead.id)).toMatchObject({ ok: false, reason: "declined" });
    expect((await researchStore(db).lead(lead.id))!.status).toBe("failed");

    await wipe(db);
    const flaky2 = deps({ model: fakeModel({ investigate: async () => { throw new Error("fetch failed"); } }) });
    await watch(flaky2);
    const [l2] = await researchStore(db).leads();
    await expect(investigate(flaky2, l2.id)).rejects.toThrow("fetch failed");
    expect((await researchStore(db).lead(l2.id))!.status).toBe("new");
  });

  it("write: the pack goes on the shelf priced by the rule, its drop is scheduled, and confirmed subscribers get the email", async () => {
    const mailer = inbox();
    const d = deps({ mailer });
    // One confirmed subscriber, one who never confirmed.
    const mail = mailStore(db);
    await mail.signup("yes@example.com", NOW);
    await mail.signup("no@example.com", NOW);
    await db.query("UPDATE subscribers SET confirmed = true WHERE email = 'yes@example.com'");
    await db.query("DELETE FROM outbox");

    await watch(d);
    const [lead] = await researchStore(db).leads();
    await investigate(d, lead.id);
    const r = await write(d, lead.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack).toMatchObject({ id: "flaky-test-quarantine", score: lead.total });
    expect(r.pack!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.drop).toMatchObject({ copies: 5, opensAt: "2026-11-04T18:00:00.000Z", phase: "upcoming" }); // 09:00 is under 12 hours before 18:00, so the next day
    expect(mailer.box.map((m) => [m.to, m.email.subject])).toEqual([["yes@example.com", "New in: Flaky Test Quarantine"]]);
    expect(mailer.box[0].email.text).toContain("Haggling opens Wed 4 Nov, 18:00 UTC.");
    expect((await researchStore(db).lead(lead.id))!.status).toBe("packed");
    expect(packList(r.pack!.score)).toBeGreaterThan(0);
  });

  it("auto drop off: the pack is written but nothing is scheduled or emailed", async () => {
    const mailer = inbox();
    const d = deps({ mailer });
    await shopStore(db).setSetting("auto_drop", "0");
    await watch(d);
    const [lead] = await researchStore(db).leads();
    await investigate(d, lead.id);
    const r = await write(d, lead.id);
    expect(r.ok && r.drop).toBeUndefined();
    expect(await shopStore(db).drops(NOW.getTime())).toEqual([]);
  });

  it("drop slots: 18:00 UTC, at least 12 hours ahead", () => {
    expect(nextOpening(new Date("2026-11-03T05:59:00Z")).toISOString()).toBe("2026-11-03T18:00:00.000Z");
    expect(nextOpening(new Date("2026-11-03T06:01:00Z")).toISOString()).toBe("2026-11-04T18:00:00.000Z");
  });

  it("scheduling by hand announces once per drop", async () => {
    const mailer = inbox();
    const mail = mailStore(db);
    await mail.signup("yes@example.com", NOW);
    await db.query("UPDATE subscribers SET confirmed = true");
    await db.query("DELETE FROM outbox");
    await shopStore(db).addPack({ id: "hand-made", title: "Hand Made", blurb: "b", teaser: "t", body: "x", score: 70, leadId: null });
    await scheduleDrop({ db, mailer, now: () => NOW, site: "https://shop.test" }, "hand-made", 3, new Date("2026-11-06T18:00:00Z"), 24);
    expect(mailer.box).toHaveLength(1);
    expect(mailer.box[0].email.text).toContain("3 copies. Haggling opens Fri 6 Nov, 18:00 UTC.");
  });

  it("daily: watch, then one investigation and one pack, best lead first", async () => {
    const d = deps();
    const r = await daily(d);
    expect(r.investigated).toBeTruthy();
    expect(r.wrote).toBe("flaky-test-quarantine");
    expect(d.model.calls).toHaveLength(2);
  });
});
