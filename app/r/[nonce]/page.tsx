import { Shop } from "@/components/shop/Shop";

// A pledger's link. Friends haggle like anyone else; their purchase counts toward the pledge.
export default async function Referred({ params }: { params: Promise<{ nonce: string }> }) {
  const { nonce } = await params;
  return <Shop refNonce={nonce} />;
}
