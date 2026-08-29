/**
 * Bouncer engine entry point.
 *
 * Cost-descending cascade (SPEC §0): free deterministic tiers resolve the vast
 * majority of messages; only borderline traffic escalates. Tiers land in build
 * order (SPEC §12) — all five tiers are in place.
 */

import { now } from "./clock.js";
import { classify, type ClassifierModel } from "./classifier/index.js";
import { Adjudicator, applyFailMode, type AdjudicationResult } from "./llm/index.js";
import { runDetectors } from "./detectors/index.js";
import { normalize } from "./normalize/index.js";
import { RiskEngine, bandFor, type Band } from "./risk/index.js";
import { DEFAULT_RISK_CONFIG, type RiskConfig } from "./risk/config.js";
import { scoreMessage } from "./risk/score.js";
import type { SessionStore } from "./risk/state.js";
import { messageWeirdness, type TrigramModel } from "./weirdness/index.js";
import type {
  Category,
  ModerateRequest,
  ModerateResult,
  ResolvedBy,
  Span,
  Verdict,
} from "./types.js";

export interface ModerateOptions {
  /**
   * Trigram model for the weirdness meter (SPEC §5). Injected rather than
   * loaded, because core does no fs I/O (SPEC §1). Omit to skip weirdness.
   */
  trigramModel?: TrigramModel;
  /**
   * Tier 4 classifier (SPEC §7). Omit to skip Tier 4, in which case the
   * escalation band resolves as `review`.
   */
  classifierModel?: ClassifierModel;
  /** Tier 3 weights and bands. Defaults to DEFAULT_RISK_CONFIG. */
  config?: RiskConfig;
  /**
   * Tier 5 adjudicator (SPEC §8). Only consulted when Tier 4 is still
   * uncertain. Requires the async entry points, since it performs I/O.
   */
  adjudicator?: Adjudicator;
  /** Injected clock, so tests and benchmarks are deterministic. */
  nowMs?: number;
}

export interface ModerateStatefulOptions extends ModerateOptions {
  /** Session store enabling relationship-level accumulation (SPEC §6). */
  store: SessionStore;
}

/**
 * Stateless moderation: Tiers 1-3 over a single message, with no
 * relationship-level accumulation. Use `moderateStateful` when a
 * conversation_id's history should count.
 */
export function moderate(req: ModerateRequest, options: ModerateOptions = {}): ModerateResult {
  const started = now();
  const config = options.config ?? DEFAULT_RISK_CONFIG;

  const views = normalize(req.text);
  const { detections, intentHits } = runDetectors(views);

  // Weirdness runs on the folded view: confusables are already ASCII, but the
  // noise digits that make mangling visible are still present.
  const weirdness =
    options.trigramModel !== undefined
      ? messageWeirdness(views.folded, options.trigramModel)
      : null;

  const breakdown = scoreMessage(
    {
      detections,
      signals: views.signals,
      digitRuns: views.digitRuns,
      weirdTokenCount: weirdness?.weirdTokenCount ?? 0,
      digitPressure: 0,
      sessionIntentHits: 0,
      role: req.sender_role,
      stage: req.booking_stage,
      text: views.folded,
    },
    config,
  );

  const band = bandFor(breakdown.score, config);

  // Tier 4 only runs on the band Tier 3 could not resolve — that is the whole
  // point of the cascade, and it is also what the classifier was trained on.
  const tier4 =
    band === "escalate" && options.classifierModel !== undefined
      ? classify(
          {
            detections,
            signals: views.signals,
            digitRuns: views.digitRuns,
            text: views.folded,
            weirdTokenCount: weirdness?.weirdTokenCount ?? 0,
            riskScore: breakdown.score,
            digitPressure: 0,
            role: req.sender_role,
            stage: req.booking_stage,
          },
          options.classifierModel,
        )
      : null;

  return buildResult({
    band,
    detections,
    intentHits,
    views,
    weirdness,
    breakdown,
    started,
    tier4,
  });
}

/**
 * Stateless moderation with Tier 5 (SPEC §8).
 *
 * Same as `moderate`, but async so the adjudicator can be consulted when
 * Tiers 1-4 leave the message unresolved. Use this when there is no
 * conversation history to draw on; `moderateStateful` when there is.
 */
