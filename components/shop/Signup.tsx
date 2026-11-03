"use client";

import { useState } from "react";
import { copy } from "@/lib/copy";

// Drop emails. The browser only sends the address to our server; the server checks it,
// saves it and sends the confirmation. Nothing here talks to the database or the mailbox.
export function Signup() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || state === "busy") return;
    setState("busy");
    setError(undefined);
    try {
      const r = await fetch("/api/mail/signup", { method: "POST", body: JSON.stringify({ email }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return setState("done");
      setError(copy.errors[j.error] ?? copy.errors.generic);
    } catch {
      setError(copy.errors.generic);
    }
    setState("idle");
  }

  if (state === "done") return <p className="rounded-xl bg-[#d6f5e6] px-3 py-2 text-sm font-semibold">{copy.mail.done}</p>;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-xl border-2 border-[#151311]/15 px-3 py-2">
      <label htmlFor="drop-email" className="text-sm font-semibold">{copy.mail.line}</label>
      <div className="flex gap-2">
        <input
          id="drop-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={copy.mail.placeholder}
          maxLength={254}
          className="min-w-0 flex-1 rounded-full border-2 border-[#151311] bg-white px-3 py-1.5 text-sm outline-none focus:shadow-[3px_3px_0_#ff4a24]"
        />
        <button disabled={state === "busy" || !email.trim()} className="rounded-full bg-[#151311] px-4 text-sm font-bold text-white disabled:opacity-40">
          {copy.mail.button}
        </button>
      </div>
      {error && <p className="text-sm font-semibold text-[#c2341a]">{error}</p>}
    </form>
  );
}
