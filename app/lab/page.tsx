import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Bench } from "./bench";

// Bench for the shopkeeper alone, for local tools only: scripts/stills.mts takes stills here and
// scripts/portrait.mts renders her for covers (?portrait=1, transparent background).
// It is not part of the shop: in a production build it's a 404.
export default function Lab() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <Bench />
    </Suspense>
  );
}
