// Prices said in words ("one sixty", "a buck fifty", "two dollars and ten cents") slip past a
// digits-only check. This reads them so the honesty guard can hold them to the same rule.
// It errs strict: anything that looks like an amount and can't be read is "unreadable", and the
// caller retries the line. A lone "one" or "two" is left alone; that's just how people talk.

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const DOLLARS = new Set(["dollar", "dollars", "buck", "bucks", "usdc", "usd", "quid"]);
const CENTS = new Set(["cent", "cents"]);
const COUNTED = new Set(["friend", "friends", "people", "person", "mates", "pals", "buyers", "folks"]);

const isNum = (w: string) => w in UNITS || w in TEENS || w in TENS || w === "hundred";

export type Spoken =
  | { kind: "money"; value: number } // USDC
  | { kind: "count"; value: number } // friends
  | { kind: "either"; value: number } // a bare multi-word number: fine if it's any allowed figure
  | { kind: "unreadable" };

/** Splits a run of number words into whole numbers: "one sixty five" -> [1, 65]. */
function groups(words: string[]): number[] | null {
  const out: number[] = [];
  let cur: number | null = null;
  let last: "unit" | "teen" | "tens" | "hundred" | null = null;
  const flush = () => { if (cur !== null) out.push(cur); cur = null; };
  for (const w of words) {
    if (w === "and") { if (last !== "hundred") return null; continue; }
    if (w in UNITS) {
      if (last === "tens" || last === "hundred") cur! += UNITS[w]; else { flush(); cur = UNITS[w]; }
      last = "unit";
    } else if (w in TEENS) {
      if (last === "hundred") cur! += TEENS[w]; else { flush(); cur = TEENS[w]; }
      last = "teen";
    } else if (w in TENS) {
      if (last === "hundred") cur! += TENS[w]; else { flush(); cur = TENS[w]; }
      last = "tens";
    } else if (w === "hundred") {
      if (last !== "unit") return null;
      cur! *= 100;
      last = "hundred";
    } else return null;
  }
  flush();
  return out;
}

/** Every amount or count said in words in `line` (voice tags ignored). */
export function spokenNumbers(line: string): Spoken[] {
  const t = line.toLowerCase().replace(/\[[^\]]*\]/g, " ").match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
  const found: Spoken[] = [];
  let i = 0;
  // A run of number words starting at j (with "and" allowed after "hundred").
  const run = (j: number): string[] => {
    const r: string[] = [];
    while (j < t.length && (isNum(t[j]) || (t[j] === "and" && r[r.length - 1] === "hundred" && isNum(t[j + 1] ?? "")))) r.push(t[j++]);
    return r;
  };
  while (i < t.length) {
    const aBuck = t[i] === "a" && DOLLARS.has(t[i + 1] ?? ""); // "a buck", "a dollar"
    const words = aBuck ? ["one"] : run(i);
    if (words.length === 0) { i++; continue; }
    const j = aBuck ? i + 1 : i + words.length;
    const g = groups(words);
    if (!g || g.length === 0) { found.push({ kind: "unreadable" }); i = j; continue; }

    if (t[j] === "point") {
      // "one point six oh": digits after the point, one word each
      const digits: number[] = [];
      let k = j + 1;
      while (k < t.length && t[k] in UNITS) digits.push(UNITS[t[k++]]);
      if (g.length !== 1 || digits.length === 0) found.push({ kind: "unreadable" });
      else found.push({ kind: "money", value: Number(`${g[0]}.${digits.join("")}`) });
      if (DOLLARS.has(t[k] ?? "")) k++;
      i = k;
      continue;
    }
    if (DOLLARS.has(t[j] ?? "")) {
      // "two dollars", "two dollars and ten cents", "a buck fifty"
      let k = j + 1;
      if (t[k] === "and") k++;
      const cw = run(k);
      const cg = cw.length ? groups(cw) : [];
      if (g.length === 2 && g[1] >= 10 && g[1] < 100 && cw.length === 0) found.push({ kind: "money", value: g[0] + g[1] / 100 }); // "one twenty USDC"
      else if (g.length !== 1 || !cg || cg.length > 1 || (cg[0] ?? 0) >= 100) found.push({ kind: "unreadable" });
      else found.push({ kind: "money", value: g[0] + (cg[0] ?? 0) / 100 });
      k += cw.length;
      if (CENTS.has(t[k] ?? "")) k++;
      i = k;
      continue;
    }
    if (CENTS.has(t[j] ?? "")) {
      if (g.length !== 1 || g[0] >= 100) found.push({ kind: "unreadable" });
      else found.push({ kind: "money", value: g[0] / 100 });
      i = j + 1;
      continue;
    }
    if (COUNTED.has(t[j] ?? "")) {
      found.push(g.length === 1 ? { kind: "count", value: g[0] } : { kind: "unreadable" });
      i = j + 1;
      continue;
    }
    // No unit word after it.
    if (g.length === 2 && g[1] >= 10 && g[1] < 100) found.push({ kind: "money", value: g[0] + g[1] / 100 }); // "one sixty"
    else if (g.length === 1 && words.length > 1) found.push({ kind: "either", value: g[0] }); // "twenty five"
    else if (g.length > 1) found.push({ kind: "unreadable" });
    // a lone word like "one" or "two": ordinary speech, not a figure
    i = j;
  }
  return found;
}
