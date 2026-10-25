// Peek, buy, read: the product path in a browser. Usage: npx tsx scripts/flow-book.mts [baseUrl]
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.argv[2] ?? "http://localhost:3000";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const shot = (n: string) => p.screenshot({ path: join(tmpdir(), `book-${n}.png`) }).then(() => console.log("shot", n));
await p.goto(base); await p.waitForTimeout(2000);
await p.getByRole("button", { name: "Peek inside" }).click();
await p.waitForSelector("[role=dialog] .book h2"); await shot("1-peek");
await p.getByRole("button", { name: "Haggle for the rest" }).click();
await p.getByRole("button", { name: "Walk in" }).click(); await p.waitForSelector("aside form input");
for (const line of ["1.80", "1.90", "deal", "deal"]) {
  await p.fill("aside form input", line); await p.getByRole("button", { name: "Say it" }).click();
  await p.waitForFunction(() => !document.querySelector("aside p.border-dashed"), null, { timeout: 30_000 });
  if (await p.getByRole("button", { name: "Grab a demo wallet to pay" }).count()) break;
}
await p.getByRole("button", { name: "Grab a demo wallet to pay" }).click();
await p.waitForSelector("text=/Demo wallet, [1-9]/", { timeout: 60_000 });
await p.getByRole("button", { name: /^Pay \d/ }).click();
await p.waitForSelector("text=/It's yours|didn't go through|busy/", { timeout: 120_000 });
await shot("2-bought");
await p.getByRole("link", { name: "Read it" }).click();
await p.waitForSelector(".book h1", { timeout: 30_000 }); await p.waitForTimeout(500);
await shot("3-reading");
console.log("reader words:", (await p.locator(".book").textContent())!.split(/\s+/).length);
await b.close();
