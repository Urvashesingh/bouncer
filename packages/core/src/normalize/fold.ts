/**
 * SPEC §3 steps 1-3: NFKC, zero-width stripping, confusable folding.
 */

import { CONFUSABLES, LEET, ZERO_WIDTH } from "./maps.js";

/**
 * Non-ASCII decimal digits (Devanagari ९, Arabic-Indic ٩, Bengali ৯, …).
 *
 * SPEC §3.3: these are REAL digits, not confusables — map by Unicode digit
 * value rather than by lookup table. NFKC leaves them alone by design, so we
 * handle them explicitly. Each entry is the codepoint of that script's ZERO.
 */
const DIGIT_BLOCK_ZEROS = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
  0x0ed0, // Lao
  0x0f20, // Tibetan
  0x1040, // Myanmar
  0xff10, // Fullwidth (NFKC usually covers this; belt and braces)
];

/** Returns the ASCII digit for a non-ASCII decimal digit, else null. */
export function asciiDigitValue(ch: string): string | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if (cp >= 0x30 && cp <= 0x39) return ch; // already ASCII
  for (const zero of DIGIT_BLOCK_ZEROS) {
    if (cp >= zero && cp <= zero + 9) return String(cp - zero);
  }
  return null;
}

export interface FoldResult {
  text: string;
  zeroWidthCount: number;
  confusablesFolded: number;
}

/** Step 1: NFKC. Handles fullwidth ９８７, circled ⑨, math-bold 𝟗, keycaps. */
export function toNfkcView(raw: string): { text: string; zeroWidthCount: number } {
  const normalized = raw.normalize("NFKC");

  // Step 2: strip zero-width & bidi controls, keeping the count as a signal.
  let out = "";
  let zeroWidthCount = 0;
  for (const ch of normalized) {
    if (ZERO_WIDTH.has(ch)) {
      zeroWidthCount++;
      continue;
    }
    out += ch;
  }
  return { text: out, zeroWidthCount };
}

/**
 * Step 3: confusable fold + lowercase, plus non-ASCII digit → ASCII digit.
 * Input should be the nfkc view.
 */
export function toFoldedView(nfkc: string): { text: string; confusablesFolded: number } {
  let out = "";
  let confusablesFolded = 0;

  for (const ch of nfkc) {
    const digit = asciiDigitValue(ch);
    if (digit !== null && digit !== ch) {
      out += digit;
      confusablesFolded++;
      continue;
    }

    const mapped = CONFUSABLES[ch];
    if (mapped !== undefined) {
      out += mapped;
      // Whitespace/punctuation unification isn't really "evasion"; only count
      // letter-level substitutions, which are.
      if (/\S/.test(ch) && !/[-._ ]/.test(mapped)) confusablesFolded++;
      continue;
    }

    out += ch;
  }

  return { text: out.toLowerCase(), confusablesFolded };
}

const LETTER_RE = /\p{L}/u;

/**
 * Leet fold, applied per-token and ONLY where the token is otherwise
 * alphabetic (SPEC §3 "Leet note"): `c4ll` → call, `wh4tsapp` → whatsapp,
 * while `₹500` and `403507` are left untouched.
 *
 * Gate: the token must contain at least one letter AND at least half its
 * non-separator characters must be letters. That admits `c4ll` (3/4 letters)
 * and rejects `98765` (0 letters) and `9-8-7` (0 letters).
 */
export function toDeleetView(folded: string): { text: string; leetFolded: number } {
  let leetFolded = 0;

  const text = folded.replace(/\S+/gu, (token) => {
    if (!LETTER_RE.test(token)) return token;

    const chars = [...token];
    const letters = chars.filter((c) => LETTER_RE.test(c)).length;
    const leetable = chars.filter((c) => LEET[c] !== undefined).length;
    if (letters === 0) return token;

    // Majority-letters gate keeps this away from numeric-ish tokens.
    if (letters < leetable) return token;

    let out = "";
    for (const ch of chars) {
      const mapped = LEET[ch];
      if (mapped !== undefined) {
        out += mapped;
        leetFolded++;
      } else {
        out += ch;
      }
    }
    return out;
  });

  return { text, leetFolded };
}
