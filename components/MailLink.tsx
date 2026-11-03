"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { copy } from "@/lib/copy";

// The page behind a confirm or unsubscribe link. Opening it does nothing on its own: the button
// does it. Mail scanners open links to check them, and shouldn't sign people up or off.
export function MailLink({ kind }: { kind: "confirm" | "unsubscribe" }) {
  const token = useSearchParams().get("t");
  const [state, setState] = useState<"ready" | "busy" | "done" | "gone" | "slow" | "error">(token ? "ready" : "gone");

  async function go() {
    setState("busy");
    try {
      const r = await fetch(`/api/mail/${kind}`, { method: "POST", body: JSON.stringify({ t: token }) });
      setState(r.ok ? "done" : r.status === 410 ? "gone" : r.status === 429 ? "slow" : "error");
    } catch {
      setState("error");
    }
  }

  const m = copy.mail;
  return (
    <main className="min-h-screen bg-[#fff6ea] px-5 py-10 text-[#151311]">
      <div className="mx-auto max-w-md">
        <Link href="/" className="font-display text-2xl font-extrabold">LOW<span className="text-[#ff4a24]">BALL</span></Link>
        <div className="mt-10 rounded-2xl border-2 border-[#151311] bg-white p-6 shadow-[6px_6px_0_#151311]">
          {state === "done" ? (
            <p className="font-display text-xl font-extrabold">{kind === "confirm" ? m.confirmed : m.unsubscribed}</p>
          ) : state === "gone" ? (
            <p className="font-semibold">{copy.errors.link_gone}</p>
          ) : (
            <>
              {kind === "unsubscribe" && <p className="mb-4 font-display text-xl font-extrabold">{m.unsubLine}</p>}
              <button onClick={go} disabled={state === "busy"} className="w-full rounded-full bg-[#151311] py-3 font-display text-lg font-extrabold text-white disabled:opacity-50">
                {kind === "confirm" ? m.confirmButton : m.unsubButton}
              </button>
              {state === "slow" && <p className="mt-3 text-sm font-semibold">{copy.errors.signup_slow}</p>}
              {state === "error" && <p className="mt-3 text-sm font-semibold">{copy.errors.generic}</p>}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
