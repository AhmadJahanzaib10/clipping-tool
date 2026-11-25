// Re-exports for tests (keeps test imports short).
export { claimTask, createJob, enqueueTask, seedDb, type Db } from "@clip/shared";
export { schema } from "@clip/shared/db";
import { schema } from "@clip/shared/db";
export const { campaigns, operators } = schema;
