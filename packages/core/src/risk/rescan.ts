/**
 * Windowed re-scan and fragment merging (SPEC §6).
 *
 * A number split across messages — "98765" … (reply) … "43210" — is invisible
 * to any per-message detector. Two mechanisms recover it:
 *
 *   1. Windowed re-scan: concatenate the last N messages from the SAME sender
 *      and re-run Tier 1+2 over the joined text.
 *   2. Fragment merging: combine buffered digit runs inside a 30-minute
 *      window; if the result is ≥10 digits and forms a valid IN mobile, block.
 */

import type { TimestampedRun } from "./state.js";
import type { RememberedMessage } from "./state.js";
import type { DigitRun, SenderRole } from "../types.js";

/** SPEC §4: 10 digits starting 6-9 is a valid IN mobile. */
const IN_MOBILE_RE = /^[6-9]\d{9}$/;

export interface MergedFragment {
  digits: string;
  /** True when the merged digits form a valid IN mobile number. */
  validPhone: boolean;
  /** How many separate messages contributed. */
  contributingRuns: number;
  /** Time between the first and last contributing fragment. */
  spanMs: number;
  /**
   * The exact fragments that produced this merge.
   *
   * The caller needs these to CONSUME them once the merge has been acted on.
   * Left in the buffer, they re-merge on every later message and re-report the
   * same number forever — so an innocent "thanks, see you on the 9th!" is
   * blocked for a number recovered three turns earlier and already handled.
   */
  contributors: readonly TimestampedRun[];
}

/**
 * Merge buffered fragments from one sender into candidate numbers.
 *
 * Fragments are concatenated in the order they arrived. Only same-sender runs
 * are merged: a guest's "98765" and a host's "43210" are unrelated, and
 * merging across senders would manufacture numbers nobody sent.
 */
export function mergeFragments(
  fragments: readonly TimestampedRun[],
  sender: SenderRole,
  nowMs: number,
  windowMs: number,
): MergedFragment[] {
  const inWindow = fragments.filter(
    (f) => f.sender === sender && nowMs - f.timestamp <= windowMs,
  );
  if (inWindow.length < 2) return [];

  const results: MergedFragment[] = [];

  // Try every contiguous combination, longest first. Contiguity matters: an
  // unrelated run in between usually means the digits are not one number.
  for (let start = 0; start < inWindow.length; start++) {
    for (let end = inWindow.length; end > start + 1; end--) {
      const slice = inWindow.slice(start, end);
      const digits = slice.map((f) => f.run.digits).join("");
      if (digits.length < 10) continue;

      // A phone number is 10 digits, or 12 with a country code. Anything
      // longer is not "a number with extra bits" — it is proof the merge is
      // wrong. Without this ceiling, one real number in the buffer glued
      // itself to every later price, flight number and clock time, producing
      // 20+ digit strings that still "validated" because only the leading 10
      // were checked. Every subsequent message containing any digit then
      // blocked.
      if (digits.length > 12) continue;

      const validPhone =
        IN_MOBILE_RE.test(digits) || /^91[6-9]\d{9}$/.test(digits);

      results.push({
        digits,
        validPhone,
        contributingRuns: slice.length,
        spanMs: slice[slice.length - 1]!.timestamp - slice[0]!.timestamp,
        contributors: slice,
      });
    }
  }

  // Most complete candidates first; valid numbers outrank longer invalid ones.
  return results.sort(
    (a, b) => Number(b.validPhone) - Number(a.validPhone) || b.digits.length - a.digits.length,
  );
}

/**
 * Build the windowed re-scan text: the last N messages from this sender plus
 * the current one, joined so Tier 1 sees them as adjacent.
 *
 * Joined with a space, not concatenated directly: gluing "98765"+"43210" into
 * one token would fabricate adjacency the sender never wrote. Tier 1's digit
 * merging already spans separators, so a space is enough for a genuine split
 * number to be recovered — while keeping the two runs distinguishable.
 */
export function buildRescanText(
  lastMessages: readonly RememberedMessage[],
  sender: SenderRole,
  currentText: string,
  windowSize: number,
): string | null {
  const sameSender = lastMessages.filter((m) => m.sender === sender).slice(-windowSize);
  if (sameSender.length === 0) return null;

  return [...sameSender.map((m) => m.text), currentText].join(" ");
}

/** Count distinct digits contributed by a set of runs, for digit pressure. */
export function uniqueDigitCount(runs: readonly DigitRun[]): number {
  const digits = new Set<string>();
  for (const run of runs) {
    for (const ch of run.digits) digits.add(ch);
  }
  return digits.size;
}

/** Total digits across runs — the volume of numeric content in a message. */
export function totalDigitCount(runs: readonly DigitRun[]): number {
  return runs.reduce((sum, run) => sum + run.digits.length, 0);
}
