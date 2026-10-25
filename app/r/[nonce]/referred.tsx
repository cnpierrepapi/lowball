"use client";

import { useParams } from "next/navigation";
import { Shop } from "@/components/shop/Shop";

export function ReferredShop() {
  const { nonce } = useParams<{ nonce: string }>();
  return <Shop refNonce={nonce} />;
}
