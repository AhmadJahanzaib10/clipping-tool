"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RetryButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/tasks/${taskId}/retry`, { method: "POST" });
        router.refresh();
      }}
      className="rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {busy ? "Retrying…" : "Retry"}
    </button>
  );
}
