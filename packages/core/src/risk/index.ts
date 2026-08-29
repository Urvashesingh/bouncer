/**
 * Tier 3 — risk engine + relationship state (SPEC §6).
 *
 * Ties together: session state, windowed re-scan, fragment merging, and the
 * weighted linear score. This is the tier that has to resolve the bulk of
 * traffic — SPEC §6 targets ≥92% decided at or before here.
 */

import { DEFAULT_RISK_CONFIG, type RiskConfig } from "./config.js";
import { buildRescanText, mergeFragments, totalDigitCount, uniqueDigitCount } from "./rescan.js";
import { bandFor, scoreMessage, type Band, type ScoreBreakdown } from "./score.js";
import {
  decayDigitPressure,
  decayIntentHits,
  emptyPairState,
  pruneFragments,
  type PairState,
  type SessionStore,
} from "./state.js";
import { runDetectors } from "../detectors/index.js";
import { normalize } from "../normalize/index.js";
import { messageWeirdness, type TrigramModel } from "../weirdness/index.js";
import type { Detection, ModerateRequest, NormalizedViews } from "../types.js";

/** A run that stands alone as a valid number, so it needs no reassembly. */
function isCompletePhone(digits: string): boolean {
  return /^[6-9]\d{9}$/.test(digits) || /^91[6-9]\d{9}$/.test(digits);
}

/**
 * Words that give a digit run an innocent reading. A run sitting next to one
 * of these is a flight number, a clock time, a room number or a price — not
 * half of a phone number someone is smuggling out.
 */
const BENIGN_NEIGHBOURS =
  /\b(?:flight|pnr|train|seat|gate|room|villa|flat|apt|floor|lane|door|house|pin|pincode|zip|postal|gst|invoice|ref|booking|order|check|checkin|checkout|night|nights|day|days|adult|adults|kid|kids|guest|guests|person|people|am|pm|rs|inr|price|cost|total|rate|deposit|refund|km|kms|metre|meters|m|gb|mb|tb|iphone|samsung|pixel|pro|max|plus|wifi|password|code)\b/i;

/** How much text on either side counts as "next to" a run. */
const NEIGHBOUR_WINDOW = 20;

/**
 * A run fused to letters is part of an alphanumeric IDENTIFIER, not a bare
 * fragment of a number: `G81104` / `IX1982` (flight), `A66617` (PNR),
 * `BK-88231` (booking ref), `256GB`, `AI2634`.
 *
 * BENIGN_NEIGHBOURS alone cannot see these. It scans the ~20 characters around
 * a run for an explaining word, but in "we are on G81104 arriving tomorrow"
 * the only clue is the `G` glued to the digits — there is no "flight" nearby
 * to find. Two such messages in one conversation had their runs buffered as
 * innocent fragments and merged into `8110489892`, a structurally valid IN
 * mobile that nobody sent, which then blocked the conversation.
 *
 * A genuine split number arrives as bare digits ("98765" … "43210"); digits
 * welded to a letter code are the one thing it never looks like.
 */
function isAlphanumericIdentifier(
  run: { sourceSpan: { start: number; end: number } },
  text: string,
): boolean {
  // The span covers the whole source token, which for `G81104` includes the
  // leading letter — so check the span itself as well as the characters
  // immediately flanking it.
  const within = text.slice(run.sourceSpan.start, run.sourceSpan.end);
  const charBefore = text.slice(Math.max(0, run.sourceSpan.start - 1), run.sourceSpan.start);
  const charAfter = text.slice(run.sourceSpan.end, run.sourceSpan.end + 1);
  return /[a-z]/i.test(within) || /[a-z]/i.test(charBefore) || /[a-z]/i.test(charAfter);
}

/**
 * True when a run could plausibly be part of a number split across messages.
 *
 * A genuine split ("98765" … "43210") arrives as bare digits with nothing
 * explaining them. A flight number, a price or a clock time always travels
 * with a word that gives it meaning — and must never be buffered, or unrelated
 * fragments eventually assemble into a valid-looking mobile by chance.
 *
 * No length floor. A single digit ("9", "8", "7"...) is the most extreme
 * split of all — a number sent one character per message — and used to be
 * excluded here on the theory that it was "usually a count". That theory is
 * exactly backwards for a message with NOTHING else in it: an isolated "2"
 * answering "how many guests?" is caught below by BENIGN_NEIGHBOURS finding
 * "guests" in the question that preceded it, which is the correct filter.
 * A bare "9" with no explaining neighbour anywhere nearby has no innocent
 * reading regardless of length, and length was doing weaker, redundant work.
 */
