import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { testDb, wipe } from "@/lib/testing/pglite";
import { setDb, type Db } from "@/lib/db";
import { setMailer, type Mailer } from "@/lib/mail/mailer";
import type { Email } from "@/lib/mail/templates";
import { shopStore } from "@/lib/shop/store";
import { setResearchModel } from "@/lib/research/service";
import { GET, POST } from "./route";
import { isAdmin, login } from "@/lib/admin";
import { GET as researchCron } from "../cron/research/route";

process.env.OFFER_SIGNING_KEY = "99".repeat(32);
process.env.LOWBALL_SITE_URL = "https://shop.test";
process.env.CRON_SECRET = "s".repeat(40);
delete process.env.ZOHO_MAIL_USER;
delete process.env.ZOHO_APP_PASSWORD;

const box: { to: string; email: Email }[] = [];
const fake: Mailer = { live: false, send: async (to, email) => { box.push({ to, email }); } };

let db: Db;
let ip = 0;
beforeAll(async () => { db = await testDb(); setDb(db); setMailer(fake); }, 30_000);
beforeEach(async () => { await wipe(db); box.length = 0; ip++; });

function req(method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://shop.test/api/admin", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "x-forwarded-for": `10.3.0.${ip}`, ...headers },
  });
}
const call = async (r: Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") }; };
async function signIn(pw = "fellas-test-pw") {
  const r = await call(POST(req("POST", { action: "login", password: pw })));
  expect(r.status).toBe(200);
  return r.cookie!.split(";")[0]; // "lowball_admin=..."
}

describe("the admin lock", () => {
  it("first visit sets the password; after that only that password works", async () => {
    expect((await call(GET(req("GET")))).body).toEqual({ passwordSet: false, signedIn: false });
    const cookie = await signIn("first-password");
    expect(cookie).toMatch(/^lowball_admin=/);
    expect((await call(GET(req("GET")))).body.passwordSet).toBe(true);
    ip++;
    expect((await call(POST(req("POST", { action: "login", password: "someone-else" })))).status).toBe(401);
    expect((await call(POST(req("POST", { action: "login", password: "first-password" })))).status).toBe(200);
  });

  it("the password is stored scrambled, never as typed", async () => {
    await signIn("first-password");
    const stored = await shopStore(db).setting("admin_password");
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain("first-password");
  });

  it("too short a password can't be set", async () => {
    expect((await call(POST(req("POST", { action: "login", password: "short" })))).status).toBe(401);
    expect(await shopStore(db).setting("admin_password")).toBeUndefined();
  });

  it("guessing is slowed down", async () => {
    await signIn("first-password");
    ip++;
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await POST(req("POST", { action: "login", password: `guess-${i}-xx` }))).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it("every action needs the cookie, and a forged cookie doesn't work", async () => {
    for (const action of ["watch", "schedule_drop", "settings", "send_mail", "cancel_drop"]) {
      expect((await call(POST(req("POST", { action })))).status).toBe(401);
    }
    expect((await call(POST(req("POST", { action: "watch" }, { cookie: "lowball_admin=forged.token" })))).status).toBe(401);
    expect((await call(GET(req("GET", undefined, { cookie: "lowball_admin=forged.token" })))).body.signedIn).toBe(false);
  });

  it("a login lasts 12 hours", async () => {
    await signIn("first-password");
    const old = await login("first-password", Date.now() - 13 * 3600_000);
    const fresh = await login("first-password");
    const with_ = (v: string) => new NextRequest("https://shop.test/api/admin", { headers: { cookie: `lowball_admin=${v}` } });
    expect(isAdmin(with_(fresh!))).toBe(true);
    expect(isAdmin(with_(old!))).toBe(false);
  });

  it("a form posted from another site is refused", async () => {
    const cookie = await signIn();
    expect((await call(POST(req("POST", { action: "settings", autoDrop: false }, { cookie, origin: "https://evil.example" })))).status).toBe(403);
  });
});

describe("the dashboard's actions", () => {
  beforeEach(async () => {
    await shopStore(db).addPack({ id: "admin-pack", title: "Admin Pack", blurb: "A pack.", teaser: "t", body: "b", score: 60, leadId: null });
    await db.query("INSERT INTO subscribers (email, created_at, confirmed, unsub_nonce, unsub_hash) VALUES ('yes@example.com', now(), true, 'n1', 'h1'), ('no@example.com', now(), false, 'n2', 'h2')");
  });

  it("preview shows the email and who gets it; scheduling sends it to confirmed addresses only", async () => {
    const cookie = await signIn();
    const opensAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const p = await call(POST(req("POST", { action: "preview_drop", packId: "admin-pack", copies: 3, opensAt }, { cookie })));
    expect(p.body.recipients).toBe(1);
    expect(p.body.email.subject).toBe("New in: Admin Pack");
    expect(box).toHaveLength(0);
    const s = await call(POST(req("POST", { action: "schedule_drop", packId: "admin-pack", copies: 3, opensAt, hoursOpen: 24 }, { cookie })));
    expect(s.status).toBe(200);
    expect(box.map((b) => b.to)).toEqual(["yes@example.com"]);
    const overview = await call(GET(req("GET", undefined, { cookie })));
    expect(overview.body.drops).toHaveLength(1);
    expect(overview.body.drops[0]).toMatchObject({ copies: 3, phase: "upcoming" });
  });

  it("refuses a drop in the past or with silly numbers", async () => {
    const cookie = await signIn();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect((await call(POST(req("POST", { action: "schedule_drop", packId: "admin-pack", copies: 3, opensAt: past, hoursOpen: 24 }, { cookie })))).status).toBe(400);
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call(POST(req("POST", { action: "schedule_drop", packId: "admin-pack", copies: 0, opensAt: later, hoursOpen: 24 }, { cookie })))).status).toBe(400);
    expect(box).toHaveLength(0);
  });

  it("settings: research cap within $0 to $100; real email can't be turned on without the Zoho settings", async () => {
    const cookie = await signIn();
    expect((await call(POST(req("POST", { action: "settings", capUsd: 7.5 }, { cookie })))).status).toBe(200);
    expect(await shopStore(db).setting("research_cap_usd")).toBe("7.5");
    expect((await call(POST(req("POST", { action: "settings", capUsd: 1000 }, { cookie })))).status).toBe(400);
    expect((await call(POST(req("POST", { action: "settings", mailLive: true }, { cookie })))).body.error).toMatch(/Zoho/);
    expect(await shopStore(db).setting("mail_live")).toBeUndefined();
  });
});

