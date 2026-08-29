/**
 * Policy layer (SPEC §9) — verdict → action.
 *
 * Two design rules drive everything here:
 *
 * 1. ORACLE RESISTANCE. A blocked message returns a generic reason and never
 *    reveals which pattern tripped. Telling an attacker "we detected a phone
 *    number in a handle" turns the engine into a free oracle they can grind
 *    against until they find what slips through.
 * 2. PROPORTIONALITY. Blocking is the last resort, not the first. Masking
 *    delivers the message with the offending span hidden, which preserves the
 *    conversation while removing the payload.
 */

import type { Category, ModerateResult, SenderRole, Span, Verdict } from "../types.js";

export type Action = "deliver" | "warn" | "mask" | "block" | "review";

export interface PolicyDecision {
  action: Action;
  /** Text shown to the sender. Deliberately generic for blocks. */
  reason: string;
  /** The message as it should be delivered, with masked spans replaced. */
  deliveredText: string | null;
  /** Spans replaced in `deliveredText`. */
  maskedSpans: Span[];
  /** True when the sender has tripped the rate limit (SPEC §9). */
  cooldown: boolean;
}

/**
 * Generic block reasons. One per broad family — enough for a user to
 * understand and appeal, not enough to reverse-engineer the detector.
 */
const BLOCK_REASONS: Record<string, string> = {
  contact: "This message can't be sent because it looks like it shares contact details. Keep conversations here so we can support you if something goes wrong.",
  safety: "This message can't be sent because it may violate our community guidelines.",
  default: "This message can't be sent. Please review our messaging guidelines.",
};

const WARN_REASONS: Record<string, string> = {
  contact: "Sharing contact details before booking isn't allowed. Bookings made outside the platform aren't protected.",
  safety: "Please keep the conversation respectful.",
  default: "Please review our messaging guidelines.",
};

const MASK_CHAR = "•";
const MASK_TOKEN = "•••";

/** Which family a set of categories belongs to, for reason selection. */
function familyOf(categories: readonly Category[]): "contact" | "safety" | "default" {
  if (categories.some((c) => c.startsWith("safety."))) return "safety";
  if (categories.some((c) => c.startsWith("contact.") || c.startsWith("payment.") || c.startsWith("intent.")))
    return "contact";
  return "default";
}

export interface PolicyOptions {
  /** Sender's recent block count, for the cooldown rule (SPEC §9). */
  recentBlocks?: number;
  blockCooldownThreshold?: number;
  /**
   * When true, a `block` is downgraded to `mask` where maskable spans exist.
   * Masking preserves the conversation and is the friendlier default for
   * contact leaks; safety blocks are never downgraded.
   */
  preferMasking?: boolean;
}

/**
 * Map an engine result to a deliverable action.
 */
export function applyPolicy(
  result: ModerateResult,
  originalText: string,
  options: PolicyOptions = {},
): PolicyDecision {
  const family = familyOf(result.categories);
  const threshold = options.blockCooldownThreshold ?? 3;
  const cooldown = (options.recentBlocks ?? 0) >= threshold;

  switch (result.verdict) {
    case "allow":
      return {
        action: "deliver",
        reason: "",
        deliveredText: originalText,
        maskedSpans: [],
        cooldown,
      };

    case "warn":
      return {
        action: "warn",
        reason: WARN_REASONS[family] ?? WARN_REASONS["default"]!,
        deliveredText: originalText,
        maskedSpans: [],
        cooldown,
      };

    case "mask": {
      const { text, spans } = maskSpans(originalText, result.spans);
      return {
        action: "mask",
        reason: WARN_REASONS[family] ?? WARN_REASONS["default"]!,
        deliveredText: text,
        maskedSpans: spans,
        cooldown,
      };
    }

    case "review":
      return {
        action: "review",
        // Never say "a human is looking at this" — that is itself a signal an
        // attacker can probe for.
        reason: BLOCK_REASONS["default"]!,
        deliveredText: null,
        maskedSpans: [],
        cooldown,
      };

    case "block":
    default: {
      // Contact leaks can often be masked instead of blocked outright, which
      // keeps the conversation alive. Safety issues are never downgraded.
      if (options.preferMasking === true && family === "contact") {
        const { text, spans } = maskSpans(originalText, result.spans);
        if (spans.length > 0) {
          return {
            action: "mask",
            reason: WARN_REASONS["contact"]!,
            deliveredText: text,
            maskedSpans: spans,
            cooldown,
          };
        }
      }

      return {
        action: "block",
        reason: BLOCK_REASONS[family] ?? BLOCK_REASONS["default"]!,
        deliveredText: null,
        maskedSpans: [],
        cooldown,
      };
    }
  }
}

