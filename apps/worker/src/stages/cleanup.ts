import fs from "node:fs";
import path from "node:path";
import { clipFiles, DELIVERED_CLIP_WORK_FILES, folderBytes, planCleanup, SOURCE_WORK_FILES, sourceDir } from "@clip/shared";
import type { StageHandler } from "../context";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

/**
 * CLEANUP (SPEC §7.12, daily and on startup): source audio / full downloads after KEEP_SOURCES_DAYS;
 * section.mp4 + base.mp4 of approved clips 2 days after delivery (the delivered file stays);
 * rejected clips (whole folder) after KEEP_REJECTED_DAYS. Transcripts and plans are small and kept.
 */
export const cleanup: StageHandler = async (_task, { env, api }) => {
  const state = await api.cleanupState();
  const plan = planCleanup({ now: new Date(), keepSourcesDays: env.KEEP_SOURCES_DAYS, keepRejectedDays: env.KEEP_REJECTED_DAYS, ...state });
  let freed = 0;
  let files = 0;
  const rm = (p: string) => {
    if (!fs.existsSync(p)) return;
    freed += fs.statSync(p).isDirectory() ? folderBytes(p) : fs.statSync(p).size;
    fs.rmSync(p, { recursive: true, force: true });
    files++;
  };
  for (const id of plan.sources) for (const f of SOURCE_WORK_FILES) rm(path.join(sourceDir(env.STORAGE_DIR, id), f));
  for (const id of plan.deliveredClips) for (const f of DELIVERED_CLIP_WORK_FILES) rm(path.join(clipFiles(env.STORAGE_DIR, id).dir, f));
  for (const id of plan.rejectedClips) rm(clipFiles(env.STORAGE_DIR, id).dir);
  await api.event({
    level: "info",
    message: `Cleanup: freed ${mb(freed)} (${files} items) — ${plan.sources.length} old sources, ${plan.deliveredClips.length} delivered clips, ${plan.rejectedClips.length} rejected clips; storage now ${mb(folderBytes(env.STORAGE_DIR))}`,
    data: { freed, plan },
  });
  return [];
};
