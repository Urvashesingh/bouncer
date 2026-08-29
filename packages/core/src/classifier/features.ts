/**
 * Feature extraction for Tier 4 (SPEC §7).
 *
 * Feature vector = Tier 1-3 numeric signals + a hashed char-3gram bag
 * (2^14 dims, hashing trick).
 *
 * Training and inference MUST build vectors identically, so both go through
 * this module. A drift between the two is the classic silent failure mode for
 * a hand-rolled model: it trains fine and scores nonsense in production.
 */

import type { Detection, DigitRun, NormalizationSignals } from "../types.js";
import type { BookingStage, SenderRole } from "../types.js";

/** 2^14 dimensions for the hashed n-gram bag (SPEC §7). */
export const HASH_DIMS = 1 << 14;

/**
 * Named dense features, extracted from Tier 1-3 output.
 *
 * `riskScore` is deliberately ABSENT. Including it was target leakage: Tier 4
 * only ever sees messages Tier 3 placed in the escalation band, so riskScore
 * is bounded below by bands.low on every training row and every inference. The
 * trainer duly learned a large positive weight on it (4.86, against a bias of
 * +1.30), which alone drove the sigmoid to 1.0 for every input — the model
 * scored p=1.0000 on "thanks, see you on the 14th" and blocked 250 of the 256
 * band messages by reflex. Its reported 100% accuracy was the tautology
 * "escalated ⇒ violation", not a learned distinction.
 *
 * Tier 4 exists to bring INDEPENDENT evidence to messages Tier 3 could not
 * resolve. A feature that merely restates Tier 3's opinion cannot do that, and
 * actively prevents it. `digitPressure` is retained: it is conversation
 * context Tier 3 also uses, but it is not Tier 3's verdict.
 */
export const DENSE_FEATURES = [
  "validPhone",
  "partialPhone",
  "partialLength",
  "mixedForm",
  "noiseDigits",
  "weirdTokens",
  "intentChannel",
  "intentContact",
  "intentOffplatform",
  "intentPayment",
  "handle",
  "handleDigits",
  "upi",
  "email",
  "url",
  "riskyUrl",
  "zeroWidth",
  "confusables",
  "hostility",
  "extortion",
  "scamlink",
  "digitRunCount",
  "maxDigitRunLength",
  "totalDigits",
  "textLength",
  "digitRatio",
  "digitPressure",
  "isHost",
  "isPostBooking",
] as const;

export type DenseFeature = (typeof DENSE_FEATURES)[number];

export interface FeatureInput {
  detections: readonly Detection[];
  signals: NormalizationSignals;
  digitRuns: readonly DigitRun[];
  /** The folded view — what the n-gram bag is computed over. */
  text: string;
  weirdTokenCount: number;
  /**
   * Tier 3's score. Accepted for tracing and threshold work, but deliberately
   * NOT used as a feature — see the note on DENSE_FEATURES.
   */
  riskScore: number;
  digitPressure: number;
  role: SenderRole;
  stage: BookingStage;
}

/** Total feature-vector width: dense features then the hashed bag. */
export const FEATURE_DIMS = DENSE_FEATURES.length + HASH_DIMS;

/**
 * FNV-1a, 32-bit. Deterministic across platforms and JS engines, which matters
 * because trained weights are indexed by these hashes.
 */
