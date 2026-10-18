import { describe, expect, it } from "vitest";
import { voiceText } from "./voice";

describe("voiceText", () => {
  it("keeps opening tags and drops the rest", () => {
    expect(voiceText("[sighs] [grumbling] Fine. [whispers] One sixty.")).toBe("[sighs] [grumbling] Fine. One sixty.");
  });
  it("leaves untagged lines alone", () => {
    expect(voiceText("Fine. One sixty.")).toBe("Fine. One sixty.");
  });
  it("handles a line that is only tags", () => {
    expect(voiceText("[sighs]")).toBe("[sighs]");
  });
});
