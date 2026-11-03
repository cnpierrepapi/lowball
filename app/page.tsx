import { Suspense } from "react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { shelf } from "@/lib/shop/view";
import { formatOpensAt } from "@/lib/mail/templates";
import { Signup } from "@/components/shop/Signup";
import { HeroKeeper } from "@/components/landing/HeroKeeper";

// The front of the shop: what she does, what's on the shelf, and the email box.
export default function Home() {
  return (
    <main className="min-h-screen bg-[#fff6ea] text-[#151311]">
      <section className="shop-backdrop relative overflow-hidden border-b-2 border-[#151311]">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 pt-8 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-14">
          <div className="pb-8 lg:pb-16">
            <h1 className="font-display text-5xl font-extrabold leading-none tracking-tight lg:text-7xl">
              LOW<span className="text-[#ff4a24]">BALL</span>
            </h1>
            <p className="mt-4 max-w-md font-display text-2xl font-bold leading-tight lg:text-3xl">{copy.headline}</p>
            <p className="mt-4 max-w-md text-lg">{copy.shelf.pitch}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a href="#shelf" className="rounded-full bg-[#151311] px-5 py-3 font-display text-lg font-extrabold text-white">{copy.shelf.heading}</a>
              <Link href="/notebook" className="rounded-full border-2 border-[#151311] bg-white px-5 py-3 font-display text-lg font-extrabold">{copy.shelf.notebook}</Link>
            </div>
          </div>
          <div className="relative h-72 sm:h-96 lg:h-auto">
            <HeroKeeper />
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 py-10 sm:px-6 md:grid-cols-3">
        {copy.shelf.steps.map(([head, body], i) => (
          <div key={head} className="rounded-2xl border-2 border-[#151311] bg-white p-5 shadow-[4px_4px_0_#151311]">
            <p className="font-mono text-sm font-bold text-[#ff4a24]">{i + 1}</p>
            <p className="font-display text-xl font-extrabold">{head}</p>
            <p className="mt-1 text-[#151311]/80">{body}</p>
          </div>
        ))}
      </section>

      <section id="shelf" className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
        <h2 className="font-display text-3xl font-extrabold">{copy.shelf.heading}</h2>
        <Suspense fallback={<p className="mt-4 font-mono text-sm">{copy.reader.loading}</p>}>
          <Shelf />
        </Suspense>
      </section>

      <section className="mx-auto max-w-xl px-4 pb-10 sm:px-6">
        <Signup />
      </section>

      <footer className="border-t-2 border-[#151311]/10 px-4 py-6 text-center font-mono text-xs text-[#151311]/60">{copy.devnet}</footer>
    </main>
  );
}

async function Shelf() {
  const cards = await shelf();
  if (cards.length === 0) return <p className="mt-4 text-lg">{copy.shelf.empty}</p>;
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => {
        const open = c.sale.phase === "open";
        const status =
          c.sale.phase === "upcoming" && c.sale.opensAt ? copy.drop.notOpen(formatOpensAt(c.sale.opensAt))
          : c.sale.phase === "sold_out" ? copy.drop.soldOut
          : c.sale.phase === "closed" ? copy.drop.closed
          : copy.drop.left(c.sale.left ?? 0, c.sale.copies ?? 0);
        return (
          <Link
            key={c.packId}
            href={`/pack/${c.packId}`}
            className={`flex flex-col rounded-2xl border-2 border-[#151311] bg-white p-5 shadow-[4px_4px_0_#151311] transition-transform hover:-translate-y-0.5 ${open ? "" : "opacity-80"}`}
          >
            <p className="font-mono text-xs font-bold uppercase tracking-widest text-[#151311]/50">{copy.shelf.score(c.score)}</p>
            <p className="mt-1 font-display text-xl font-extrabold leading-tight">{c.title}</p>
            <p className="mt-1 flex-1 text-[#151311]/80">{c.blurb}</p>
            <p className={`mt-3 font-mono text-sm font-bold ${open ? "text-[#19a866]" : ""}`}>{status}</p>
            <span className="mt-3 self-start rounded-full bg-[#151311] px-4 py-2 text-sm font-bold text-white">{open ? copy.shelf.go : copy.shelf.look}</span>
          </Link>
        );
      })}
    </div>
  );
}
