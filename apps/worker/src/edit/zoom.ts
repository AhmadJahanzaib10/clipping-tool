import type { ZoomKeyframe } from "@clip/shared";

/**
 * Zoom punch-ins (SPEC §7.7 step 5): on emphasis words, ease to 1.06 (subtle) / 1.12 (punchy) over
 * 150 ms, hold, ease back after 1.2 s. At most one zoom every 4 s; never across a scene/jump cut.
 */
export const ZOOM_SCALE = { off: 1, subtle: 1.06, punchy: 1.12 } as const;
export const ZOOM_EASE_SEC = 0.15;
export const ZOOM_HOLD_SEC = 1.2;
export const ZOOM_MIN_SPACING_SEC = 4;

export function zoomKeyframes(emphasisTimes: number[], cuts: number[], level: keyof typeof ZOOM_SCALE, duration: number): ZoomKeyframe[] {
  if (level === "off") return [];
  const scale = ZOOM_SCALE[level];
  const out: ZoomKeyframe[] = [];
  let lastStart = -Infinity;
  for (const t of [...emphasisTimes].sort((a, b) => a - b)) {
    if (t - lastStart < ZOOM_MIN_SPACING_SEC) continue;
    const z = { start: t, peak: t + ZOOM_EASE_SEC, holdEnd: t + ZOOM_HOLD_SEC, end: t + ZOOM_HOLD_SEC + ZOOM_EASE_SEC, scale };
    if (z.end > duration) continue;
    // A cut inside the zoom would make the punch-in jump mid-ease: skip this one.
    if (cuts.some((c) => c > z.start - 0.05 && c < z.end + 0.05)) continue;
    out.push(z);
    lastStart = t;
  }
  return out;
}

/** Zoom scale at output time t (smoothstep easing), for previews and the renderer's tests. */
export function zoomAt(zooms: ZoomKeyframe[], t: number): number {
  for (const z of zooms) {
    if (t < z.start || t > z.end) continue;
    const ease = (u: number) => u * u * (3 - 2 * u);
    if (t < z.peak) return 1 + (z.scale - 1) * ease((t - z.start) / (z.peak - z.start));
    if (t <= z.holdEnd) return z.scale;
    return 1 + (z.scale - 1) * (1 - ease((t - z.holdEnd) / (z.end - z.holdEnd)));
  }
  return 1;
}
