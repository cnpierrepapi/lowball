"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { formatOpensAt } from "@/lib/mail/templates";

// The owner's back office: drops, packs, email and research. The browser only talks to
// /api/admin; every action is checked there against the admin cookie.

interface Drop { id: string; packId: string; title: string; copies: number; sold: number; held: number; opensAt: string; closesAt: string; phase: string }
interface Pack { id: string; title: string; score: number; hash: string; onchainTx: string | null }
interface LeadRow { id: string; title: string; total: number; verdict: string; status: string; packId: string | null }
interface Overview {
  passwordSet: boolean;
  signedIn: boolean;
  packs?: Pack[];
  drops?: Drop[];
  mail?: { confirmed: number; unconfirmed: number; sentToday: number; cap: number; waiting: number; live: boolean; liveFromServer: boolean };
  research?: { spent: number; capUsd: number; autoDrop: boolean; leads: LeadRow[] };
  error?: string;
}

const a = copy.admin;
const box = "rounded-2xl border-2 border-[#151311] bg-white p-4 shadow-[4px_4px_0_#151311]";
const btn = "rounded-full bg-[#151311] px-4 py-2 text-sm font-bold text-white disabled:opacity-40";
const btnLine = "rounded-full border-2 border-[#151311] px-3 py-1 text-sm font-bold disabled:opacity-40";
const field = "rounded-lg border-2 border-[#151311] px-2 py-1";

function tomorrowAt18(): string {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + 1);
  t.setUTCHours(18, 0, 0, 0);
  return t.toISOString().slice(0, 16);
}

