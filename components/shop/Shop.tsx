"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TransactionSigner } from "@solana/kit";
import type { Wallet as StdWallet } from "@wallet-standard/base";
import { Keeper } from "@/components/keeper/Keeper";
import type { Keeper as Controller } from "@/components/keeper/scene";
import { copy } from "@/lib/copy";
import { formatUsdc } from "@/lib/engine/money";
import { createDemoWallet, loadDemoWallet, payingFetch, usdcOf } from "@/lib/client/wallet";
import { createVoice, type Voice } from "@/lib/client/voice";
import { connectWallet, subscribeWallets, walletsServerSnapshot, walletsSnapshot } from "@/lib/client/injected";
import { decodePaymentResponseHeader } from "@x402/core/http";

type Deal = { kind: "cash"; price: number } | { kind: "pledge"; price: number; referrals: number };
interface Msg { who: "keeper" | "buyer"; text: string }
interface ItemInfo { id: string; name: string; blurb: string; list: number }
interface Pledge {
  status: string; count?: number; required?: number; deadline?: number; paid?: number; topUp?: number; price?: number;
}
// The wallet paying: the in-browser demo one, or a real one connected through Wallet Standard.
interface Payer { signer: TransactionSigner; address: string; label: string; demo: boolean }
type Result =
  | { kind: "delivered"; title: string; tx?: string }
  | { kind: "pledged"; nonce: string; required: number; claim: string };

const ITEM = "overlords";
const UUID = /^[0-9a-f-]{36}$/i;

const errorText = (code?: string) => copy.errors[code ?? ""] ?? copy.errors.generic;

