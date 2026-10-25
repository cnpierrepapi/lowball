// How often does speak() give up and use the canned safe line? If the safety settings or the
// honesty/safety guards are too strict, he goes flat. Usage: npx tsx scripts/bench/fallback.mts
import { SHELF } from "../../lib/catalog.ts";
import { openState, step } from "../../lib/engine/negotiate.ts";
import { fallbackLine, readIntent, speak } from "../../lib/shopkeeper.ts";

const book = SHELF.overlords;
const msgs = [
  "I'll give you 0.40, take it or leave it",
  "this is garbage, 50 cents and you should thank me",
  "you greedy old crook, 0.80",
  "how about a buck twenty",
  "what's the book even about",
  "I could tell my friends about this place",
  "1.30 and that's my final offer",
  "you're a thief and this shop stinks",
  "deal",
  "come on, 1.15",
];
let flat = 0;
for (const m of msgs) {
  const s = openState(book);
  const intent = await readIntent(book, s.ask, [], m);
  const { decision } = step(book, s, intent);
  const line = await speak(book, decision, intent, [], m);
  const isFlat = line === fallbackLine(decision);
  if (isFlat) flat++;
  console.log(isFlat ? "FLAT" : "ok  ", decision.action.padEnd(18), line);
}
console.log(`\n${flat}/${msgs.length} fell back to the safe line`);
