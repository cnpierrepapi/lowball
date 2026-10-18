// Haggles one turn, then voices the shopkeeper's sealed line through /api/voice.
import { writeFileSync } from "node:fs";
const base = process.argv[2] ?? "http://localhost:3000";
let r = await fetch(`${base}/api/haggle`, { method: "POST", body: JSON.stringify({ item: "overlords" }) }).then((x) => x.json());
r = await fetch(`${base}/api/haggle`, { method: "POST", body: JSON.stringify({ session: r.session, message: "I'll give you 0.40, take it or leave it" }) }).then((x) => x.json());
console.log("line:", r.line);
let t = Date.now();
const v = await fetch(`${base}/api/voice`, { method: "POST", body: JSON.stringify({ token: r.voice }) });
const buf = Buffer.from(await v.arrayBuffer());
console.log("voice", v.status, v.headers.get("content-type"), buf.length, "bytes", Date.now() - t, "ms");
writeFileSync("/tmp/lowball-line.wav", buf);
const forged = await fetch(`${base}/api/voice`, { method: "POST", body: JSON.stringify({ token: r.voice.slice(0, -4) + "AAAA" }) });
console.log("forged token ->", forged.status);
