import type { ClipEdit, PlanWord } from "@clip/shared";

/**
 * ASS captions (SPEC §7.9) for a 1080×1920 frame.
 *  - lines of 2–3 words (break on punctuation or > 0.35 s gap), max ~16 characters
 *  - safe zones: captions centred between 58–68 % of the height (split: on the seam), hook 12–22 %,
 *    nothing in the bottom 20 % or the right 12 %
 *  - active word in the preset colour; emphasis words in an accent colour with a 115 % pop easing back
 *    over 120 ms; hook 0.0–2.8 s (max 2 lines, pop-in); hidden words skipped, edited words keep timing
 */

export const FRAME_W = 1080;
export const FRAME_H = 1920;
export const SAFE = {
  left: Math.round(FRAME_W * 0.06),
  right: Math.round(FRAME_W * 0.88), // nothing right of this (platform buttons)
  bottom: Math.round(FRAME_H * 0.8), // nothing below this (platform captions)
  captionCenterY: Math.round(FRAME_H * 0.63),
  captionBand: [Math.round(FRAME_H * 0.58), Math.round(FRAME_H * 0.68)] as const,
  hookBand: [Math.round(FRAME_H * 0.12), Math.round(FRAME_H * 0.22)] as const,
};
export const SAFE_CENTER_X = Math.round((SAFE.left + SAFE.right) / 2);
export const MAX_TEXT_W = SAFE.right - SAFE.left;

export const MAX_LINE_WORDS = 3;
export const MAX_LINE_CHARS = 16;
export const LINE_GAP_SEC = 0.35;
export const HOOK_END_SEC = 2.8;
export const POP_MS = 120;

/** ASS colour &HAABBGGRR from #RRGGBB and opacity (1 = opaque). */
export function assColor(hex: string, opacity = 1): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  const a = Math.round((1 - opacity) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

export interface Preset {
  font: string;
  size: number;
  bold: boolean;
  text: string;
  active: string;
  accent: string;
  /** 1 = outline + shadow, 3 = opaque box. */
  borderStyle: 1 | 3;
  outline: number;
  shadow: number;
  outlineColor: string;
  back: string;
  /** Average glyph width as a fraction of the font size (for layout estimates). */
  charW: number;
  uppercase: boolean;
}

export const PRESETS: Record<string, Preset> = {
  // Montserrat ExtraBold 80 px, white, yellow active word, 6 px black outline.
  "bold-yellow": {
    font: "Montserrat ExtraBold",
    size: 80,
    bold: false,
    text: assColor("#FFFFFF"),
    active: assColor("#FFD400"),
    accent: assColor("#4ADE80"),
    borderStyle: 1,
    outline: 6,
    shadow: 0,
    outlineColor: assColor("#000000"),
    back: assColor("#000000", 0),
    charW: 0.5, // measured ≈ 0.43 em/char in caps (margin kept)
    uppercase: true,
  },
  // Inter Bold 64 px, white on a 70 % black box.
  "white-box": {
    font: "Inter",
    size: 64,
    bold: true,
    text: assColor("#FFFFFF"),
    active: assColor("#FFD400"),
    accent: assColor("#4ADE80"),
    borderStyle: 3,
    outline: 14,
    shadow: 0,
    outlineColor: assColor("#000000", 0.7),
    back: assColor("#000000", 0.7),
    charW: 0.5,
    uppercase: false,
  },
  // Inter Bold 68 px, white, soft shadow.
  "clean-white": {
    font: "Inter",
    size: 68,
    bold: true,
    text: assColor("#FFFFFF"),
    active: assColor("#FFE066"),
    accent: assColor("#7DD3FC"),
    borderStyle: 1,
    outline: 1.5,
    shadow: 4,
    outlineColor: assColor("#000000", 0.6),
    back: assColor("#000000", 0.5),
    charW: 0.5,
    uppercase: false,
  },
};

/**
 * Hook text. Sizes calibrated by rendering with libass and measuring pixels: Montserrat ExtraBold is
 * ≈ 0.38 em per character in mixed case (0.42 used, with margin) and a line is ≈ 1.0 × the font size tall
 * (1.05 used). Two lines use a smaller size so the block fits the 12–22 % band (192 px).
 */
export const HOOK_STYLE = { font: "Montserrat ExtraBold", size: 92, twoLineSize: 76, pad: 16, charW: 0.42, lineH: 1.05, maxLineChars: 20 };

export interface AssInput {
  words: PlanWord[];
  edit: Pick<ClipEdit, "captionPreset" | "wordEdits" | "emphasisWords">;
  hook: string;
  hookStyle: "top-banner" | "center-pop";
  layout: "single" | "split" | "fit";
  duration: number;
  showNameOnScreen?: string;
}

/** Text box estimate for safe-zone checks (pixels, 1080×1920). */
export interface Box {
  kind: "caption" | "hook" | "name";
  start: number;
  end: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
}

export interface CaptionLine {
  words: { text: string; s: number; e: number; emphasis: boolean }[];
  start: number;
  end: number;
}

const clean = (s: string) => s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
const endsPunct = (w: string) => /[.,!?;:…—–]["')\]]*$/.test(w);

/** Apply word edits (hide / replace text, keep timing) and drop empty words. */
export function captionWords(words: PlanWord[], edits: ClipEdit["wordEdits"], emphasis: string[]) {
  const byIndex = new Map(edits.map((e) => [e.index, e]));
  const emph = new Set(emphasis.map((e) => e.toLowerCase()));
  return words
    .map((w) => {
      const e = byIndex.get(w.i);
      if (e?.hidden) return null;
      const text = clean(e?.text ?? w.w);
      if (!text) return null;
      const key = text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
      return { text, s: w.s, e: w.e, emphasis: Boolean(w.emphasis) || emph.has(key) };
    })
    .filter((w): w is NonNullable<typeof w> => w !== null);
}

/** Group words into caption lines (2–3 words, ≤ 16 chars, break on punctuation or a > 0.35 s gap). */
export function buildLines(words: ReturnType<typeof captionWords>): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let cur: CaptionLine["words"] = [];
  const flush = () => {
    if (cur.length) lines.push({ words: cur, start: cur[0]!.s, end: cur[cur.length - 1]!.e });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= MAX_LINE_WORDS || chars > MAX_LINE_CHARS || w.s - prev.e > LINE_GAP_SEC || endsPunct(prev.text))) flush();
    cur.push(w);
  }
  flush();
  // Keep each line up a little after its last word: until the next line if that is close (no flicker),
  // otherwise 0.3 s more, never overlapping the next line.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const next = lines[i + 1];
    if (!next) l.end += 0.4;
    else if (next.start - l.end <= 0.3) l.end = next.start;
    else l.end = Math.min(l.end + 0.3, next.start);
  }
  return lines;
}

