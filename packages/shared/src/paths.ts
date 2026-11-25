import fs from "node:fs";
import path from "node:path";

let cachedRoot: string | undefined;

/** Repo root = nearest ancestor of `start` containing pnpm-workspace.yaml. Works from apps/web, apps/worker, scripts. */
export function findRepoRoot(start: string = process.cwd()): string {
  if (cachedRoot && start === process.cwd()) return cachedRoot;
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      if (start === process.cwd()) cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not find repo root (pnpm-workspace.yaml) above ${start}`);
    dir = parent;
  }
}

/** Resolve a possibly-relative path from .env against the repo root. */
export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(findRepoRoot(), p);
}

export function migrationsFolder(): string {
  return path.join(findRepoRoot(), "packages", "shared", "drizzle");
}