export async function moderateAsync(
  req: ModerateRequest,
  options: ModerateOptions = {},
): Promise<ModerateResult> {
  const config = options.config ?? DEFAULT_RISK_CONFIG;
  const sync = moderate(req, options);

  // Only `review` can still be improved by Tier 5; everything else is settled.
  if (sync.verdict !== "review" || options.adjudicator === undefined) return sync;

  const started = now();
  const views = normalize(req.text);
  const tier5 = await options.adjudicator.adjudicate(views.folded, req.text);

  if (tier5.verdict !== null) {
    const flagged = tier5.verdict.contact || tier5.verdict.safety;
    return {
      ...sync,
      verdict: flagged ? "block" : "allow",
      resolved_by: tier5.source === "cache" ? "cache" : "tier5.llm",
      signals: {
        ...sync.signals,
        llm_source: tier5.source,
        llm_contact: tier5.verdict.contact,
        llm_safety: tier5.verdict.safety,
        llm_confidence: tier5.verdict.confidence,
      },
      latency_ms: sync.latency_ms + (now() - started),
      cost_usd: tier5.costUsd,
    };
  }

  // No verdict — apply the SPEC §2 failure policy.
  const failVerdict = applyFailMode(req.booking_stage, config.failMode);
  return {
    ...sync,
    verdict: failVerdict === "block" ? "block" : "review",
    resolved_by: "tier5.llm",
    signals: { ...sync.signals, llm_source: tier5.source, llm_error: tier5.error },
    latency_ms: sync.latency_ms + (now() - started),
    cost_usd: 0,
  };
}

/**
 * Stateful moderation: Tiers 1-3 with relationship-level accumulation,
 * windowed re-scan and cross-message fragment merging (SPEC §6).
 */
export async function moderateStateful(
  req: ModerateRequest,
  options: ModerateStatefulOptions,
): Promise<ModerateResult> {
  const started = now();
  const config = options.config ?? DEFAULT_RISK_CONFIG;
  const nowMs = options.nowMs ?? Date.now();

  const views = normalize(req.text);
  const { detections, intentHits } = runDetectors(views);
  const weirdness =
    options.trigramModel !== undefined
      ? messageWeirdness(views.folded, options.trigramModel)
      : null;

  const engine = new RiskEngine({
    store: options.store,
    config,
    ...(options.trigramModel !== undefined ? { trigramModel: options.trigramModel } : {}),
  });

  const assessment = await engine.assess({
    request: req,
    views,
    detections,
    weirdTokenCount: weirdness?.weirdTokenCount ?? 0,
    nowMs,
  });

  const tier4 =
    assessment.band === "escalate" && options.classifierModel !== undefined
      ? classify(
          {
            detections: [...detections, ...assessment.rescanDetections],
            signals: views.signals,
            digitRuns: views.digitRuns,
            text: views.folded,
            weirdTokenCount: weirdness?.weirdTokenCount ?? 0,
            riskScore: assessment.breakdown.score,
            digitPressure: assessment.state.digitPressure,
            role: req.sender_role,
            stage: req.booking_stage,
          },
          options.classifierModel,
        )
      : null;

  // Tier 5 runs only where Tier 4 is still uncertain — or where Tier 4 is
  // absent entirely and Tier 3 escalated. That is the ~0-2% of traffic the
  // whole cascade exists to shrink (SPEC §8).
  const needsAdjudication =
    assessment.band === "escalate" && (tier4 === null || tier4.decision === "escalate");

  const tier5 =
    needsAdjudication && options.adjudicator !== undefined
      ? await options.adjudicator.adjudicate(views.folded, req.text)
      : null;

  return buildResult({
    band: assessment.band,
    // Only THIS message's own detections become categories and spans.
    // Windowed re-scan hits belong to earlier turns; reporting them here
    // makes the engine claim "looks like a phone number" about a message
    // that contains no number, and produces spans that do not index into
    // this text. They are surfaced separately, and Tier 4 still sees them.
    detections,
    rescanDetections: assessment.rescanDetections,
    intentHits,
    views,
    weirdness,
    breakdown: assessment.breakdown,
    started,
    tier4,
    tier5,
    failMode: config.failMode,
    stage: req.booking_stage,
    extraSignals: {
      digit_pressure: round(assessment.state.digitPressure),
      session_intent_hits: assessment.state.intentHits,
      strikes: assessment.state.strikes,
      ...(assessment.mergedNumber !== null
        ? {
            merged_fragments: assessment.mergedNumber.digits,
            merged_from_messages: assessment.mergedNumber.contributingRuns,
          }
        : {}),
    },
  });
}

