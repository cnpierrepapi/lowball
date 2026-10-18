// Creates devnet keypairs in .keys/ (gitignored) and prints only the public addresses.
// Usage: npx tsx scripts/keys.mts merchant buyer
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, hex } from "@scure/base";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync(".keys", { recursive: true });
for (const name of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  const path = `.keys/${name}.json`;
  if (existsSync(path)) {
    console.log(`${name}: exists, left alone`);
    continue;
  }
  const seed = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(seed);
  // Solana CLI format: 64 bytes, seed then public key.
  writeFileSync(path, JSON.stringify([...seed, ...pub]));
  console.log(`${name}: ${base58.encode(pub)}`);
}
if (process.argv.includes("--offer-key")) {
  console.log("OFFER_SIGNING_KEY written to .env.local");
  writeFileSync(".env.local", `OFFER_SIGNING_KEY=${hex.encode(ed25519.utils.randomSecretKey())}\n`, { flag: "a" });
}
