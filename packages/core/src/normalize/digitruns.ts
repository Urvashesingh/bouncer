/**
 * SPEC §3.5-3.6 — number-word expansion and digit-run extraction.
 *
 * Adjacent digit chunks merge across separators (`9-8-7`, `9 . 8 . 7`, `98_76`,
 * "nine eight 7") into one run carrying provenance. `mixedForm` — words and
 * numerals interleaved — almost never occurs in legit text, so it is the
 * highest-value signal this stage produces.
 */

import { AMBIGUOUS_WORDS, HIGH_RISK_AMBIGUOUS, MULTIPLIERS, NUM_WORDS } from "./numwords.js";
import type { DigitRun, SeparatorType } from "../types.js";

interface Token {
  text: string;
  start: number;
  end: number;
  /** Separator text immediately preceding this token. */
  sepBefore: string;
}

/** A token that contributed digits to a run. */
interface Chunk {
  digits: string;
  form: "numeral" | "word";
  start: number;
  end: number;
  sepBefore: string;
  /** Ambiguous words only count once anchored by a neighbouring chunk. */
  ambiguous: boolean;
  /** Ambiguous AND an extremely common English word; needs both neighbours. */
  highRisk: boolean;
  /**
   * True when the digits came from a multiplier ("double three" -> 33).
   * Such a chunk is dictation, not a quantity, so it still anchors an
   * adjacent ambiguous word despite being more than one digit long.
   */
  fromMultiplier: boolean;
}

const SEPARATOR_CHARS = /[\s_\-.,;:]/u;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let pendingSep = "";

  while (i < text.length) {
    if (SEPARATOR_CHARS.test(text[i]!)) {
      pendingSep += text[i]!;
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && !SEPARATOR_CHARS.test(text[i]!)) i++;
    tokens.push({ text: text.slice(start, i), start, end: i, sepBefore: pendingSep });
    pendingSep = "";
  }

  return tokens;
}

function classifySeparator(sep: string): SeparatorType[] {
  const types: SeparatorType[] = [];
  if (sep === "") return ["none"];
  if (/\s/.test(sep)) types.push("space");
  if (sep.includes("-")) types.push("dash");
  if (sep.includes(".")) types.push("dot");
  if (sep.includes("_")) types.push("underscore");
  if (sep.includes(",")) types.push("comma");
  if (sep.includes(":")) types.push("colon");
  if (sep.includes(";")) types.push("semicolon");
  return types.length > 0 ? types : ["none"];
}

/**
 * Turn one token into a digit chunk, if it is one.
 * Handles pure numerals, number-words, and leading multipliers.
 */
function tokenToChunks(token: Token, multiplier: number | null): Chunk[] {
  const lower = token.text.toLowerCase();

  // Pure numeral token, e.g. "7", "98", "9876".
  if (/^\d+$/.test(lower)) {
    const digits = multiplier ? lower.repeat(multiplier) : lower;
    return [
      {
        digits,
        form: "numeral",
        start: token.start,
        end: token.end,
        sepBefore: token.sepBefore,
        ambiguous: false,
        highRisk: false,
        fromMultiplier: multiplier !== null,
      },
    ];
  }

  // Number-word token, e.g. "nine", "paanch", "नौ".
  // \p{M} matters: Devanagari vowel signs (मात्रा) are combining marks, not
  // letters, so stripping on \p{L} alone turns "पांच" into "पच" and every
  // Devanagari number-word silently fails to match.
  const stripped = lower.replace(/[^\p{L}\p{M}]/gu, "");
  const word = NUM_WORDS[stripped];
  if (word !== undefined) {
    const digits = multiplier ? word.repeat(multiplier) : word;
    return [
      {
        digits,
        form: "word",
        start: token.start,
        end: token.end,
        sepBefore: token.sepBefore,
        ambiguous: AMBIGUOUS_WORDS.has(stripped),
        highRisk: HIGH_RISK_AMBIGUOUS.has(stripped),
        fromMultiplier: multiplier !== null,
      },
    ];
  }

  // Mixed alphanumeric token that still carries a digit tail/head, e.g. the
  // "98" and "76" inside "akshay_98_76" survive tokenization as their own
  // tokens; but "five4" style compounds need splitting.
  if (/^[a-z]+\d+$/.test(lower) || /^\d+[a-z]+$/.test(lower)) {
    const digitPart = lower.replace(/\D/gu, "");
    const letterPart = lower.replace(/\d/gu, "");
    const asWord = NUM_WORDS[letterPart];
    const chunks: Chunk[] = [];
    if (asWord !== undefined) {
      chunks.push({
        digits: asWord,
        form: "word",
        start: token.start,
        end: token.end,
        sepBefore: token.sepBefore,
        ambiguous: AMBIGUOUS_WORDS.has(letterPart),
        highRisk: HIGH_RISK_AMBIGUOUS.has(letterPart),
        fromMultiplier: multiplier !== null,
      });
    }
    if (digitPart.length > 0) {
      chunks.push({
        digits: digitPart,
        form: "numeral",
        start: token.start,
        end: token.end,
        sepBefore: chunks.length > 0 ? "" : token.sepBefore,
        ambiguous: false,
        highRisk: false,
        fromMultiplier: false,
      });
    }
    if (chunks.length > 0) return chunks;
  }

  return [];
}

