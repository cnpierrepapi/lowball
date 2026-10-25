import { describe, expect, it } from "vitest";
import { allow } from "./limits";

describe("allow", () => {
  it("lets max hits through per window, then refuses", () => {
    const k = `t:${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(allow(k, 3, 1000, 10_000 + i)).toBe(true);
    expect(allow(k, 3, 1000, 10_500)).toBe(false);
  });
  it("lets hits through again once the window slides past them", () => {
    const k = `t:${Math.random()}`;
    for (let i = 0; i < 3; i++) allow(k, 3, 1000, 10_000);
    expect(allow(k, 3, 1000, 11_001)).toBe(true);
  });
  it("counts refused hits as nothing", () => {
    const k = `t:${Math.random()}`;
    for (let i = 0; i < 10; i++) allow(k, 2, 1000, 10_000);
    expect(allow(k, 2, 1000, 11_001)).toBe(true);
  });
});
