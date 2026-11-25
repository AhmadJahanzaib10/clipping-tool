import type { Analysis, CropKeyframe, CropPlan, FaceBox, Rect, Segment } from "@clip/shared";
import { srcToOut } from "../edit/pacing";

/**
 * Layout + crop (SPEC §7.7 step 4), in section pixel space.
 *  single: 9:16 window of full height following the active face (EMA α 0.15, dead zone = face leaves
 *          the middle 40%, instant re-center at scene cuts, ≤ 2 keyframes/s)
 *  split:  two faces in > 60% of frames → two 9:8 regions (1080×960 each) stacked
 *  fit:    no reliable face → whole frame over a blurred copy
 */

export const MIN_FACE_SCORE = 0.5;
export const SPLIT_MIN_RATIO = 0.6;
export const SINGLE_MIN_RATIO = 0.5;
export const EMA_ALPHA = 0.15;
/** The face may move inside the middle 40% of the crop window without the window following. */
export const DEAD_ZONE = 0.4;
export const MIN_KEYFRAME_GAP_SEC = 0.5;
/** Face this far outside the window centre (fraction of window width) for FAR_SAMPLES in a row = a cut. */
export const FAR_JUMP = 0.6;
export const FAR_SAMPLES = 2;

type Layout = "single" | "split" | "fit";
type Focus = "auto" | "left" | "center" | "right";

const area = (f: FaceBox) => f.w * f.h;
const cx = (f: FaceBox) => f.x + f.w / 2;

/** Faces worth tracking in one sample: confident, and not tiny next to the biggest one (posters, crowds). */
export function mainFaces(faces: FaceBox[]): FaceBox[] {
  const good = faces.filter((f) => f.score >= MIN_FACE_SCORE);
  const big = Math.max(0, ...good.map(area));
  return good.filter((f) => area(f) >= big * 0.2).sort((a, b) => cx(a) - cx(b));
}

/** Two faces count as "two speakers" only if clearly side by side (centers ≥ 15% of the width apart). */
function twoApart(faces: FaceBox[]): boolean {
  return faces.length >= 2 && cx(faces[faces.length - 1]!) - cx(faces[0]!) >= 0.15;
}

export function chooseLayout(a: Analysis): { layout: Layout; reason: string; oneFace: number; twoFaces: number } {
  const n = a.faces.length || 1;
  const per = a.faces.map((s) => mainFaces(s.faces));
  const oneFace = per.filter((f) => f.length >= 1).length / n;
  const twoFaces = per.filter((f) => twoApart(f)).length / n;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const cropW = (a.height * 9) / 16;
  if (cropW >= a.width * 0.95) return { layout: "fit", reason: `source is already vertical (${a.width}×${a.height})`, oneFace, twoFaces };
  if (twoFaces > SPLIT_MIN_RATIO) return { layout: "split", reason: `two faces in ${pct(twoFaces)} of frames`, oneFace, twoFaces };
  if (oneFace >= SINGLE_MIN_RATIO) return { layout: "single", reason: `a face in ${pct(oneFace)} of frames (two in ${pct(twoFaces)})`, oneFace, twoFaces };
  return { layout: "fit", reason: `no reliable face (a face in only ${pct(oneFace)} of frames)`, oneFace, twoFaces };
}

/** The face to follow: stick with the one nearest the current center unless another is much bigger. */
function pickTarget(faces: FaceBox[], currentCx: number | null): FaceBox | null {
  if (!faces.length) return null;
  const largest = faces.reduce((a, b) => (area(b) > area(a) ? b : a));
  if (currentCx === null) return largest;
  const nearest = faces.reduce((a, b) => (Math.abs(cx(b) - currentCx) < Math.abs(cx(a) - currentCx) ? b : a));
  return area(nearest) >= area(largest) * 0.6 ? nearest : largest;
}

export interface SingleCropInput {
  analysis: Analysis;
  /** Source time of section t = 0. */
  sectionStart: number;
  segments: Segment[];
  focus: Focus;
}

/**
 * Crop window centre in section time, then mapped onto the output timeline. Returned keyframes are in
 * output time; `jump` keyframes mark instant re-centres (scene cuts and the start of every segment).
 */
