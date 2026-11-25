import { loadEnv } from "@clip/shared";
import { openDb } from "@clip/shared/db";

const env = loadEnv();
const { sqlite } = openDb(env.DATABASE_PATH); // applies pending migrations
const tables = sqlite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not glob '__*' order by name").all() as { name: string }[];
console.log(`Migrated ${env.DATABASE_PATH}`);
console.log(`Tables: ${tables.map((t) => t.name).join(", ")}`);
sqlite.close();