function isPlausibleFragment(
  run: { digits: string; sourceSpan: { start: number; end: number } },
  views: NormalizedViews,
): boolean {
  const text = views.denoised;

  // Digits welded to a letter code are an identifier, not a fragment.
  if (isAlphanumericIdentifier(run, text)) return false;

  const before = text.slice(Math.max(0, run.sourceSpan.start - NEIGHBOUR_WINDOW), run.sourceSpan.start);
  const after = text.slice(run.sourceSpan.end, run.sourceSpan.end + NEIGHBOUR_WINDOW);

  return !BENIGN_NEIGHBOURS.test(before) && !BENIGN_NEIGHBOURS.test(after);
}

export interface AssessInput {
  request: ModerateRequest;
  views: NormalizedViews;
  detections: readonly Detection[];
  weirdTokenCount: number;
  /** Injected clock, so tests control decay and windows deterministically. */
  nowMs: number;
}

export interface RiskAssessment {
  band: Band;
  breakdown: ScoreBreakdown;
  /** Detections discovered only by the windowed re-scan. */
  rescanDetections: Detection[];
  /** A number reconstructed from fragments across messages, if any. */
  mergedNumber: { digits: string; contributingRuns: number } | null;
  /** State as it stands after this message. */
  state: PairState;
}

export interface RiskEngineOptions {
  store: SessionStore;
  config?: RiskConfig;
  trigramModel?: TrigramModel;
}

export class RiskEngine {
  private readonly store: SessionStore;
  private readonly config: RiskConfig;
  private readonly trigramModel: TrigramModel | undefined;

  constructor(options: RiskEngineOptions) {
    this.store = options.store;
    this.config = options.config ?? DEFAULT_RISK_CONFIG;
    this.trigramModel = options.trigramModel;
  }

