"use client";

import { useSearchParams } from "next/navigation";
import { Keeper } from "@/components/keeper/Keeper";
import type { Keeper as Controller } from "@/components/keeper/scene";

// The page exposes the controller on window so a script can set mood and talk.
const expose = (k: Controller) => {
  (window as unknown as { keeper: Controller }).keeper = k;
};

export function Bench() {
  const portrait = useSearchParams().has("portrait");
  return (
    <main className={`relative h-screen w-screen ${portrait ? "" : "shop-backdrop"}`}>
      <Keeper onReady={expose} portrait={portrait} className="relative h-full w-full" />
    </main>
  );
}
