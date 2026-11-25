import { spawn } from "node:child_process";
import { lowerPriority } from "./mediaService";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a binary with an argv array (no shell), optionally at below-normal priority. Rejects on non-zero exit. */
export function runProcess(bin: string, args: string[], opts: { lowPriority?: boolean; signal?: AbortSignal } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, signal: opts.signal });
    if (opts.lowPriority) lowerPriority(p.pid);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    p.on("error", (e) => reject(new Error(`${bin}: ${e.message}`)));
    p.on("close", (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${bin} exited with code ${code}: ${stderr.trim().split("\n").slice(-5).join("\n")}`));
    });
  });
}
