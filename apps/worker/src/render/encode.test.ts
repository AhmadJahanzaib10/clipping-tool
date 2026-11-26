import { beforeEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "@clip/shared";

const calls: string[][] = [];
let qsvWorks = true;
vi.mock("../proc", () => ({
  runProcess: vi.fn(async (_bin: string, args: string[]) => {
    calls.push(args);
    if (args.includes("h264_qsv") && !qsvWorks) throw new Error("ffmpeg exited with code 1: Error initializing output stream: h264_qsv");
    return { code: 0, stdout: "", stderr: "" };
  }),
}));

const { runEncode, preferredEncoder, resetEncoderState } = await import("./encode");
const env = envSchema.parse({ VIDEO_ENCODER: "h264_qsv" });
const build = (e: string) => ["-c:v", e, "out.mp4"];

beforeEach(() => {
  calls.length = 0;
  qsvWorks = true;
  resetEncoderState();
});

describe("QSV with libx264 fallback", () => {
  it("uses h264_qsv when it works", async () => {
    const r = await runEncode(env, build);
    expect(r).toMatchObject({ encoder: "h264_qsv", fellBack: false });
    expect(calls).toHaveLength(1);
  });

  it("re-runs with libx264 when QSV fails, and skips QSV afterwards", async () => {
    qsvWorks = false;
    const r = await runEncode(env, build);
    expect(r).toMatchObject({ encoder: "libx264", fellBack: true });
    expect(r.qsvError).toMatch(/h264_qsv/);
    expect(calls.map((c) => c[1])).toEqual(["h264_qsv", "libx264"]);
    expect(preferredEncoder(env)).toBe("libx264");
    await runEncode(env, build);
    expect(calls.at(-1)![1]).toBe("libx264");
  });

  it("VIDEO_ENCODER=libx264 never tries QSV", async () => {
    await runEncode(envSchema.parse({ VIDEO_ENCODER: "libx264" }), build);
    expect(calls.map((c) => c[1])).toEqual(["libx264"]);
  });
});
