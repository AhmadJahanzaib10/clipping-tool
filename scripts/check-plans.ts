/**
 * `pnpm check:plans <sourceId>`: M4 report for a source — section bytes, alignment, layout, crop smoothness,
 * pacing, words. Exits 1 if a hard rule is broken.
 */
import fs from "node:fs";
import { analysisSchema, clipFiles, jobDetail, loadEnv, planSchema, planWordSchema, sectionInfoSchema, sourceClips } from "@clip/shared";
import { openDb } from "@clip/shared/db";
import { z } from "zod";
import { maxPanSpeed } from "../apps/worker/src/render/crop";

const sourceId = process.argv[2];
if (!sourceId) {
  console.error("usage: pnpm check:plans <sourceId>");
  process.exit(2);
}
const env = loadEnv();
const { db, sqlite } = openDb(env.DATABASE_PATH);
const d = jobDetail(db, sourceId);
if (!d) {
  console.error(`source ${sourceId} not found`);
  process.exit(2);
}
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const read = <T>(file: string, s: z.ZodType<T>): T | null => (fs.existsSync(file) ? s.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : null);

console.log(`\n${d.source.title ?? sourceId}  [${d.source.status}]\n`);
const sectionsEvent = d.events.find((e) => e.message.startsWith("Sections for"));
if (sectionsEvent) console.log(`  ${sectionsEvent.message}\n`);

let problems = 0;
const bad = (msg: string) => {
  problems++;
  return `  !! ${msg}`;
};
for (const c of sourceClips(db, sourceId)) {
  const f = clipFiles(env.STORAGE_DIR, c.id);
  const sec = read(f.sectionInfo, sectionInfoSchema);
  const an = read(f.analysis, analysisSchema);
  const plan = read(f.plan, planSchema);
  const words = read(f.words, z.array(planWordSchema));
  console.log(`#${c.rank} clip ${c.startSec.toFixed(1)}–${c.endSec.toFixed(1)} s (${(c.endSec - c.startSec).toFixed(1)} s)`);
  if (!sec) {
    console.log("    (no section yet)");
    continue;
  }
  console.log(`    section: ${sec.method}, ${mb(sec.bytes)}, ${sec.width}×${sec.height}@${sec.fps}, starts at ${sec.sourceStart.toFixed(3)} s (align ${sec.alignScore})`);
  if (sec.sourceStart > c.startSec + 0.01 || sec.sourceStart + sec.duration < c.endSec - 0.01) console.log(bad("section does not cover the clip"));
  if (an) {
    const withFace = an.faces.filter((s) => s.faces.length).length;
    console.log(`    analysis: ${an.scenes.length} scene(s), face in ${withFace}/${an.faces.length} samples`);
  }
  if (!plan || !words) {
    console.log("    (no plan yet)");
    continue;
  }
  const crop =
    plan.crop.mode === "single"
      ? `single ${plan.crop.w}×${plan.crop.h}, ${plan.crop.keyframes.length} keyframes (${(plan.crop.keyframes.length / plan.duration).toFixed(2)}/s), max pan ${maxPanSpeed(plan.crop).toFixed(0)} px/s, x ${Math.min(...plan.crop.keyframes.map((k) => k.x))}–${Math.max(...plan.crop.keyframes.map((k) => k.x))}`
      : plan.crop.mode === "split"
        ? `split top ${JSON.stringify(plan.crop.top)} bottom ${JSON.stringify(plan.crop.bottom)}`
        : "fit (whole frame over blurred background)";
  console.log(`    layout: ${plan.layout} — ${plan.layoutReason}`);
  console.log(`    crop: ${crop}`);
  console.log(`    timeline: ${plan.segments.length} segment(s), ${plan.duration.toFixed(1)} s (−${plan.stats.savedSec} s: ${plan.stats.removedPauses} pauses, ${plan.stats.removedFillers} fillers)${plan.stats.coldOpen ? ", cold open" : ""}; ${plan.zoom.length} zoom(s), ${plan.cuts.length} cut(s)`);
  if (plan.crop.mode === "single") {
    const plain = plan.crop.keyframes.filter((k) => !k.jump);
    for (let i = 1; i < plain.length; i++) if (plain[i]!.t - plain[i - 1]!.t < 0.5 - 1e-6) { console.log(bad("more than 2 keyframes/s")); break; }
  }
  if (plan.sfx.length) {
    console.log(`    sfx: ${plan.sfx.map((c) => `${c.at.toFixed(1)}s ${c.category}`).join(", ")}`);
    const sorted = [...plan.sfx].sort((a, b) => a.at - b.at);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.at - sorted[i - 1]!.at < 1.0 - 1e-6) console.log(bad(`SFX cues ${sorted[i - 1]!.at}s and ${sorted[i]!.at}s are < 1 s apart`));
      if (sorted[i]!.sfxId === sorted[i - 1]!.sfxId) console.log(bad(`same SFX file twice in a row at ${sorted[i]!.at}s`));
    }
  } else console.log("    sfx: none");
  const main = words.filter((w) => !w.teaser);
  const order = main.every((w, i) => w.e >= w.s && (i === 0 || w.s >= main[i - 1]!.e - 1e-6));
  const inside = words.every((w) => w.s >= -1e-6 && w.e <= plan.duration + 1e-6);
  console.log(`    words: ${words.length} (${words.filter((w) => w.emphasis).length} emphasis, ${words.filter((w) => w.teaser).length} teaser), ordered ${order ? "yes" : "NO"}, inside clip ${inside ? "yes" : "NO"}`);
  if (!order || !inside) console.log(bad("caption words out of order / outside the clip"));
}
sqlite.close();
console.log(problems ? `\n${problems} problem(s)` : "\nno problems");
process.exit(problems ? 1 : 0);
