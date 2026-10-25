// Drives the real shop in a browser: walk in, haggle, demo wallet, pay. Screenshots each step.
// Usage: npx tsx scripts/flow.mts [baseUrl] [WxH]  -> <os tmp>/flow-*.png
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:3000";
const [w, h] = (process.argv[3] ?? "1440x900").split("x").map(Number);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 200)));
const shot = async (name: string) => { await page.screenshot({ path: join(tmpdir(), `flow-${name}.png`) }); console.log("shot", name); };
const lastLine = async () => (await page.locator("aside p.mr-10").last().textContent())?.trim();

await page.goto(base);
await page.waitForTimeout(2500);
await shot("1-outside");

await page.getByRole("button", { name: "Walk in" }).click();
await page.waitForSelector("aside form input");
await page.waitForTimeout(800);
await shot("2-walked-in");

for (const offer of ["0.80, and that's generous", "1.10?", "fine, 1.40", "1.60 final", "deal"]) {
  await page.fill("aside form input", offer);
  await page.getByRole("button", { name: "Say it" }).click();
  await page.waitForFunction(() => !document.querySelector("aside p.border-dashed"), null, { timeout: 30_000 });
  console.log(`> ${offer}\n< ${await lastLine()}`);
  if (await page.getByRole("button", { name: /^Pay / }).count()) break;
}
await page.waitForTimeout(600);
await shot("3-deal");

if (await page.getByRole("button", { name: "Get a demo wallet" }).count()) {
  await page.getByRole("button", { name: "Get a demo wallet" }).click();
  await page.waitForSelector("text=/Demo wallet, [1-9]/", { timeout: 60_000 });
}
await shot("4-wallet");

const pay = page.getByRole("button", { name: /^Pay / });
if (await pay.count()) {
  console.log("paying:", await pay.textContent());
  await pay.click();
  await page.waitForSelector("text=/It's yours|Now .* through your link|didn't go through|Solana's busy/", { timeout: 120_000 });
  await page.waitForTimeout(800);
  await shot("5-paid");
  console.log("url:", page.url());
}
await browser.close();
