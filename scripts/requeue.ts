/**
 * `pnpm requeue <sourceId> <TASK_TYPE>`: enqueue a pipeline stage again for a source
 * (e.g. re-run EDIT after changing selection rules). Runs against the local database.
 */
import { enqueueTask, jobDetail, loadEnv, sourceClips, TASK_TYPES, updateSource, type TaskType } from "@clip/shared";
import { openDb } from "@clip/shared/db";

const [sourceId, type] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!sourceId || !type || !(TASK_TYPES as readonly string[]).includes(type)) {
  console.error(`usage: pnpm requeue <sourceId> <${TASK_TYPES.join("|")}>`);
  process.exit(2);
}
const { db, sqlite } = openDb(loadEnv().DATABASE_PATH);
const d = jobDetail(db, sourceId);
if (!d) {
  console.error(`source ${sourceId} not found`);
  process.exit(2);
}
const prev = d.tasks.find((t) => t.type === type);
const payload = prev?.payload ?? {};
const priorityArg = process.argv.find((a) => a.startsWith("--priority="));
const priority = priorityArg ? Number(priorityArg.split("=")[1]) : 0;
// Per-clip stages are queued once per clip of the source.
const PER_CLIP: TaskType[] = ["ANALYZE", "PREP_CLIP", "RENDER_BASE", "COMPOSE", "DELIVER"];
if (PER_CLIP.includes(type as TaskType)) {
  for (const c of sourceClips(db, sourceId)) {
    const task = enqueueTask(db, { type: type as TaskType, sourceId, clipId: c.id, payload, priority });
    console.log(`queued ${task.type} ${task.id} for clip #${c.rank}`);
  }
} else {
  const task = enqueueTask(db, { type: type as TaskType, sourceId, payload, priority });
  console.log(`queued ${task.type} ${task.id} for ${d.source.title ?? sourceId}`);
}
if (["SCOUT", "EDIT"].includes(type)) updateSource(db, sourceId, { status: "selecting", error: null });
sqlite.close();
