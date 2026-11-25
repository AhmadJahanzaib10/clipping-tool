import { spawn } from "node:child_process";
import path from "node:path";
import { findRepoRoot, loadEnv } from "@clip/shared";

/** Runs `next dev|start` in apps/web with HOST/PORT from the repo-root .env. */
const mode = process.argv[2] === "dev" ? "dev" : "start";
const env = loadEnv();
const webDir = path.join(findRepoRoot(), "apps", "web");
const nextBin = path.join(webDir, "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextBin, mode, "-H", env.HOST, "-p", String(env.PORT)], {
  cwd: webDir,
  stdio: "inherit",
  env: process.env,
});
const forward = (sig: NodeJS.Signals) => child.kill(sig);
process.on("SIGINT", forward);
process.on("SIGTERM", forward);
child.on("exit", (code) => process.exit(code ?? 0));