/**
 * Replace detected spans with mask characters.
 *
 * Spans are merged and applied right-to-left so earlier offsets stay valid,
 * and only spans that actually index into the text are used — detector spans
 * are computed on normalized views, which can drift from the raw string.
 */
export function maskSpans(text: string, spans: readonly Span[]): { text: string; spans: Span[] } {
  const usable = spans
    .filter((s) => s.start >= 0 && s.end <= text.length && s.end > s.start)
    // Mask IDENTIFIERS, not intent. "my number is 9876543210" should deliver
    // as "my number is ••••••••••", not "•••••••••••• ••••••••••" — the
    // phrase carries no contact data, and redacting it makes the delivered
    // message unreadable for no benefit.
    .filter((s) => !s.type.startsWith("intent."))
    .sort((a, b) => a.start - b.start);

  if (usable.length === 0) return { text, spans: [] };

  // Merge overlaps so we do not double-mask.
  const merged: Span[] = [];
  for (const span of usable) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  let out = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const span = merged[i]!;
    const width = span.end - span.start;
    const replacement = width >= 3 ? MASK_CHAR.repeat(Math.min(width, 12)) : MASK_TOKEN;
    out = out.slice(0, span.start) + replacement + out.slice(span.end);
    span.masked = replacement;
  }

  return { text: out, spans: merged };
}

/**
 * Per-sender rate limit (SPEC §9): more than N blocks in the window puts the
 * sender in cooldown. This is anti threshold-probing — without it an attacker
 * can binary-search the detector by sending variations until one lands.
 */
export class RateLimiter {
  private readonly blocks = new Map<string, number[]>();

  constructor(
    private readonly threshold = 3,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Record a block for this sender. Returns true if they are now in cooldown. */
  recordBlock(senderKey: string): boolean {
    const nowMs = this.clock();
    const recent = (this.blocks.get(senderKey) ?? []).filter((t) => nowMs - t <= this.windowMs);
    recent.push(nowMs);
    this.blocks.set(senderKey, recent);
    return recent.length >= this.threshold;
  }

  /** How many blocks this sender has in the current window. */
  recentBlocks(senderKey: string): number {
    const nowMs = this.clock();
    const recent = (this.blocks.get(senderKey) ?? []).filter((t) => nowMs - t <= this.windowMs);
    if (recent.length === 0) this.blocks.delete(senderKey);
    else this.blocks.set(senderKey, recent);
    return recent.length;
  }

  isInCooldown(senderKey: string): boolean {
    return this.recentBlocks(senderKey) >= this.threshold;
  }

  clear(): void {
    this.blocks.clear();
  }
}

/** Compose the rate-limit key. Blocks are tracked per sender per conversation. */
export function senderKey(conversationId: string, role: SenderRole): string {
  return `${conversationId}:${role}`;
}

/**
 * Async mode (SPEC §9): return `allow` with `pending: true` immediately, then
 * deliver the real verdict via callback. Zero user-facing latency; the
 * playground shows the retro-redact visually.
 */
export function toPendingResult(result: ModerateResult): ModerateResult {
  return {
    ...result,
    verdict: "allow",
    pending: true,
  };
}

export const REASONS = { block: BLOCK_REASONS, warn: WARN_REASONS };
export type { Verdict };
