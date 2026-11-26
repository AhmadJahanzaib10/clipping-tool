import fs from "node:fs";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { clipFiles } from "./clips";
import { PRIORITY_USER } from "./constants";
import type { Db } from "./db/client";
import { campaigns, clips, sources, type Clip, type Task } from "./db/schema";
import { enqueueTask } from "./queue/queue";
import { hookAngle, renderKindFor, trimInsideSection, type ClipUserPatch, type RenderKind } from "./review";
import { addEvent } from "./jobs";
import { clipEditSchema } from "./schemas/clip";
import { planWordSchema, sectionInfoSchema } from "./schemas/plan";

/** The hook actually shown on a clip. */
export const hookInUse = (c: Pick<Clip, "hookA" | "hookB" | "edit">) => c.edit?.hookOverride?.trim() || (c.edit?.hookChoice === "B" ? c.hookB : c.hookA) || "";

function readSection(storageDir: string, clipId: string) {
  try {
    return sectionInfoSchema.parse(JSON.parse(fs.readFileSync(clipFiles(storageDir, clipId).sectionInfo, "utf8")));
  } catch {
    return null;
  }
}

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Save an edit from the review page and queue the right re-render (SPEC §6.2, §11: "the correct one chosen
 * automatically"): picture/timeline → PREP_CLIP → RENDER_BASE → COMPOSE (re-fetching the section first if the
 * new trim leaves it); text/SFX → COMPOSE only; title/captions → nothing. User renders jump the queue.
 */
export function applyClipPatch(db: Db, storageDir: string, clipId: string, patch: ClipUserPatch, now: Date = new Date()): { clip: Clip; render: RenderKind; tasks: Task[] } {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new ReviewError("clip not found", 404);
  if (!clip.edit) throw new ReviewError("clip has no edit yet");
  if (clip.status === "approved") throw new ReviewError("clip is approved; reject or re-open it before editing", 409);
  const edit = patch.edit ? clipEditSchema.parse(patch.edit) : clip.edit;
  const render = renderKindFor({ edit: clip.edit, hookA: clip.hookA, hookB: clip.hookB }, patch);
  const { edit: _e, ...text } = patch;
  const ts = now.toISOString();

  return db.transaction((tx) => {
    const updated = tx
      .update(clips)
      .set({ ...text, edit, startSec: edit.trim.start, endSec: edit.trim.end, ...(render !== "none" ? { status: "rendering" as const } : {}), updatedAt: ts })
      .where(eq(clips.id, clipId))
      .returning()
      .get()!;
    const tasks: Task[] = [];
    const base = { sourceId: clip.sourceId, clipId, priority: PRIORITY_USER };
    if (render === "base") {
      const inside = trimInsideSection(edit.trim, readSection(storageDir, clipId));
      tasks.push(
        inside
          ? enqueueTask(tx as unknown as Db, { ...base, type: "PREP_CLIP" }, now)
          : enqueueTask(tx as unknown as Db, { sourceId: clip.sourceId, priority: PRIORITY_USER, type: "FETCH_SECTIONS", payload: { clipIds: [clipId] } }, now),
      );
    } else if (render === "compose") {
      tasks.push(enqueueTask(tx as unknown as Db, { ...base, type: "COMPOSE" }, now));
    }
    addEvent(tx as unknown as Db, { sourceId: clip.sourceId, clipId, level: "info", message: `Edited in review → ${render === "base" ? "full re-render" : render === "compose" ? "fast re-render" : "saved (no render needed)"}` }, now);
    return { clip: updated, render, tasks };
  });
}

/** Explicit Fast / Full re-render buttons (SPEC §11). */
export function requestRender(db: Db, storageDir: string, clipId: string, kind: "compose" | "base", now: Date = new Date()): Task {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip?.edit) throw new ReviewError("clip not found", 404);
  db.update(clips).set({ status: "rendering", updatedAt: now.toISOString() }).where(eq(clips.id, clipId)).run();
  if (kind === "compose") return enqueueTask(db, { type: "COMPOSE", sourceId: clip.sourceId, clipId, priority: PRIORITY_USER }, now);
  return trimInsideSection(clip.edit.trim, readSection(storageDir, clipId))
    ? enqueueTask(db, { type: "PREP_CLIP", sourceId: clip.sourceId, clipId, priority: PRIORITY_USER }, now)
    : enqueueTask(db, { type: "FETCH_SECTIONS", sourceId: clip.sourceId, priority: PRIORITY_USER, payload: { clipIds: [clipId] } }, now);
}

