import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseRange, safeStoragePath } from "./files";

describe("media file route helpers", () => {
  const root = path.resolve("C:/storage");
  it("keeps paths inside STORAGE_DIR", () => {
    expect(safeStoragePath(root, ["clips", "abc", "clip.v1.mp4"])).toBe(path.join(root, "clips", "abc", "clip.v1.mp4"));
    for (const bad of [["..", ".env"], ["clips", "..", "..", "x"], ["C:", "Windows"], ["a\\b"], ["..\\..\\.env"], ["a/b"], [], ["clips", ""]]) expect(safeStoragePath(root, bad)).toBeNull();
  });
  it("parses byte ranges", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("items=1-2", 100)).toBeNull();
  });
});
