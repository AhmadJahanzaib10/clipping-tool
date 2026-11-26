import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BASE_EDIT_FIELDS, clipEditSchema, type ClipEdit } from "./schemas/clip";
import type { CampaignConfig } from "./schemas/campaign";

/** SPEC §6.2 / §7.10 / §7.11 / §7.12 / §9: review-side rules, all pure. */

// ---------- which re-render does an edit need? ----------

export type RenderKind = "base" | "compose" | "none";

/** Fields the review page may change outside the ClipEdit. */
export const clipTextPatchSchema = z.object({
  title: z.string().max(200),
  captionTiktok: z.string().max(2200),
  captionInstagram: z.string().max(2200),
  captionYoutube: z.string().max(5000),
  hashtags: z.array(z.string().max(60)).max(30),
  hookA: z.string().max(120),
  hookB: z.string().max(120),
});
export const clipUserPatchSchema = clipTextPatchSchema.partial().extend({ edit: clipEditSchema.optional() });
export type ClipUserPatch = z.infer<typeof clipUserPatchSchema>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * SPEC §6.2: trim / layout / focus / pacing / coldOpen / zoom → RENDER_BASE (picture/timeline);
 * any other edit field, or the text of the hook in use → COMPOSE; title/captions/hashtags → nothing.
 */
export function renderKindFor(prev: { edit: ClipEdit; hookA: string | null; hookB: string | null }, patch: ClipUserPatch): RenderKind {
  const next = patch.edit ?? prev.edit;
  if (BASE_EDIT_FIELDS.some((k) => !same(prev.edit[k], next[k]))) return "base";
  const composeFields = (Object.keys(next) as (keyof ClipEdit)[]).filter((k) => !(BASE_EDIT_FIELDS as readonly string[]).includes(k));
  if (composeFields.some((k) => !same(prev.edit[k], next[k]))) return "compose";
  // Editing the text of the hook that is on screen (and not overridden) also changes the picture.
  if (!next.hookOverride?.trim()) {
    const shown = next.hookChoice === "B" ? "hookB" : "hookA";
    if (patch[shown] !== undefined && patch[shown] !== prev[shown]) return "compose";
  }
  return "none";
}

/** Does the new trim still fit inside the downloaded section? (Otherwise the section must be fetched again.) */
export function trimInsideSection(trim: { start: number; end: number }, section: { sourceStart: number; duration: number } | null): boolean {
  if (!section) return false;
  return trim.start >= section.sourceStart - 1e-3 && trim.end <= section.sourceStart + section.duration + 1e-3;
}

// ---------- delivery (SPEC §7.11) ----------

export function slugify(s: string, max = 60): string {
  const slug = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "clip";
}

