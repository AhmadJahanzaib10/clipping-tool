import type { ClipEdit, Plan, PlanWord } from "@clip/shared";

/**
 * Automatic SFX cues (SPEC §10.3), in output time.
 *
 * | Moment                        | Category            | subtle | normal    | heavy     |
 * | Hook appears (0.0 s)          | whoosh              |   ✓    |    ✓      |    ✓      |
 * | Cold-open → clip transition   | whoosh / transition |   ✓    |    ✓      |    ✓      |
 * | Emphasis word                 | pop                 |   –    | every 2nd | every one |
 * | Zoom punch-in                 | click               |   –    |    ✓      |    ✓      |
 * | Payoff line (end − ~3 s)      | impact              |   –    |    ✓      |    ✓      |
 * | Number/stat word              | ding                |   –    |    ✓      |    ✓      |
 * | Scene cut / jump cut          | transition          |   –    |    –      |    ✓      |
 *
 * Rules: ≥ 1.5 s between any two cues (heavy 1.0 s); never the same file twice in a row (random pick
 * within the category, seeded by clip id so re-renders are stable); never over the first 0.3 s of a
 * sentence's speech (shift into the gap before); gain = campaign gainDb + file defaultGainDb.
 */

export type Intensity = "off" | "subtle" | "normal" | "heavy";
export type SfxCue = ClipEdit["sfxCues"][number];

export interface LibrarySound {
  id: string;
  category: string;
  file: string;
  durationSec: number | null;
  defaultGainDb: number;
}

export interface PlannerInput {
  clipId: string;
  plan: Pick<Plan, "segments" | "duration" | "zoom" | "cuts">;
  words: PlanWord[];
  library: LibrarySound[];
  sfx: { intensity: Intensity; categories: string[]; gainDb: number };
  /** Cues placed by hand in the editor: kept as-is and respected by the spacing rule. */
  manual?: SfxCue[];
}

export const MIN_GAP_SEC = { off: 1.5, subtle: 1.5, normal: 1.5, heavy: 1.0 } as const;
export const SENTENCE_GUARD_SEC = 0.3;
/** Pull a cue this far before a sentence's first word when shifting it into the gap. */
const LEAD_SEC = 0.12;

type Moment = { t: number; categories: string[]; priority: number; reason: string; atZero?: boolean };

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NUMBER_WORDS = /^(hundred|thousand|million|millions|billion|billions|trillion|percent|percentage|half|double|triple|twice|dozen)$/i;
/** A token that *is* a number: "75,000", "$7", "40%", "2007", "4K", "3x", "1990s", "21st". */
const NUMERIC = /^[$€£]?\d[\d,.]*(%|k|m|bn|b|x|s|st|nd|rd|th)?$/i;
/** Numbers/stats ("75,000", "$7", "40%", "million") — not words that merely contain a digit ("B2B", "MP3"). */
export function isNumberWord(w: string): boolean {
  const t = w.replace(/^[^\p{L}\p{N}$€£]+|[^\p{L}\p{N}%]+$/gu, "");
  return NUMERIC.test(t) || NUMBER_WORDS.test(t);
}

