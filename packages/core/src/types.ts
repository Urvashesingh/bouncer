/**
 * Core type contract for the Bouncer engine.
 * Mirrors the public API in SPEC §2 and the normalizer output in SPEC §3.
 */

export type SenderRole = "guest" | "host";
export type BookingStage = "pre_booking" | "post_booking";
export type Mode = "sync" | "async";

export type Verdict = "allow" | "warn" | "mask" | "block" | "review";

export type ResolvedBy =
  | "tier1.normalize"
  | "tier2.phone"
  | "tier2.email"
  | "tier2.url"
  | "tier2.handle"
  | "tier2.upi"
  | "tier2.intent"
  | "tier2.safety"
  | "tier3.risk"
  | "tier4.classifier"
  | "tier5.llm"
  | "cache";

/** Dot-delimited category, e.g. "contact.phone.obfuscated", "intent.offplatform". */
export type Category = string;

export interface Span {
  start: number;
  end: number;
  type: Category;
  masked?: string;
}

// ---------------------------------------------------------------------------
// Tier 1 — normalization
// ---------------------------------------------------------------------------

/** How a chunk of a digit run was written in the source text. */
export type DigitForm = "numeral" | "word";

/** Separator characters observed between merged digit chunks. */
export type SeparatorType = "space" | "dash" | "dot" | "underscore" | "comma" | "colon" | "semicolon" | "none";

export interface DigitRun {
  /** The recovered digit string, e.g. "98760". */
  digits: string;
  /** Span into the view the run was extracted from. */
  sourceSpan: { start: number; end: number };
  /** How many contributing chunks were spelled as number-words. */
  wordFormCount: number;
  /** How many contributing chunks were written as numerals. */
  numeralCount: number;
  /** Distinct separators seen while merging adjacent chunks. */
  separatorTypes: SeparatorType[];
  /**
   * True when words and numerals are interleaved ("nine eight 7 six zero").
   * Per SPEC §3.6 this almost never occurs in legit text → high-weight signal.
   */
  mixedForm: boolean;
}

export interface NormalizedViews {
  raw: string;
  /** NFKC + zero-width/bidi stripped. */
  nfkc: string;
  /** + confusable folding + lowercase. */
  folded: string;
  /** + leet map, applied in LETTER context only (SPEC §3 "Leet note"). */
  deleet: string;
  /** + token-level noise strip. The benchmark killer (SPEC §3.4). */
  denoised: string;
  /** + number-words expanded to digits, separators unified. */
  digitized: string;
  /** Candidate digit sequences with provenance. Spans are RAW offsets. */
  digitRuns: DigitRun[];
  /**
   * Maps a `denoised` index back to its index in `raw`. Detector spans found
   * on the denoised view must be translated through this before they are used
   * to mask the original message.
   */
  denoisedOffsetMap: number[];
  /** Signals surfaced by normalization itself. */
  signals: NormalizationSignals;
}

export interface NormalizationSignals {
  /** Digits deleted as intra-token noise. >0 is itself strong evasion evidence. */
  noiseDigitsRemoved: number;
  /** Zero-width / bidi control characters stripped. */
  zeroWidthCount: number;
  /** Characters remapped by the confusable folder. */
  confusablesFolded: number;
  /** Characters remapped by the leet folder. */
  leetFolded: number;
}

// ---------------------------------------------------------------------------
// Tier 2 — detectors
// ---------------------------------------------------------------------------

export interface Detection {
  type: Category;
  span: { start: number; end: number };
  confidence: number;
  evidence: string;
}

export type Detector = (views: NormalizedViews) => Detection[];

// ---------------------------------------------------------------------------
// Engine entry point
// ---------------------------------------------------------------------------

export interface ModerateRequest {
  message_id: string;
  /** Required — enables relationship-level state (SPEC §6). */
  conversation_id: string;
  sender_role: SenderRole;
  booking_stage: BookingStage;
  text: string;
  mode?: Mode;
}

export interface ModerateSignals {
  weirdness?: number;
  digit_pressure?: number;
  intent_hits?: string[];
  [key: string]: unknown;
}

export interface ModerateResult {
  verdict: Verdict;
  categories: Category[];
  spans: Span[];
  confidence: number;
  resolved_by: ResolvedBy;
  signals: ModerateSignals;
  latency_ms: number;
  cost_usd: number;
  /** async mode only: final verdict follows via callback (SPEC §9). */
  pending?: boolean;
}
