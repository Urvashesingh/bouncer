/**
 * SPEC §4 safety detectors: hostility, extortion, scamlink.
 *
 * Extortion is the founder's pet issue (it is on their homepage), so it is
 * modelled properly: three slot families — DEMAND, CONDITIONAL, LEVERAGE —
 * scored by co-occurrence and proximity rather than one brittle regex. That
 * catches the reordered and Hinglish variants a fixed pattern would miss:
 *
 *   "give me a refund or I'll leave a 1 star review"     demand→cond→leverage
 *   "warna main bura review kar dunga, paisa wapas karo"  cond→leverage→demand
 *   "I'll post about this unless you refund"              leverage→cond→demand
 */

import { AhoCorasick, keepLongest } from "./aho.js";
import {
  EXTORTION_CONDITIONAL,
  EXTORTION_DEMAND,
  EXTORTION_LEVERAGE,
  HOSTILITY_MILD,
  HOSTILITY_SEV1,
  HOSTILITY_SEV2,
  HOSTILITY_SEV3,
  SCAM_PAYMENT,
  SCAM_TOO_GOOD,
  SCAM_URGENCY,
} from "./lexicons.js";
import type { Detection, NormalizedViews } from "../types.js";

// --- hostility -------------------------------------------------------------

const hostility = new AhoCorasick();
hostility.addAll(HOSTILITY_MILD, "0");
hostility.addAll(HOSTILITY_SEV1, "1");
hostility.addAll(HOSTILITY_SEV2, "2");
hostility.addAll(HOSTILITY_SEV3, "3");
hostility.build();

/**
 * Coarse language aimed at a PERSON rather than a thing.
 *
 * "we had a shitty flight" is a complaint; "you shitty little man" is abuse,
 * and the only difference is what the word attaches to. A second-person
 * pronoun or possessive immediately before the word (or a direct-address
 * "your <word>") is the cheap, reliable signal for that.
 */
const DIRECTED_AT_PERSON =
  /\b(?:you|your|ur|u|yours|urself|yourself|thou)\b(?:\s+(?:are|is|r|were|was|being|such|a|an|so|absolute|total|complete|fucking|bloody|damn))*\s*$/i;

/** How much text before the match counts as "immediately before". */
const DIRECTION_WINDOW = 16;

/**
 * Self-censored profanity: `f*ck`, `f**k`, `sh!t`, `b*tch`, `a$$hole`.
 *
 * People mask these themselves, and the intent is identical — the whole point
 * of the spelling is that the reader still reads the word. The Tier 1 views
 * do not recover them: `denoise`/`deleet` are built for DIGIT obfuscation, so
 * `f*ck off` reaches the lexicon unchanged and matches nothing.
 *
 * Listing every masked spelling does not scale (`f*ck`, `f**k`, `fu*k`,
 * `f#ck`, …), so this matches the shape instead: the word's first and last
 * letters with punctuation or repeated symbols standing in for the middle.
 * Anchored on both ends by a word boundary, so ordinary text with symbols
 * ("2*4 sockets") cannot trip it.
 */
const MASK = "[^a-z0-9\\s]";

const MASKED_PROFANITY: Array<[RegExp, number]> = [
  // f-word: f, then any mix of masked chars and the real u/c, then k.
  // Covers f*ck, f**k, fu*k, f#ck, f*ck*ng.
  [new RegExp(`\\bf(?:${MASK}|[uc]){1,3}k(?:${MASK}?(?:ing|in|er|ed|s))?\\b`, "i"), 2],
  // sh!t / sh*t / s**t — mild unless directed, same as plain "shit".
  [new RegExp(`\\bs(?:${MASK}|h){1,2}${MASK}?t(?:ty|s)?\\b`, "i"), 0],
  // b!tch, a$$hole, c*nt, d!ck
  [new RegExp(`\\bb(?:${MASK}|i){1,2}tch(?:es)?\\b`, "i"), 2],
  [new RegExp(`\\ba${MASK}{2}hole\\b`, "i"), 2],
  [new RegExp(`\\bc(?:${MASK}|u){1,2}nt\\b`, "i"), 2],
];

export function detectHostility(views: NormalizedViews): Detection[] {
  const text = views.deleet;
  const matches = keepLongest(hostility.search(text));

  const detections: Detection[] = matches.map((match) => {
    let severity = Number(match.tag);

    // Mild terms escalate only when pointed at the other party.
    if (severity === 0) {
      const before = text.slice(Math.max(0, match.start - DIRECTION_WINDOW), match.start);
      severity = DIRECTED_AT_PERSON.test(before) ? 2 : 0;
    }

    return {
      type: `safety.hostility.sev${severity}`,
      span: { start: match.start, end: match.end },
      confidence: severity === 3 ? 0.95 : severity === 2 ? 0.9 : severity === 1 ? 0.7 : 0.4,
      evidence: match.term,
    };
  });

  // Self-censored spellings the lexicon cannot hold. Only added where the
  // lexicon found nothing at that position, so "fucking" is not double-counted.
  for (const [pattern, baseSeverity] of MASKED_PROFANITY) {
    const found = pattern.exec(text);
    if (found === null) continue;
    if (detections.some((d) => d.span.start <= found.index && d.span.end > found.index)) continue;

    let severity = baseSeverity;
    if (severity === 0) {
      const before = text.slice(Math.max(0, found.index - DIRECTION_WINDOW), found.index);
      severity = DIRECTED_AT_PERSON.test(before) ? 2 : 0;
    }

    detections.push({
      type: `safety.hostility.sev${severity}`,
      span: { start: found.index, end: found.index + found[0].length },
      confidence: severity >= 2 ? 0.85 : 0.4,
      evidence: `${found[0]} (self-censored)`,
    });
  }

  return detections;
}