export function Shop({ refNonce }: { refNonce?: string }) {
  const keeper = useRef<Controller | null>(null);
  const voice = useRef<Voice | null>(null);

  const [item, setItem] = useState<ItemInfo>();
  const [session, setSession] = useState<string>();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [ask, setAsk] = useState<number>();
  const [mood, setMood] = useState(-0.2);
  const [deal, setDeal] = useState<Deal>();
  const [offer, setOffer] = useState<string>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [muted, setMuted] = useState(false);

  const [wallet, setWallet] = useState<Payer | null>(null);
  const installed = useSyncExternalStore(subscribeWallets, walletsSnapshot, walletsServerSnapshot);
  const [balance, setBalance] = useState<number>();
  const [funding, setFunding] = useState(false);

  const [result, setResult] = useState<Result>();
  const [pledge, setPledge] = useState<Pledge>();
  const [friendPledge, setFriendPledge] = useState<Pledge>();
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(0);

  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" }); }, [msgs]);

  const onKeeper = useCallback((k: Controller) => { keeper.current = k; }, []);

  // Wallet and a returning buyer's claim, on load.
  useEffect(() => {
    loadDemoWallet().then(async (w) => {
      if (!w) return;
      setWallet({ signer: w, address: w.address, label: "Demo wallet", demo: true });
      setBalance(await usdcOf(w.address));
    });
    const claim = new URLSearchParams(location.search).get("claim");
    if (claim) {
      fetch(`/api/claim?token=${encodeURIComponent(claim)}`).then(async (r) => {
        const j = await r.json();
        if (j.status === "delivered") setResult({ kind: "delivered", title: j.title });
        else if (j.status === "pledged") {
          const nonce = String(j.pledge).split("/").pop()!;
          setResult({ kind: "pledged", nonce, required: 0, claim });
        }
      });
    }
    if (refNonce && UUID.test(refNonce)) {
      fetch(`/api/pledge/${refNonce}`).then(async (r) => r.ok && setFriendPledge(await r.json()));
    }
  }, [refNonce]);

  // A pledger watches their friends come in.
  useEffect(() => {
    if (result?.kind !== "pledged") return;
    let stop = false;
    const tick = async () => {
      const r = await fetch(`/api/pledge/${result.nonce}`);
      if (!r.ok || stop) return;
      const p: Pledge = await r.json();
      setPledge(p);
      setNow(Math.floor(Date.now() / 1000));
      if (p.status === "released") {
        const c = await fetch(`/api/claim?token=${encodeURIComponent(result.claim)}`).then((x) => x.json());
        if (c.status === "delivered") setResult({ kind: "delivered", title: c.title });
      }
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => { stop = true; clearInterval(id); };
  }, [result]);

  function hear(j: { line: string; voice?: string; mood?: number; action?: string }) {
    setMsgs((m) => [...m, { who: "keeper", text: j.line }]);
    if (typeof j.mood === "number") {
      setMood(j.mood);
      keeper.current?.setMood(j.mood);
    }
    const reaction = j.action === "raise" || j.action === "walk_out" ? "slam"
      : j.action === "deal" || j.action === "pledge_deal" ? "nod"
      : j.action === "counter" || j.action === "final_offer" ? "scoff" : undefined;
    if (reaction) keeper.current?.react(reaction);
    if (j.voice) voice.current?.play(j.voice);
  }

  async function walkIn() {
    voice.current ??= createVoice((l) => keeper.current?.setTalk(l));
    voice.current.unlock();
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/api/haggle", { method: "POST", body: JSON.stringify({ item: ITEM, ref: refNonce }) });
      const j = await r.json();
      if (!r.ok) return setError(errorText(j.error));
      setItem(j.item);
      setAsk(j.ask);
      setSession(j.session);
      setMsgs([]);
      setDeal(undefined);
      setOffer(undefined);
      hear(j);
    } catch {
      setError(copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  async function say(e: React.FormEvent) {
    e.preventDefault();
    const message = draft.trim();
    if (!message || !session || busy) return;
    setDraft("");
    setMsgs((m) => [...m, { who: "buyer", text: message }]);
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/api/haggle", { method: "POST", body: JSON.stringify({ session, message }) });
      const j = await r.json();
      if (!r.ok) {
        if (j.line) hear({ line: j.line, action: "walk_out" });
        return setError(errorText(j.error));
      }
      setSession(j.session);
      setAsk(j.ask);
      if (j.offer) {
        setDeal(j.deal);
        setOffer(j.offer);
      }
      hear(j);
    } catch {
      setError(copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  async function getDemoWallet() {
    setFunding(true);
    setError(undefined);
    try {
      let w = wallet;
      if (!w) {
        const k = await createDemoWallet();
        w = { signer: k, address: k.address, label: "Demo wallet", demo: true };
        setWallet(w);
      }
      const r = await fetch("/api/drip", { method: "POST", body: JSON.stringify({ wallet: w.address }) });
      if (!r.ok) setError(errorText((await r.json()).error));
      setBalance(await usdcOf(w.address));
    } finally {
      setFunding(false);
    }
  }

  async function connect(std: StdWallet) {
    setError(undefined);
    try {
      const signer = await connectWallet(std);
      setWallet({ signer, address: signer.address, label: signer.label, demo: false });
      setBalance(await usdcOf(signer.address));
    } catch {
      setError(copy.errors.wallet_refused);
    }
  }

  async function pay() {
    if (!wallet || !offer || !deal) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await payingFetch(wallet.signer)(`/api/item/${ITEM}?offer=${offer}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(r.status === 402 ? copy.errors.payment_failed : errorText(j.error));
        return;
      }
      history.replaceState(null, "", `?claim=${encodeURIComponent(j.claim)}`);
      const pr = r.headers.get("PAYMENT-RESPONSE");
      const tx = pr ? decodePaymentResponseHeader(pr).transaction : j.recovered;
      if (j.status === "delivered") setResult({ kind: "delivered", title: j.title, tx });
      else setResult({ kind: "pledged", nonce: String(j.link).split("/").pop()!, required: j.referralsNeeded, claim: j.claim });
      keeper.current?.react("nod");
      keeper.current?.setMood(0.8);
      setMood(0.8);
      setBalance(await usdcOf(wallet.address));
    } catch {
      setError(copy.errors.payment_failed);
    } finally {
      setBusy(false);
    }
  }

  async function topUp() {
    if (!wallet || result?.kind !== "pledged") return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await payingFetch(wallet.signer)(`/api/pledge/${result.nonce}/topup`);
      if (!r.ok) setError(r.status === 402 ? copy.errors.payment_failed : errorText((await r.json().catch(() => ({}))).error));
      setPledge(await fetch(`/api/pledge/${result.nonce}`).then((x) => x.json()));
      setBalance(await usdcOf(wallet.address));
    } finally {
      setBusy(false);
    }
  }

  async function refund() {
    if (result?.kind !== "pledged") return;
    setBusy(true);
    try {
      const r = await fetch(`/api/pledge/${result.nonce}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) setError(errorText(j.error));
      else setPledge({ status: "refunded" });
      if (wallet) setBalance(await usdcOf(wallet.address));
    } finally {
      setBusy(false);
    }
  }

  const list = item?.list;
  // Once there's a deal, the card shows what you shook on, not her last ask.
  const shown = deal?.price ?? ask;
  const off = list && shown && shown < list ? Math.round((1 - shown / list) * 100) : 0;
  const moodIdx = Math.max(0, Math.min(4, Math.round((mood + 1) * 2)));
  const lastLine = [...msgs].reverse().find((m) => m.who === "keeper")?.text;
  const shareLink = result?.kind === "pledged" ? `${typeof location === "undefined" ? "" : location.origin}/r/${result.nonce}` : "";

  return (
    <div className="grid min-h-screen grid-rows-[46vh_auto] bg-[#fff6ea] text-[#151311] lg:h-screen lg:grid-cols-[1fr_440px] lg:grid-rows-1">
      {/* The shop floor */}
      <section className="shop-backdrop relative overflow-hidden">
        <Keeper onReady={onKeeper} className="absolute inset-0 h-full w-full" />
        <header className="pointer-events-none absolute left-4 top-3 lg:left-10 lg:top-8">
          <h1 className="font-display text-4xl font-extrabold leading-none tracking-tight lg:text-7xl">
            LOW<span className="text-[#ff4a24]">BALL</span>
          </h1>
          <p className="mt-2 hidden max-w-xs font-display text-2xl font-bold leading-tight lg:block">{copy.headline}</p>
        </header>
        {lastLine && (
          <div key={lastLine} className="bubble-in absolute right-4 top-[30%] max-w-[min(300px,34%)] rounded-2xl border-2 border-[#151311] bg-white px-4 py-3 text-base font-semibold shadow-[4px_4px_0_#151311] lg:right-10 lg:text-lg">
            {lastLine}
          </div>
        )}
        <button
          onClick={() => { setMuted(!muted); voice.current?.setMuted(!muted); }}
          className="absolute bottom-4 right-4 rounded-full border-2 border-[#151311] bg-white px-3 py-1 text-sm font-bold"
        >
          {muted ? "Sound off" : "Sound on"}
        </button>
        <p className="absolute bottom-4 left-6 font-mono text-xs text-[#151311]/60">{copy.devnet}</p>
      </section>

      {/* The counter: item, price, chat, pay */}
      <aside className="flex min-h-0 flex-col gap-3 border-[#151311] p-4 lg:border-l-2 lg:p-5">
        {refNonce && (
          <div className="rounded-xl bg-[#d6f5e6] px-3 py-2 text-sm font-semibold">
            {copy.referred}
            {friendPledge?.required ? <span className="ml-1 font-mono">({copy.progress(friendPledge.count ?? 0, friendPledge.required)})</span> : null}
          </div>
        )}

        <div className="rounded-2xl border-2 border-[#151311] bg-white p-4 shadow-[4px_4px_0_#151311]">
          <p className="font-display text-lg font-extrabold leading-tight">{item?.name ?? "How to Give Up and Love Your AI Overlords"}</p>
          <p className="text-sm text-[#151311]/70">{item?.blurb ?? "A survival guide written entirely in the finest AI slop."}</p>
          <div className="mt-3 flex items-end justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-[#151311]/60">{deal ? copy.yourDeal : copy.hisPrice}</p>
              <p className="font-display text-4xl font-extrabold tracking-tight">
                {list && shown !== undefined && shown < list && <span className="mr-2 text-xl font-bold text-[#151311]/35 line-through">{formatUsdc(list)}</span>}
                {shown !== undefined ? formatUsdc(shown) : "?.??"} <span className="text-lg">USDC</span>
              </p>
            </div>
            {off > 0 && <span className="rounded-lg bg-[#19a866] px-2 py-1 font-mono text-lg font-bold text-white">-{off}%</span>}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs font-semibold">
            <span className="uppercase tracking-widest text-[#151311]/60">{copy.mood}</span>
            <div className="flex flex-1 gap-1">
              {copy.moods.map((m, i) => (
                <span key={m} className={`h-2 flex-1 rounded-full ${i <= moodIdx ? (moodIdx < 2 ? "bg-[#ff4a24]" : moodIdx < 3 ? "bg-[#f2b544]" : "bg-[#19a866]") : "bg-[#151311]/10"}`} />
              ))}
            </div>
            <span>{copy.moods[moodIdx]}</span>
          </div>
        </div>

        {/* After paying */}
        {result?.kind === "delivered" && (
          <div className="rounded-2xl border-2 border-[#151311] bg-[#d6f5e6] p-4 shadow-[4px_4px_0_#151311]">
            <p className="text-xs font-bold uppercase tracking-widest text-[#19a866]">Deal sealed</p>
            <p className="font-display text-2xl font-extrabold">{copy.delivered}</p>
            <p className="mt-1 text-sm">{copy.keepLink}</p>
            {result.tx && (
              <a href={`https://explorer.solana.com/tx/${result.tx}?cluster=devnet`} target="_blank" rel="noreferrer" className="mt-2 inline-block font-mono text-xs font-bold underline">
                {copy.receipt}
              </a>
            )}
          </div>
        )}
        {result?.kind === "pledged" && (
          <div className="rounded-2xl border-2 border-[#151311] bg-white p-4 shadow-[4px_4px_0_#151311]">
            <p className="font-semibold">{copy.pledged(pledge?.required ?? result.required)}</p>
            {pledge?.required ? (
              <>
                <div className="mt-2 flex gap-1">
                  {Array.from({ length: pledge.required }, (_, i) => (
                    <span key={i} className={`h-3 flex-1 rounded-full ${i < (pledge.count ?? 0) ? "bg-[#19a866]" : "bg-[#151311]/10"}`} />
                  ))}
                </div>
                <p className="mt-1 flex justify-between font-mono text-xs">
                  <span>{copy.progress(pledge.count ?? 0, pledge.required)}</span>
                  {pledge.deadline && now > 0 && <span>{copy.timeLeft(pledge.deadline - now)}</span>}
                </p>
              </>
            ) : null}
            {pledge?.status === "refunded" && <p className="mt-2 font-semibold">{copy.refunded}</p>}
            {(pledge?.status === "open" || pledge?.status === "missed") && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => { navigator.clipboard.writeText(shareLink); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  className="rounded-full bg-[#151311] px-4 py-2 text-sm font-bold text-white"
                >
                  {copied ? copy.copied : copy.copyLink}
                </button>
                {pledge.topUp ? (
                  <button onClick={topUp} disabled={busy || !wallet} className="rounded-full border-2 border-[#151311] px-4 py-2 text-sm font-bold disabled:opacity-40">
                    {copy.topUp(pledge.topUp)}
                  </button>
                ) : null}
                {pledge.status === "missed" && pledge.paid ? (
                  <button onClick={refund} disabled={busy} className="rounded-full border-2 border-[#151311] px-4 py-2 text-sm font-bold disabled:opacity-40">
                    {copy.refund(pledge.paid)}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* The haggle */}
        {!result && (
          <>
            <div ref={log} className="flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {msgs.map((m, i) => (
                <p
                  key={i}
                  className={m.who === "buyer"
                    ? "ml-10 self-end rounded-2xl bg-[#ff4a24] px-4 py-2 font-semibold text-white"
                    : "mr-10 self-start rounded-2xl border-2 border-[#151311] bg-white px-4 py-2"}
                >
                  {m.text}
                </p>
              ))}
              {busy && session && <p className="mr-10 self-start rounded-2xl border-2 border-dashed border-[#151311]/40 px-4 py-2 text-[#151311]/50">...</p>}
            </div>

            {!session ? (
              <button onClick={walkIn} disabled={busy} className="rounded-full bg-[#151311] py-4 font-display text-xl font-extrabold text-white disabled:opacity-50">
                {copy.walkIn}
              </button>
            ) : (
              <form onSubmit={say} className="flex gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={copy.placeholder}
                  maxLength={600}
                  className="min-w-0 flex-1 rounded-full border-2 border-[#151311] bg-white px-4 py-3 outline-none focus:shadow-[3px_3px_0_#ff4a24]"
                />
                <button disabled={busy || !draft.trim()} className="rounded-full bg-[#ff4a24] px-5 font-bold text-white disabled:opacity-40">
                  {copy.send}
                </button>
              </form>
            )}

            {deal && offer && (
              <div className="flex flex-col gap-2">
                {wallet ? (
                  <button onClick={pay} disabled={busy} className="rounded-full bg-[#19a866] py-4 font-display text-xl font-extrabold text-white shadow-[4px_4px_0_#151311] disabled:opacity-50">
                    {busy ? copy.paying : deal.kind === "cash" ? copy.payCash(deal.price) : copy.payPledge(deal.price, deal.referrals)}
                  </button>
                ) : (
                  <>
                    <button onClick={getDemoWallet} disabled={funding} className="rounded-full bg-[#151311] py-4 font-display text-xl font-extrabold text-white shadow-[4px_4px_0_#ff4a24] disabled:opacity-50">
                      {funding ? copy.wallet.funding : copy.wallet.toPay}
                    </button>
                    {installed.map((w) => (
                      <button key={w.name} onClick={() => connect(w)} className="flex items-center justify-center gap-2 rounded-full border-2 border-[#151311] bg-white py-3 font-bold">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={w.icon} alt="" className="h-5 w-5" />
                        {copy.wallet.connect(w.name)}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {error && <p className="rounded-xl bg-[#ffe1d6] px-3 py-2 text-sm font-semibold">{error}</p>}

        {/* Wallet strip */}
        <div className="mt-auto flex items-center justify-between gap-2 rounded-xl border-2 border-[#151311]/15 px-3 py-2 text-sm">
          {wallet ? (
            <>
              <span className="font-mono">
                {wallet.demo ? copy.wallet.demo(formatUsdc(balance ?? 0)) : copy.wallet.real(wallet.label, wallet.address, formatUsdc(balance ?? 0))}
              </span>
              {(balance ?? 0) < 1_000_000 && (
                <button onClick={getDemoWallet} disabled={funding} className="font-bold text-[#ff4a24] underline disabled:opacity-50">
                  {funding ? copy.wallet.funding : copy.wallet.refill}
                </button>
              )}
            </>
          ) : (
            <>
              <span>{copy.wallet.none}</span>
              <div className="flex shrink-0 gap-1">
                {installed.slice(0, 2).map((w) => (
                  <button key={w.name} onClick={() => connect(w)} title={copy.wallet.connect(w.name)} className="rounded-full border-2 border-[#151311] bg-white p-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.icon} alt={w.name} className="h-5 w-5" />
                  </button>
                ))}
                <button onClick={getDemoWallet} disabled={funding} className="rounded-full bg-[#151311] px-3 py-1.5 font-bold text-white disabled:opacity-50">
                  {funding ? copy.wallet.funding : copy.wallet.getDemo}
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
