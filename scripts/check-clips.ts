/**
 * `pnpm check:clips <sourceId>`: run the M3 acceptance checks on a source's clips and print them.
 */
import fs from "node:fs";
import { campaignConfigSchema, checkSelection, getSourceContext, jobDetail, loadEnv, sourceClips, sourceFiles, transcriptSchema } from "@clip/shared";
import { openDb } from "@clip/shared/db";

const sourceId = process.argv[2];
if (!sourceId) {
  console.error("usage: pnpm check:clips <sourceId>");
  process.exit(2);
}
const env = loadEnv();
const { db, sqlite } = openDb(env.DATABASE_PATH);
const src = jobDetail(db, sourceId)?.source;
if (!src) {
  console.error(`source ${sourceId} not found`);
  process.exit(2);
}
const cfg = getSourceContext(db, sourceId)?.campaign.config ?? campaignConfigSchema.parse({});
const t = transcriptSchema.parse(JSON.parse(fs.readFileSync(sourceFiles(env.STORAGE_DIR, sourceId).transcript, "utf8")));
const clips = sourceClips(db, sourceId);

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const words = (a: number, b: number) => t.words.filter((w) => w.s >= a - 0.002 && w.e <= b + 0.002);

console.log(`\n${src.title ?? sourceId} (${mmss(src.durationSec ?? 0)}, transcript: ${src.transcriptProvider}/${src.transcriptQuality})\n`);
for (const c of clips) {
  const ws = words(c.startSec, c.endSec);
  console.log(`#${c.rank}  score ${c.score?.toFixed(0)}  ${mmss(c.startSec)}–${mmss(c.endSec)}  (${(c.endSec - c.startSec).toFixed(1)} s)`);
  console.log(`    A: ${c.hookA}`);
  console.log(`    B: ${c.hookB}`);
  console.log(`    starts: "${ws.slice(0, 8).map((w) => w.w).join(" ")}…"`);
  console.log(`    ends:   "…${ws.slice(-8).map((w) => w.w).join(" ")}"`);
}
const checks = checkSelection(clips, t, { minLengthSec: cfg.minLengthSec, maxLengthSec: cfg.maxLengthSec, bannedWords: cfg.bannedWords });
console.log("\nAcceptance checks");
for (const c of checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`);
sqlite.close();
process.exit(checks.every((c) => c.pass) ? 0 : 1);