// --- extortion -------------------------------------------------------------

const extortion = new AhoCorasick();
extortion.addAll(EXTORTION_DEMAND, "demand");
extortion.addAll(EXTORTION_CONDITIONAL, "conditional");
extortion.addAll(EXTORTION_LEVERAGE, "leverage");
extortion.build();

/** Slots must co-occur within this many characters to count as one threat. */
const EXTORTION_WINDOW = 160;

export function detectExtortion(views: NormalizedViews): Detection[] {
  const matches = keepLongest(extortion.search(views.deleet));
  if (matches.length === 0) return [];

  const demand = matches.filter((m) => m.tag === "demand");
  const conditional = matches.filter((m) => m.tag === "conditional");
  const leverage = matches.filter((m) => m.tag === "leverage");

  // Leverage is the necessary ingredient: without a threat to review/report,
  // "refund or else" is an ordinary (if grumpy) service complaint.
  if (leverage.length === 0) return [];
  if (demand.length === 0 && conditional.length === 0) return [];

  const detections: Detection[] = [];

  for (const lev of leverage) {
    const nearDemand = demand.find((d) => distance(d, lev) <= EXTORTION_WINDOW);
    const nearConditional = conditional.find((c) => distance(c, lev) <= EXTORTION_WINDOW);

    // Full pattern: demand + conditional + leverage. Highest confidence.
    if (nearDemand !== undefined && nearConditional !== undefined) {
      const parts = [nearDemand, nearConditional, lev];
      detections.push({
        type: "safety.extortion",
        span: spanOf(parts),
        confidence: 0.95,
        evidence: `demand "${nearDemand.term}" + condition "${nearConditional.term}" + leverage "${lev.term}"`,
      });
      continue;
    }

    // Partial: demand + leverage with no explicit conditional
    // ("refund me, I have already written the 1 star review").
    if (nearDemand !== undefined) {
      detections.push({
        type: "safety.extortion.implied",
        span: spanOf([nearDemand, lev]),
        confidence: 0.75,
        evidence: `demand "${nearDemand.term}" co-occurring with leverage "${lev.term}"`,
      });
      continue;
    }

    // Partial: conditional + leverage, demand implied
    // ("otherwise I'm leaving a bad review").
    if (nearConditional !== undefined) {
      detections.push({
        type: "safety.extortion.implied",
        span: spanOf([nearConditional, lev]),
        confidence: 0.75,
        evidence: `condition "${nearConditional.term}" + leverage "${lev.term}"`,
      });
    }
  }

  return dedupe(detections);
}

// --- scam links ------------------------------------------------------------

const scam = new AhoCorasick();
scam.addAll(SCAM_URGENCY, "urgency");
scam.addAll(SCAM_PAYMENT, "payment");
scam.addAll(SCAM_TOO_GOOD, "too_good");
scam.build();

/**
 * SPEC §4: url detector output × (payment | urgency | too-good pricing).
 * Takes the URL detections so it composes rather than re-parsing.
 */
export function detectScamLink(views: NormalizedViews, urlDetections: Detection[]): Detection[] {
  if (urlDetections.length === 0) return [];

  const matches = keepLongest(scam.search(views.deleet));
  if (matches.length === 0) return [];

  const tags = new Set(matches.map((m) => m.tag));
  const detections: Detection[] = [];

  for (const url of urlDetections) {
    const reasons = [...tags];
    if (reasons.length === 0) continue;

    // Two or more independent scam cues alongside a link is a strong signal.
    const confidence = Math.min(0.93, 0.6 + reasons.length * 0.12);

    detections.push({
      type: "safety.scamlink",
      span: url.span,
      confidence,
      evidence: `${url.evidence} + ${reasons.join(", ")} cues`,
    });
  }

  return detections;
}

// --- helpers ---------------------------------------------------------------

interface Positioned {
  start: number;
  end: number;
  term: string;
}

function distance(a: Positioned, b: Positioned): number {
  if (a.end < b.start) return b.start - a.end;
  if (b.end < a.start) return a.start - b.end;
  return 0; // overlapping
}

function spanOf(parts: Positioned[]): { start: number; end: number } {
  return {
    start: Math.min(...parts.map((p) => p.start)),
    end: Math.max(...parts.map((p) => p.end)),
  };
}

function dedupe(detections: Detection[]): Detection[] {
  const best = new Map<string, Detection>();
  for (const d of detections) {
    const key = `${d.type}:${d.span.start}:${d.span.end}`;
    const existing = best.get(key);
    if (existing === undefined || d.confidence > existing.confidence) best.set(key, d);
  }
  return [...best.values()];
}
