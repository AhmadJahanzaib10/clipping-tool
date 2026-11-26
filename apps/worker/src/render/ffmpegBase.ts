import type { CropKeyframe, Plan, ZoomKeyframe } from "@clip/shared";

/**
 * RENDER_BASE (SPEC §7.8) as a pure FFmpeg argument builder.
 * section.mp4 → base.mp4: 1080×1920 at OUTPUT_FPS, timeline cuts applied (trim/atrim + concat), cold-open
 * flash, crop/zoom per plan, voice cleaned (highpass 80 Hz + gentle compressor). No captions, hook or SFX.
 */

export type VideoEncoder = "h264_qsv" | "libx264";
export const OUT_W = 1080;
export const OUT_H = 1920;

export interface EncodeOptions {
  encoder: VideoEncoder;
  threads: number;
  fps: number;
}

const n = (v: number, d = 3) => Number(v.toFixed(d)).toString();

/** Piecewise crop-x(t): linear between keyframes, a hard step into `jump` keyframes. */
export function cropXExpr(keyframes: CropKeyframe[]): string {
  const k = [...keyframes].sort((a, b) => a.t - b.t);
  if (!k.length) return "0";
  let expr = n(k[k.length - 1]!.x, 1);
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i]!;
    const b = k[i + 1]!;
    const seg = b.jump || b.x === a.x || b.t <= a.t ? n(a.x, 1) : `${n(a.x, 1)}+${n(b.x - a.x, 1)}*(t-${n(a.t)})/${n(b.t - a.t)}`;
    expr = `if(lt(t,${n(b.t)}),${seg},${expr})`;
  }
  return expr;
}

/** Zoom factor z(t) ≥ 1: smoothstep ease in over [start, peak], hold, ease out over [holdEnd, end]. */
export function zoomExpr(zooms: ZoomKeyframe[]): string {
  if (!zooms.length) return "1";
  const ease = (u: string) => `(${u})*(${u})*(3-2*(${u}))`;
  const terms = zooms.map((z) => {
    const up = ease(`(t-${n(z.start)})/${n(z.peak - z.start)}`);
    const down = ease(`(${n(z.end)}-t)/${n(z.end - z.holdEnd)}`);
    return `${n(z.scale - 1, 4)}*if(between(t,${n(z.start)},${n(z.end)}),if(lt(t,${n(z.peak)}),${up},if(lt(t,${n(z.holdEnd)}),1,${down})),0)`;
  });
  return `1+${terms.join("+")}`;
}

/** Encoder flags (SPEC §7.8 / §7.10 quality targets). */
export function videoEncoderArgs(o: EncodeOptions, pass: "base" | "compose"): string[] {
  if (o.encoder === "h264_qsv") return ["-c:v", "h264_qsv", "-global_quality", pass === "base" ? "18" : "23", "-preset", "medium"];
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", pass === "base" ? "17" : "21", "-pix_fmt", "yuv420p"];
}
/** Pixel format at the end of the filter graph: QSV wants nv12. */
export const finalFormat = (e: VideoEncoder) => (e === "h264_qsv" ? "nv12" : "yuv420p");

export function threadArgs(threads: number): string[] {
  return ["-threads", String(threads), "-filter_threads", String(threads), "-filter_complex_threads", String(threads)];
}

