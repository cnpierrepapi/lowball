"use client";

import { useEffect, useRef } from "react";
import { createKeeper, type Keeper as Controller } from "./scene";

/** The shopkeeper canvas. Hand back the controller so the page can drive mood and voice. */
export function Keeper({ onReady, className }: { onReady?: (k: Controller) => void; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const k = createKeeper(ref.current!);
    onReady?.(k);
    const move = (e: PointerEvent) => k.lookAt((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
    addEventListener("pointermove", move);
    return () => {
      removeEventListener("pointermove", move);
      k.dispose();
    };
  }, [onReady]);
  return <canvas ref={ref} className={className} />;
}