const ts = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** Split a hook into ≤ 2 lines of ≤ maxChars each. */
export function wrapHook(hook: string, maxChars = HOOK_STYLE.maxLineChars): string[] {
  const words = clean(hook).split(" ").filter(Boolean);
  if (words.join(" ").length <= maxChars) return [words.join(" ")];
  let best: string[] = [words.join(" ")];
  let bestDiff = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(" ");
    const b = words.slice(k).join(" ");
    const over = Math.max(0, a.length - maxChars) + Math.max(0, b.length - maxChars);
    const diff = over * 100 + Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [a, b];
    }
  }
  return best;
}

/** Estimated text width (px) at a font size. */
const width = (text: string, size: number, charW: number) => text.length * size * charW;

export function buildAss(i: AssInput): { ass: string; boxes: Box[]; lines: CaptionLine[] } {
  const p = PRESETS[i.edit.captionPreset] ?? PRESETS["bold-yellow"]!;
  const words = captionWords(i.words, i.edit.wordEdits, i.edit.emphasisWords);
  const lines = buildLines(words);
  const cy = i.layout === "split" ? FRAME_H / 2 : SAFE.captionCenterY;
  const lineH = p.size * 1.25 + (p.borderStyle === 3 ? p.outline * 2 : p.outline * 2);
  const boxes: Box[] = [];
  const events: string[] = [];
  const up = (s: string) => (p.uppercase ? s.toUpperCase() : s);

  for (const line of lines) {
    const text = line.words.map((w) => up(w.text)).join(" ");
    // Shrink the whole line if it would leave the safe width (incl. the emphasis pop).
    const est = width(text, p.size, p.charW) * (line.words.some((w) => w.emphasis) ? 1.08 : 1);
    const fit = Math.min(100, Math.floor((MAX_TEXT_W / Math.max(1, est)) * 100));
    const scaleTag = fit < 100 ? `\\fscx${fit}\\fscy${fit}` : "";
    const w = (est * fit) / 100;
    boxes.push({ kind: "caption", start: line.start, end: line.end, x0: SAFE_CENTER_X - w / 2, x1: SAFE_CENTER_X + w / 2, y0: cy - lineH / 2, y1: cy + lineH / 2, text });

    line.words.forEach((active, k) => {
      const start = k === 0 ? line.start : active.s;
      const end = k + 1 < line.words.length ? line.words[k + 1]!.s : line.end;
      if (end - start < 0.01) return;
      const parts = line.words.map((x, j) => {
        const color = j === k ? (x.emphasis ? p.accent : p.active) : x.emphasis ? p.accent : p.text;
        if (j === k && x.emphasis) {
          // Emphasis pop: 115 % easing back over 120 ms, then the line's own scale for the following words.
          const big = Math.round(115 * (fit / 100));
          return `{\\c${color}\\fscx${big}\\fscy${big}\\t(0,${POP_MS},\\fscx${fit}\\fscy${fit})}${up(x.text)}{\\fscx${fit}\\fscy${fit}}`;
        }
        return `{\\c${color}}${up(x.text)}`;
      });
      events.push(`Dialogue: 1,${ts(start)},${ts(end)},Caption,,0,0,0,,{\\an5\\pos(${SAFE_CENTER_X},${Math.round(cy)})${scaleTag}}${parts.join(" ")}`);
    });
  }

  // Hook (0.0–2.8 s): top banner or centre pop, inside 12–22 % of the height.
  const hookLines = wrapHook(i.hook);
  if (hookLines[0]) {
    const end = Math.min(HOOK_END_SEC, i.duration);
    const size = hookLines.length > 1 ? HOOK_STYLE.twoLineSize : HOOK_STYLE.size;
    const widest = Math.max(...hookLines.map((l) => width(l, size, HOOK_STYLE.charW)));
    const fit = Math.min(100, Math.floor(((MAX_TEXT_W - 2 * HOOK_STYLE.pad) / widest) * 100));
    const lh = size * HOOK_STYLE.lineH;
    const blockH = hookLines.length * lh * (fit / 100) + 2 * HOOK_STYLE.pad;
    const cyHook = Math.round((SAFE.hookBand[0] + SAFE.hookBand[1]) / 2);
    const anim = i.hookStyle === "center-pop" ? `\\fscx${Math.round(fit * 0.6)}\\fscy${Math.round(fit * 0.6)}\\t(0,180,\\fscx${fit}\\fscy${fit})` : `\\fscx${fit}\\fscy${fit}\\fad(120,180)`;
    events.push(`Dialogue: 2,${ts(0)},${ts(end)},${i.hookStyle === "center-pop" ? "HookPop" : "HookBanner"},,0,0,0,,{\\an5\\pos(${SAFE_CENTER_X},${cyHook})\\fs${size}${anim}}${hookLines.join("\\N")}`);
    const w = (widest * fit) / 100 + 2 * HOOK_STYLE.pad;
    boxes.push({ kind: "hook", start: 0, end, x0: SAFE_CENTER_X - w / 2, x1: SAFE_CENTER_X + w / 2, y0: cyHook - blockH / 2, y1: cyHook + blockH / 2, text: hookLines.join(" / ") });
  }

  // Optional name label, small, at the top (above the hook).
  if (i.showNameOnScreen?.trim()) {
    const name = clean(i.showNameOnScreen).slice(0, 40);
    const y = Math.round(FRAME_H * 0.075);
    events.push(`Dialogue: 0,${ts(0)},${ts(i.duration)},Name,,0,0,0,,{\\an5\\pos(${SAFE_CENTER_X},${y})}${name}`);
    const w = width(name, 40, 0.6);
    boxes.push({ kind: "name", start: 0, end: i.duration, x0: SAFE_CENTER_X - w / 2, x1: SAFE_CENTER_X + w / 2, y0: y - 30, y1: y + 30, text: name });
  }

  const style = (name: string, font: string, size: number, primary: string, outlineColor: string, back: string, bold: boolean, borderStyle: number, outline: number, shadow: number) =>
    `Style: ${name},${font},${size},${primary},${primary},${outlineColor},${back},${bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},5,0,0,0,1`;
  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${FRAME_W}`,
    `PlayResY: ${FRAME_H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style("Caption", p.font, p.size, p.text, p.outlineColor, p.back, p.bold, p.borderStyle, p.outline, p.shadow),
    style("HookBanner", HOOK_STYLE.font, HOOK_STYLE.size, assColor("#FFFFFF"), assColor("#111111", 0.85), assColor("#111111", 0.85), false, 3, HOOK_STYLE.pad, 0),
    style("HookPop", HOOK_STYLE.font, HOOK_STYLE.size, assColor("#FFFFFF"), assColor("#000000"), assColor("#000000", 0), false, 1, 7, 0),
    style("Name", "Inter", 40, assColor("#FFFFFF"), assColor("#000000", 0.6), assColor("#000000", 0), true, 1, 3, 0),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
  return { ass, boxes, lines };
}

/** SRT of the caption lines (for the "Download clean version" bundle, SPEC §11). */
export function buildSrt(lines: CaptionLine[], uppercase = false): string {
  const t = (sec: number) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return lines.map((l, i) => `${i + 1}\n${t(l.start)} --> ${t(l.end)}\n${l.words.map((w) => (uppercase ? w.text.toUpperCase() : w.text)).join(" ")}\n`).join("\n");
}