/** The picture chain for the plan's layout, from [vc] (concatenated source frames) to [vpic]. */
export function layoutChain(plan: Plan): string {
  const c = plan.crop;
  if (c.mode === "single") {
    const crop = `crop=w=${c.w}:h=${c.h}:x='${cropXExpr(c.keyframes)}':y=${c.y}`;
    if (!plan.zoom.length) return `[vc]${crop},scale=${OUT_W}:${OUT_H}:flags=bicubic[vpic]`;
    // Zoom inside the crop window (SPEC §7.7 step 5): scale up per frame, then cut the centre back out.
    const z = zoomExpr(plan.zoom);
    return `[vc]${crop},scale=w='trunc(${OUT_W}*(${z})/2)*2':h='trunc(${OUT_H}*(${z})/2)*2':eval=frame:flags=bicubic,crop=${OUT_W}:${OUT_H}:(iw-${OUT_W})/2:(ih-${OUT_H})/2[vpic]`;
  }
  if (c.mode === "split") {
    const half = OUT_H / 2;
    const r = (x: typeof c.top) => `crop=${x.w}:${x.h}:${x.x}:${x.y},scale=${OUT_W}:${half}:flags=bicubic`;
    return `[vc]split=2[vt0][vb0];[vt0]${r(c.top)}[vt1];[vb0]${r(c.bottom)}[vb1];[vt1][vb1]vstack=inputs=2[vpic]`;
  }
  // fit: whole frame over a blurred, zoomed copy of itself; blur computed at 1/4 resolution for speed.
  return (
    `[vc]split=2[vbg0][vfg0];` +
    `[vbg0]scale=${OUT_W / 4}:${OUT_H / 4}:force_original_aspect_ratio=increase,crop=${OUT_W / 4}:${OUT_H / 4},gblur=sigma=10,eq=brightness=-0.06,scale=${OUT_W}:${OUT_H}[vbg1];` +
    `[vfg0]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease:flags=bicubic[vfg1];` +
    `[vbg1][vfg1]overlay=(W-w)/2:(H-h)/2[vpic]`
  );
}

export function buildBaseArgs(i: { section: string; plan: Plan; out: string } & EncodeOptions): string[] {
  const { plan, fps } = i;
  const { width: W, height: H, sourceStart } = plan.section;
  const parts: string[] = [];
  const labels: string[] = [];
  plan.segments.forEach((seg, k) => {
    const dur = seg.outEnd - seg.outStart;
    if (seg.kind === "transition") {
      // Cold-open flash: white frames and silence (the whoosh comes from the SFX pass).
      parts.push(`color=c=white:s=${W}x${H}:r=${fps}:d=${n(dur)},format=yuv420p,setsar=1[v${k}]`);
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(dur)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${k}]`);
    } else {
      const a = seg.srcStart - sourceStart;
      const b = seg.srcEnd - sourceStart;
      parts.push(`[0:v]trim=start=${n(a)}:end=${n(b)},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p,setsar=1[v${k}]`);
      parts.push(`[0:a]atrim=start=${n(a)}:end=${n(b)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${k}]`);
    }
    labels.push(`[v${k}][a${k}]`);
  });
  parts.push(`${labels.join("")}concat=n=${plan.segments.length}:v=1:a=1[vc][ac]`);
  parts.push(layoutChain(plan));
  parts.push(`[vpic]format=${finalFormat(i.encoder)}[vout]`);
  // Voice clean-up (SPEC §7.8): rumble cut + gentle compression; loudness is set in COMPOSE.
  parts.push(`[ac]highpass=f=80,acompressor=threshold=0.1:ratio=2.5:attack=10:release=200:makeup=1.5[aout]`);
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-i", i.section,
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-r", String(fps),
    ...videoEncoderArgs(i, "base"),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    ...threadArgs(i.threads),
    "-t", n(plan.duration),
    "-movflags", "+faststart",
    i.out,
  ];
}

// ---------- loudness measurement (first loudnorm pass, cached for COMPOSE) ----------

export interface LoudnessMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export function measureLoudnessArgs(input: string, targetLufs: number): string[] {
  return ["-hide_banner", "-nostdin", "-nostats", "-i", input, "-vn", "-af", `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"];
}

/** The JSON block loudnorm prints on stderr at the end. */
export function parseLoudnorm(stderr: string): LoudnessMeasure | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
    if (!keys.every((k) => typeof j[k] === "string" && Number.isFinite(Number(j[k])))) return null;
    return Object.fromEntries(keys.map((k) => [k, j[k]])) as unknown as LoudnessMeasure;
  } catch {
    return null;
  }
}
