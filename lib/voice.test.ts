import { beforeAll, describe, expect, it } from "vitest";
import { readVoiceToken, voiceText, voiceToken } from "./voice";

beforeAll(() => {
  process.env.OFFER_SIGNING_KEY = "11".repeat(32);
});

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

describe("voice tokens", () => {
  const t0 = 1_800_000_000; // on an hour boundary
  it("are the same for the same line within the hour, so the edge can cache them", () => {
    expect(voiceToken("[sighs] Fine.", t0 + 5)).toBe(voiceToken("[sighs] Fine.", t0 + 3500));
    expect(voiceToken("[sighs] Fine.", t0)).not.toBe(voiceToken("[sighs] Fine!", t0));
  });
  it("read back while fresh, and not after they expire", () => {
    const t = voiceToken("[sighs] Fine.", t0);
    expect(readVoiceToken(t, t0 + 60)).toBe("[sighs] Fine.");
    expect(readVoiceToken(t, t0 + 2 * 3600)).toBeUndefined();
  });
  it("refuse forged and foreign tokens", () => {
    const t = voiceToken("[sighs] Fine.", t0);
    expect(readVoiceToken(t.slice(0, -4) + "AAAA", t0)).toBeUndefined();
    expect(readVoiceToken(null, t0)).toBeUndefined();
  });
});
