import type { Segment } from "@clip/shared";

/** SPEC §7.7 step 3: teaser (2–4 s punchline from later in the clip) → 0.2 s flash/whoosh → the clip. */
export const TRANSITION_SEC = 0.2;

export interface ColdOpenRange {
  start: number;
  end: number;
}

/** Whether to use the teaser: needs a range, and coldOpen not "off" in the campaign / disabled in the edit. */
export function useColdOpen(mode: "off" | "auto" | "always", edit: { enabled: boolean; start: number; end: number } | null): ColdOpenRange | null {
  if (mode === "off" || !edit?.enabled) return null;
  const d = edit.end - edit.start;
  if (!(d >= 1.5 && d <= 4.5)) return null;
  return { start: edit.start, end: edit.end };
}

/** Teaser + transition segments, and the output offset at which the main clip starts. */
export function coldOpenSegments(co: ColdOpenRange): { segments: Segment[]; mainOffset: number } {
  const d = co.end - co.start;
  return {
    segments: [
      { kind: "teaser", srcStart: co.start, srcEnd: co.end, outStart: 0, outEnd: d },
      { kind: "transition", srcStart: co.end, srcEnd: co.end, outStart: d, outEnd: d + TRANSITION_SEC },
    ],
    mainOffset: d + TRANSITION_SEC,
  };
}
