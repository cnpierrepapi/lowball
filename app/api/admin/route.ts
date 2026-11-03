import { NextRequest, NextResponse } from "next/server";
import { COOKIE, isAdmin, login, passwordSet, SESSION_SECONDS } from "@/lib/admin";
import { allow, clientIp } from "@/lib/limits";
import { db } from "@/lib/db";
import { shopStore } from "@/lib/shop/store";
import { mailStore } from "@/lib/mail/store";
import { dailyCap, mailSettings } from "@/lib/mail/mailer";
import { drain } from "@/lib/mail/outbox";
import { activeMailer } from "@/lib/mail/service";
import { dropEmail } from "@/lib/mail/templates";
import { siteUrl } from "@/lib/site";
import { investigate, scheduleDrop, settings, watch, write } from "@/lib/research/loop";
import { researchStore } from "@/lib/research/store";
import { liveDeps } from "@/lib/research/service";

// The admin dashboard's one route. Everything but logging in needs the admin cookie.
// Research steps can take minutes, so this may run up to 5 minutes.

export const maxDuration = 300;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Any failure comes back as JSON with its message, so the dashboard can show what went wrong
// instead of a blank "something broke". Messages never include settings or keys.
function failed(where: string, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`admin ${where}:`, message);
  return json({ error: "server_error", where, detail: message.slice(0, 300) }, 500);
}

export async function GET(req: NextRequest) {
  const d = db();
  if (!d) return json({ error: "not_set_up" }, 503);
  try {
    if (!isAdmin(req)) return json({ passwordSet: await passwordSet(), signedIn: false });
    return json({ passwordSet: true, signedIn: true, ...(await overview()) });
  } catch (e) {
    return failed("overview", e);
  }
}

async function overview() {
  const d = db()!;
  const now = new Date();
  const shop = shopStore(d);
  const research = researchStore(d);
  const mail = mailStore(d);
  const counts = (await d.query<{ confirmed: number; waiting: number }>(
    "SELECT count(*) FILTER (WHERE confirmed)::int AS confirmed, count(*) FILTER (WHERE NOT confirmed)::int AS waiting FROM subscribers",
  ))[0];
  const s = await settings(d);
  const m = mailSettings();
  return {
    packs: (await shop.packs()).map((p) => ({ id: p.id, title: p.title, score: p.score, hash: p.hash, onchainTx: p.onchainTx, createdAt: p.createdAt })),
    drops: await shop.drops(now.getTime()),
    mail: {
      confirmed: counts?.confirmed ?? 0,
      unconfirmed: counts?.waiting ?? 0,
      sentToday: await mail.sentOn(now),
      cap: dailyCap(),
      waiting: await mail.waiting(),
      live: m.live || (await shop.setting("mail_live")) === "1",
      liveFromServer: m.live,
      zoho: { user: Boolean(m.user), password: Boolean(m.password), host: Boolean(process.env.ZOHO_SMTP_HOST) },
    },
    research: {
      spent: await research.spentThisMonth(now),
      capUsd: s.capUsd,
      autoDrop: s.autoDrop,
      leads: (await research.leads(30)).map((l) => ({ id: l.id, title: l.title, total: l.total, verdict: l.verdict, status: l.status, checks: l.checks, packId: l.packId })),
      spendLog: await research.spendLog(20),
    },
  };
}

export async function POST(req: NextRequest) {
  try {
    return await post(req);
  } catch (e) {
    return failed("action", e);
  }
}

async function post(req: NextRequest) {
  const d = db();
  if (!d) return json({ error: "not_set_up" }, 503);
  // Forms posted from another site carry their own Origin; only ours gets in.
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.nextUrl.host) return json({ error: "bad_origin" }, 403);
  const body = await req.json().catch(() => ({}));

  if (body.action === "login") {
    const ip = clientIp(req);
    if (!allow(`admin:${ip}`, 5, 60_000) || !allow(`admin-h:${ip}`, 20, 3_600_000)) return json({ error: "slow_down" }, 429);
    const session = await login(body.password);
    if (!session) return json({ error: "wrong_password" }, 401);
    const res = json({ ok: true });
    res.cookies.set(COOKIE, session, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: SESSION_SECONDS });
    return res;
  }
  if (body.action === "logout") {
    const res = json({ ok: true });
    res.cookies.delete(COOKIE);
    return res;
  }
  if (!isAdmin(req)) return json({ error: "not_signed_in" }, 401);

  try {
    return json(await act(body));
  } catch (e) {
    console.error("admin:", (e as Error).message);
    return json({ error: (e as Error).message.slice(0, 300) }, 400);
  }
}

async function act(body: Record<string, unknown>) {
  const d = db()!;
  const shop = shopStore(d);
  const now = new Date();
  switch (body.action) {
    case "preview_drop": {
      const p = await shop.pack(String(body.packId));
      if (!p) throw new Error("no such pack");
      const opensAt = new Date(String(body.opensAt));
      if (Number.isNaN(opensAt.getTime())) throw new Error("bad opening time");
      const email = dropEmail(
        { id: "preview", name: p.title, blurb: p.blurb, copies: Number(body.copies), opensAt: opensAt.toISOString() },
        { shop: `${siteUrl()}/`, unsubscribe: `${siteUrl()}/unsubscribe?t=…` },
      );
      const recipients = (await d.query<{ n: number }>("SELECT count(*)::int AS n FROM subscribers WHERE confirmed"))[0]?.n ?? 0;
      return { email, recipients };
    }
    case "schedule_drop": {
      const opensAt = new Date(String(body.opensAt));
      const copies = Number(body.copies);
      const hours = Number(body.hoursOpen);
      if (Number.isNaN(opensAt.getTime()) || opensAt.getTime() < now.getTime()) throw new Error("the opening time must be in the future");
      if (!Number.isInteger(copies) || copies < 1 || copies > 100) throw new Error("copies must be 1 to 100");
      if (!(hours >= 1 && hours <= 24 * 30)) throw new Error("open for 1 hour to 30 days");
      const deps = (await liveDeps())!;
      const drop = await scheduleDrop(deps, String(body.packId), copies, opensAt, hours);
      return { drop };
    }
    case "cancel_drop":
      return { cancelled: await shop.cancel(String(body.dropId), now) };
    case "watch":
      return { watched: await watch({ db: d }) };
    case "investigate":
      return { result: await investigate((await liveDeps())!, String(body.leadId), { force: body.force === true }) };
    case "write":
      return { result: await write((await liveDeps())!, String(body.leadId)) };
    case "send_mail":
      return { sent: await drain(mailStore(d), await activeMailer(), { cap: dailyCap(), budgetMs: 45_000 }) };
    case "settings": {
      if (body.capUsd !== undefined) {
        const cap = Number(body.capUsd);
        if (!(cap >= 0 && cap <= 100)) throw new Error("research cap must be $0 to $100");
        await shop.setSetting("research_cap_usd", String(cap));
      }
      if (body.autoDrop !== undefined) await shop.setSetting("auto_drop", body.autoDrop ? "1" : "0");
      if (body.mailLive !== undefined) {
        const m = mailSettings();
        if (body.mailLive && (!m.user || !m.password)) throw new Error("the Zoho settings are missing on the server");
        await shop.setSetting("mail_live", body.mailLive ? "1" : "0");
      }
      return { ok: true };
    }
    default:
      throw new Error("unknown action");
  }
}
