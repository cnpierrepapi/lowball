// The pay-in-friends path in real browsers: A pledges, friend B buys through A's link,
// A's page shows the friend counted. Usage: npx tsx scripts/flow-friends.mts [baseUrl]
import { chromium, type Page } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const shot = (p: Page, name: string) => p.screenshot({ path: join(tmpdir(), `friends-${name}.png`) }).then(() => console.log("shot", name));

async function haggle(p: Page, lines: string[]) {
  await p.getByRole("button", { name: "Walk in" }).click();
  await p.waitForSelector("aside form input");
  for (const line of lines) {
    await p.fill("aside form input", line);
    await p.getByRole("button", { name: "Say it" }).click();
    await p.waitForFunction(() => !document.querySelector("aside p.border-dashed"), null, { timeout: 30_000 });
    console.log(`> ${line}\n< ${(await p.locator("aside p.mr-10").last().textContent())?.trim()}`);
    if (await p.getByRole("button", { name: /^Pay |demo wallet to pay/ }).count()) return true;
  }
  return false;
}
async function payWithDemoWallet(p: Page) {
  await p.getByRole("button", { name: "Grab a demo wallet to pay" }).click();
  await p.waitForSelector("text=/Demo wallet, [1-9]/", { timeout: 60_000 });
  const pay = p.getByRole("button", { name: /^Pay / });
  console.log("paying:", await pay.textContent());
  await pay.click();
  await p.waitForSelector("text=/It's yours|through your link|didn't go through|Solana's busy/", { timeout: 120_000 });
}

const a = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] })).newPage();
await a.goto(base);
const got = await haggle(a, ["what if I tell my friends about this place?", "two friends", "ok 3 friends", "fine, 4"]);
if (!got) { console.log("no pledge deal reached"); process.exit(1); }
await payWithDemoWallet(a);
await a.waitForTimeout(9000); // first status poll
await shot(a, "1-pledged");
const nonce = JSON.parse(Buffer.from(new URL(a.url()).searchParams.get("claim")!.split(".")[0], "base64url").toString()).v.nonce;
console.log("pledge", nonce);

const b = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await b.goto(`${base}/r/${nonce}`);
await b.waitForTimeout(2500);
await shot(b, "2-friend-arrives");
if (await haggle(b, ["1.50", "1.70", "deal"])) {
  await payWithDemoWallet(b);
  await shot(b, "3-friend-paid");
}
await a.waitForTimeout(10_000); // next poll
await shot(a, "4-pledger-sees-friend");
console.log("pledger panel:", (await a.locator("aside").textContent())?.replace(/\s+/g, " ").slice(0, 300));
await browser.close();
