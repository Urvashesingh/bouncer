/**
 * Fastify app (SPEC §2, §9).
 *
 * POST /v1/moderate  — the moderation endpoint
 * GET  /v1/health    — liveness plus which models are loaded
 * GET  /v1/stats     — per-tier counters, feeds the cost slide
 */

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import {
  Adjudicator,
  MemorySessionStore,
  RateLimiter,
  applyPolicy,
  createGroqTransport,
  moderateStateful,
  senderKey,
  toPendingResult,
} from "@bouncer/core";
import type {
  BookingStage,
  ModerateRequest,
  ModerateResult,
  ResolvedBy,
  SenderRole,
  SessionStore,
} from "@bouncer/core";

import type { ServerConfig } from "./config.js";

const ROLES = new Set(["guest", "host"]);
const STAGES = new Set(["pre_booking", "post_booking"]);
const MODES = new Set(["sync", "async"]);

/** Bound so a single message cannot monopolise the engine. */
const MAX_TEXT_LENGTH = 8000;

export interface Stats {
  requests: number;
  byTier: Record<string, number>;
  byVerdict: Record<string, number>;
  totalCostUsd: number;
  latencySamples: number[];
  llm: { calls: number; cacheHits: number; timeouts: number; errors: number };
  startedAt: number;
}

export interface AppOptions {
  config: ServerConfig;
  /** Injected for tests; defaults to an in-memory store. */
  store?: SessionStore;
  adjudicator?: Adjudicator;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { config } = options;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  const store = options.store ?? new MemorySessionStore();
  const rateLimiter = new RateLimiter(
    config.riskConfig.policy.blockCooldownThreshold,
    config.riskConfig.policy.blockCooldownWindowMs,
  );

  // Tier 5 is optional: with no key the cascade simply stops at Tier 4 and
  // unresolved messages fall to the SPEC §2 failure policy.
  const adjudicator =
    options.adjudicator ??
    (config.tier5Enabled && config.groqApiKey !== undefined
      ? new Adjudicator({
          transport: createGroqTransport({ apiKey: config.groqApiKey }),
          model: config.groqModel,
          timeoutMs: 1200,
        })
      : undefined);

  const stats: Stats = {
    requests: 0,
    byTier: {},
    byVerdict: {},
    totalCostUsd: 0,
    latencySamples: [],
    llm: { calls: 0, cacheHits: 0, timeouts: 0, errors: 0 },
    startedAt: Date.now(),
  };

  void app.register(cors, { origin: config.corsOrigin });

  // --- POST /v1/moderate ---------------------------------------------------
  app.post("/v1/moderate", async (request, reply) => {
    const body = request.body as Partial<ModerateRequest> | undefined;
    const invalid = validate(body);
    if (invalid !== null) {
      return reply.code(400).send({ error: "invalid_request", detail: invalid });
    }

    const req: ModerateRequest = {
      message_id: body!.message_id!,
      conversation_id: body!.conversation_id!,
      sender_role: body!.sender_role as SenderRole,
      booking_stage: body!.booking_stage as BookingStage,
      text: body!.text!,
      mode: body!.mode ?? "sync",
    };

    const key = senderKey(req.conversation_id, req.sender_role);

    let result: ModerateResult;
    try {
      result = await moderateStateful(req, {
        store,
        config: config.riskConfig,
        ...(config.trigramModel !== undefined ? { trigramModel: config.trigramModel } : {}),
        ...(config.classifierModel !== undefined ? { classifierModel: config.classifierModel } : {}),
        ...(adjudicator !== undefined ? { adjudicator } : {}),
      });
    } catch (error) {
      // SPEC §2 failure policy applies to engine faults too, not just LLM
      // timeouts: pre_booking fails CLOSED.
      request.log.error(error);
      const failClosed = config.riskConfig.failMode[req.booking_stage] === "closed";
      stats.requests++;
      return reply.code(failClosed ? 200 : 200).send({
        verdict: failClosed ? "block" : "allow",
        categories: [],
        spans: [],
        confidence: 0,
        resolved_by: "tier1.normalize",
        signals: { error: "engine_error" },
        latency_ms: 0,
        cost_usd: 0,
      });
    }

    const decision = applyPolicy(result, req.text, {
      recentBlocks: rateLimiter.recentBlocks(key),
      blockCooldownThreshold: config.riskConfig.policy.blockCooldownThreshold,
    });

    if (decision.action === "block") rateLimiter.recordBlock(key);

    // --- stats ------------------------------------------------------------
    stats.requests++;
    stats.byTier[result.resolved_by] = (stats.byTier[result.resolved_by] ?? 0) + 1;
    stats.byVerdict[result.verdict] = (stats.byVerdict[result.verdict] ?? 0) + 1;
    stats.totalCostUsd += result.cost_usd;
    stats.latencySamples.push(result.latency_ms);
    if (stats.latencySamples.length > 10_000) stats.latencySamples.shift();
    if (adjudicator !== undefined) {
      stats.llm = {
        calls: adjudicator.stats.calls,
        cacheHits: adjudicator.stats.cacheHits,
        timeouts: adjudicator.stats.timeouts,
        errors: adjudicator.stats.errors,
      };
    }

    // --- async mode (SPEC §9) ---------------------------------------------
    // Deliver immediately, adjudicate behind the scenes. The final verdict is
    // already computed here; a production build would post it to a webhook.
    const payload = req.mode === "async" ? toPendingResult(result) : result;

    return reply.send({
      ...payload,
      action: decision.action,
      reason: decision.reason,
      delivered_text: decision.deliveredText,
      masked_spans: decision.maskedSpans,
      cooldown: decision.cooldown,
      ...(req.mode === "async" ? { final_verdict: result.verdict } : {}),
    });
  });

