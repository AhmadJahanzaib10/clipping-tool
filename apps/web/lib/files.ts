import path from "node:path";

/** Resolve a storage-relative path; null if it would escape the storage folder (SPEC §11). */
export function safeStoragePath(storageDir: string, parts: string[]): string | null {
  if (!parts.length || parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\0") || /[\\/:]/.test(p))) return null;
  const root = path.resolve(storageDir);
  const full = path.resolve(root, ...parts);
  return full.startsWith(root + path.sep) ? full : null;
}

export const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".opus": "audio/ogg",
  ".srt": "text/plain; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
  ".json": "application/json",
};

/** Parse a single "bytes=a-b" range against a file size. null = no/invalid range → whole file; "unsatisfiable" → 416. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
