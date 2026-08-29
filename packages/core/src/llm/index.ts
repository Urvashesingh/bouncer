/**
 * Tier 5 — LLM adjudicator (SPEC §8).
 *
 * Runs only on the sliver of traffic Tiers 1-4 could not resolve. Cache-first,
 * strictly time-boxed, and injection-hardened.
 *
 * The HTTP call is INJECTED as a transport function rather than performed
 * here: core does no network I/O (SPEC §1), which is what lets the same engine
 * run in the browser playground. The server supplies a real Groq transport.
 */

import { LruCache, cacheKey, type AdjudicationCache } from "./cache.js";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  makeSentinel,
  parseVerdict,
  type AdjudicationVerdict,
} from "./prompt.js";
import { clearTimer, createAbortController, now, setTimer, type AbortSignalLike } from "../clock.js";
import type { BookingStage } from "../types.js";

/** Groq pricing for llama-3.1-8b-instant (SPEC §8), USD per million tokens. */
export const GROQ_PRICING = {
  inputPerMillion: 0.05,
  outputPerMillion: 0.08,
};

export interface LlmRequest {
  system: string;
  user: string;
  model: string;
  /** Abort signal wired to the timeout. */
  signal?: AbortSignalLike;
}

export interface LlmResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/** Injected transport. The server implements this against the Groq API. */
export type LlmTransport = (request: LlmRequest) => Promise<LlmResponse>;

export type AdjudicationSource = "cache" | "llm" | "timeout" | "error" | "disabled";

export interface AdjudicationResult {
  verdict: AdjudicationVerdict | null;
  source: AdjudicationSource;
  costUsd: number;
  latencyMs: number;
  /** Populated when the call failed, for the /v1/stats error counters. */
  error?: string;
}

export interface AdjudicatorOptions {
  transport: LlmTransport;
  model?: string;
  /** SPEC §8: 1200ms, then fall back. */
  timeoutMs?: number;
  cache?: AdjudicationCache<AdjudicationVerdict>;
  enabled?: boolean;
  random?: () => number;
}

/** Distinguishes a timeout from a transport failure in the catch block. */
export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class Adjudicator {
  private readonly transport: LlmTransport;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  private readonly random: () => number;
  readonly cache: AdjudicationCache<AdjudicationVerdict>;

  /** Counters for GET /v1/stats (SPEC §2). */
  readonly stats = { calls: 0, cacheHits: 0, timeouts: 0, errors: 0, costUsd: 0 };

  constructor(options: AdjudicatorOptions) {
    this.transport = options.transport;
    this.model = options.model ?? "llama-3.1-8b-instant";
    this.timeoutMs = options.timeoutMs ?? 1200;
    this.enabled = options.enabled ?? true;
    this.random = options.random ?? Math.random;
    this.cache = options.cache ?? new LruCache<AdjudicationVerdict>(50_000);
  }

  /**
   * Adjudicate a message. `foldedText` is the Tier 1 folded view: using it as
   * the cache key means trivial variants share one adjudication.
   */
  async adjudicate(foldedText: string, rawText: string): Promise<AdjudicationResult> {
    const started = now();

    if (!this.enabled) {
      return { verdict: null, source: "disabled", costUsd: 0, latencyMs: 0 };
    }

    // --- cache first (SPEC §8) ---------------------------------------------
    const key = cacheKey(foldedText);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return { verdict: cached, source: "cache", costUsd: 0, latencyMs: now() - started };
    }

    // --- call the model ----------------------------------------------------
    const sentinel = makeSentinel(this.random);
    const controller = createAbortController();

    // The timeout must be a RACE, not just an abort signal. Aborting asks the
    // transport to stop; a transport that ignores the signal (or a hung
    // socket) would otherwise leave us awaiting forever and blow the latency
    // budget the whole cascade is built to protect.
    let timer: unknown;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimer(() => {
        controller.abort();
        reject(new TimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });

    try {
      this.stats.calls++;
      const response = await Promise.race([
        this.transport({
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(rawText, sentinel),
          model: this.model,
          signal: controller.signal,
        }),
        timeout,
      ]);

      const verdict = parseVerdict(response.content);
      const costUsd = estimateCost(response.usage);
      this.stats.costUsd += costUsd;

      // Only cache a well-formed verdict: caching a parse failure would pin
      // the failure for every future occurrence of that message.
      if (verdict !== null) this.cache.set(key, verdict);

      return {
        verdict,
        source: "llm",
        costUsd,
        latencyMs: now() - started,
        ...(verdict === null ? { error: "unparseable response" } : {}),
      };
    } catch (error) {
      const timedOut = error instanceof TimeoutError || controller.signal.aborted;
      if (timedOut) this.stats.timeouts++;
      else this.stats.errors++;

      return {
        verdict: null,
        source: timedOut ? "timeout" : "error",
        costUsd: 0,
        latencyMs: now() - started,
        error: timedOut ? `timeout after ${this.timeoutMs}ms` : String(error),
      };
    } finally {
      clearTimer(timer);
    }
  }
}

export function estimateCost(usage: LlmResponse["usage"]): number {
  if (usage === undefined) return 0;
  return (
    (usage.promptTokens / 1_000_000) * GROQ_PRICING.inputPerMillion +
    (usage.completionTokens / 1_000_000) * GROQ_PRICING.outputPerMillion
  );
}

/**
 * Failure policy (SPEC §2): pre_booking fails CLOSED, post_booking fails OPEN.
 *
 * Applied when Tier 5 could not produce a verdict. Pre-booking is where
 * contact-sharing fraud lives, so an unresolved message is blocked; after
 * booking the pair has a legitimate reason to talk and the cost of blocking
 * outweighs the risk.
 */
export function applyFailMode(
  stage: BookingStage,
  failMode: Record<BookingStage, "open" | "closed">,
): "block" | "allow" {
  return failMode[stage] === "closed" ? "block" : "allow";
}

export { LruCache, cacheKey } from "./cache.js";
export type { AdjudicationCache } from "./cache.js";
export {
  SYSTEM_PROMPT,
  buildUserPrompt,
  makeSentinel,
  parseVerdict,
} from "./prompt.js";
export type { AdjudicationVerdict } from "./prompt.js";
