/**
 * SPEC §4 `phone` detector.
 *
 * Validates digit runs from Tier 1 against IN (plus generic international).
 * A 10-digit run starting 6-9 is a valid IN mobile even without +91.
 *
 * Runs of 5-9 digits are PARTIALS: they feed Tier 3's relationship-level
 * accumulator and must never auto-block on their own, because that is what
 * "98765" ... "43210" split across two messages looks like from here.
 */

import parsePhoneNumberFromString from "libphonenumber-js/min";

import type { Detection, DigitRun, NormalizedViews } from "../types.js";

/** SPEC §4: 10 digits starting 6-9 is a valid IN mobile. */
const IN_MOBILE_RE = /^[6-9]\d{9}$/;

const PARTIAL_MIN = 5;
const PARTIAL_MAX = 9;

/**
 * Digit lengths that are overwhelmingly benign in this domain and must not be
 * treated as phone partials on their own (SPEC §10 hard negatives): 6-digit
 * PIN codes, 4-digit years/room numbers, prices.
 */
function looksLikeIndianPin(digits: string): boolean {
  return /^[1-8]\d{5}$/.test(digits);
}

export function detectPhone(views: NormalizedViews): Detection[] {
  const detections: Detection[] = [];

  for (const run of views.digitRuns) {
    const digits = run.digits;

    // --- Full valid numbers -------------------------------------------------
    if (IN_MOBILE_RE.test(digits)) {
      detections.push(makeDetection(run, "contact.phone", confidenceFor(run, 0.95), "IN mobile (10 digits, leading 6-9)"));
      continue;
    }

    // +91 / 91 prefixed, and general international via libphonenumber.
    const withPlus = digits.length > 10 ? `+${digits}` : null;
    if (withPlus !== null) {
      const parsed = safeParse(withPlus);
      if (parsed !== null) {
        detections.push(
          makeDetection(run, "contact.phone", confidenceFor(run, 0.95), `valid ${parsed} number`),
        );
        continue;
      }
      // 91-prefixed IN mobile written without the plus.
      if (/^91[6-9]\d{9}$/.test(digits)) {
        detections.push(makeDetection(run, "contact.phone", confidenceFor(run, 0.95), "IN mobile with 91 country prefix"));
        continue;
      }
    }

    // --- Partials -----------------------------------------------------------
    // Never a verdict on their own; Tier 3 accumulates them per conversation.
    if (digits.length >= PARTIAL_MIN && digits.length <= PARTIAL_MAX) {
      // A partial with NO obfuscation evidence is only a fragment if nothing
      // in its neighbourhood explains it as ordinary content. Prices, flight
      // codes, PINs and dates are the SPEC §10 hard negatives that would
      // otherwise eat the 0.5% friction budget. Obfuscated partials still
      // fire — mangling is the signal, per SPEC §3.4.
      const obfuscated = isObfuscated(run, views);
      if (!obfuscated) {
        if (looksLikeIndianPin(digits)) continue;
        if (hasBenignContext(run, views)) continue;
      }

      detections.push(
        makeDetection(
          run,
          "contact.phone.partial",
          // Partial confidence scales with length, per SPEC §6 w2·(len/10).
          Math.min(0.6, 0.2 + (digits.length / 10) * 0.4),
          `${digits.length}-digit partial run`,
        ),
      );
    }
  }

  return detections;
}

/**
 * Obfuscation evidence raises confidence and marks the `.obfuscated` subtype
 * (SPEC §2 shows "contact.phone.obfuscated" as a category).
 */
function isObfuscated(run: DigitRun, views: NormalizedViews): boolean {
  return (
    run.mixedForm ||
    run.wordFormCount > 0 ||
    views.signals.noiseDigitsRemoved > 0 ||
    views.signals.zeroWidthCount > 0 ||
    views.signals.confusablesFolded > 0 ||
    run.separatorTypes.some((s) => s !== "none" && s !== "space")
  );
}

