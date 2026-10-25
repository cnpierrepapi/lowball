"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { copy } from "@/lib/copy";

// The bought item, for whoever holds the claim. The link is the receipt: bookmark it.
export function Reader() {
  const token = useSearchParams().get("claim");
  const [book, setBook] = useState<{ title: string; markdown: string }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!token) return;
    fetch(`/api/read?token=${encodeURIComponent(token)}`).then(async (r) => {
      const j = await r.json();
      if (r.ok) setBook(j);
      else setError(j.error === "not_yours_yet" ? copy.reader.notYet : copy.reader.bad);
    });
  }, [token]);

  return (
    <main className="min-h-screen bg-[#fff6ea] px-5 py-10 text-[#151311]">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="font-display text-2xl font-extrabold">LOW<span className="text-[#ff4a24]">BALL</span></Link>
        {!token || error ? (
          <p className="mt-10 font-semibold">{error ?? copy.reader.bad}</p>
        ) : !book ? (
          <p className="mt-10 font-mono text-sm">{copy.reader.loading}</p>
        ) : (
          <article className="mt-8 rounded-2xl border-2 border-[#151311] bg-white p-6 shadow-[6px_6px_0_#151311] sm:p-10">
            <Markdown text={book.markdown} />
          </article>
        )}
      </div>
    </main>
  );
}
