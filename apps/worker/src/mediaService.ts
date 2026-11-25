import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { findRepoRoot } from "@clip/shared";
import { z } from "zod";

/**
 * Manages the long-lived Python media service (SPEC §3, §12): `python -m media serve`,
 * one JSON request per stdin line, one JSON response per stdout line, logs on stderr.
 * Started lazily, restarted on crash, run at below-normal priority.
 */

const responseSchema = z.union([
  z.object({ id: z.string().nullable(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().nullable(), ok: z.literal(false), error: z.string(), type: z.string().optional() }),
]);

export class MediaServiceError extends Error {
  constructor(
    message: string,
    readonly type?: string,
  ) {
    super(message);
    this.name = "MediaServiceError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface MediaServiceOptions {
  pythonPath: string;
  lowPriority: boolean;
  /** Called with each stderr line from Python. */
  onLog?: (line: string) => void;
}

export function lowerPriority(pid: number | undefined) {
  if (!pid) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not fatal: e.g. process already exited.
  }
}

export class MediaService {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly opts: MediaServiceOptions) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const pyDir = path.join(findRepoRoot(), "py");
    const proc = spawn(this.opts.pythonPath, ["-u", "-m", "media", "serve"], {
      cwd: pyDir,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
    this.proc = proc;
    if (this.opts.lowPriority) lowerPriority(proc.pid);

    readline.createInterface({ input: proc.stderr }).on("line", (l) => this.opts.onLog?.(l));

    this.ready = new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => {
        reject(new MediaServiceError(`media service exited during startup (code ${code})`));
      };
      proc.once("exit", onExit);
      proc.once("error", (e) => reject(new MediaServiceError(`could not start '${this.opts.pythonPath}': ${e.message}`)));
      readline.createInterface({ input: proc.stdout }).on("line", (line) => {
        let msg: z.infer<typeof responseSchema>;
        try {
          msg = responseSchema.parse(JSON.parse(line));
        } catch {
          this.opts.onLog?.(`[media stdout, not protocol] ${line}`);
          return;
        }
        if (msg.id === null) {
          if (msg.ok) {
            proc.off("exit", onExit);
            resolve();
          }
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new MediaServiceError(msg.error, msg.type));
      });
    });

    proc.on("exit", (code) => {
      this.opts.onLog?.(`media service exited (code ${code})`);
      for (const [, p] of this.pending) p.reject(new MediaServiceError(`media service exited (code ${code})`));
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });
    return this.ready;
  }

  /** Send one command and validate its result with `schema`. */
  async call<T>(cmd: string, args: Record<string, unknown>, schema: z.ZodType<T>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new MediaServiceError("media service not running");
    const id = `r${++this.seq}`;
    const result = await new Promise<unknown>((resolve, reject) => {
      const p: Pending = { resolve, reject };
      if (opts.timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new MediaServiceError(`${cmd} timed out after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      opts.signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        if (p.timer) clearTimeout(p.timer);
        reject(new MediaServiceError(`${cmd} aborted`));
      });
      this.pending.set(id, p);
      proc.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
    });
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new MediaServiceError(`invalid ${cmd} result from media service: ${parsed.error.message}`);
    return parsed.data;
  }

  stop() {
    this.proc?.stdin.end();
  }
}
