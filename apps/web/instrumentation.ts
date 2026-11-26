/** Next.js startup hook: scan the SFX library once when the server starts (SPEC §10.2). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runSfxScan } = await import("./lib/sfx");
  // CLEANUP on startup and then daily (SPEC §7.12); the queue never holds two waiting CLEANUP tasks.
  const { enqueueTask } = await import("@clip/shared");
  const { getDb } = await import("./lib/db");
  const queueCleanup = () => {
    try {
      enqueueTask(getDb(), { type: "CLEANUP" });
    } catch (e) {
      console.error("[cleanup] could not queue:", e instanceof Error ? e.message : e);
    }
  };
  queueCleanup();
  setInterval(queueCleanup, 24 * 60 * 60 * 1000).unref();
  runSfxScan()
    .then((r) => console.log(`[sfx] startup scan: +${r.added.length} new, ${r.updated.length} updated, ${r.unchanged} unchanged, ${r.removed.length} removed, ${r.failed.length} failed (${r.ms} ms)`))
    .catch((e) => console.error("[sfx] startup scan failed:", e instanceof Error ? e.message : e));
}