/** Approve → DELIVER (SPEC §7.11). Only a rendered (or uploaded) clip can be approved. */
export function approveClip(db: Db, clipId: string, now: Date = new Date()): { clip: Clip; task: Task } {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new ReviewError("clip not found", 404);
  if (!clip.outputPath) throw new ReviewError("render the clip before approving it", 409);
  if (clip.status === "rendering") throw new ReviewError("wait for the render to finish", 409);
  const ts = now.toISOString();
  const updated = db.update(clips).set({ status: "approved", approvedAt: ts, updatedAt: ts }).where(eq(clips.id, clipId)).returning().get()!;
  const task = enqueueTask(db, { type: "DELIVER", sourceId: clip.sourceId, clipId, priority: PRIORITY_USER }, now);
  addEvent(db, { sourceId: clip.sourceId, clipId, level: "info", message: "Approved → delivering" }, now);
  return { clip: updated, task };
}

export function rejectClip(db: Db, clipId: string, now: Date = new Date()): Clip {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new ReviewError("clip not found", 404);
  const updated = db.update(clips).set({ status: "rejected", updatedAt: now.toISOString() }).where(eq(clips.id, clipId)).returning().get()!;
  addEvent(db, { sourceId: clip.sourceId, clipId, level: "info", message: "Rejected" }, now);
  return updated;
}

/** Re-open an approved/rejected clip for editing (it goes back to "rendered"). */
export function reopenClip(db: Db, clipId: string, now: Date = new Date()): Clip {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) throw new ReviewError("clip not found", 404);
  return db.update(clips).set({ status: clip.outputPath ? "rendered" : "candidate", updatedAt: now.toISOString() }).where(eq(clips.id, clipId)).returning().get()!;
}

export function setPerformance(db: Db, clipId: string, p: { views72h: number; platform: string }, now: Date = new Date()): Clip {
  const clip = db.update(clips).set({ views72h: p.views72h, viewsPlatform: p.platform, updatedAt: now.toISOString() }).where(eq(clips.id, clipId)).returning().get();
  if (!clip) throw new ReviewError("clip not found", 404);
  return clip;
}

/**
 * Few-shot examples for the EDIT prompt (SPEC §9): the top 5 clips of the same niche from the last 30 days
 * by views at 72 h — hook used, first line, length.
 */
export function fewShotExamples(db: Db, storageDir: string | null, niche: string, now: Date = new Date(), limit = 5) {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const rows = db
    .select({ clip: clips, niche: campaigns.niche })
    .from(clips)
    .innerJoin(campaigns, eq(clips.campaignId, campaigns.id))
    .where(and(isNotNull(clips.views72h), gte(clips.createdAt, since), eq(campaigns.niche, niche)))
    .orderBy(desc(clips.views72h))
    .limit(limit)
    .all();
  return rows.map(({ clip }) => {
    let firstLine = clip.title ?? "";
    if (storageDir) {
      try {
        const words = planWordSchema.array().parse(JSON.parse(fs.readFileSync(clipFiles(storageDir, clip.id).words, "utf8")));
        firstLine = words.filter((w) => !w.teaser).slice(0, 14).map((w) => w.w).join(" ");
      } catch {
        // words.json gone (cleanup): fall back to the title
      }
    }
    return { hook: hookInUse(clip), firstLine, lengthSec: Math.round(clip.endSec - clip.startSec), views: clip.views72h! };
  });
}

/** What the CLEANUP stage needs to decide (SPEC §7.12). */
export function cleanupState(db: Db) {
  return {
    sources: db.select({ id: sources.id, createdAt: sources.createdAt }).from(sources).all(),
    clips: db.select({ id: clips.id, sourceId: clips.sourceId, status: clips.status, deliveredAt: clips.deliveredAt, updatedAt: clips.updatedAt }).from(clips).all(),
  };
}

/** Overview (SPEC §9): average views at 72 h by hook angle and by caption preset. */
export function performanceTables(db: Db) {
  const rows = db.select().from(clips).where(isNotNull(clips.views72h)).all();
  const group = (key: (c: Clip) => string) => {
    const m = new Map<string, number[]>();
    for (const c of rows) m.set(key(c), [...(m.get(key(c)) ?? []), c.views72h!]);
    return [...m.entries()]
      .map(([k, v]) => ({ key: k, clips: v.length, avgViews: Math.round(v.reduce((a, b) => a + b, 0) / v.length) }))
      .sort((a, b) => b.avgViews - a.avgViews);
  };
  return { byAngle: group((c) => hookAngle(hookInUse(c))), byPreset: group((c) => c.edit?.captionPreset ?? "?"), total: rows.length };
}
