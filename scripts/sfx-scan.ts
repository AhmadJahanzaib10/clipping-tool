/** `pnpm sfx:scan [--force]`: scan assets/sfx into the library (SPEC §10.2). */
import { loadEnv, scanSfx } from "@clip/shared";
import { openDb } from "@clip/shared/db";

const env = loadEnv();
const { db, sqlite } = openDb(env.DATABASE_PATH);
const r = await scanSfx(db, { ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH, force: process.argv.includes("--force") });
console.log(`SFX scan in ${r.ms} ms: +${r.added.length} new, ${r.updated.length} updated, ${r.unchanged} unchanged, ${r.removed.length} removed, ${r.failed.length} failed`);
console.log(`Categories: ${Object.entries(r.categories).map(([c, n]) => `${c} ${n}`).join(", ") || "(none — add files under assets/sfx/<category>/)"}`);
for (const f of r.failed) console.log(`  FAILED ${f.file}: ${f.error}`);
for (const w of r.warnings) console.log(`  warning: ${w}`);
sqlite.close();
process.exit(r.failed.length ? 1 : 0);