interface BuildResultInput {
  band: Band;
  detections: readonly import("./types.js").Detection[];
  intentHits: string[];
  views: import("./types.js").NormalizedViews;
  weirdness: ReturnType<typeof messageWeirdness> | null;
  breakdown: ReturnType<typeof scoreMessage>;
  started: number;
  /** Evidence found only by looking across recent turns (SPEC §6). */
  rescanDetections?: readonly import("./types.js").Detection[];
  /** Tier 4 output, present only when Tier 3 escalated (SPEC §7). */
  tier4?: ReturnType<typeof classify> | null;
  /** Tier 5 output, present only when Tier 4 was still uncertain (SPEC §8). */
  tier5?: AdjudicationResult | null;
  /** Fail-open/closed policy, applied when Tier 5 produced no verdict. */
  failMode?: Record<import("./types.js").BookingStage, "open" | "closed">;
  stage?: import("./types.js").BookingStage;
  extraSignals?: Record<string, unknown>;
}

function buildResult(input: BuildResultInput): ModerateResult {
  const { band, detections, intentHits, views, weirdness, breakdown, started } = input;
  const tier4 = input.tier4 ?? null;
  const tier5 = input.tier5 ?? null;

  const categories: Category[] = [...new Set(detections.map((d) => d.type))];
  const spans: Span[] = detections.map((d) => ({
    start: d.span.start,
    end: d.span.end,
    type: d.type,
  }));

  // Tier 3 bands resolve directly; only the escalate band consults Tier 4.
  // Where Tier 4 is absent or still uncertain, the verdict stays `review`
  // rather than silently allowing — the conservative reading of the SPEC §2
  // failure policy, and the hand-off point for Tier 5 at build step 8.
  let verdict: Verdict;
  let resolvedBy: ResolvedBy;

  if (band === "allow") {
    verdict = "allow";
    resolvedBy = detections.length === 0 ? "tier1.normalize" : "tier3.risk";
  } else if (band === "block") {
    verdict = "block";
    resolvedBy = "tier3.risk";
  } else if (tier4 !== null && tier4.decision !== "escalate") {
    // Tier 4 resolves UNCERTAINTY; it must never overturn hard evidence.
    // A statistical model trained on a finite corpus will confidently allow
    // patterns it has not seen — "my digits: nine seven double three ..."
    // scored p=0.004 despite Tier 2 having found a contact fragment. Letting
    // that downgrade a deterministic detection would make the cheap, reliable
    // tiers subordinate to the one that generalises worst.
    // "Hard" means a RECOVERED identifier, not merely a contact-shaped hint.
    // Partials, bare handles and plain URLs are exactly the ambiguity Tier 4
    // exists to adjudicate — guarding those too would pin every borderline
    // legitimate message ("is there a landline in the room?") at review and
    // spend the friction budget defending against a hypothetical.
    const hasHardEvidence = detections.some(
      (d) =>
        d.type === "contact.phone" ||
        d.type === "contact.phone.obfuscated" ||
        d.type.startsWith("contact.email") ||
        d.type.startsWith("payment.upi") ||
        d.type === "contact.url.messenger",
    );

    if (tier4.decision === "allow" && hasHardEvidence) {
      verdict = "review";
      resolvedBy = "tier4.classifier";
    } else {
      verdict = tier4.decision === "block" ? "block" : "allow";
      resolvedBy = "tier4.classifier";
    }
  } else if (tier5 !== null) {
    // --- Tier 5 (SPEC §8) --------------------------------------------------
    if (tier5.verdict !== null) {
      const flagged = tier5.verdict.contact || tier5.verdict.safety;
      verdict = flagged ? "block" : "allow";
      resolvedBy = tier5.source === "cache" ? "cache" : "tier5.llm";
    } else {
      // No verdict: timeout or error. SPEC §2 failure policy — pre_booking
      // fails CLOSED, post_booking fails OPEN. Sync callers additionally see
      // `review` so a human can look, rather than a silent block.
      const failVerdict =
        input.failMode !== undefined && input.stage !== undefined
          ? applyFailMode(input.stage, input.failMode)
          : "review";
      verdict = failVerdict === "block" ? "block" : "review";
      resolvedBy = "tier5.llm";
    }
  } else {
    verdict = "review";
    resolvedBy = tier4 !== null ? "tier4.classifier" : "tier3.risk";
  }

  return {
    verdict,
    categories,
    spans,
    confidence: detections.reduce((max, d) => Math.max(max, d.confidence), band === "allow" ? 1 : 0),
    resolved_by: resolvedBy,
    signals: {
      intent_hits: intentHits,
      risk_score: round(breakdown.score),
      contact_score: round(breakdown.contactRaw),
      safety_score: round(breakdown.safetyRaw),
      contributions: breakdown.contributions,
      stage_modifier: breakdown.stageModifier,
      role_modifier: breakdown.roleModifier,
      noise_digits_removed: views.signals.noiseDigitsRemoved,
      zero_width_count: views.signals.zeroWidthCount,
      confusables_folded: views.signals.confusablesFolded,
      digit_runs: views.digitRuns.length,
      detections: detections.length,
      ...(weirdness !== null
        ? { weirdness: round(weirdness.score), weird_tokens: weirdness.weirdTokenCount }
        : {}),
      ...((input.rescanDetections?.length ?? 0) > 0
        ? {
            cross_message_categories: [
              ...new Set((input.rescanDetections ?? []).map((d) => d.type)),
            ],
          }
        : {}),
      ...(tier4 !== null
        ? { classifier_p: round(tier4.probability), classifier_decision: tier4.decision }
        : {}),
      ...(tier5 !== null
        ? {
            llm_source: tier5.source,
            llm_latency_ms: round(tier5.latencyMs),
            ...(tier5.verdict !== null
              ? {
                  llm_contact: tier5.verdict.contact,
                  llm_contact_type: tier5.verdict.contact_type,
                  llm_safety: tier5.verdict.safety,
                  llm_safety_type: tier5.verdict.safety_type,
                  llm_confidence: tier5.verdict.confidence,
                }
              : {}),
            ...(tier5.error !== undefined ? { llm_error: tier5.error } : {}),
          }
        : {}),
      ...(input.extraSignals ?? {}),
    },
    latency_ms: now() - started,
    cost_usd: tier5?.costUsd ?? 0,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export { normalize } from "./normalize/index.js";
export { runDetectors } from "./detectors/index.js";
export { messageWeirdness, scoreToken, percentile } from "./weirdness/index.js";
export { classify, predictProbability, extractFeatures } from "./classifier/index.js";
export {
  Adjudicator,
  LruCache,
  cacheKey,
  parseVerdict,
  buildUserPrompt,
  applyFailMode,
  SYSTEM_PROMPT,
  GROQ_PRICING,
} from "./llm/index.js";
export type {
  AdjudicationResult,
  AdjudicationVerdict,
  LlmTransport,
  LlmRequest,
  LlmResponse,
} from "./llm/index.js";
export type { ClassifierModel, ClassifierResult, FeatureInput } from "./classifier/index.js";
export type { TrigramModel, MessageWeirdness, TokenScore } from "./weirdness/index.js";
export * from "./risk/index.js";
export {
  applyPolicy,
  maskSpans,
  RateLimiter,
  senderKey,
  toPendingResult,
  REASONS,
} from "./policy/index.js";
export type { Action, PolicyDecision, PolicyOptions } from "./policy/index.js";
export { createGroqTransport } from "./llm/groq.js";
export * from "./types.js";
