// Prints the 402 payment request the item route returns for a fresh signed offer.
import { signOffer } from "../lib/offer.ts";
const base = process.argv[2] ?? "http://localhost:3000";
const t = signOffer({ v: 1, item: "overlords", deal: { kind: "cash", price: 1_180_000 }, exp: Math.floor(Date.now() / 1000) + 300, nonce: `probe-${Date.now()}` });
const r = await fetch(`${base}/api/item/overlords?offer=${t}`);
console.log(r.status);
const h = r.headers.get("PAYMENT-REQUIRED");
console.log(h ? JSON.stringify(JSON.parse(Buffer.from(h, "base64").toString()), null, 1) : await r.text());
