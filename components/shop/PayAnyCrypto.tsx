"use client";

import { useEffect, useState } from "react";
import { copy } from "@/lib/copy";

// Paying the shaken price with any crypto, through Aurora Intents (real money). The browser only
// talks to our server; the server asks Aurora for a one-time deposit address for the exact price,
// and checks the payment until it's final.

interface Option { assetId: string; symbol: string; chain: string }
interface Started { nonce: string; depositAddress: string; depositMemo: string | null; amount: string; symbol: string; chain: string; deadline: string; status: string }

const c = copy.intents;

export function PayAnyCrypto({ itemId, offer, onPaid }: { itemId: string; offer: string; onPaid: (claim: string) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<Option[]>([]);
  const [asset, setAsset] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [started, setStarted] = useState<Started>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/intents").then((r) => r.json()).then((j) => {
      if (!live || !j.enabled) return;
      setEnabled(true);
      setOpts(j.tokens);
      setAsset(j.tokens[0]?.assetId ?? "");
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  // Once started, ask how it's going every 5 seconds until it's final.
  useEffect(() => {
    if (!started) return;
    let stop = false;
    const tick = async () => {
      const r = await fetch("/api/intents", { method: "POST", body: JSON.stringify({ action: "status", nonce: started.nonce }) });
      const j = await r.json().catch(() => ({}));
      if (stop) return;
      if (j.status) setStatus(j.status);
      if (j.paid && j.claim) return onPaid(j.claim);
      if (j.status === "REFUNDED" || j.status === "FAILED") return;
      setTimeout(tick, 5000);
    };
    const t = setTimeout(tick, 3000);
    return () => { stop = true; clearTimeout(t); };
  }, [started, onPaid]);

  if (!enabled) return null;
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-full border-2 border-[#151311] bg-white py-3 font-bold">
        {c.button}
      </button>
    );
  }

  const chosen = opts.find((o) => o.assetId === asset);

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/api/intents", { method: "POST", body: JSON.stringify({ action: "start", item: itemId, offer, originAsset: asset, refundTo }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setError(copy.errors[j.error] ?? c.errors[j.error] ?? copy.errors.generic);
      setStarted(j);
      setStatus(j.status);
    } catch {
      setError(copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border-2 border-[#151311] bg-white p-3 text-sm shadow-[4px_4px_0_#151311]">
      <p className="font-display text-base font-extrabold">{c.title}</p>
      <p className="text-xs text-[#151311]/70">{c.realMoney}</p>
      {!started ? (
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex flex-col font-semibold">{c.payWith}
            <select value={asset} onChange={(e) => setAsset(e.target.value)} className="rounded-lg border-2 border-[#151311] px-2 py-1 font-normal">
              {opts.map((o) => <option key={o.assetId} value={o.assetId}>{c.option(o.symbol, o.chain)}</option>)}
            </select>
          </label>
          <label className="flex flex-col font-semibold">{c.refund(chosen ? c.chainName(chosen.chain) : "")}
            <input value={refundTo} onChange={(e) => setRefundTo(e.target.value)} placeholder={c.refundPlaceholder} autoComplete="off" className="rounded-lg border-2 border-[#151311] px-2 py-1 font-mono font-normal" />
          </label>
          <button onClick={start} disabled={busy || !asset || !refundTo.trim()} className="rounded-full bg-[#151311] py-2 font-bold text-white disabled:opacity-40">
            {busy ? c.getting : c.get}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          <p>{c.send(started.amount, started.symbol, c.chainName(started.chain))}</p>
          <p className="break-all rounded-lg bg-[#fff6ea] px-2 py-1 font-mono text-xs">{started.depositAddress}</p>
          {started.depositMemo && <p className="font-mono text-xs">{c.memo(started.depositMemo)}</p>}
          <button
            onClick={() => { navigator.clipboard.writeText(started.depositAddress); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="self-start rounded-full border-2 border-[#151311] px-3 py-1 text-xs font-bold"
          >
            {copied ? copy.copied : c.copyAddress}
          </button>
          <p className="text-xs">{c.before(new Date(started.deadline).toISOString().slice(11, 16))}</p>
          <p className="font-mono text-xs font-bold">{c.status[status ?? "PENDING_DEPOSIT"] ?? status}</p>
        </div>
      )}
      {error && <p className="mt-2 font-semibold text-[#c2341a]">{error}</p>}
    </div>
  );
}