describe("when something breaks", () => {
  it("the dashboard gets the error as JSON, with where it happened, not a bare crash", async () => {
    const cookie = await signIn();
    setDb({ ...db, query: async () => { throw new Error("relation \"leads\" does not exist"); } });
    try {
      const r = await call(GET(req("GET", undefined, { cookie })));
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: "server_error", where: "overview", detail: 'relation "leads" does not exist' });
      const p = await call(POST(req("POST", { action: "settings", capUsd: 3 }, { cookie })));
      expect(p.status).toBe(400); // actions already answered with their error message
      expect(p.body.error).toContain("does not exist");
    } finally {
      setDb(db);
    }
  });
});

describe("the research cron", () => {
  it("turns away anyone without the secret", async () => {
    const r = await researchCron(new NextRequest("https://shop.test/api/cron/research", { headers: { authorization: "Bearer nope" } }));
    expect(r.status).toBe(401);
  });
  it("with the secret, runs the day's research (sources faked as down: it reports and carries on)", async () => {
    setResearchModel({ investigate: async () => { throw new Error("should not be called"); }, writePack: async () => { throw new Error("should not be called"); } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    try {
      const r = await researchCron(new NextRequest("https://shop.test/api/cron/research", { headers: { authorization: `Bearer ${"s".repeat(40)}` } }));
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.watched.errors.length).toBe(10);
      expect(j.investigated).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
      setResearchModel(undefined);
    }
  });
});
