/**
 * Character maps for Tier 1 (SPEC §3 steps 2-3, and the leet note).
 *
 * Kept as plain data so they stay auditable and cheap. Devanagari/Arabic-Indic
 * digits are NOT confusables — they are real digits and are mapped by Unicode
 * digit value in fold.ts, not from this table.
 */

/** Zero-width and bidi control characters (SPEC §3.2). Stripped, and counted. */
export const ZERO_WIDTH = new Set([
  "​", // zero width space
  "‌", // zero width non-joiner
  "‍", // zero width joiner
  "﻿", // zero width no-break space / BOM
  "⁠", // word joiner
  "­", // soft hyphen
  "᠎", // mongolian vowel separator
  "‎", // left-to-right mark
  "‏", // right-to-left mark
  "‪", // LRE
  "‫", // RLE
  "‬", // PDF
  "‭", // LRO
  "‮", // RLO
  "⁦", // LRI
  "⁧", // RLI
  "⁨", // FSI
  "⁩", // PDI
]);

/**
 * Confusable folding map: visually-similar non-ASCII → ASCII (SPEC §3.3).
 * Cyrillic and Greek lookalikes dominate real evasion traffic.
 */
export const CONFUSABLES: Record<string, string> = {
  // --- Cyrillic → Latin ---
  "а": "a", // а
  "А": "a", // А
  "е": "e", // е
  "Е": "e", // Е
  "о": "o", // о
  "О": "o", // О
  "р": "p", // р
  "Р": "p", // Р
  "с": "c", // с
  "С": "c", // С
  "х": "x", // х
  "Х": "x", // Х
  "у": "y", // у
  "У": "y", // У
  "і": "i", // і
  "І": "i", // І
  "ј": "j", // ј
  "Ј": "j", // Ј
  "к": "k", // к
  "К": "k", // К
  "м": "m", // м
  "М": "m", // М
  "н": "h", // н
  "Н": "h", // Н
  "в": "b", // в
  "В": "b", // В
  "т": "t", // т
  "Т": "t", // Т
  "г": "r", // г
  "ѕ": "s", // ѕ
  "Ѕ": "s", // Ѕ
  "һ": "h", // һ
  "ԁ": "d", // ԁ
  "ԛ": "q", // ԛ
  "ԝ": "w", // ԝ
  "ґ": "g", // ґ
  "п": "n", // п  (shape-approximate; common in mangled handles)

  // --- Greek → Latin ---
  "α": "a", // α
  "Α": "a", // Α
  "β": "b", // β
  "Β": "b", // Β
  "ε": "e", // ε
  "Ε": "e", // Ε
  "ο": "o", // ο
  "Ο": "o", // Ο
  "ρ": "p", // ρ
  "Ρ": "p", // Ρ
  "τ": "t", // τ
  "Τ": "t", // Τ
  "ν": "v", // ν
  "Ν": "n", // Ν
  "κ": "k", // κ
  "Κ": "k", // Κ
  "ι": "i", // ι
  "Ι": "i", // Ι
  "υ": "u", // υ
  "χ": "x", // χ
  "Χ": "x", // Χ
  "Ζ": "z", // Ζ
  "Η": "h", // Η
  "Μ": "m", // Μ
  "Υ": "y", // Υ
  "σ": "o", // σ
  "γ": "y", // γ

  // --- Latin lookalikes / punctuation-as-letter ---
  "ı": "i", // ı dotless
  "ł": "l", // ł
  "ø": "o", // ø
  "œ": "oe", // œ
  "æ": "ae", // æ
  "ß": "ss", // ß
  "ℓ": "l", // ℓ
  "ⅼ": "l", // ⅼ
  "ⅰ": "i", // ⅰ
  "⓪": "0", // ⓪ (circled — NFKC misses some)
  "＠": "@", // ＠
  "@": "@",

  // --- separator-ish confusables normalized to ASCII ---
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  "﹘": "-",
  "－": "-",
  "·": ".",
  "•": ".",
  "‧": ".",
  "．": ".",
  "。": ".",
  "＿": "_",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  "　": " ",
};

/**
 * Leet map (SPEC §3 "Leet note").
 *
 * CRITICAL: applied ONLY inside otherwise-alphabetic tokens, never globally —
 * a global digit→letter map destroys prices ("₹500" → "₹soo"). See deleet.ts
 * for the letter-context gate.
 */
export const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
  "+": "t",
};
