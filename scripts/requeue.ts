/**
 * `pnpm requeue <sourceId> <TASK_TYPE>`: enqueue a pipeline stage again for a source
 * (e.g. re-run EDIT after changing selection rules). Runs against the local database.
 */
import { enqueueTask, jobDetail, loadEnv, TASK_TYPES, updateSource, type TaskType } from "@clip/shared";
import { openDb } from "@clip/shared/db";

const [sourceId, type] = process.argv.slice(2);
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
const task = enqueueTask(db, { type: type as TaskType, sourceId, payload: prev?.payload ?? {} });
if (["SCOUT", "EDIT"].includes(type)) updateSource(db, sourceId, { status: "selecting", error: null });
console.log(`queued ${task.type} ${task.id} for ${d.source.title ?? sourceId}`);
sqlite.close();