  // --- GET /v1/health ------------------------------------------------------
  app.get("/v1/health", async () => ({
    status: "ok",
    uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
    tiers: {
      "1_normalize": true,
      "2_detectors": true,
      "3_risk": true,
      "4_classifier": config.classifierModel !== undefined,
      "5_llm": adjudicator !== undefined,
    },
    weirdness_model: config.trigramModel !== undefined,
    fail_mode: config.riskConfig.failMode,
  }));

  // --- GET /v1/stats -------------------------------------------------------
  app.get("/v1/stats", async () => {
    const sorted = [...stats.latencySamples].sort((a, b) => a - b);
    const total = Math.max(1, stats.requests);

    const tierShare: Record<string, string> = {};
    for (const [tier, count] of Object.entries(stats.byTier)) {
      tierShare[tier] = `${((count / total) * 100).toFixed(2)}%`;
    }

    // Cost per 100k projected from what has actually been spent so far.
    const costPer100k = (stats.totalCostUsd / total) * 100_000;

    return {
      requests: stats.requests,
      by_tier: stats.byTier,
      tier_share: tierShare,
      by_verdict: stats.byVerdict,
      latency_ms: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
      },
      cost: {
        total_usd: Number(stats.totalCostUsd.toFixed(8)),
        per_100k_usd: Number(costPer100k.toFixed(4)),
      },
      llm: stats.llm,
      uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
    };
  });

  return app;
}

function validate(body: Partial<ModerateRequest> | undefined): string | null {
  if (body === undefined || body === null || typeof body !== "object") return "body must be an object";
  if (typeof body.message_id !== "string" || body.message_id === "") return "message_id is required";
  // SPEC §2: required, because it is what enables relationship-level state.
  if (typeof body.conversation_id !== "string" || body.conversation_id === "")
    return "conversation_id is required";
  if (typeof body.text !== "string") return "text is required";
  if (body.text.length > MAX_TEXT_LENGTH) return `text exceeds ${MAX_TEXT_LENGTH} characters`;
  if (!ROLES.has(String(body.sender_role))) return "sender_role must be guest or host";
  if (!STAGES.has(String(body.booking_stage)))
    return "booking_stage must be pre_booking or post_booking";
  if (body.mode !== undefined && !MODES.has(String(body.mode))) return "mode must be sync or async";
  return null;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const value = low === high ? sorted[low]! : sorted[low]! + (rank - low) * (sorted[high]! - sorted[low]!);
  return Number(value.toFixed(3));
}

export type { ResolvedBy };
