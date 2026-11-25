import { describe, expect, it } from "vitest";
import { SECTION_PAD_SEC, sectionRange } from "./fetchSections";

describe("sectionRange (SPEC §7.5: start-2 … end+2)", () => {
  it("pads the clip by 2 s on each side", () => {
    expect(SECTION_PAD_SEC).toBe(2);
    expect(sectionRange({ start: 100, end: 145 }, 3600)).toEqual({ start: 98, end: 147 });
  });
  it("clamps to the start and end of the source", () => {
    expect(sectionRange({ start: 1, end: 30 }, 3600)).toEqual({ start: 0, end: 32 });
    expect(sectionRange({ start: 3570, end: 3599 }, 3600)).toEqual({ start: 3568, end: 3600 });
    expect(sectionRange({ start: 10, end: 40 }, null)).toEqual({ start: 8, end: 42 });
  });
});
