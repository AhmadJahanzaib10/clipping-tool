/**
 * `pnpm release:stale`: hand back every running task whose worker is gone (after a hard restart),
 * so it is picked up immediately instead of waiting for the 10-minute lease to expire.
 */
import { failTask, loadEnv } from "@clip/shared";
import { openDb, schema } from "@clip/shared/db";

const { db, sqlite } = openDb(loadEnv().DATABASE_PATH);
const running = db.select().from(schema.tasks).all().filter((t) => t.status === "running" && t.workerId);
for (const t of running) {
  failTask(db, { taskId: t.id, workerId: t.workerId!, release: true });
  console.log(`released ${t.type} ${t.id} (was on ${t.workerId})`);
}
if (!running.length) console.log("no running tasks");
sqlite.close();
