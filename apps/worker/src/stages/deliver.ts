import fs from "node:fs";
import path from "node:path";
import { deliveryTarget, sidecarText } from "@clip/shared";
import { PermanentError, requireSourceId, type StageHandler } from "../context";

/** Copy via a temp name so a half-written file never appears in the (synced) delivery folder. */
function copyInto(src: string, dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  const tmp = `${dest}.partial`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * DELIVER (SPEC §7.11, on approve): the approved version → storage/out/{operator}/{campaign}/{YYYY-MM-DD}/
 * {clipId}-{slug(title)}.mp4, plus {DRIVE_ROOT}/{operator.driveFolder}/… when DRIVE_ROOT is set, each with a
 * {clipId}.txt sidecar (platform captions + title, required hashtags and mentions always appended).
 */
export const deliver: StageHandler = async (task, { env, api }) => {
  const sourceId = requireSourceId(task);
  const clipId = task.clipId;
  if (!clipId) throw new PermanentError("DELIVER needs a clipId");
  const { clip, campaign, operator } = await api.clip(clipId);
  if (clip.status !== "approved") throw new PermanentError(`clip is ${clip.status}, not approved`);
  if (!clip.outputPath) throw new PermanentError("clip has no rendered output");
  const output = path.join(env.STORAGE_DIR, clip.outputPath);
  if (!fs.existsSync(output)) throw new PermanentError(`output file missing: ${clip.outputPath}`);

  const t = deliveryTarget({
    storageDir: env.STORAGE_DIR,
    driveRoot: env.DRIVE_ROOT ?? null,
    operator: operator ?? { slug: "unassigned", driveFolder: null },
    campaignSlug: campaign.slug,
    clipId,
    title: clip.title,
    date: new Date(),
  });
  const sidecar = sidecarText(clip, campaign.config);
  const delivered: string[] = [];
  for (const dir of [t.outDir, t.driveDir].filter((d): d is string => !!d)) {
    delivered.push(copyInto(output, dir, t.fileName));
    fs.writeFileSync(path.join(dir, t.sidecarName), sidecar, "utf8");
  }

  const rel = path.relative(env.STORAGE_DIR, delivered[0]!).split(path.sep).join("/");
  await api.patchClip(clipId, { deliveredAt: new Date().toISOString(), deliveryPath: rel });
  await api.event({
    sourceId,
    clipId,
    level: "info",
    message: `Delivered ${t.fileName} → ${delivered.map((d) => path.dirname(d)).join(" and ")}`,
    data: { files: delivered },
  });
  return [];
};
