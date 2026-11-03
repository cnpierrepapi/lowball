import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { testDb, wipe } from "@/lib/testing/pglite";
import { setDb, type Db } from "@/lib/db";
import { setEmailLookup } from "@/lib/mail/address";
import { setMailer, type Mailer } from "@/lib/mail/mailer";
import type { Email } from "@/lib/mail/templates";
import { POST as signup } from "./signup/route";
import { POST as confirm } from "./confirm/route";
import { POST as unsubscribe } from "./unsubscribe/route";
import { GET as cron } from "../cron/mail/route";
import { mailStore } from "@/lib/mail/store";

process.env.OFFER_SIGNING_KEY = "66".repeat(32);
process.env.LOWBALL_SITE_URL = "https://shop.test";
process.env.CRON_SECRET = "c".repeat(40);

const box: { to: string; email: Email }[] = [];
const fake: Mailer = { live: false, send: async (to, email) => { box.push({ to, email }); } };

let db: Db;
let ip = 0;
beforeAll(async () => { db = await testDb(); setDb(db); setMailer(fake); setEmailLookup(async () => true); }, 30_000);
beforeEach(async () => { await wipe(db); box.length = 0; ip++; });

const req = (url: string, init: { body?: unknown; headers?: Record<string, string>; method?: string } = {}) =>
  new NextRequest(`https://shop.test${url}`, {
    method: init.method ?? "POST",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { "x-forwarded-for": `10.1.0.${ip}`, ...init.headers },
  });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const tokenIn = (e: Email, path: string) => new RegExp(`/${path}\\?t=([A-Za-z0-9_-]{43})`).exec(e.text)![1];

describe("signup route", () => {
  it("saves the address, lowercased, and sends one confirmation", async () => {
    expect(await json(await signup(req("/api/mail/signup", { body: { email: " Ana@Example.com " } })))).toEqual({ status: 200, body: { ok: true } });
    expect(box.map((b) => [b.to, b.email.subject])).toEqual([["ana@example.com", "Confirm it's you"]]);
    expect(await db.query("SELECT email, confirmed FROM subscribers")).toEqual([{ email: "ana@example.com", confirmed: false }]);
  });

  it("rejects a bad address before touching the database", async () => {
    expect(await json(await signup(req("/api/mail/signup", { body: { email: "not an email" } })))).toEqual({ status: 400, body: { error: "bad_email" } });
    expect(await db.query("SELECT * FROM subscribers")).toEqual([]);
  });

  it("answers the same for a new, a repeated and a confirmed address", async () => {
    const one = await json(await signup(req("/api/mail/signup", { body: { email: "ana@example.com" } })));
    ip++;
    const two = await json(await signup(req("/api/mail/signup", { body: { email: "ana@example.com" } })));
    await json(await confirm(req("/api/mail/confirm", { body: { t: tokenIn(box[0].email, "confirm") } })));
    ip++;
    const three = await json(await signup(req("/api/mail/signup", { body: { email: "ana@example.com" } })));
    expect(two).toEqual(one);
    expect(three).toEqual(one);
    expect(box).toHaveLength(1);
  });

  it("slows down a flood from one address", async () => {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await signup(req("/api/mail/signup", { body: { email: `p${i}@example.com` } }))).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await json(await signup(req("/api/mail/signup", { body: { email: "z@example.com" } })))).body).toEqual({ error: "signup_slow" });
  });

  it("with no database, says the shop isn't set up", async () => {
    setDb(null);
    expect((await signup(req("/api/mail/signup", { body: { email: "ana@example.com" } }))).status).toBe(503);
    setDb(db);
  });
});

describe("confirm and unsubscribe routes", () => {
  it("confirm works once; junk and reused links get 410", async () => {
    await signup(req("/api/mail/signup", { body: { email: "ana@example.com" } }));
    const t = tokenIn(box[0].email, "confirm");
    expect((await confirm(req("/api/mail/confirm", { body: { t } }))).status).toBe(200);
    expect(await json(await confirm(req("/api/mail/confirm", { body: { t } })))).toEqual({ status: 410, body: { error: "link_gone" } });
    expect((await confirm(req("/api/mail/confirm", { body: { t: "short" } }))).status).toBe(410);
    expect((await confirm(req("/api/mail/confirm", { body: {} }))).status).toBe(410);
  });

  it("one-click unsubscribe from the email header deletes the address", async () => {
    await signup(req("/api/mail/signup", { body: { email: "ana@example.com" } }));
    await confirm(req("/api/mail/confirm", { body: { t: tokenIn(box[0].email, "confirm") } }));
    const store = mailStore(db);
    await store.announce({ id: "d1", name: "Thing", blurb: "A thing.", copies: 5, opensAt: "2026-11-06T18:00:00Z" }, new Date());
    expect((await json(await cron(req("/api/cron/mail", { method: "GET", headers: { authorization: `Bearer ${"c".repeat(40)}` } })))).body).toMatchObject({ sent: 1 });
    const header = box.at(-1)!.email.headers!["List-Unsubscribe"].slice(1, -1);
    const url = new URL(header);
    expect(url.pathname).toBe("/api/mail/unsubscribe");
    const r = await unsubscribe(new NextRequest(header, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.9.9.9" } }));
    expect(r.status).toBe(200);
    expect(await db.query("SELECT * FROM subscribers")).toEqual([]);
  });
});

describe("cron route", () => {
  it("turns away anyone without the secret", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${"c".repeat(39)}`, "c".repeat(40)]) {
      const r = await cron(req("/api/cron/mail", { method: "GET", headers: authorization ? { authorization } : {} }));
      expect(r.status).toBe(401);
    }
  });
  it("a wrong secret of the right length is turned away", async () => {
    const r = await cron(req("/api/cron/mail", { method: "GET", headers: { authorization: `Bearer ${"d".repeat(40)}` } }));
    expect(r.status).toBe(401);
  });
  it("a too-short CRON_SECRET is treated as not set", async () => {
    const s = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "abc";
    expect((await cron(req("/api/cron/mail", { method: "GET", headers: { authorization: "Bearer abc" } }))).status).toBe(401);
    process.env.CRON_SECRET = s;
  });
  it("refuses everyone if CRON_SECRET isn't set", async () => {
    const s = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    expect((await cron(req("/api/cron/mail", { method: "GET", headers: { authorization: "Bearer " } }))).status).toBe(401);
    process.env.CRON_SECRET = s;
  });
});
