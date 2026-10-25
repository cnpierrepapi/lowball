import { Suspense } from "react";
import { ReferredShop } from "./referred";

// A pledger's link. Friends haggle like anyone else; their purchase counts toward the pledge.
// The shell prerenders; the nonce streams in from the URL.
export default function Referred() {
  return (
    <Suspense fallback={<div className="shop-backdrop h-screen" />}>
      <ReferredShop />
    </Suspense>
  );
}
