/** Next.js startup hook: scan the SFX library once when the server starts (SPEC §10.2). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runSfxScan } = await import("./lib/sfx");
  runSfxScan()
    .then((r) => console.log(`[sfx] startup scan: +${r.added.length} new, ${r.updated.length} updated, ${r.unchanged} unchanged, ${r.removed.length} removed, ${r.failed.length} failed (${r.ms} ms)`))
    .catch((e) => console.error("[sfx] startup scan failed:", e instanceof Error ? e.message : e));
}
