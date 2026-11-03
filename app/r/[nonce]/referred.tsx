"use client";

import { useParams } from "next/navigation";
import { Shop } from "@/components/shop/Shop";
import { OLD_BOOK } from "@/lib/oldbook";

export function ReferredShop() {
  const { nonce } = useParams<{ nonce: string }>();
  // Friends' links belong to pledges, and pledges were only ever made on the old book.
  return <Shop itemId={OLD_BOOK.id} name={OLD_BOOK.name} blurb={OLD_BOOK.blurb} sale={{ phase: "book" }} refNonce={nonce} />;
}
