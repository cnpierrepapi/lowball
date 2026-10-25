import { describe, expect, it } from "vitest";
import { spokenNumbers } from "./spoken";

const money = (value: number) => ({ kind: "money", value });

describe("spokenNumbers", () => {
  it("reads prices the way people say them", () => {
    expect(spokenNumbers("Fine. One sixty, final.")).toEqual([money(1.6)]);
    expect(spokenNumbers("one sixty five")).toEqual([money(1.65)]);
    expect(spokenNumbers("A buck fifty and not a cent less.")).toEqual([money(1.5)]);
    expect(spokenNumbers("two dollars and ten cents")).toEqual([money(2.1)]);
    expect(spokenNumbers("two dollars")).toEqual([money(2)]);
    expect(spokenNumbers("ninety cents")).toEqual([money(0.9)]);
    expect(spokenNumbers("one point six oh")).toEqual([money(1.6)]);
    expect(spokenNumbers("[sighs] one twenty USDC")).toEqual([money(1.2)]);
  });
  it("reads friend counts", () => {
    expect(spokenNumbers("Bring five friends.")).toEqual([{ kind: "count", value: 5 }]);
    expect(spokenNumbers("twelve people through your link")).toEqual([{ kind: "count", value: 12 }]);
  });
  it("flags a bare multi-word number so it has to match something allowed", () => {
    expect(spokenNumbers("twenty five, take it")).toEqual([{ kind: "either", value: 25 }]);
    expect(spokenNumbers("one hundred and ten")).toEqual([{ kind: "either", value: 110 }]);
  });
  it("leaves ordinary words alone", () => {
    expect(spokenNumbers("One more word and the price goes up.")).toEqual([]);
    expect(spokenNumbers("You two can leave. It's a one of a kind book.")).toEqual([]);
    expect(spokenNumbers("No price tag, and none for you either.")).toEqual([]);
  });
  it("calls garbled amounts unreadable rather than guessing", () => {
    expect(spokenNumbers("one two three dollars")).toEqual([{ kind: "unreadable" }]);
    expect(spokenNumbers("five six seven")).toEqual([{ kind: "unreadable" }]);
  });
});
