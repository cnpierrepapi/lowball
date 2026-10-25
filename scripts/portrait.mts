// Renders the shopkeeper alone on a transparent background, for covers and social images.
// Usage: npx tsx scripts/portrait.mts <out.png> [mood=-0.35] [lookX=0.15] [size=900]
import { chromium } from "playwright";
const [out, mood = "-0.35", lookX = "0.15", size = "900"] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: Number(size), height: Number(size) } });
await p.goto("http://localhost:3000/lab?portrait=1");
await p.waitForFunction(() => "keeper" in window, null, { timeout: 60_000 });
await p.evaluate(([m, x]) => {
  document.documentElement.style.background = document.body.style.background = "transparent";
  const k = (window as unknown as { keeper: { setMood(m: number): void; lookAt(x: number, y: number): void } }).keeper;
  k.setMood(Number(m)); k.lookAt(Number(x), 0.05);
}, [mood, lookX]);
await p.waitForTimeout(1500);
await p.screenshot({ path: out, omitBackground: true });
await b.close();
console.log("wrote", out);
