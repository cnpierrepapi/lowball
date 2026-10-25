// Pays through the Wallet Standard bridge using a fake extension wallet injected into the page
// (registers like Phantom would, signs with WebCrypto). Proves the plumbing; a real Phantom
// still needs one manual run. Usage: npx tsx --env-file=.env.local scripts/flow-wallet.mts [baseUrl]
import { chromium } from "playwright";
import { ed25519 } from "@noble/curves/ed25519.js";
import { getAddressDecoder } from "@solana/kit";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:3000";
const seed = ed25519.utils.randomSecretKey();
const pub = ed25519.getPublicKey(seed);
const addr = getAddressDecoder().decode(pub);
const drip = await fetch(`${base}/api/drip`, { method: "POST", body: JSON.stringify({ wallet: addr }) });
console.log("fake wallet", addr, "drip", drip.status);

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 300)));
// Passed as plain text: tsx would otherwise wrap the function with helpers the page lacks.
await page.addInitScript(`(() => { const seedHex = ${JSON.stringify(Buffer.from(seed).toString("hex"))}; const pubArr = ${JSON.stringify([...pub])}; const address = ${JSON.stringify(addr)};

  const hex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  const pkcs8 = new Uint8Array([...hex("302e020100300506032b657004220420"), ...hex(seedHex)]);
  const keyP = crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const account = { address, publicKey: new Uint8Array(pubArr), chains: ["solana:devnet"], features: ["solana:signTransaction"] };
  const readLen = (b, o) => { let len = 0, size = 0; for (;;) { const x = b[o + size]; len |= (x & 0x7f) << (7 * size); size++; if (!(x & 0x80)) return [len, size]; } };
  const wallet = {
    version: "1.0.0", name: "Test Wallet", chains: ["solana:devnet"], accounts: [account],
    icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#6d5bd0"/></svg>'),
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": {
        version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => Promise.all(inputs.map(async ({ transaction }) => {
          const tx = new Uint8Array(transaction);
          const [nSig, sz] = readLen(tx, 0);
          const msgStart = sz + 64 * nSig;
          const msg = tx.slice(msgStart);
          let o = msg[0] & 0x80 ? 1 : 0; // v0 prefix
          o += 3; // header
          const [nKeys, ksz] = readLen(msg, o); o += ksz;
          let idx = -1;
          for (let i = 0; i < nKeys; i++) if (msg.slice(o + 32 * i, o + 32 * i + 32).every((v, j) => v === pubArr[j])) idx = i;
          const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", await keyP, msg));
          tx.set(sig, sz + 64 * idx);
          return { signedTransaction: tx };
        })),
      },
    },
  };
  const register = (api) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => register(e.detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));

})()`);

await page.goto(base);
await page.getByRole("button", { name: "Walk in" }).click();
await page.waitForSelector("aside form input");
for (const line of ["1.70", "1.80", "1.85", "1.90", "deal", "deal"]) {
  await page.fill("aside form input", line);
  await page.getByRole("button", { name: "Say it" }).click();
  await page.waitForFunction(() => !document.querySelector("aside p.border-dashed"), null, { timeout: 30_000 });
  if (await page.getByRole("button", { name: "Pay with Test Wallet" }).count()) break;
}
await page.getByRole("button", { name: "Pay with Test Wallet" }).click();
await page.waitForSelector("text=/Test Wallet .*USDC/", { timeout: 30_000 });
const pay = page.getByRole("button", { name: /^Pay \d/ });
console.log("paying:", await pay.textContent());
await pay.click();
await page.waitForSelector("text=/It's yours|didn't go through|Solana's busy|said no/", { timeout: 120_000 });
await page.screenshot({ path: join(tmpdir(), "wallet-paid.png") });
console.log("result:", (await page.locator("aside").textContent())?.replace(/\s+/g, " ").slice(0, 260));
await browser.close();