  /**
   * Assess a message against the conversation's accumulated state, then
   * persist the updated state.
   */
  async assess(input: AssessInput): Promise<RiskAssessment> {
    const { request, views, detections, nowMs } = input;
    const session = this.config.session;

    const existing = await this.store.get(request.conversation_id);
    const state = existing ?? emptyPairState(nowMs);

    // --- decay carried-over pressure ---------------------------------------
    const decayedPressure = decayDigitPressure(state, nowMs, session.digitPressureHalfLifeMs);
    // Same half-life as digit pressure: both measure recent behaviour, not a
    // permanent record.
    const decayedIntentHits = decayIntentHits(state, nowMs, session.digitPressureHalfLifeMs);

    // --- windowed re-scan ---------------------------------------------------
    // Concatenate this sender's recent messages and re-run Tier 1+2, so a
    // number split across turns is seen as one run.
    const rescanDetections: Detection[] = [];
    const rescanText = buildRescanText(
      state.lastMessages,
      request.sender_role,
      request.text,
      session.windowedRescanMessages,
    );

    if (rescanText !== null) {
      const rescanViews = normalize(rescanText);
      const rescanResult = runDetectors(rescanViews);

      // A detection that any SINGLE message already produces on its own is
      // not a cross-boundary find — it was caught on its own turn and must
      // not be re-charged to this one. Without this, an earlier
      // "my number is 9876543210" was re-detected in every later message's
      // re-scan window and scored at full validPhone weight, so an innocent
      // price or flight number blocked at 13+.
      const seen = new Set(detections.map((d) => d.type));
      for (const remembered of state.lastMessages) {
        if (remembered.sender !== request.sender_role) continue;
        for (const d of runDetectors(normalize(remembered.text)).detections) {
          seen.add(d.type);
        }
      }

      // Joining messages creates ADJACENCY THAT NOBODY WROTE, and detectors
      // keying on proximity will happily fire on it. "wifi password is
      // villa98765" followed by "someone messaged me on whatsapp claiming to
      // be you" concatenates to put `whatsapp` next to `98765`, which the
      // handle detector reads as a messaging handle carrying a digit run —
      // a contact identifier assembled from two innocent messages, one of
      // which is a scam REPORT the platform most wants delivered.
      //
      // Type-level dedup cannot catch this: the fabricated type appears in no
      // single message, so it looks exactly like a genuine cross-boundary
      // find. The distinguishing property is that a real split number
      // RECOVERS AN IDENTIFIER the fragments could not produce alone — a
      // phone or a UPI id, whose digits come from more than one message.
      // Proximity-only detections (handles, channel names, addresses, plain
      // URLs) carry no such proof and are dropped.
      const RECOVERABLE = /^(?:contact\.phone|payment\.upi|contact\.email)/;

      // The current message must CONTRIBUTE to the cross-message find, or it
      // is not evidence about this message at all.
      //
      // The re-scan joins this sender's recent turns and re-detects over the
      // whole window, so once "98765" … "43210" is in history, `contact.phone`
      // is recoverable from that history on EVERY later message — and was
      // charged at the full 9.0 validPhone weight to messages containing no
      // digits whatsoever. "sorry, long day. let's just confirm the booking,
      // I've paid" blocked at 11.3 with an empty category list, which is the
      // engine asserting a phone number is present in a message that has none.
      //
      // Type-level dedup could not catch this either: the fragments produce
      // only `contact.phone.partial` individually, so the recovered
      // `contact.phone` is genuinely absent from every single message and
      // looks like a legitimate cross-boundary find on each new turn.
      //
      // Merely CONTAINING digits is not contributing: "will do! iPhone 15 Pro
      // 256GB" has two runs, neither of which is part of the number recovered
      // from earlier turns, and it blocked at 12.2 for a phone it does not
      // contain. The current message's digits must appear IN the recovered
      // identifier for it to be evidence about this message.
      const recoveredDigits = rescanResult.detections
        .filter((d) => RECOVERABLE.test(d.type))
        .map((d) => d.evidence.replace(/\D/g, ""))
        .filter((d) => d.length > 0);

      const currentContributes = views.digitRuns.some((run) =>
        recoveredDigits.some(
          (recovered) => run.digits.length > 0 && recovered.includes(run.digits),
        ),
      );

      for (const detection of rescanResult.detections) {
        if (!currentContributes) break;
        if (seen.has(detection.type)) continue;
        if (!detection.type.startsWith("contact.") && !detection.type.startsWith("payment.")) continue;
        if (!RECOVERABLE.test(detection.type)) continue;
        rescanDetections.push({
          ...detection,
          evidence: `${detection.evidence} (windowed re-scan across messages)`,
        });
      }
    }

    // --- fragment merging ---------------------------------------------------
    const fragments = pruneFragments(
      state.fragmentBuffer,
      nowMs,
      session.fragmentWindowMs,
      session.fragmentBufferSize,
    );
    // Only runs that plausibly belong to a SPLIT phone number are buffered.
    //
    // Two exclusions, both learned the hard way:
    //   - a run that is already a complete valid number was caught on its own
    //     turn and only glues onto later digits if kept;
    //   - a run Tier 2 explained as ordinary content — a flight number, a
    //     clock time, a price, "iPhone 15" — is not a fragment of anything.
    //     Buffering those let "62134" + "940" + "15" assemble into
    //     "6213494015", a structurally valid IN mobile that nobody sent, and
    //     from then on every message blocked.
    const explainedByTier2 = new Set(
      detections
        .filter((d) => !d.type.startsWith("contact.phone"))
        .flatMap((d) => views.digitRuns
          .filter((r) => r.sourceSpan.start >= d.span.start && r.sourceSpan.end <= d.span.end)
          .map((r) => r.digits)),
    );

    const currentFragments = views.digitRuns
      .filter((run) => !isCompletePhone(run.digits))
      .filter((run) => !explainedByTier2.has(run.digits))
      .filter((run) => isPlausibleFragment(run, views))
      .map((run) => ({
        run,
        timestamp: nowMs,
        sender: request.sender_role,
      }));
    const allFragments = [...fragments, ...currentFragments];

    const merged = mergeFragments(
      allFragments,
      request.sender_role,
      nowMs,
      session.fragmentWindowMs,
    );
    const validMerge = merged.find((m) => m.validPhone) ?? null;

    // --- score --------------------------------------------------------------
    const combinedDetections = [...detections, ...rescanDetections];
    const breakdown = scoreMessage(
      {
        detections: combinedDetections,
        signals: views.signals,
        digitRuns: views.digitRuns,
        weirdTokenCount: input.weirdTokenCount,
        digitPressure: decayedPressure,
        sessionIntentHits: decayedIntentHits,
        role: request.sender_role,
        stage: request.booking_stage,
        text: views.folded,
      },
      this.config,
    );

    // A number reconstructed from fragments inside the window is decisive:
    // SPEC §6 says block outright. Force the score past the high band rather
    // than special-casing the verdict, so the band logic stays single-source.
    let band = bandFor(breakdown.score, this.config);
    if (validMerge !== null) {
      band = "block";
      breakdown.contributions["mergedFragments"] = this.config.weights.validPhone;
      breakdown.score = Math.max(breakdown.score, this.config.bands.high + 1);
    }

    // Drop the fragments this merge consumed (see fragmentBuffer below).
    const retainedFragments =
      validMerge !== null
        ? allFragments.filter((f) => !validMerge.contributors.includes(f))
        : allFragments;

    // --- persist updated state ----------------------------------------------
    // Only count intent hits belonging to the CURRENT message's sender.
    // rescanDetections are found across THIS sender's recent turns, so they
    // stay in scope; but session.intentHits itself must never mix senders —
    // a guest's "call me" must not inflate the host's next "welcome!".
    const messageIntentHits = combinedDetections.filter((d) => d.type.startsWith("intent.")).length;

    // Digit pressure accrues from the volume of digits shared, pre-booking
    // being where it matters (SPEC §6). Post-booking numbers are usually
    // legitimate logistics, so they accrue at a heavily reduced rate.
    const pressureDelta =
      totalDigitCount(views.digitRuns) *
      (request.booking_stage === "pre_booking" ? 1 : 0.2);

    const nextState: PairState = {
      digitPressure: decayedPressure + pressureDelta,
      digitPressureUpdatedAt: nowMs,
      // Fragments that produced a merge are CONSUMED, not carried forward.
      //
      // A recovered number is acted on once, on the turn that completes it.
      // Leaving its parts in the buffer means they re-merge against every
      // later message and re-report the same number indefinitely: after
      // "98765" … "43210" was caught, an innocent "thanks, see you on the
      // 9th!" four turns later was still blocked with "combined with an
      // earlier message, this forms the number 9876543210" — a message with
      // no digits in it at all, held responsible for evidence that was
      // already handled.
      fragmentBuffer: pruneFragments(
        retainedFragments,
        nowMs,
        session.fragmentWindowMs,
        session.fragmentBufferSize,
      ),
      intentHits: decayedIntentHits + messageIntentHits,
      intentHitsUpdatedAt: nowMs,
      strikes: state.strikes + (band === "block" ? 1 : 0),
      lastMessages: [
        ...state.lastMessages,
        { text: request.text, sender: request.sender_role, timestamp: nowMs },
      ].slice(-session.lastMessagesSize),
      recentBlocks:
        band === "block"
          ? [...state.recentBlocks, nowMs].filter(
              (t) => nowMs - t <= this.config.policy.blockCooldownWindowMs,
            )
          : state.recentBlocks.filter((t) => nowMs - t <= this.config.policy.blockCooldownWindowMs),
    };

    await this.store.set(request.conversation_id, nextState);

    return {
      band,
      breakdown,
      rescanDetections,
      mergedNumber:
        validMerge !== null
          ? { digits: validMerge.digits, contributingRuns: validMerge.contributingRuns }
          : null,
      state: nextState,
    };
  }

  /** Convenience wrapper that runs Tiers 1-3 in one call. */
  async assessText(request: ModerateRequest, nowMs: number): Promise<RiskAssessment> {
    const views = normalize(request.text);
    const { detections } = runDetectors(views);
    const weirdTokenCount =
      this.trigramModel !== undefined
        ? messageWeirdness(views.folded, this.trigramModel).weirdTokenCount
        : 0;

    return this.assess({ request, views, detections, weirdTokenCount, nowMs });
  }
}

export { DEFAULT_RISK_CONFIG } from "./config.js";
export type { RiskConfig, RiskWeights, SafetyWeights } from "./config.js";
export { bandFor, scoreMessage } from "./score.js";
export type { Band, ScoreBreakdown, ScoreInput } from "./score.js";
export {
  MemorySessionStore,
  decayDigitPressure,
  emptyPairState,
  pruneFragments,
} from "./state.js";
export type { PairState, SessionStore, TimestampedRun, RememberedMessage } from "./state.js";
export { buildRescanText, mergeFragments, totalDigitCount, uniqueDigitCount } from "./rescan.js";
export type { MergedFragment } from "./rescan.js";
