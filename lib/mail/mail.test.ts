import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, wipe } from "../testing/pglite";
import type { Db } from "../db";
import { checkEmail, normalizeEmail } from "./address";
import { hashToken, looksLikeToken, newNonce, tokenFor } from "./tokens";
import { mailStore, type MailStore } from "./store";
import { dailyCap, logMailer, mailer, mailSettings, type Mailer } from "./mailer";
import { announceDrop, drain } from "./outbox";
import { confirmEmail, dropEmail, formatOpensAt, type DropInfo, type Email } from "./templates";
import { siteUrl } from "../site";

process.env.OFFER_SIGNING_KEY = "44".repeat(32);

const SITE = "https://shop.test";
const T0 = new Date("2026-11-03T10:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const drop: DropInfo = { id: "drop-1", name: "Build Pack: Flaky Test Finder", blurb: "Finds the tests that fail on Tuesdays.", copies: 5, opensAt: "2026-11-06T18:00:00Z" };

// A mailbox that keeps what it's given, and can be told to fail.
function fakeMailer() {
  const box: { to: string; email: Email }[] = [];
  let failing = false;
  const m: Mailer & { box: typeof box; fail(v: boolean): void } = {
    live: false,
    box,
    fail: (v) => { failing = v; },
    async send(to, email) {
      if (failing) throw new Error("smtp down");
      box.push({ to, email });
    },
  };
  return m;
}

const linkIn = (e: Email, path: string) => new RegExp(`${SITE}/${path}\\?t=([A-Za-z0-9_-]{43})`).exec(e.text)?.[1];

let db: Db;
let store: MailStore;
let box: ReturnType<typeof fakeMailer>;
const send = (cap = 40, now = T0) => drain(store, box, { cap, now: () => now, site: SITE });

async function confirmed(email: string, now = T0) {
  await store.signup(email, now);
  await send(500, now);
  const mail = box.box.filter((b) => b.to === email).at(-1)!;
  expect(await store.confirm(linkIn(mail.email, "confirm")!, now)).toBe(true);
}

beforeAll(async () => {
  db = await testDb();
  store = mailStore(db);
}, 30_000);

beforeEach(async () => {
  await wipe(db);
  box = fakeMailer();
});

describe("addresses", () => {
  const ok = async () => true;
  it("accepts real-looking addresses and lowercases them", async () => {
    expect(await checkEmail("  Ana.B+drops@Example.COM ", ok)).toBe("ana.b+drops@example.com");
    expect(await checkEmail("x@sub.domain.io", ok)).toBe("x@sub.domain.io");
  });
  for (const bad of ["", "plainaddress", "@example.com", "ana@", "ana@example", "ana@@example.com", "ana b@example.com",
    "ana@exa mple.com", "<ana@example.com>", ".ana@example.com", "ana.@example.com", "an..a@example.com", "ana@-example.com",
    "ana@example.c", `${"a".repeat(65)}@example.com`, `a@${"b".repeat(250)}.com`, "ana@example.com\nbcc:x@y.com"]) {
    it(`rejects ${JSON.stringify(bad).slice(0, 40)}`, async () => expect(await checkEmail(bad, ok)).toBeUndefined());
  }
  it("rejects an address over 254 characters, even with valid parts", async () => {
    const tail = `${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(60)}.com`;
    const address = (pad: number) => `${"a".repeat(64)}@${"g".repeat(pad)}.${tail}`;
    expect(address(2)).toHaveLength(254);
    expect(await checkEmail(address(2), ok)).toBe(address(2));
    expect(await checkEmail(address(3), ok)).toBeUndefined(); // 255, every part still valid
  });
  it("rejects anything that isn't a string", async () => {
    for (const v of [undefined, null, 42, ["a@b.com"], { email: "a@b.com" }]) expect(normalizeEmail(v)).toBeUndefined();
  });
  it("rejects a domain that can't receive mail, lets a slow DNS through", async () => {
    expect(await checkEmail("ana@nowhere.example", async () => false)).toBeUndefined();
    expect(await checkEmail("ana@slow.example", async () => undefined)).toBe("ana@slow.example");
  });
});

describe("link tokens", () => {
  it("are 256 bits, unique, and differ by purpose", () => {
    const n = newNonce();
    const tokens = new Set(Array.from({ length: 500 }, () => tokenFor("confirm", newNonce())));
    expect(tokens.size).toBe(500);
    expect(looksLikeToken(tokenFor("confirm", n))).toBe(true);
    expect(tokenFor("confirm", n)).not.toBe(tokenFor("unsub", n));
  });
  it("depend on the server key: the database's nonce alone doesn't make a link", () => {
    const n = newNonce();
    const a = tokenFor("confirm", n);
    process.env.OFFER_SIGNING_KEY = "55".repeat(32);
    expect(tokenFor("confirm", n)).not.toBe(a);
    process.env.OFFER_SIGNING_KEY = "44".repeat(32);
  });
  it("the database never holds a token", async () => {
    await store.signup("ana@example.com", T0);
    await send();
    const token = linkIn(box.box[0].email, "confirm")!;
    const dump = JSON.stringify(await db.query("SELECT * FROM subscribers"));
    expect(dump).not.toContain(token);
    expect(dump).toContain(hashToken(token));
  });
});

describe("double opt-in", () => {
  it("a signup gets one confirmation email, and the link confirms", async () => {
    expect(await store.signup("ana@example.com", T0)).toBe("new");
    const r = await send();
    expect(r.sent).toBe(1);
    expect(box.box[0]).toMatchObject({ to: "ana@example.com", email: { subject: "Confirm it's you" } });
    const t = linkIn(box.box[0].email, "confirm")!;
    expect(await store.confirm(t, T0)).toBe(true);
  });

  it("a confirm link works once", async () => {
    await store.signup("ana@example.com", T0);
    await send();
    const t = linkIn(box.box[0].email, "confirm")!;
    expect(await store.confirm(t, T0)).toBe(true);
    expect(await store.confirm(t, T0)).toBe(false);
  });

  it("one person's link can't confirm someone else, and made-up tokens do nothing", async () => {
    await store.signup("ana@example.com", T0);
    await store.signup("bo@example.com", T0);
    await send();
    const anas = linkIn(box.box.find((b) => b.to === "ana@example.com")!.email, "confirm")!;
    expect(await store.confirm(anas, T0)).toBe(true);
    const rows = await db.query<{ email: string; confirmed: boolean }>("SELECT email, confirmed FROM subscribers ORDER BY email");
    expect(rows).toEqual([{ email: "ana@example.com", confirmed: true }, { email: "bo@example.com", confirmed: false }]);
    expect(await store.confirm(tokenFor("confirm", newNonce()), T0)).toBe(false);
    expect(await store.confirm("A".repeat(43), T0)).toBe(false);
  });

  it("an unsubscribe token can't confirm, and a confirm token can't unsubscribe", async () => {
    await confirmed("ana@example.com");
    await store.announce(drop, T0);
    await send();
    const dropMail = box.box.find((b) => b.email.subject.startsWith("New in"))!;
    const unsub = linkIn(dropMail.email, "unsubscribe")!;
    expect(await store.confirm(unsub, T0)).toBe(false);
    await store.signup("bo@example.com", T0);
    await send();
    const bosConfirm = linkIn(box.box.at(-1)!.email, "confirm")!;
    expect(await store.unsubscribe(bosConfirm)).toBe(false);
  });

  it("a confirm link goes cold after 7 days", async () => {
    await store.signup("ana@example.com", T0);
    await send();
    expect(await store.confirm(linkIn(box.box[0].email, "confirm")!, later(7 * DAY + 1))).toBe(false);
  });

  it("signing up again within the hour sends nothing; after an hour, a fresh link replaces the old one", async () => {
    await store.signup("ana@example.com", T0);
    await send();
    const first = linkIn(box.box[0].email, "confirm")!;
    expect(await store.signup("ana@example.com", later(30 * 60_000))).toBe("nothing");
    expect((await send(40, later(30 * 60_000))).sent).toBe(0);
    expect(await store.signup("ANA@example.com".toLowerCase(), later(HOUR))).toBe("resend");
    await send(40, later(HOUR));
    expect(box.box).toHaveLength(2);
    const second = linkIn(box.box[1].email, "confirm")!;
    expect(second).not.toBe(first);
    expect(await store.confirm(first, later(HOUR))).toBe(false);
    expect(await store.confirm(second, later(HOUR))).toBe(true);
  });

  it("confirming before the confirmation email went out means it never goes out", async () => {
    await store.signup("ana@example.com", T0);
    expect((await send(0)).sent).toBe(0); // today's cap is used up, so it waits
    const nonce = (await db.query<{ confirm_nonce: string }>("SELECT confirm_nonce FROM subscribers"))[0].confirm_nonce;
    expect(await store.confirm(tokenFor("confirm", nonce), T0)).toBe(true);
    expect((await send(40, later(DAY))).sent).toBe(0);
  });

  it("a confirmed address signing up again gets nothing", async () => {
    await confirmed("ana@example.com");
    expect(await store.signup("ana@example.com", later(5 * DAY))).toBe("nothing");
    expect((await send(40, later(5 * DAY))).sent).toBe(0);
  });
});

describe("drop emails", () => {
  it("go to confirmed addresses only", async () => {
    await confirmed("ana@example.com");
    await store.signup("bo@example.com", T0); // never confirms
    box.box.length = 0;
    const r = await announceDrop(store, box, drop, { cap: 40, now: () => T0, site: SITE });
    expect(r.queued).toBe(1);
    expect(box.box.map((b) => [b.to, b.email.subject])).toEqual([
      ["bo@example.com", "Confirm it's you"],
      ["ana@example.com", "New in: Build Pack: Flaky Test Finder"],
    ]);
  });

  it("even a drop email forced into the queue for an unconfirmed address is never sent", async () => {
    await store.signup("bo@example.com", T0);
    await send();
    await db.query("INSERT INTO outbox (email, kind, drop_id, drop_info, created_at) VALUES ($1, 'drop', 'x', $2::jsonb, $3)", ["bo@example.com", JSON.stringify(drop), T0]);
    box.box.length = 0;
    expect((await send(40, later(DAY))).sent).toBe(0);
  });

  it("announcing the same drop twice sends it once", async () => {
    await confirmed("ana@example.com");
    expect(await store.announce(drop, T0)).toBe(1);
    expect(await store.announce(drop, later(HOUR))).toBe(0);
  });

  it("every drop email carries a working unsubscribe link that deletes the address", async () => {
    await confirmed("ana@example.com");
    await announceDrop(store, box, drop, { cap: 40, now: () => T0, site: SITE });
    const mail = box.box.at(-1)!.email;
    expect(mail.headers?.["List-Unsubscribe"]).toMatch(new RegExp(`^<${SITE}/api/mail/unsubscribe\\?t=[A-Za-z0-9_-]{43}>$`));
    const t = linkIn(mail, "unsubscribe")!;
    expect(await store.unsubscribe(t)).toBe(true);
    expect(await db.query("SELECT * FROM subscribers")).toEqual([]);
    expect(await store.unsubscribe(t)).toBe(false);
  });

  it("unsubscribing drops whatever was still queued for that address", async () => {
    await confirmed("ana@example.com");
    await store.announce(drop, T0);
    const nonce = (await db.query<{ unsub_nonce: string }>("SELECT unsub_nonce FROM subscribers"))[0].unsub_nonce;
    expect(await store.unsubscribe(tokenFor("unsub", nonce))).toBe(true);
    expect(await db.query("SELECT * FROM outbox")).toEqual([]);
  });
});

describe("the daily cap", () => {
  async function subscribers(n: number) {
    for (let i = 0; i < n; i++) await confirmed(`p${i}@example.com`, later(-2 * DAY));
    box.box.length = 0;
  }

  it("holds: the rest wait for the next day, then go", async () => {
    await subscribers(5);
    const day1 = await announceDrop(store, box, drop, { cap: 3, now: () => T0, site: SITE });
    expect(day1).toMatchObject({ queued: 5, sent: 3, waiting: 2 });
    expect((await send(3, later(2 * HOUR))).sent).toBe(0); // same UTC day
    const day2 = await send(3, later(DAY));
    expect(day2).toMatchObject({ sent: 2, waiting: 0 });
    expect(new Set(box.box.map((b) => b.to)).size).toBe(5);
  });

  it("counts confirmations too", async () => {
    for (let i = 0; i < 4; i++) await store.signup(`n${i}@example.com`, T0);
    expect((await send(2)).sent).toBe(2);
    expect(await store.sentOn(T0)).toBe(2);
  });

  it("a cap of zero sends nothing at all", async () => {
    await store.signup("ana@example.com", T0);
    expect((await send(0)).sent).toBe(0);
  });

  it("two senders at once still stop at the cap", async () => {
    await subscribers(10);
    await store.announce(drop, T0);
    const [a, b] = await Promise.all([send(4), send(4)]);
    expect(a.sent + b.sent).toBe(4);
    expect(box.box).toHaveLength(4);
  });

  it("a failed send counts, is retried after a while, and gives up after 3 tries", async () => {
    await store.signup("ana@example.com", T0);
    box.fail(true);
    expect(await send(40)).toMatchObject({ sent: 0, failed: 1, waiting: 1 });
    expect(await store.sentOn(T0)).toBe(1);
    expect((await send(40, later(60_000))).failed).toBe(0); // too soon to retry
    await send(40, later(11 * 60_000));
    await send(40, later(22 * 60_000));
    expect((await send(40, later(33 * 60_000))).failed).toBe(0);
    expect(await store.waiting()).toBe(0);
    box.fail(false);
  });

  it("is always set, and never unlimited", () => {
    expect(dailyCap({})).toBe(40);
    expect(dailyCap({ LOWBALL_MAIL_DAILY_CAP: "10" })).toBe(10);
    for (const bad of ["", "abc", "-1", "2.5", "Infinity"]) expect(dailyCap({ LOWBALL_MAIL_DAILY_CAP: bad })).toBe(bad === "" ? 0 : 40);
    expect(dailyCap({ LOWBALL_MAIL_DAILY_CAP: "100000" })).toBe(500);
  });
});

describe("sending switch", () => {
  it("without MAIL_LIVE=1 nothing is sent, only logged, and the log has no links", async () => {
    const lines: string[] = [];
    await logMailer((s) => lines.push(s)).send("ana@example.com", confirmEmail(`${SITE}/confirm?t=${"x".repeat(43)}`));
    expect(lines).toEqual(['mail not sent (MAIL_LIVE is off): to=a***@example.com subject="Confirm it\'s you"']);
    expect(mailSettings({}).live).toBe(false);
    expect(mailSettings({ MAIL_LIVE: "true" }).live).toBe(false);
    expect(mailSettings({ MAIL_LIVE: "1" }).live).toBe(true);
    delete process.env.MAIL_LIVE;
    expect(mailer().live).toBe(false);
  });
  it("defaults the Zoho host to smtp.zoho.eu", () => {
    expect(mailSettings({}).host).toBe("smtp.zoho.eu");
    expect(mailSettings({ ZOHO_SMTP_HOST: "smtp.zoho.com" }).host).toBe("smtp.zoho.com");
  });
});

describe("the words", () => {
  it("formats the opening time for the reader", () => {
    expect(formatOpensAt("2025-11-06T18:00:00Z")).toBe("Thu 6 Nov, 18:00 UTC");
    expect(formatOpensAt("2026-11-06T09:05:00+01:00")).toBe("Fri 6 Nov, 08:05 UTC");
  });
  it("the confirmation email, word for word", () => {
    expect(confirmEmail("LINK")).toEqual({
      subject: "Confirm it's you",
      text: "Someone left this email at my shop. If it was you, click here:\n\nLINK\n\nIf it wasn't, ignore this and you'll never hear from me again.\n\nThe shopkeeper\nLowball\n",
    });
  });
  it("the drop email, word for word", () => {
    const e = dropEmail({ ...drop, opensAt: "2025-11-06T18:00:00Z" }, { shop: "SHOP", unsubscribe: `${SITE}/unsubscribe?t=U` });
    expect(e.subject).toBe("New in: Build Pack: Flaky Test Finder");
    expect(e.text).toBe(
      "Got something new.\n\nBuild Pack: Flaky Test Finder\nFinds the tests that fail on Tuesdays.\n\n5 copies. Haggling opens Thu 6 Nov, 18:00 UTC. Not before. Once they're gone, they're gone, and I don't restock.\n\nSame rules as always. No price tag. Make me an offer.\n\nSHOP\n\nThe shopkeeper\n\nYou're getting this because you signed up at Lowball. Don't want these? https://shop.test/unsubscribe?t=U\n",
    );
  });
});

describe("links point at the right site", () => {
  it("production, preview, local", () => {
    expect(siteUrl({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "lowball-drab.vercel.app", VERCEL_URL: "x.vercel.app" })).toBe("https://lowball-drab.vercel.app");
    expect(siteUrl({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "lowball-git-phase2.vercel.app", VERCEL_URL: "x.vercel.app" })).toBe("https://lowball-git-phase2.vercel.app");
    expect(siteUrl({})).toBe("http://localhost:3000");
  });
});