/** Folder names from user data must not escape the delivery root. */
export const safeSegment = (s: string) => slugify(s.replace(/[\\/:*?"<>|]/g, " "), 80);

export interface DeliveryTarget {
  /** storage/out/{operator}/{campaign}/{YYYY-MM-DD}/ */
  outDir: string;
  /** {DRIVE_ROOT}/{operator.driveFolder}/{campaign}/{YYYY-MM-DD}/ when DRIVE_ROOT is set. */
  driveDir: string | null;
  fileName: string;
  sidecarName: string;
}

export function deliveryTarget(i: {
  storageDir: string;
  driveRoot?: string | null;
  operator: { slug: string; driveFolder: string | null };
  campaignSlug: string;
  clipId: string;
  title: string | null;
  date: Date;
}): DeliveryTarget {
  const day = i.date.toISOString().slice(0, 10);
  const rel = [safeSegment(i.campaignSlug), day];
  return {
    outDir: path.join(i.storageDir, "out", safeSegment(i.operator.slug), ...rel),
    driveDir: i.driveRoot ? path.join(i.driveRoot, safeSegment(i.operator.driveFolder || i.operator.slug), ...rel) : null,
    fileName: `${i.clipId}-${slugify(i.title ?? "clip")}.mp4`,
    sidecarName: `${i.clipId}.txt`,
  };
}

const withTags = (text: string, tags: string[]) => {
  const missing = tags.filter((t) => t && !text.toLowerCase().includes(t.toLowerCase()));
  return [text.trim(), missing.join(" ")].filter(Boolean).join("\n\n");
};

/** Platform caption with the campaign's required hashtags + mentions (and the clip's hashtags) appended. */
export function platformCaption(caption: string | null, clipTags: string[] | null, cfg: Pick<CampaignConfig, "requiredHashtags" | "requiredMentions">): string {
  const tags = [...new Set([...cfg.requiredMentions, ...cfg.requiredHashtags, ...(clipTags ?? [])])];
  return withTags(caption ?? "", tags);
}

/** Sidecar {clipId}.txt (SPEC §7.11): captions per platform and the title; required tags always appended. */
export function sidecarText(
  c: { id: string; title: string | null; captionTiktok: string | null; captionInstagram: string | null; captionYoutube: string | null; hashtags: string[] | null },
  cfg: Pick<CampaignConfig, "requiredHashtags" | "requiredMentions">,
): string {
  return [
    `Clip ${c.id}`,
    "",
    "== TikTok ==",
    platformCaption(c.captionTiktok, c.hashtags, cfg),
    "",
    "== Instagram ==",
    platformCaption(c.captionInstagram, c.hashtags, cfg),
    "",
    "== YouTube Shorts ==",
    `Title: ${c.title ?? ""}`,
    platformCaption(c.captionYoutube, c.hashtags, cfg),
    "",
  ].join("\n");
}

// ---------- cleanup (SPEC §7.12) ----------

export interface CleanupInput {
  now: Date;
  keepSourcesDays: number;
  keepRejectedDays: number;
  /** Days after delivery before an approved clip's working files go. */
  keepDeliveredDays?: number;
  sources: { id: string; createdAt: string }[];
  clips: { id: string; sourceId: string; status: string; deliveredAt: string | null; updatedAt: string }[];
}

export interface CleanupPlan {
  /** Source working files (audio, full download, upload) to delete. */
  sources: string[];
  /** Approved + delivered clips: delete section.mp4 and base.mp4 (keep the delivered output). */
  deliveredClips: string[];
  /** Rejected clips: delete the whole clip folder. */
  rejectedClips: string[];
}

const ageDays = (now: Date, iso: string) => (now.getTime() - new Date(iso).getTime()) / 86_400_000;

export function planCleanup(i: CleanupInput): CleanupPlan {
  const keepDelivered = i.keepDeliveredDays ?? 2;
  return {
    sources: i.sources.filter((s) => ageDays(i.now, s.createdAt) > i.keepSourcesDays).map((s) => s.id),
    deliveredClips: i.clips.filter((c) => c.status === "approved" && c.deliveredAt && ageDays(i.now, c.deliveredAt) > keepDelivered).map((c) => c.id),
    rejectedClips: i.clips.filter((c) => c.status === "rejected" && ageDays(i.now, c.updatedAt) > i.keepRejectedDays).map((c) => c.id),
  };
}

/** Source working files the cleanup may delete (the transcript and candidates stay: small and useful). */
export const SOURCE_WORK_FILES = ["audio.wav", "audio.opus", "full.mp4", "upload.mp4", "upload.mov", "upload.m4v", "upload.mkv", "upload.webm"];
export const DELIVERED_CLIP_WORK_FILES = ["section.mp4", "base.mp4", "section-words.json"];

/** Total size (bytes) of a folder, recursively. */
export function folderBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? folderBytes(p) : fs.statSync(p).size;
  }
  return total;
}

// ---------- learning loop (SPEC §9) ----------

export type HookAngle = "question" | "number" | "pov/story" | "contrarian" | "bold claim" | "curiosity gap";

/** Rough angle of a hook, for the Overview performance table. */
export function hookAngle(hook: string): HookAngle {
  const h = hook.trim().toLowerCase();
  if (/^pov\b|^when\b|^the day\b|^i\b|^my\b/.test(h)) return "pov/story";
  if (h.endsWith("?") || /^(why|how|what|who|is|are|do|does|can|should)\b/.test(h)) return "question";
  if (/\d|\b(million|billion|thousand|percent)\b/.test(h)) return "number";
  if (/\b(stop|never|don't|dont|wrong|myth|lie|lies|nobody|overrated|not)\b/.test(h)) return "contrarian";
  if (/\b(this|the one|secret|truth|nobody tells|here's)\b/.test(h)) return "curiosity gap";
  return "bold claim";
}

export const performanceSchema = z.object({
  views72h: z.number().int().min(0).max(10_000_000_000),
  platform: z.enum(["tiktok", "instagram", "youtube"]),
});
