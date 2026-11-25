import { loadEnv, type Db } from "@clip/shared";
import { openDb } from "@clip/shared/db";

const g = globalThis as unknown as { __clipDb?: Db };

/** One SQLite connection per server process (survives Next dev hot reloads). Migrations apply on first open. */
export function getDb(): Db {
  if (!g.__clipDb) g.__clipDb = openDb(loadEnv().DATABASE_PATH).db;
  return g.__clipDb;
}
