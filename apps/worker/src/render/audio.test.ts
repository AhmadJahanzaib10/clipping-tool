import { describe, expect, it } from "vitest";
import { extractAudioArgs, parseProbe, probeArgs } from "./audio";

describe("extractAudioArgs", () => {
  const args = extractAudioArgs("C:\\My Videos\\ep 1.mp4", "C:\\s\\audio.wav", "C:\\s\\audio.opus", 4);

  it("keeps paths with spaces as single argv entries", () => {
    expect(args).toContain("C:\\My Videos\\ep 1.mp4");
    expect(args[args.indexOf("-i") + 1]).toBe("C:\\My Videos\\ep 1.mp4");
  });

  it("never decodes video: audio-only map with -vn for both outputs", () => {
    expect(args.filter((a) => a === "-vn")).toHaveLength(2);
    expect(args.filter((a) => a === "0:a:0")).toHaveLength(2);
    expect(args.join(" ")).not.toMatch(/0:v/);
  });

  it("writes 16 kHz mono WAV and 32 kbps Opus", () => {
    const wavIdx = args.indexOf("C:\\s\\audio.wav");
    const opusIdx = args.indexOf("C:\\s\\audio.opus");
    const wavPart = args.slice(0, wavIdx).join(" ");
    const opusPart = args.slice(wavIdx + 1, opusIdx).join(" ");
    expect(wavPart).toMatch(/-ac 1 -ar 16000 -c:a pcm_s16le$/);
    expect(opusPart).toMatch(/-c:a libopus -b:a 32k/);
    expect(args.slice(0, 8)).toEqual(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-threads", "4", "-i"]);
  });
});

describe("probe", () => {
  it("builds JSON probe args", () => {
    expect(probeArgs("a b.mp4")).toEqual(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "a b.mp4"]);
  });

  it("parses duration, size and audio presence", () => {
    expect(
      parseProbe({
        format: { duration: "612.48", filename: "x" },
        streams: [
          { codec_type: "video", width: 1920, height: 1080 },
          { codec_type: "audio", sample_rate: "48000" },
        ],
      }),
    ).toEqual({ durationSec: 612.48, width: 1920, height: 1080, hasAudio: true });
    expect(parseProbe({ streams: [{ codec_type: "video", width: 640, height: 360 }] })).toEqual({
      durationSec: null,
      width: 640,
      height: 360,
      hasAudio: false,
    });
  });
});
