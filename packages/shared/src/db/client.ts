import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { migrationsFolder } from "../paths";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDbOptions {
  /** Apply pending migrations on open (default true). */
  migrate?: boolean;
}

/** Open SQLite (WAL, foreign keys, busy timeout) and return a Drizzle handle. Use ":memory:" in tests. */
export function openDb(file: string, opts: OpenDbOptions = {}): { db: Db; sqlite: Database.Database } {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  const db = drizzle(sqlite, { schema });
  if (opts.migrate !== false) migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, sqlite };
}

export { schema };