export default function AdminPage() {
  const [o, setO] = useState<Overview>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [pw, setPw] = useState("");
  // The opening time is filled in when a pack is picked: the clock can't be read while the page is pre-built.
  const [form, setForm] = useState({ packId: "", copies: 5, opensAt: "", hoursOpen: 48 });
  const [preview, setPreview] = useState<{ text: string; subject: string; recipients: number }>();
  const [cap, setCap] = useState("");

  const show = useCallback((j: Overview) => {
    setO(j);
    if (j.research) setCap(String(j.research.capUsd));
  }, []);
  const load = useCallback(async () => show(await (await fetch("/api/admin", { cache: "no-store" })).json()), [show]);
  useEffect(() => {
    let live = true;
    fetch("/api/admin", { cache: "no-store" }).then((r) => r.json()).then((j: Overview) => live && show(j));
    return () => { live = false; };
  }, [show]);

  async function act(body: Record<string, unknown>, done?: (j: Record<string, unknown>) => void) {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) setMsg(j.error === "wrong_password" ? a.wrong : j.error === "slow_down" ? copy.errors.slow_down : String(j.error));
      else {
        done?.(j);
        if (body.action !== "preview_drop") await load();
      }
    } catch {
      setMsg(copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  if (!o) return <Shell><p className="font-mono text-sm">{copy.reader.loading}</p></Shell>;
  if (o.error) return <Shell><p>{copy.errors[o.error] ?? copy.errors.generic}</p></Shell>;

  if (!o.signedIn) {
    return (
      <Shell>
        <form
          onSubmit={(e) => { e.preventDefault(); act({ action: "login", password: pw }); }}
          className={`${box} flex max-w-sm flex-col gap-3`}
        >
          {!o.passwordSet && <p className="text-sm font-semibold">{a.setPassword}</p>}
          <label className="text-sm font-bold" htmlFor="pw">{a.login}</label>
          <input id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} className={field} />
          <button disabled={busy || pw.length < 8} className={btn}>{a.enter}</button>
          {msg && <p className="text-sm font-semibold text-[#c2341a]">{msg}</p>}
        </form>
      </Shell>
    );
  }

  const packsWithoutDrop = (o.packs ?? []).filter((p) => !(o.drops ?? []).some((d) => d.packId === p.id && d.phase !== "cancelled"));

  return (
    <Shell onLogout={() => act({ action: "logout" })}>
      {msg && <p className="mb-4 rounded-xl bg-[#ffe1d6] px-3 py-2 text-sm font-semibold">{msg}</p>}

      <section className={box}>
        <h2 className="font-display text-xl font-extrabold">{a.drops}</h2>
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {(o.drops ?? []).map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#151311]/10 pt-2">
              <span>
                <Link href={`/pack/${d.packId}`} className="font-bold underline">{d.title}</Link>
                <span className="ml-2 font-mono text-xs">{d.phase} · {d.sold} sold, {d.held} held, of {d.copies} · {formatOpensAt(d.opensAt)}</span>
              </span>
              {d.phase === "upcoming" && <button disabled={busy} onClick={() => act({ action: "cancel_drop", dropId: d.id })} className={btnLine}>{a.cancel}</button>}
            </li>
          ))}
        </ul>

        <h3 className="mt-4 font-bold">{a.schedule}</h3>
        <div className="mt-2 grid gap-2 text-sm sm:grid-cols-4">
          <label className="flex flex-col">{a.pack}
            <select value={form.packId} onChange={(e) => { setForm({ ...form, packId: e.target.value, opensAt: form.opensAt || tomorrowAt18() }); setPreview(undefined); }} className={field}>
              <option value="">–</option>
              {packsWithoutDrop.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
          <label className="flex flex-col">{a.copies}
            <input type="number" min={1} max={100} value={form.copies} onChange={(e) => setForm({ ...form, copies: Number(e.target.value) })} className={field} />
          </label>
          <label className="flex flex-col">{a.opensAt}
            <input type="datetime-local" value={form.opensAt} onChange={(e) => setForm({ ...form, opensAt: e.target.value })} className={field} />
          </label>
          <label className="flex flex-col">{a.hoursOpen}
            <input type="number" min={1} max={720} value={form.hoursOpen} onChange={(e) => setForm({ ...form, hoursOpen: Number(e.target.value) })} className={field} />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            disabled={busy || !form.packId || !form.opensAt}
            onClick={() => act({ action: "preview_drop", ...form, opensAt: `${form.opensAt}:00Z` }, (j) => {
              const e = j.email as { subject: string; text: string };
              setPreview({ subject: e.subject, text: e.text, recipients: Number(j.recipients) });
            })}
            className={btnLine}
          >
            {a.preview}
          </button>
          {preview && (
            <button disabled={busy} onClick={() => act({ action: "schedule_drop", ...form, opensAt: `${form.opensAt}:00Z` }, () => setPreview(undefined))} className={btn}>
              {a.confirm}
            </button>
          )}
        </div>
        {preview && (
          <div className="mt-2 rounded-lg bg-[#fff6ea] p-3 text-sm">
            <p className="font-semibold">{a.recipients(preview.recipients)}</p>
            <p className="mt-2 font-bold">{preview.subject}</p>
            <pre className="whitespace-pre-wrap font-sans">{preview.text}</pre>
          </div>
        )}
      </section>

      <section className={`${box} mt-4`}>
        <h2 className="font-display text-xl font-extrabold">{a.packs}</h2>
        {(o.packs ?? []).length === 0 ? <p className="text-sm">{a.noPacks}</p> : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {o.packs!.map((p) => (
              <li key={p.id}>
                <Link href={`/pack/${p.id}`} className="font-bold underline">{p.title}</Link>
                <span className="ml-2 font-mono text-xs">{p.id} · score {p.score} · {p.hash.slice(0, 12)}… · {copy.notebook.onchain(p.onchainTx)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {o.mail && (
        <section className={`${box} mt-4`}>
          <h2 className="font-display text-xl font-extrabold">{a.mail}</h2>
          <p className="text-sm">{a.mailStats(o.mail.confirmed, o.mail.unconfirmed, o.mail.sentToday, o.mail.cap, o.mail.waiting)}</p>
          {o.mail.liveFromServer ? <p className="mt-2 text-sm font-semibold">{a.mailLiveServer}</p> : (
            <label className="mt-2 flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={o.mail.live} disabled={busy} onChange={(e) => act({ action: "settings", mailLive: e.target.checked })} />
              {a.mailLive}
            </label>
          )}
          <button disabled={busy || o.mail.waiting === 0} onClick={() => act({ action: "send_mail" })} className={`${btnLine} mt-2`}>{a.sendNow}</button>
        </section>
      )}

      {o.research && (
        <section className={`${box} mt-4`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-xl font-extrabold">{a.research}</h2>
            <Link href="/notebook" className="text-sm font-bold underline">{a.notebook}</Link>
          </div>
          <p className="text-sm">{a.spent(o.research.spent.toFixed(2), o.research.capUsd.toFixed(2))}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">{a.capLabel}
              <input type="number" min={0} max={100} step={0.5} value={cap} onChange={(e) => setCap(e.target.value)} className={`${field} w-24`} />
            </label>
            <button disabled={busy} onClick={() => act({ action: "settings", capUsd: Number(cap) })} className={btnLine}>{a.save}</button>
            <label className="flex items-center gap-2 font-semibold">
              <input type="checkbox" checked={o.research.autoDrop} disabled={busy} onChange={(e) => act({ action: "settings", autoDrop: e.target.checked })} />
              {a.autoDrop}
            </label>
          </div>
          <button disabled={busy} onClick={() => act({ action: "watch" })} className={`${btn} mt-3`}>{busy ? a.working : a.watchNow}</button>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {o.research.leads.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#151311]/10 pt-1">
                <span><span className="font-mono text-xs font-bold">{l.total} {l.verdict}</span> {l.title} <span className="font-mono text-xs">({l.status})</span></span>
                <span className="flex gap-1">
                  {l.status === "new" && l.verdict === "INVESTIGATE" && <button disabled={busy} onClick={() => act({ action: "investigate", leadId: l.id }, showResult)} className={btnLine}>{a.investigate}</button>}
                  {l.status === "new" && l.verdict === "WATCH" && <button disabled={busy} onClick={() => act({ action: "investigate", leadId: l.id, force: true }, showResult)} className={btnLine}>{a.investigateAnyway}</button>}
                  {l.status === "investigated" && <button disabled={busy} onClick={() => act({ action: "write", leadId: l.id }, showResult)} className={btnLine}>{a.write}</button>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  );

  function showResult(j: Record<string, unknown>) {
    const r = j.result as { ok: boolean; reason?: string } | undefined;
    if (r && !r.ok) setMsg(r.reason ?? copy.errors.generic);
  }
}

function Shell({ children, onLogout }: { children: React.ReactNode; onLogout?: () => void }) {
  return (
    <main className="min-h-screen bg-[#fff6ea] px-4 py-8 text-[#151311] sm:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="font-display text-2xl font-extrabold">LOW<span className="text-[#ff4a24]">BALL</span> <span className="text-base">{a.title}</span></Link>
          {onLogout && <button onClick={onLogout} className="text-sm font-bold underline">{a.logout}</button>}
        </div>
        {children}
      </div>
    </main>
  );
}
