"use client";

import dynamic from "next/dynamic";

// The shopkeeper scene pulls in three.js (about 560 KB). Loading it after the page lets the
// words show first; the canvas fades in when it's ready.
export const LazyKeeper = dynamic(() => import("./Keeper").then((m) => m.Keeper), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});
