import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { loadEnv } from "@clip/shared";
import { MIME, parseRange, safeStoragePath } from "@/lib/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/files/<storage-relative path> — media streaming with Range support (SPEC §11). */
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const file = safeStoragePath(loadEnv().STORAGE_DIR, (await params).path);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("not found", { status: 404 });
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = parseRange(req.headers.get("range"), size);
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=0, must-revalidate" };
  if (new URL(req.url).searchParams.get("download") === "1") headers["content-disposition"] = `attachment; filename="${path.basename(file)}"`;
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: { ...headers, "content-length": String(end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) },
  });
}
