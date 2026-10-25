import { Suspense } from "react";
import { Reader } from "./reader";

export default function ReadPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#fff6ea]" />}>
      <Reader />
    </Suspense>
  );
}
