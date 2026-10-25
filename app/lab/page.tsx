"use client";

import { Keeper } from "@/components/keeper/Keeper";
import type { Keeper as Controller } from "@/components/keeper/scene";

// Bench for the shopkeeper alone. Stills are taken from here with Playwright; the page exposes
// the controller on window so a script can set mood and talk.
const expose = (k: Controller) => {
  (window as unknown as { keeper: Controller }).keeper = k;
};

export default function Lab() {
  return (
    <main className="h-screen w-screen bg-[#fdf3e7]">
      <Keeper onReady={expose} className="h-full w-full" />
    </main>
  );
}
