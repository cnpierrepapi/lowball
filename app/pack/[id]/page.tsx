import { Suspense } from "react";
import { notFound } from "next/navigation";
import { packPage } from "@/lib/shop/view";
import { Shop } from "@/components/shop/Shop";

// One pack: the free part, the drop's state, and the counter to haggle at.
export default function PackPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="shop-backdrop h-screen" />}>
      <Pack params={params} />
    </Suspense>
  );
}

async function Pack({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await packPage(id);
  if (!p) notFound();
  return <Shop itemId={p.id} name={p.title} blurb={p.blurb} sale={p.sale ?? { phase: "closed" }} />;
}
