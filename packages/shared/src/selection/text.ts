/** Text rules applied to LLM output after the model (SPEC §7.4, §8.2, §8.4). */

export const MAX_HOOK_WORDS = 7;
export const MAX_TITLE_CHARS = 70;
export const MAX_CAPTION_CHARS = 150;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function bannedRe(banned: string[]): RegExp | null {
  const terms = banned.map((b) => b.trim()).filter(Boolean);
  if (!terms.length) return null;
  // Word boundaries that also work for terms starting/ending with symbols (#tag, @handle).
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

/** Banned words/phrases found in `text` (case-insensitive, whole words). */
export function findBanned(text: string, banned: string[]): string[] {
  const re = bannedRe(banned);
  return re ? [...text.matchAll(re)].map((m) => m[0]) : [];
}

/** Remove banned words/phrases and tidy the leftover spacing/punctuation. */
export function stripBanned(text: string, banned: string[]): string {
  const re = bannedRe(banned);
  if (!re) return text;
  return text
    .replace(re, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** "THIS IS HUGE" → "This is huge" (keeps short acronyms like "AI" in mixed-case text). */
function fixAllCaps(s: string): string {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (letters.length < 4 || letters !== letters.toUpperCase()) return s;
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Normalize a hook; returns null if it breaks the rules (empty, > 7 words, banned word). */
export function cleanHook(raw: string | null | undefined, banned: string[]): string | null {
  if (!raw) return null;
  let h = raw.replace(EMOJI, "").replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").replace(/\s+/g, " ").trim();
  h = fixAllCaps(h).replace(/#\S+/g, "").trim();
  if (!h || wordCount(h) > MAX_HOOK_WORDS || findBanned(h, banned).length) return null;
  return h;
}

const hookKey = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
export function sameHook(a: string, b: string): boolean {
  const x = hookKey(a);
  const y = hookKey(b);
  return x === y || (x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x)));
}

/** Trim to `max` chars at a word boundary. */
export function clampText(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const i = cut.lastIndexOf(" ");
  return (i > max * 0.6 ? cut.slice(0, i) : t.slice(0, max)).replace(/[,;:\-–—\s]+$/, "");
}

/** First `n` words of a text, without trailing punctuation. */
export function firstWords(s: string, n: number): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, n)
    .join(" ")
    .replace(/[,;:\-–—.…]+$/, "");
}

/** Caption text: banned words removed, no hashtags (they're added separately), length-capped. */
export function cleanCaption(raw: string | null | undefined, banned: string[], max = MAX_CAPTION_CHARS): string {
  return clampText(stripBanned((raw ?? "").replace(EMOJI, " ").replace(/#[\p{L}\p{N}_]+/gu, ""), banned), max);
}

/** "#Money Tips" → "#moneytips"; drops generic spam tags and banned ones; 3–5 kept by the caller. */
const SPAM_TAGS = new Set(["fyp", "foryou", "foryoupage", "viral", "trending", "explore", "xyzbca", "fy", "reels", "shorts", "tiktok"]);
export function cleanHashtags(raw: string[] | null | undefined, banned: string[], max = 5): string[] {
  const out: string[] = [];
  for (const r of raw ?? []) {
    const tag = r.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase();
    if (!tag || SPAM_TAGS.has(tag) || findBanned(tag, banned).length || out.includes(`#${tag}`)) continue;
    out.push(`#${tag}`);
    if (out.length >= max) break;
  }
  return out;
}
