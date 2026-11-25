import { z } from "zod";
import type { ClipScores } from "../schemas/clip";

/** SPEC §8.3 default weights (stored in settings as "scoreWeights"). */
export const DEFAULT_SCORE_WEIGHTS = {
  hook: 0.3,
  standalone: 0.2,
  payoff: 0.2,
  emotion: 0.1,
  novelty: 0.1,
  quotability: 0.1,
} as const satisfies ClipScores;

export const scoreWeightsSchema = z.object({
  hook: z.number().min(0),
  standalone: z.number().min(0),
  payoff: z.number().min(0),
  emotion: z.number().min(0),
  novelty: z.number().min(0),
  quotability: z.number().min(0),
});
export type ScoreWeights = z.infer<typeof scoreWeightsSchema>;

/** final = Σ weight × score (0–10) × 10 → 0–100. Weights are normalized so they need not sum to 1. */
export function finalScore(s: ClipScores, w: ScoreWeights = DEFAULT_SCORE_WEIGHTS): number {
  const keys = Object.keys(DEFAULT_SCORE_WEIGHTS) as (keyof ClipScores)[];
  const total = keys.reduce((n, k) => n + w[k], 0);
  if (total <= 0) return 0;
  const v = keys.reduce((n, k) => n + w[k] * Math.min(10, Math.max(0, s[k])), 0) / total;
  return Math.round(v * 10 * 10) / 10;
}
