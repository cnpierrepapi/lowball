import { Suspense } from "react";
import Link from "next/link";
import { copy } from "@/lib/copy";
import { notebook } from "@/lib/research/view";
import { SOURCE_NAMES, type Source } from "@/lib/research/sources";

// Her research, in the open: every score with its parts and inputs, every check with its
// reason, and links to the real posts.
export default function NotebookPage() {
  const n = copy.notebook;
  return (
    <main className="min-h-screen bg-[#fff6ea] px-4 py-8 text-[#151311] sm:px-6">
      <div className="mx-auto max-w-4xl">
        <Link href="/" className="font-display text-2xl font-extrabold">LOW<span className="text-[#ff4a24]">BALL</span></Link>
        <h1 className="mt-6 font-display text-4xl font-extrabold">{n.title}</h1>
        <p className="mt-2 max-w-2xl text-lg">{n.sub}</p>
        <p className="mt-2 font-mono text-sm font-bold">{n.thresholds}</p>
        <Suspense fallback={<p className="mt-6 font-mono text-sm">{copy.reader.loading}</p>}>
          <Entries />
        </Suspense>
      </div>
    </main>
  );
}

const VERDICT_COLOUR: Record<string, string> = { IGNORE: "bg-[#151311]/10", WATCH: "bg-[#f2b544]", INVESTIGATE: "bg-[#19a866] text-white" };

async function Entries() {
  const n = copy.notebook;
  const data = await notebook();
  if (!data || data.leads.length === 0) return <p className="mt-6 text-lg">{n.empty}</p>;
  return (
    <>
      <p className="mt-2 font-mono text-sm">{n.spent(data.spent.toFixed(2), data.cap.toFixed(2))}</p>
      <div className="mt-6 flex flex-col gap-4">
        {data.leads.map((l) => (
          <article key={l.id} className="rounded-2xl border-2 border-[#151311] bg-white p-4 shadow-[4px_4px_0_#151311] sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-display text-lg font-extrabold leading-tight">{l.title}</p>
              <p className="flex items-center gap-2 font-mono text-sm font-bold">
                <span className={`rounded px-2 py-0.5 ${VERDICT_COLOUR[l.verdict]}`}>{l.verdict}</span>
                <span>{l.total}/100</span>
              </p>
            </div>
            <p className="mt-1 text-sm text-[#151311]/70">{n.status[l.status]} · {l.terms.slice(0, 6).join(", ")}</p>
            <p className="text-sm font-semibold">{n.seenOn([...new Set(l.posts.map((p) => SOURCE_NAMES[p.source as Source]))].join(", "))}</p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <tbody>
                  {(["velocity", "sources", "size", "pain", "novelty"] as const).map((k) => {
                    const c = l.score[k];
                    return (
                      <tr key={k} className="border-t border-[#151311]/10 align-top">
                        <td className="py-1 pr-3 font-bold">{n.parts[k]}</td>
                        <td className="py-1 pr-3 font-mono">{c.points}</td>
                        <td className="py-1 pr-3 font-mono text-xs">{Object.entries(c.inputs).map(([key, v]) => `${key}: ${v ?? "–"}`).join(" · ")}</td>
                        <td className="py-1 text-xs text-[#151311]/60">{c.rule}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {l.checks && (
              <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
                {(["onMission", "seenTwice", "notInvestigated", "underCap"] as const).filter((k) => l.checks![k]).map((k) => (
                  <li key={k} className={`rounded-lg px-2 py-1 ${l.checks![k].ok ? "bg-[#d6f5e6]" : "bg-[#ffe1d6]"}`}>
                    <span className="font-bold">{l.checks![k].ok ? "✓" : "✗"} {n.checks[k]}</span>
                    <span className="block text-xs">{l.checks![k].why}</span>
                  </li>
                ))}
              </ul>
            )}
            {l.checks?.forced && <p className="mt-1 text-xs font-semibold">{n.forced}</p>}

            {l.investigation && !l.investigation.error && (
              <div className="mt-3 rounded-lg bg-[#fff6ea] p-3 text-sm">
                <p className="font-bold">{n.found}</p>
                <p>{l.investigation.reason}</p>
                {l.investigation.existing.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {l.investigation.existing.map((e) => <li key={e.url}>{e.name}: {e.gap}</li>)}
                  </ul>
                )}
              </div>
            )}
            {l.investigation?.error && <p className="mt-2 text-sm">{l.investigation.error}</p>}
            {l.packId && (
              <p className="mt-2 text-sm">
                <Link href={`/pack/${l.packId}`} className="font-bold text-[#ff4a24] underline">{l.packId}</Link>
                <span className="ml-2 font-mono text-xs">{n.onchain(l.onchainTx ?? null)}</span>
              </p>
            )}

            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-bold">{n.posts} ({l.posts.length})</summary>
              <ul className="mt-2 flex flex-col gap-2">
                {l.posts.map((p) => (
                  <li key={p.id}>
                    <a href={p.url} target="_blank" rel="noreferrer nofollow" className="font-semibold underline">{p.title}</a>
                    <span className="ml-1 font-mono text-xs text-[#151311]/60">
                      {SOURCE_NAMES[p.source as Source]}{p.repo ? ` ${p.repo}` : ""} · {p.postedAt.slice(0, 10)}
                      {l.crossIds.includes(p.id) && <span className="ml-1 rounded bg-[#f2b544] px-1 text-[#151311]">{n.crossChecked}</span>}
                    </span>
                    <p className="text-[#151311]/70">{p.excerpt}</p>
                  </li>
                ))}
              </ul>
            </details>
          </article>
        ))}
      </div>
    </>
  );
}
