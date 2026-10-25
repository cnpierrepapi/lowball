// Close-up stills of the shopkeeper from /lab, for judging the look before anyone sees it.
// Usage: npx tsx scripts/stills.mts [baseUrl]  -> <os tmp>/keeper-*.png
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(`${base}/lab`);
await page.waitForFunction(() => "keeper" in window, null, { timeout: 60_000 });

const shots: [string, string][] = [
  ["neutral", "k.setMood(-0.2); k.setTalk(0); k.lookAt(0,0)"],
  ["furious", "k.setMood(-1); k.setTalk(0); k.lookAt(0,0)"],
  ["pleased", "k.setMood(1); k.setTalk(0); k.lookAt(0,0)"],
  ["talking", "k.setMood(-0.4); k.setTalk(0.8); k.lookAt(0,0)"],
  ["three-quarter", "k.setMood(-0.3); k.setTalk(0); k.lookAt(0.9,0.1)"],
];
for (const [name, js] of shots) {
  await page.evaluate(`(() => { const k = window.keeper; ${js}; })()`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(tmpdir(), `keeper-${name}.png`) });
  console.log("shot", name);
}
await browser.close();