export interface ExtractOptions {
  /** Minimum digits for a run to be reported. Partials matter (SPEC §4). */
  minLength?: number;
}

/**
 * Extract digit runs from a normalized view.
 *
 * Chunks merge into one run when they are adjacent tokens (nothing but a
 * separator between them). A non-digit token breaks the run.
 */
export function extractDigitRuns(text: string, options: ExtractOptions = {}): DigitRun[] {
  const minLength = options.minLength ?? 2;
  const tokens = tokenize(text);

  const runs: DigitRun[] = [];
  let current: Chunk[] = [];

  /** Emit one contiguous group of accepted chunks as a run. */
  const emit = (segment: Chunk[]) => {
    if (segment.length === 0) return;
    // A group of nothing but ambiguous words is ordinary language, not a number.
    if (segment.every((c) => c.ambiguous)) return;

    const digits = segment.map((c) => c.digits).join("");
    if (digits.length < minLength) return;

    const wordFormCount = segment.filter((c) => c.form === "word").length;
    const numeralCount = segment.filter((c) => c.form === "numeral").length;

    const separatorTypes = new Set<SeparatorType>();
    for (let i = 1; i < segment.length; i++) {
      for (const t of classifySeparator(segment[i]!.sepBefore)) separatorTypes.add(t);
    }

    runs.push({
      digits,
      sourceSpan: { start: segment[0]!.start, end: segment[segment.length - 1]!.end },
      wordFormCount,
      numeralCount,
      separatorTypes: [...separatorTypes],
      mixedForm: wordFormCount > 0 && numeralCount > 0,
    });
  };

  const flush = () => {
    if (current.length === 0) return;
    const chunks = current;
    current = [];

    // Words that double as ordinary language ("for", "to", "one", "do") only
    // count as digits inside a DICTATED sequence — where every neighbour is
    // itself a single digit, the way a spoken number reads ("nine eight 7 six
    // zero"). A multi-digit neighbour means a quantity.
    //
    // Without this, "₹98,765 for 5 nights" reads as 765 + for(4) + 5 and is
    // marked mixedForm: a high-weight evasion signal fired by a price.
    //
    // A rejected chunk BREAKS the run rather than being spliced out, otherwise
    // "765 for 5" would glue into "7655" and feed Tier 3's digit-pressure
    // accumulator digits that were never adjacent in the text.
    let segment: Chunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      let accepted = true;

      if (chunk.ambiguous) {
        const prev = chunks[i - 1];
        const next = chunks[i + 1];
        const isDictation = (n: Chunk) => n.digits.length === 1 || n.fromMultiplier;
        const neighbours = [prev, next].filter((n) => n !== undefined);
        accepted = neighbours.length > 0 && neighbours.every((n) => isDictation(n!));

        // High-risk words ("for", "no", "one") need single-digit neighbours on
        // BOTH sides. One is not enough: "booking for 7 people" and "house no
        // 1" are ordinary sentences that would otherwise yield 47 and 91.
        if (accepted && chunk.highRisk) {
          accepted =
            prev !== undefined && next !== undefined && isDictation(prev) && isDictation(next);
        }
      }

      if (accepted) {
        segment.push(chunk);
      } else {
        emit(segment);
        segment = [];
      }
    }
    emit(segment);
  };

  let pendingMultiplier: number | null = null;

  for (const token of tokens) {
    const lower = token.text.toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");

    // "double"/"triple" latch onto the next digit chunk.
    const mult = MULTIPLIERS[lower];
    if (mult !== undefined) {
      pendingMultiplier = mult;
      continue;
    }

    const chunks = tokenToChunks(token, pendingMultiplier);
    pendingMultiplier = null;

    if (chunks.length === 0) {
      flush();
      continue;
    }

    // A chunk separated from the previous by more than a simple separator
    // (i.e. an intervening non-digit token) already triggered flush above.
    current.push(...chunks);
  }

  flush();
  return runs;
}

/**
 * Build the `digitized` view: number-words replaced by their digits, with
 * separators between merged digit chunks collapsed (SPEC §3.5).
 */
export function toDigitizedView(text: string): string {
  const tokens = tokenize(text);
  const runs = extractDigitRuns(text, { minLength: 1 });

  // Index runs by their source span so we can splice them back in.
  const replacements = new Map<number, { end: number; digits: string }>();
  for (const run of runs) {
    replacements.set(run.sourceSpan.start, { end: run.sourceSpan.end, digits: run.digits });
  }

  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    const replacement = replacements.get(token.start);
    if (replacement === undefined) continue;
    out += text.slice(cursor, token.start) + replacement.digits;
    cursor = replacement.end;
  }
  out += text.slice(cursor);

  return out;
}