/**
 * Markers that explain a clean digit run as ordinary content (SPEC §10 hard
 * negatives). Checked in a window around the run, on the folded view.
 */
const BENIGN_CONTEXT_TERMS = [
  // money
  "₹", "rs", "rs.", "inr", "\\$", "usd", "eur", "£", "per night", "per person",
  "total", "price", "cost", "amount", "paid", "bill", "charge", "deposit", "refund",
  // codes and identifiers
  "pin code", "pincode", "zip", "postal", "flight", "pnr", "train", "seat",
  "gate", "platform", "terminal", "booking ref", "booking id", "booking no",
  "ref no", "order id", "invoice", "gst", "gstin", "pan", "aadhaar",
  // stay logistics
  "check in", "check-in", "checkin", "check out", "check-out", "checkout",
  "nights?", "days?", "guests?", "adults?", "kids?", "children",
  "room", "villa", "flat", "apt", "apartment", "floor", "house no", "door no",
  // time
  "am", "pm", "hrs", "hours?", "minutes?", "mins?",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  // measures and devices
  "sq ?ft", "kms?", "meters?", "metres?", "miles?",
  "wifi", "password", "passcode", "gate code", "door code", "otp",
  "gb", "mb", "tb", "mah", "mp", "inch",
];

const BENIGN_CONTEXT_RE = new RegExp(`(?:^|[^a-z])(?:${BENIGN_CONTEXT_TERMS.join("|")})(?:$|[^a-z])`, "i");

const CONTEXT_WINDOW = 24;

function hasBenignContext(run: DigitRun, views: NormalizedViews): boolean {
  const text = views.denoised;
  const start = Math.max(0, run.sourceSpan.start - CONTEXT_WINDOW);
  const end = Math.min(text.length, run.sourceSpan.end + CONTEXT_WINDOW);
  const window = text.slice(start, end);

  if (BENIGN_CONTEXT_RE.test(window)) return true;

  // A run glued to letters on either side is a code, not a number:
  // "6E 2134" (flight), "WYZ8842" (booking ref), "27AAPFU0939F1ZV" (GST).
  const before = text.slice(Math.max(0, run.sourceSpan.start - 3), run.sourceSpan.start);
  const after = text.slice(run.sourceSpan.end, run.sourceSpan.end + 3);
  if (/[a-z]\s?$/i.test(before) || /^\s?[a-z]/i.test(after)) return true;

  return false;
}

function confidenceFor(run: DigitRun, base: number): number {
  // Word-form and mixed-form runs are essentially never accidental.
  if (run.mixedForm) return Math.min(0.99, base + 0.04);
  if (run.wordFormCount > 0) return Math.min(0.99, base + 0.02);
  return base;
}

function makeDetection(run: DigitRun, type: string, confidence: number, evidence: string): Detection {
  return {
    type,
    span: run.sourceSpan,
    confidence,
    evidence,
  };
}

function safeParse(candidate: string): string | null {
  try {
    const parsed = parsePhoneNumberFromString(candidate);
    if (parsed !== undefined && parsed.isValid()) return parsed.country ?? "international";
  } catch {
    // libphonenumber throws on malformed input; treat as "not a phone number".
  }
  return null;
}

/**
 * Decorate a phone detection with the `.obfuscated` subtype when Tier 1 had to
 * undo evasion to find it. Exported so the registry can apply it uniformly.
 */
export function markObfuscation(views: NormalizedViews, detections: Detection[]): Detection[] {
  return detections.map((d) => {
    if (!d.type.startsWith("contact.phone")) return d;
    const run = views.digitRuns.find(
      (r) => r.sourceSpan.start === d.span.start && r.sourceSpan.end === d.span.end,
    );
    if (run === undefined || !isObfuscated(run, views)) return d;
    return { ...d, type: `${d.type}.obfuscated`.replace(".partial.obfuscated", ".partial") };
  });
}
