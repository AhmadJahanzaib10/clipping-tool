import { loadEnv, seedDb } from "@clip/shared";
import { openDb } from "@clip/shared/db";

const env = loadEnv();
const { db, sqlite } = openDb(env.DATABASE_PATH);
const r = seedDb(db);
console.log(`Seed: +${r.operators} operators, +${r.campaigns} campaigns (existing rows kept)`);
sqlite.close();
