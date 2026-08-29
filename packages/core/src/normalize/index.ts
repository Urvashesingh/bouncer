/**
 * Tier 1 — Normalization (SPEC §3).
 *
 * Produces MULTIPLE views, never one collapsed string: aggressive
 * normalization on its own causes false positives, so each detector picks the
 * view it needs and the risk engine sees what normalization had to undo.
 */

import { denoise } from "./denoise.js";
import { extractDigitRuns, toDigitizedView } from "./digitruns.js";
import { toDeleetView, toFoldedView, toNfkcView } from "./fold.js";
import type { NormalizedViews } from "../types.js";

export function normalize(raw: string): NormalizedViews {
  // 1-2. NFKC + strip zero-width/bidi controls.
  const { text: nfkc, zeroWidthCount } = toNfkcView(raw);

  // 3. Confusable fold (+ non-ASCII digits by Unicode value) + lowercase.
  const { text: folded, confusablesFolded } = toFoldedView(nfkc);

  // Leet fold, letter-context only.
  const { text: deleet, leetFolded } = toDeleetView(folded);

  // 4. Token-level noise strip. Runs on the folded view so that confusables
  // are already ASCII, but NOT on deleet — deleet turns digits into letters,
  // which would hide exactly the noise digits we want to count.
  const { text: denoised, noiseDigitsRemoved, offsetMap } = denoise(folded);

  // 5-6. Number-word expansion and digit-run extraction. Both run on the
  // denoised view so interior noise digits never pollute a candidate number.
  const digitized = toDigitizedView(denoised);

  // Runs are found on the denoised view, whose offsets have shifted wherever
  // noise digits were removed. Translate them back so every span this module
  // publishes indexes into `raw` — the policy layer masks the original text.
  //
  // minLength: 1. extractDigitRuns defaults to 2, which silently dropped every
  // single-digit message ("3", "9", "8"...) before it ever became a DigitRun —
  // invisible to phone detection, fragment buffering and digit pressure alike.
  // A guest could leak a full number by sending it one digit per message and
  // every message delivered as "Nothing concerning found," because there was
  // nothing in the pipeline's output for Tier 3 to even look at. Tier 3's own
  // fragment-plausibility check already filters out ordinary single-digit
  // replies ("how many guests?" -> "2") by requiring the run sit apart from an
  // explaining word; dropping them one step earlier, before that check could
  // even run, was a stronger and unintended filter.
  const digitRuns = extractDigitRuns(denoised, { minLength: 1 }).map((run) => ({
    ...run,
    sourceSpan: {
      start: offsetMap[run.sourceSpan.start] ?? run.sourceSpan.start,
      end: (offsetMap[run.sourceSpan.end - 1] ?? run.sourceSpan.end - 1) + 1,
    },
  }));

  return {
    raw,
    nfkc,
    folded,
    deleet,
    denoised,
    digitized,
    digitRuns,
    denoisedOffsetMap: offsetMap,
    signals: {
      noiseDigitsRemoved,
      zeroWidthCount,
      confusablesFolded,
      leetFolded,
    },
  };
}

export { denoise, denoiseToken } from "./denoise.js";
export { extractDigitRuns, toDigitizedView } from "./digitruns.js";
export { toDeleetView, toFoldedView, toNfkcView, asciiDigitValue } from "./fold.js";
