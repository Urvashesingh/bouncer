/**
 * Weirdness meter (SPEC §5) — THE differentiator.
 *
 * A character-trigram language model as a plain lookup table. No ML framework,
 * no native deps: scoring a token is a handful of map lookups.
 *
 * Why it matters: rules chase known tricks. This flags text whose CHARACTER
 * SHAPE is improbable, so it catches mangling styles that do not exist yet —
 * "a121ksh35ay" is astronomically unlikely under a model of real chat, without
 * anyone having written a rule for that particular trick.
 *
 * The model is injected, never loaded from disk here: core does no fs I/O
 * (SPEC §1).
 */

export interface TrigramModel {
  /** log P(trigram), add-one smoothed. */
  logProbs: Record<string, number>;
  /** log P for a trigram never seen in training. */
  unseenLogProb: number;
  /** Calibrated cutoff — the 99.5th percentile of legitimate token scores. */
  threshold: number;
  /** Provenance, printed by the benchmark (SPEC §5). */
  meta: {
    trainedOn: number;
    distinctTrigrams: number;
    percentile: number;
    /** Score distribution of legit tokens, for the calibration table. */
    percentiles?: Record<string, number>;
  };
}

/** SPEC §5: score alphabetic tokens of length ≥ 4. */
export const MIN_TOKEN_LENGTH = 4;

export interface TokenScore {
  token: string;
  /** Score of the token as written. */
  score: number;
  /** Score of the letters-only projection (digits/punctuation removed). */
  lettersOnlyScore: number | null;
  /** True when `score` exceeds the model threshold. */
  weird: boolean;
}

export interface MessageWeirdness {
  /**
   * Max token score in the message (SPEC §5).
   *
   * NOTE for Tier 3: prefer `weirdTokenCount` as the risk feature. `score` is
   * the raw max and can be high for legitimate text — "256gb" alone scores
   * 12.8 — because the digit-position rule that clears such tokens is applied
   * per token, not to this maximum.
   */
  score: number;
  /** How many tokens were judged weird. The reliable signal for scoring. */
  weirdTokenCount: number;
  /** Per-token detail, for the playground trace panel. */
  tokens: TokenScore[];
}

/**
 * Score a single token: the negative mean log-probability of its trigrams.
 * Higher = weirder. Padding marks word boundaries so "xz" at the start of a
 * token is penalised the way it should be.
 */
export function scoreToken(token: string, model: TrigramModel): number {
  const padded = ` ${token} `;
  if (padded.length < 3) return 0;

  let total = 0;
  let count = 0;
  for (let i = 0; i + 3 <= padded.length; i++) {
    const trigram = padded.slice(i, i + 3);
    total += model.logProbs[trigram] ?? model.unseenLogProb;
    count++;
  }

  return count === 0 ? 0 : -(total / count);
}

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
const HAS_LETTER = /\p{L}/u;

/**
 * Score a whole message.
 *
 * SPEC §5: each token is scored BOTH as written and on its letters-only
 * projection. A mangled token like "a121ksh35ay" is improbable as written even
 * though its projection ("akshay") is perfectly ordinary — reporting the max
 * of the two is what makes the mangling itself the signal.
 */
export function messageWeirdness(text: string, model: TrigramModel): MessageWeirdness {
  const tokens: TokenScore[] = [];

  for (const rawToken of text.toLowerCase().split(TOKEN_SPLIT)) {
    if (rawToken.length < MIN_TOKEN_LENGTH) continue;
    // Purely numeric tokens are prices, PINs and dates — not this detector's job.
    if (!HAS_LETTER.test(rawToken)) continue;

    const score = scoreToken(rawToken, model);

    const lettersOnly = rawToken.replace(/[^\p{L}]/gu, "");
    const lettersOnlyScore =
      lettersOnly.length >= MIN_TOKEN_LENGTH && lettersOnly !== rawToken
        ? scoreToken(lettersOnly, model)
        : null;

    tokens.push({
      token: rawToken,
      score,
      lettersOnlyScore,
      weird: isWeird(rawToken, score, lettersOnlyScore, model),
    });
  }

  const weirdTokenCount = tokens.filter((t) => t.weird).length;
  // SPEC §5: message weirdness is the max token score.
  const score = tokens.reduce((max, t) => Math.max(max, t.score), 0);

  return { score, weirdTokenCount, tokens };
}

/** Digits sitting between letters, e.g. "a92m", "a121ksh35ay". */
const INTERLEAVED_DIGITS = /\p{L}\d+\p{L}/u;

/**
 * Decide whether a token is weird.
 *
 * The raw score alone over-fires: ordinary product codes and passwords
 * ("256gb", "6e2134", "sunshine2024") are improbable as character sequences
 * but perfectly legitimate — and SPEC §10 lists them as hard negatives.
 *
 * The structural tell is WHERE the digits sit. Legitimate alphanumerics carry
 * their digits at a boundary; deliberate mangling interleaves them between
 * letters, which is the same fact Tier 1's denoiser measures. So:
 *
 *   - digits interleaved  → judge the RAW form. "a121ksh35ay" (13.7) is weird
 *     even though its projection "akshay" (7.7) is not. The mangling IS the
 *     signal, exactly as SPEC §5 requires.
 *   - digits at a boundary → judge the LETTERS-ONLY projection, so "256gb" is
 *     scored on "gb" and stays quiet.
 *   - no digits → judge the raw form.
 */
function isWeird(
  token: string,
  score: number,
  lettersOnlyScore: number | null,
  model: TrigramModel,
): boolean {
  if (INTERLEAVED_DIGITS.test(token)) return score > model.threshold;

  const hasDigits = /\d/.test(token);
  if (!hasDigits) return score > model.threshold;

  // Boundary digits, and the letters-only projection is long enough to judge.
  if (lettersOnlyScore !== null) return lettersOnlyScore > model.threshold;

  // Boundary digits with a projection too short to score ("256gb" → "gb").
  // Absence of evidence is not evidence of weirdness: the raw form of any
  // short unit-suffixed token is improbable, so judging it here would flag
  // every "256GB" and "700m" in the corpus.
  return false;
}

/**
 * Percentile of a sorted numeric array (linear interpolation).
 * Exported because the trainer and the benchmark both calibrate with it.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (rank - low) * (sorted[high]! - sorted[low]!);
}
