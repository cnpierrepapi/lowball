import { Suspense } from "react";
import { Bench } from "./bench";

// Bench for the shopkeeper alone. Stills are taken from here with Playwright.
// ?portrait=1 renders just her on a transparent background (for covers and social images).
export default function Lab() {
  return (
    <Suspense>
      <Bench />
    </Suspense>
  );
}
