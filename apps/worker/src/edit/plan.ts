import { norm, type Analysis, type CampaignConfig, type ClipEdit, type Plan, type PlanWord, type SectionInfo, type Segment, type Word } from "@clip/shared";
import { chooseLayout, singleCrop, splitCrop } from "../render/crop";
import { coldOpenSegments, useColdOpen } from "./coldOpen";
import { buildTimeline, clipWords, jumpCuts, srcToOut } from "./pacing";
import { zoomKeyframes } from "./zoom";

export interface PlanInput {
  clipId: string;
  /** Transcript words in source time (whole source or at least the clip ± margin). */
  words: Word[];
  edit: ClipEdit;
  config: Pick<CampaignConfig, "coldOpen">;
  analysis: Analysis;
  section: SectionInfo;
  /** First plan for this clip: layout/focus are decided automatically; later runs respect the edit. */
  autoLayout: boolean;
}

/** PREP_CLIP's pure core (SPEC §7.7): timeline map, cold open, layout/crop, zoom → plan + caption words. */
export function buildPlan(i: PlanInput): { plan: Plan; words: PlanWord[] } {
  const { edit, analysis: a, section } = i;
  const start = edit.trim.start;
  const end = edit.trim.end;
  // Never ask for source time the section doesn't contain.
  const secEnd = section.sourceStart + section.duration;
  if (start < section.sourceStart - 0.05 || end > secEnd + 0.05) {
    throw new Error(`clip ${start.toFixed(2)}–${end.toFixed(2)} is outside the section ${section.sourceStart.toFixed(2)}–${secEnd.toFixed(2)}`);
  }

  const cw = clipWords(i.words, start, end);
  const co = useColdOpen(i.config.coldOpen, edit.coldOpen);
  const teaser = co && co.start >= start && co.end <= end ? coldOpenSegments(co) : null;
  const tl = buildTimeline(cw, start, end, edit.pacing, teaser?.mainOffset ?? 0);
  const segments: Segment[] = [...(teaser?.segments ?? []), ...tl.segments];
  const duration = segments[segments.length - 1]!.outEnd;

  // Caption words in output time: teaser words first (flagged), then the main clip minus removed fillers.
  const emphasis = new Set(edit.emphasisWords.map(norm));
  const words: PlanWord[] = [];
  if (teaser && co) {
    cw.forEach((w, idx) => {
      if (w.s < co.start - 1e-3 || w.e > co.end + 1e-3) return;
      const s = srcToOut(segments, w.s, ["teaser"]);
      const e = srcToOut(segments, w.e, ["teaser"]);
      if (s !== null && e !== null) words.push({ i: idx, w: w.w, s, e, teaser: true, ...(w.speaker !== undefined ? { speaker: w.speaker } : {}) });
    });
  }
  cw.forEach((w, idx) => {
    if (tl.removedWords.has(idx)) return;
    const s = srcToOut(segments, w.s);
    const e = srcToOut(segments, w.e);
    if (s === null || e === null) return;
    words.push({
      i: idx,
      w: w.w,
      s,
      e,
      ...(emphasis.has(norm(w.w)) ? { emphasis: true } : {}),
      ...(w.speaker !== undefined ? { speaker: w.speaker } : {}),
    });
  });

  // Layout: decided from the analysis on the first plan (or when the edit has no explicit choice).
  const decided = chooseLayout(a);
  const layout = i.autoLayout ? decided.layout : edit.layout;
  const focus = edit.focus ?? "auto";
  const layoutReason = i.autoLayout ? decided.reason : `set in editor (auto would be ${decided.layout}: ${decided.reason})`;
  const crop =
    layout === "single"
      ? singleCrop({ analysis: a, sectionStart: section.sourceStart, segments, focus })
      : layout === "split"
        ? splitCrop(a)
        : ({ mode: "fit" } as const);

  // Cuts: scene changes mapped to output time + every jump cut from pacing / cold open.
  const sceneCuts = a.scenes
    .map((s) => s.s + section.sourceStart)
    .map((t) => srcToOut(segments, t, ["teaser", "main"]))
    .filter((t): t is number => t !== null && t > 0.05 && t < duration - 0.05);
  const cuts = [...new Set([...sceneCuts, ...jumpCuts(segments)].map((t) => Math.round(t * 1000) / 1000))].sort((x, y) => x - y);

  const emphasisTimes = words.filter((w) => w.emphasis && !w.teaser).map((w) => w.s);
  const zoom = layout === "fit" ? [] : zoomKeyframes(emphasisTimes, cuts, edit.zoom, duration);

  const plan: Plan = {
    version: 1,
    clipId: i.clipId,
    layout,
    layoutReason,
    focus,
    section: { sourceStart: section.sourceStart, width: section.width, height: section.height, fps: section.fps },
    segments,
    duration,
    crop,
    zoom,
    cuts,
    stats: {
      removedPauses: tl.removedPauses,
      removedFillers: tl.removedFillers,
      savedSec: Math.round((end - start - tl.duration) * 100) / 100,
      coldOpen: Boolean(teaser),
    },
  };
  return { plan, words };
}