/** First word of each sentence (after .?! or a pause ≥ 0.5 s, or the first word). */
export function sentenceStarts(words: PlanWord[]): number[] {
  return words.filter((w, i) => i === 0 || /[.?!…]["')\]]*$/.test(words[i - 1]!.w) || w.s - words[i - 1]!.e >= 0.5).map((w) => w.s);
}

/** Cue time adjusted so it doesn't land on the first 0.3 s of a sentence (moved into the gap before). */
export function avoidSentenceStart(t: number, words: PlanWord[], starts: number[]): number {
  const s = starts.find((x) => t >= x - 1e-6 && t < x + SENTENCE_GUARD_SEC);
  if (s === undefined) return t;
  const prev = [...words].reverse().find((w) => w.e <= s + 1e-6 && w.s < s - 1e-6);
  const gapStart = prev ? prev.e : 0;
  return Math.max(gapStart, s - LEAD_SEC);
}

function moments(i: PlannerInput): Moment[] {
  const { intensity } = i.sfx;
  const m: Moment[] = [];
  const main = i.words.filter((w) => !w.teaser);
  const level = { subtle: 1, normal: 2, heavy: 3, off: 0 }[intensity];

  m.push({ t: 0, categories: ["whoosh"], priority: 100, reason: "hook", atZero: true });
  const transition = i.plan.segments.find((s) => s.kind === "transition");
  if (transition) m.push({ t: transition.outStart, categories: ["whoosh", "transition"], priority: 90, reason: "cold open → clip" });
  if (level >= 2) {
    // Payoff: start of the last sentence that begins in the final ~5 s, else the word nearest end − 3 s.
    const starts = sentenceStarts(main);
    const late = starts.filter((t) => t >= i.plan.duration - 5 && t <= i.plan.duration - 1.5);
    const target = i.plan.duration - 3;
    const payoff = late.length ? late[late.length - 1]! : main.reduce<number | null>((best, w) => (best === null || Math.abs(w.s - target) < Math.abs(best - target) ? w.s : best), null);
    if (payoff !== null && payoff > 0.5) m.push({ t: payoff, categories: ["impact"], priority: 80, reason: "payoff" });
    for (const w of main.filter((x) => isNumberWord(x.w))) m.push({ t: w.s, categories: ["ding"], priority: 70, reason: `number "${w.w}"` });
    const emph = main.filter((w) => w.emphasis);
    emph.forEach((w, k) => {
      if (level === 3 || k % 2 === 0) m.push({ t: w.s, categories: ["pop"], priority: 60, reason: `emphasis "${w.w}"` });
    });
    for (const z of i.plan.zoom) m.push({ t: z.start, categories: ["click"], priority: 50, reason: "zoom" });
  }
  if (level === 3) {
    for (const c of i.plan.cuts) if (!transition || Math.abs(c - transition.outEnd) > 0.05) m.push({ t: c, categories: ["transition"], priority: 40, reason: "cut" });
  }
  return m;
}

export interface PlannedCue extends SfxCue {
  category: string;
  reason: string;
}

/** Plan the automatic cues for a clip. Manual cues are not returned (the caller keeps them). */
export function planSfx(i: PlannerInput): PlannedCue[] {
  if (i.sfx.intensity === "off") return [];
  const allowed = new Set(i.sfx.categories.map((c) => c.toLowerCase()));
  const byCat = new Map<string, LibrarySound[]>();
  for (const s of i.library) {
    if (!allowed.has(s.category)) continue;
    byCat.set(s.category, [...(byCat.get(s.category) ?? []), s]);
  }
  const gap = MIN_GAP_SEC[i.sfx.intensity];
  const starts = sentenceStarts(i.words);
  const manual = i.manual ?? [];

  // 1. Choose times: highest priority first; each must keep the minimum gap to everything accepted.
  const taken: { t: number; categories: string[]; reason: string }[] = [];
  const occupied = () => [...manual.map((c) => c.at), ...taken.map((x) => x.t)];
  for (const mo of moments(i).sort((a, b) => b.priority - a.priority || a.t - b.t)) {
    const cats = mo.categories.filter((c) => byCat.has(c));
    if (!cats.length) continue;
    const t = mo.atZero ? 0 : avoidSentenceStart(mo.t, i.words, starts);
    if (t < 0 || t > i.plan.duration - 0.2) continue;
    if (occupied().some((x) => Math.abs(x - t) < gap - 1e-9)) continue;
    taken.push({ t, categories: cats, reason: mo.reason });
  }

  // 2. Choose files in time order: seeded random within the category, never the file just used.
  const rnd = seededRandom(i.clipId);
  const out: PlannedCue[] = [];
  type Item = { t: number; categories: string[]; reason: string; manual: boolean; sfxId?: string };
  const timeline: Item[] = [
    ...taken.map((x) => ({ ...x, manual: false })),
    ...manual.map((c) => ({ t: c.at, categories: [], reason: "manual", manual: true, sfxId: c.sfxId })),
  ].sort((a, b) => a.t - b.t);
  let prevFile: string | null = null;
  let n = 0;
  for (let k = 0; k < timeline.length; k++) {
    const item = timeline[k]!;
    if (item.manual) {
      prevFile = item.sfxId ?? null;
      continue;
    }
    // Neighbours on both sides: the cue before, and a manual cue right after (its file is fixed).
    const next = timeline[k + 1];
    const nextFile = next?.manual ? (next.sfxId ?? null) : null;
    const pool = item.categories.flatMap((c) => byCat.get(c)!.map((s) => ({ s, c })));
    const options = pool.filter((p) => p.s.id !== prevFile && p.s.id !== nextFile);
    if (!options.length) continue; // only the file just used is available: skip rather than repeat
    const pick = options[Math.floor(rnd() * options.length)]!;
    prevFile = pick.s.id;
    out.push({
      id: `auto-${++n}`,
      sfxId: pick.s.id,
      at: Math.round(item.t * 1000) / 1000,
      gainDb: Math.round((i.sfx.gainDb + pick.s.defaultGainDb) * 10) / 10,
      source: "auto",
      category: pick.c,
      reason: item.reason,
    });
  }
  return repairRepeats(out, manual, byCat, rnd);
}

/**
 * Final guarantee on the real sequence (auto + manual cues): no file twice in a row. Skipped cues can make
 * two cues neighbours that never saw each other during assignment; swap the auto one to another file of its
 * category, or drop it if there is none (dropping only widens gaps, so spacing still holds).
 */
function repairRepeats(cues: PlannedCue[], manual: SfxCue[], byCat: Map<string, LibrarySound[]>, rnd: () => number): PlannedCue[] {
  let out = [...cues];
  for (let guard = 0; guard < 100; guard++) {
    const seq: (SfxCue & { auto?: PlannedCue })[] = [...out.map((c) => ({ ...c, auto: c })), ...manual].sort((a, b) => a.at - b.at);
    const k = seq.findIndex((c, i) => i > 0 && c.sfxId === seq[i - 1]!.sfxId);
    if (k < 0) return out;
    const victim = seq[k]!.auto ?? seq[k - 1]!.auto;
    if (!victim) return out; // two manual cues: the editor's choice
    const vi = seq.findIndex((c) => c.auto === victim);
    const avoid = new Set([seq[vi - 1]?.sfxId, seq[vi + 1]?.sfxId]);
    const alt = (byCat.get(victim.category) ?? []).filter((s) => !avoid.has(s.id));
    if (alt.length) {
      const pick = alt[Math.floor(rnd() * alt.length)]!;
      out = out.map((c) => (c === victim ? { ...c, sfxId: pick.id, gainDb: Math.round((c.gainDb - (byCat.get(victim.category)!.find((s) => s.id === victim.sfxId)?.defaultGainDb ?? 0) + pick.defaultGainDb) * 10) / 10 } : c));
    } else {
      out = out.filter((c) => c !== victim);
    }
  }
  return out;
}
