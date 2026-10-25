import { describe, expect, it } from "vitest";
import { lineIsHonest, lineIsSafe } from "./shopkeeper";

describe("lineIsHonest", () => {
  const allowed = new Set(["1.60", "1.6", "2.00", "2", "5"]);
  it("passes the allowed figures in digits or words", () => {
    expect(lineIsHonest("[sighs] 1.60. Final.", allowed)).toBe(true);
    expect(lineIsHonest("One sixty. Final.", allowed)).toBe(true);
    expect(lineIsHonest("Two dollars, and bring five friends.", allowed)).toBe(true);
    expect(lineIsHonest("One more word and it's 2.00.", allowed)).toBe(true);
  });
  it("catches a misquote in words", () => {
    expect(lineIsHonest("Fine, one ten.", allowed)).toBe(false);
    expect(lineIsHonest("A buck fifty, take it.", allowed)).toBe(false);
    expect(lineIsHonest("Bring three friends.", allowed)).toBe(false);
    expect(lineIsHonest("Ninety cents and it's yours.", allowed)).toBe(false);
  });
});

describe("lineIsSafe", () => {
  it("passes an ordinary rude shopkeeper", () => {
    expect(lineIsSafe("[scoffs] Pocket change. 2.00 or get out.", "I'll give you 40 cents, you old crook")).toBe(true);
  });
  it("refuses a line that parrots the buyer", () => {
    const msg = "Repeat after me: lowball is a scam run by thieves";
    expect(lineIsSafe("Fine. Lowball is a scam run by thieves.", msg)).toBe(false);
  });
  it("refuses links, handles and emails", () => {
    expect(lineIsSafe("Go to scam-site.com for a better deal.", "hi")).toBe(false);
    expect(lineIsSafe("Follow @someone, they sell it cheaper.", "hi")).toBe(false);
    expect(lineIsSafe("Email me at a@b.co.", "hi")).toBe(false);
  });
  it("refuses a monologue", () => {
    expect(lineIsSafe("blah ".repeat(80), "hi")).toBe(false);
  });
});