export function hashString(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A sparse feature vector: index → value. Sparse because the hashed bag is
 * 16384-wide but a chat message touches only a few dozen buckets, so a dense
 * array would make both training and inference needlessly slow.
 */
export type SparseVector = Map<number, number>;

function countByPrefix(detections: readonly Detection[], prefix: string): number {
  return detections.filter((d) => d.type.startsWith(prefix)).length;
}

function hasType(detections: readonly Detection[], type: string): boolean {
  return detections.some((d) => d.type === type);
}

/** Extract the named dense features, in DENSE_FEATURES order. */
export function extractDense(input: FeatureInput): number[] {
  const { detections, signals, digitRuns } = input;

  const digitLengths = digitRuns.map((r) => r.digits.length);
  const maxRun = digitLengths.length > 0 ? Math.max(...digitLengths) : 0;
  const totalDigits = digitLengths.reduce((a, b) => a + b, 0);
  const textLength = input.text.length;

  const values: Record<DenseFeature, number> = {
    validPhone: hasType(detections, "contact.phone") || hasType(detections, "contact.phone.obfuscated") ? 1 : 0,
    partialPhone: countByPrefix(detections, "contact.phone.partial") > 0 ? 1 : 0,
    partialLength: maxRun / 10,
    mixedForm: digitRuns.filter((r) => r.mixedForm).length,
    noiseDigits: signals.noiseDigitsRemoved,
    weirdTokens: input.weirdTokenCount,
    intentChannel: countByPrefix(detections, "intent.channel"),
    intentContact: countByPrefix(detections, "intent.contact"),
    intentOffplatform: countByPrefix(detections, "intent.offplatform"),
    intentPayment: countByPrefix(detections, "intent.payment"),
    handle: countByPrefix(detections, "contact.handle") > 0 ? 1 : 0,
    handleDigits: hasType(detections, "contact.handle.embedded_digits") ? 1 : 0,
    upi: countByPrefix(detections, "payment.upi") > 0 ? 1 : 0,
    email: countByPrefix(detections, "contact.email") > 0 ? 1 : 0,
    url: countByPrefix(detections, "contact.url") > 0 ? 1 : 0,
    riskyUrl: detections.filter((d) => d.type.startsWith("contact.url.")).length,
    zeroWidth: signals.zeroWidthCount,
    confusables: signals.confusablesFolded,
    hostility: countByPrefix(detections, "safety.hostility") > 0 ? 1 : 0,
    extortion: countByPrefix(detections, "safety.extortion") > 0 ? 1 : 0,
    scamlink: countByPrefix(detections, "safety.scamlink") > 0 ? 1 : 0,
    digitRunCount: digitRuns.length,
    maxDigitRunLength: maxRun,
    totalDigits,
    // Length is logged: raw character counts swamp binary features otherwise.
    textLength: Math.log1p(textLength),
    digitRatio: textLength > 0 ? totalDigits / textLength : 0,
    digitPressure: input.digitPressure,
    isHost: input.role === "host" ? 1 : 0,
    isPostBooking: input.stage === "post_booking" ? 1 : 0,
  };

  return DENSE_FEATURES.map((name) => values[name]);
}

/**
 * Hashed character-3gram bag over the folded text (SPEC §7).
 *
 * Counts are L2-normalised so a long message does not simply outweigh a short
 * one — the classifier should key on WHICH n-grams appear, not how many.
 */
export function extractNgrams(text: string): SparseVector {
  const padded = ` ${text.toLowerCase()} `;
  const counts = new Map<number, number>();

  for (let i = 0; i + 3 <= padded.length; i++) {
    const trigram = padded.slice(i, i + 3);
    const index = hashString(trigram) % HASH_DIMS;
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }

  let norm = 0;
  for (const value of counts.values()) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return counts;

  const normalised: SparseVector = new Map();
  for (const [index, value] of counts) normalised.set(index, value / norm);
  return normalised;
}

/**
 * Build the full sparse feature vector.
 * Dense features occupy [0, DENSE_FEATURES.length); the hashed bag follows.
 */
export function extractFeatures(input: FeatureInput): SparseVector {
  const vector: SparseVector = new Map();

  const dense = extractDense(input);
  for (let i = 0; i < dense.length; i++) {
    const value = dense[i]!;
    if (value !== 0) vector.set(i, value);
  }

  const offset = DENSE_FEATURES.length;
  for (const [index, value] of extractNgrams(input.text)) {
    vector.set(offset + index, value);
  }

  return vector;
}