export function singleCrop(i: SingleCropInput): Extract<CropPlan, { mode: "single" }> {
  const { analysis: a } = i;
  const W = a.width;
  const H = a.height;
  const w = Math.round((H * 9) / 16 / 2) * 2;
  const maxX = Math.max(0, W - w);
  const clampX = (x: number) => Math.round(Math.min(maxX, Math.max(0, x)));
  const toX = (centerNorm: number) => clampX(centerNorm * W - w / 2);

  // Section-time track of the window's left edge.
  const track: { t: number; x: number; jump: boolean }[] = [];
  if (i.focus !== "auto") {
    const fixed = { left: 0, center: maxX / 2, right: maxX }[i.focus];
    track.push({ t: 0, x: clampX(fixed), jump: true });
  } else {
    const cutTimes = a.scenes.map((s) => s.s).filter((s) => s > 0.01);
    let center: number | null = null; // normalized
    let chasing = false;
    let farCount = 0;
    let prevT = -Infinity;
    for (const sample of a.faces) {
      const faces = mainFaces(sample.faces);
      const sceneCut = cutTimes.some((c) => c > prevT && c <= sample.t);
      prevT = sample.t;
      const target = pickTarget(faces, sceneCut ? null : center);
      if (!target) {
        if (center === null) continue;
        track.push({ t: sample.t, x: toX(center), jump: false });
        continue;
      }
      const tc = cx(target);
      if (center === null || sceneCut) {
        center = tc; // instant re-center at the first face and at scene cuts
        chasing = false;
        track.push({ t: sample.t, x: toX(center), jump: true });
        continue;
      }
      // A face far away for consecutive samples is a cut the scene detector missed (an insert, a new
      // shot): re-centre instantly instead of a long fast pan.
      const offset = Math.abs(tc - center) * W;
      farCount = offset > FAR_JUMP * w ? farCount + 1 : 0;
      if (farCount >= FAR_SAMPLES) {
        center = tc;
        chasing = false;
        farCount = 0;
        track.push({ t: sample.t, x: toX(center), jump: true });
        continue;
      }
      if (farCount > 0) {
        // Unconfirmed far-off face (could be a one-frame detector glitch): hold still until confirmed.
        track.push({ t: sample.t, x: toX(center), jump: false });
        continue;
      }
      // Dead zone: start following only when the face leaves the middle 40% of the window;
      // keep following (EMA) until it is roughly centred again.
      if (!chasing && offset > (DEAD_ZONE / 2) * w) chasing = true;
      if (chasing) {
        center += EMA_ALPHA * (tc - center);
        if (Math.abs(tc - center) * W < 0.05 * w) chasing = false;
      }
      track.push({ t: sample.t, x: toX(center), jump: false });
    }
    if (!track.length) track.push({ t: 0, x: clampX(maxX / 2), jump: true });
  }

  // Section time → output time, ≤ 2 keyframes/s (jumps always kept), plus a jump at each segment start.
  const xAtSection = (t: number): number => {
    let best = track[0]!;
    for (const k of track) if (k.t <= t + 1e-6) best = k;
    return best.x;
  };
  const keyframes: CropKeyframe[] = [];
  for (const seg of i.segments) {
    if (seg.kind === "transition") continue;
    const segSecStart = seg.srcStart - i.sectionStart;
    const segSecEnd = seg.srcEnd - i.sectionStart;
    keyframes.push({ t: seg.outStart, x: xAtSection(segSecStart), jump: true });
    for (const k of track) {
      if (k.t <= segSecStart || k.t > segSecEnd) continue;
      const tOut = srcToOut([seg], k.t + i.sectionStart, [seg.kind]);
      if (tOut === null) continue;
      const last = keyframes[keyframes.length - 1]!;
      if (k.x === last.x) continue;
      if (!k.jump && tOut - last.t < MIN_KEYFRAME_GAP_SEC) continue;
      keyframes.push({ t: tOut, x: k.x, ...(k.jump ? { jump: true } : {}) });
    }
  }
  return { mode: "single", w, h: H, y: 0, keyframes };
}

/** Median of a list. */
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Two 9:8 regions around the left and right speaker (left on top). */
export function splitCrop(a: Analysis): Extract<CropPlan, { mode: "split" }> {
  const pairs = a.faces.map((s) => mainFaces(s.faces)).filter(twoApart);
  const left = pairs.map((f) => f[0]!);
  const right = pairs.map((f) => f[f.length - 1]!);
  // Each region may be at most as wide as the distance between the two speakers, so it never
  // includes the other person (e.g. side-by-side video-call tiles).
  const separation = (median(right.map(cx)) - median(left.map(cx))) * a.width;
  const region = (faces: FaceBox[]): Rect => {
    const fcx = median(faces.map(cx)) * a.width;
    const fcy = median(faces.map((f) => f.y + f.h / 2)) * a.height;
    const fh = median(faces.map((f) => f.h)) * a.height;
    // Head-and-shoulders: region ≈ 3.2 face heights tall, face centre at 40% from the top.
    let h = Math.min(a.height, Math.max(a.height * 0.35, fh * 3.2));
    let w = (h * 9) / 8;
    const maxW = Math.min(a.width, separation);
    if (w > maxW) {
      w = maxW;
      h = (w * 8) / 9;
    }
    // Even sizes (yuv420p), rounded down so the region always stays inside the frame.
    const W = Math.floor(w / 2) * 2;
    const H = Math.floor(h / 2) * 2;
    const x = Math.floor(Math.min(a.width - W, Math.max(0, fcx - W / 2)) / 2) * 2;
    const y = Math.floor(Math.min(a.height - H, Math.max(0, fcy - H * 0.4)) / 2) * 2;
    return { x, y, w: W, h: H };
  };
  return { mode: "split", top: region(left), bottom: region(right) };
}

/** Largest jump in x between consecutive non-jump keyframes, per second (smoothness metric). */
export function maxPanSpeed(c: Extract<CropPlan, { mode: "single" }>): number {
  let max = 0;
  for (let k = 1; k < c.keyframes.length; k++) {
    const a = c.keyframes[k - 1]!;
    const b = c.keyframes[k]!;
    if (b.jump || b.t <= a.t) continue;
    max = Math.max(max, Math.abs(b.x - a.x) / (b.t - a.t));
  }
  return max;
}
