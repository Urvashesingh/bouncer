/**
 * SPEC §4 `email` detector.
 *
 * RFC-lite regex on the folded view, plus the obfuscated spellings that make
 * up most real evasion: `(at)`, ` at `, `[dot]`, `(dot)`, "gmail dot com".
 */

import { EMAIL_DOMAINS } from "./lexicons.js";
import type { Detection, NormalizedViews } from "../types.js";

/** Deliberately permissive on the local part, strict on shape. */
const PLAIN_EMAIL_RE = /\b[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,24}\b/gi;

/**
 * at-substitutes. "at the rate" is the everyday spoken form in India and was
 * the gap that let "akshay at the rate gmail" through untouched.
 */
const AT_ALT = String.raw`(?:@|\(\s*at\s*\)|\[\s*at\s*\]|\{\s*at\s*\}|\s+at\s+the\s+rate(?:\s+of)?\s+|\s+at\s+|\s*_at_\s*|\s*-at-\s*|\s+attherate\s+)`;

/**
 * dot-substitutes, including letter-spaced "d o t" — typing the word with
 * spaces between its letters defeats a plain \bdot\b match, and is exactly
 * the kind of trivial mangling this engine exists to see through.
 */
const DOT_ALT = String.raw`(?:\.|\(\s*dot\s*\)|\[\s*dot\s*\]|\{\s*dot\s*\}|\s+d\s*o\s*t\s+|\s*_dot_\s*|\s*-dot-\s*)`;

const OBFUSCATED_EMAIL_RE = new RegExp(
  String.raw`\b([a-z0-9._%+-]{2,64}(?:${DOT_ALT}[a-z0-9._%+-]{1,64})?)\s*${AT_ALT}\s*([a-z0-9-]{2,64})\s*${DOT_ALT}\s*([a-z]{2,24})\b`,
  "gi",
);

export function detectEmail(views: NormalizedViews): Detection[] {
  const detections: Detection[] = [];
  const seen = new Set<string>();

  const push = (detection: Detection) => {
    const key = `${detection.span.start}:${detection.span.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    detections.push(detection);
  };

  // --- Plain, unobfuscated addresses --------------------------------------
  for (const match of views.folded.matchAll(PLAIN_EMAIL_RE)) {
    push({
      type: "contact.email",
      span: { start: match.index, end: match.index + match[0].length },
      confidence: 0.97,
      evidence: match[0],
    });
  }

  // --- Obfuscated spellings ------------------------------------------------
  for (const match of views.folded.matchAll(OBFUSCATED_EMAIL_RE)) {
    const full = match[0];
    // Skip if it was already caught as a plain address (no substitution used).
    const usedSubstitution = !/^[^\s@]+@[^\s@]+$/.test(full.trim());
    const domain = (match[2] ?? "").toLowerCase();
    const knownProvider = EMAIL_DOMAINS.includes(domain);

    push({
      type: usedSubstitution ? "contact.email.obfuscated" : "contact.email",
      span: { start: match.index, end: match.index + full.length },
      confidence: knownProvider ? 0.96 : usedSubstitution ? 0.9 : 0.93,
      evidence: full.trim(),
    });
  }

  return detections;
}
