/**
 * Number-word lexicon (SPEC §3.5), mirrored from data/lexicons/numwords.json.
 *
 * Lives in-package because core must have zero fs/network dependencies
 * (SPEC §1). Keep in sync with the JSON, which stays the human-facing source.
 */

/** word → digit character. */
export const NUM_WORDS: Record<string, string> = {
  // --- en ---
  zero: "0",
  oh: "0",
  o: "0",
  nought: "0",
  naught: "0",
  nil: "0",
  one: "1",
  two: "2",
  to: "2",
  too: "2",
  three: "3",
  four: "4",
  for: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  ate: "8",
  nine: "9",

  // --- hi-latin (hinglish) ---
  shunya: "0",
  sunya: "0",
  shoonya: "0",
  ek: "1",
  aik: "1",
  do: "2",
  teen: "3",
  tin: "3",
  char: "4",
  chaar: "4",
  paanch: "5",
  panch: "5",
  paach: "5",
  che: "6",
  chhe: "6",
  chah: "6",
  chhah: "6",
  saat: "7",
  sat: "7",
  aath: "8",
  ath: "8",
  nau: "9",
  no: "9",

  // --- devanagari script words ---
  "शून्य": "0",
  "एक": "1",
  "दो": "2",
  "तीन": "3",
  "चार": "4",
  "पांच": "5",
  "पाँच": "5",
  "छह": "6",
  "छे": "6",
  "सात": "7",
  "आठ": "8",
  "नौ": "9",
};

/** "double five" → 55, "triple 9" → 999 (SPEC §3.5). */
export const MULTIPLIERS: Record<string, number> = {
  double: 2,
  dubble: 2,
  twice: 2,
  triple: 3,
  treble: 3,
  thrice: 3,
  quadruple: 4,
};

/**
 * Number-words that are also ordinary words. These expand ONLY when adjacent
 * to another digit chunk, otherwise "do you want to book for one" becomes
 * "2 u want 2 book 4 1" and the hard-negatives corpus (SPEC §10) lights up.
 */
export const AMBIGUOUS_WORDS = new Set([
  "o",
  "oh",
  "to",
  "too",
  "for",
  "ate",
  "no",
  "do",
  "che",
  "one",
  "nil",
  "sat",
  "char",
  "tin",
]);

/**
 * The most dangerous subset: extremely common English words that also mean a
 * digit in Hinglish. A single-digit neighbour is not enough evidence for these
 * — "booking for 7 people" and "house no 1" are ordinary sentences, and
 * expanding them fabricates the runs "47" and "91".
 *
 * These require single-digit neighbours on BOTH sides, which is what a
 * dictated sequence actually looks like ("... 9 for 5 ..." mid-number).
 */
export const HIGH_RISK_AMBIGUOUS = new Set(["for", "no", "to", "too", "do", "one", "ate", "che"]);

export function isNumWord(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(NUM_WORDS, token);
}

export function isMultiplier(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(MULTIPLIERS, token);
}
