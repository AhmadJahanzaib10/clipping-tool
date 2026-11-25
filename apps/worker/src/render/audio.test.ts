import { describe, expect, it } from "vitest";
import { cutSectionArgs, extractAudioArgs, parseProbe, probeArgs } from "./audio";

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
          { codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
          { codec_type: "audio", sample_rate: "48000" },
        ],
      }),
    ).toEqual({ durationSec: 612.48, width: 1920, height: 1080, hasAudio: true, hasVideo: true, fps: 29.97 });
    expect(parseProbe({ streams: [{ codec_type: "video", width: 640, height: 360 }] })).toEqual({
      durationSec: null,
      width: 640,
      height: 360,
      hasAudio: false,
      hasVideo: true,
      fps: null,
    });
  });

  it("audio-only files (even with cover art) report no video", () => {
    const p = parseProbe({
      format: { duration: "3966.7" },
      streams: [
        { codec_type: "audio", codec_name: "opus" },
        { codec_type: "video", codec_name: "mjpeg", width: 300, height: 300, disposition: { attached_pic: 1 } },
      ],
    });
    expect(p).toMatchObject({ hasAudio: true, hasVideo: false, width: null });
  });
});

describe("cutSectionArgs", () => {
  const a = cutSectionArgs("D:\My Vids\full.mp4", 118.25, 49.5, "C:\s\section.mp4");
  it("seeks on the input and stream-copies (no re-encode)", () => {
    expect(a.slice(a.indexOf("-ss"), a.indexOf("-ss") + 4)).toEqual(["-ss", "118.250", "-i", "D:\My Vids\full.mp4"]);
    expect(a[a.indexOf("-t") + 1]).toBe("49.500");
    expect(a[a.indexOf("-c") + 1]).toBe("copy");
    expect(a).not.toContain("libx264");
    expect(a.at(-1)).toBe("C:\s\section.mp4");
  });
  it("keeps one video and the first audio stream, clamps negative starts", () => {
    expect(a.filter((x) => x === "-map")).toHaveLength(2);
    expect(a).toContain("0:a:0?");
    expect(cutSectionArgs("x", -1.2, 10, "y")[cutSectionArgs("x", -1.2, 10, "y").indexOf("-ss") + 1]).toBe("0.000");
  });
});
