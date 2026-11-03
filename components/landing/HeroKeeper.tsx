"use client";

import { useCallback } from "react";
import { LazyKeeper } from "@/components/keeper/LazyKeeper";
import type { Keeper as Controller } from "@/components/keeper/scene";

// The shopkeeper on the front page: in a good mood, watching the pointer.
export function HeroKeeper() {
  const ready = useCallback((k: Controller) => k.setMood(0.4), []);
  return <LazyKeeper onReady={ready} className="absolute inset-0 h-full w-full" />;
}
