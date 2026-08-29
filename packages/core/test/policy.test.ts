import { describe, expect, it } from "vitest";

import { RateLimiter, applyPolicy, maskSpans, senderKey, toPendingResult } from "../src/policy/index.js";
import type { ModerateResult } from "../src/types.js";

function result(overrides: Partial<ModerateResult> = {}): ModerateResult {
  return {
    verdict: "allow",
    categories: [],
    spans: [],
    confidence: 1,
    resolved_by: "tier1.normalize",
    signals: {},
    latency_ms: 1,
    cost_usd: 0,
    ...overrides,
  };
}

describe("masking", () => {
  it("replaces spans with mask characters", () => {
    const { text } = maskSpans("call me on 9876543210 ok", [
      { start: 11, end: 21, type: "contact.phone" },
    ]);
    expect(text).toBe("call me on •••••••••• ok");
  });

  it("merges overlapping spans instead of double-masking", () => {
    const { text, spans } = maskSpans("abcdefghij", [
      { start: 0, end: 5, type: "a" },
      { start: 3, end: 8, type: "b" },
    ]);
    expect(spans).toHaveLength(1);
    expect(text).toBe("••••••••ij");
  });

  it("ignores spans that do not index into the text", () => {
    // Detector spans are computed on normalized views, which can drift from
    // the raw string; applying those blindly would corrupt the message.
    const { text, spans } = maskSpans("short", [{ start: 50, end: 90, type: "x" }]);
    expect(text).toBe("short");
    expect(spans).toEqual([]);
  });
});

describe("policy actions", () => {
  it("delivers allowed messages unchanged", () => {
    const decision = applyPolicy(result(), "hello there");
    expect(decision.action).toBe("deliver");
    expect(decision.deliveredText).toBe("hello there");
  });

  it("withholds blocked messages", () => {
    const decision = applyPolicy(
      result({ verdict: "block", categories: ["contact.phone"] }),
      "my number is 9876543210",
    );
    expect(decision.action).toBe("block");
    expect(decision.deliveredText).toBeNull();
  });

  /**
   * Oracle resistance (SPEC §9): the reason must never reveal which pattern
   * tripped, or the system becomes a detector to grind against.
   */
  it("gives a generic reason that names no detector or pattern", () => {
    const decision = applyPolicy(
      result({ verdict: "block", categories: ["contact.phone.obfuscated", "intent.offplatform"] }),
      "call me on nine eight 7 six zero",
    );

    for (const leak of ["phone", "obfuscated", "digit", "regex", "tier", "score", "intent"]) {
      expect(decision.reason.toLowerCase(), leak).not.toContain(leak);
    }
  });

  it("does not leak whether a message went to human review", () => {
    const review = applyPolicy(result({ verdict: "review" }), "borderline");
    const block = applyPolicy(result({ verdict: "block" }), "bad");
    // Distinguishable responses would tell an attacker they are close.
    expect(review.reason).toBe(block.reason);
  });

  it("can downgrade a contact block to a mask, but never a safety block", () => {
    const contact = applyPolicy(
      result({ verdict: "block", categories: ["contact.phone"], spans: [{ start: 11, end: 21, type: "contact.phone" }] }),
      "call me on 9876543210",
      { preferMasking: true },
    );
    expect(contact.action).toBe("mask");
    expect(contact.deliveredText).toContain("•");

    const safety = applyPolicy(
      result({ verdict: "block", categories: ["safety.hostility.sev3"], spans: [{ start: 0, end: 5, type: "safety.hostility.sev3" }] }),
      "i will kill you",
      { preferMasking: true },
    );
    expect(safety.action).toBe("block");
  });
});

describe("rate limiting", () => {
  it("enters cooldown after the threshold", () => {
    let clock = 0;
    const limiter = new RateLimiter(3, 1000, () => clock);
    const key = senderKey("c1", "guest");

    expect(limiter.recordBlock(key)).toBe(false);
    expect(limiter.recordBlock(key)).toBe(false);
    expect(limiter.recordBlock(key)).toBe(true);
    expect(limiter.isInCooldown(key)).toBe(true);
  });

  it("forgets blocks outside the window", () => {
    let clock = 0;
    const limiter = new RateLimiter(3, 1000, () => clock);
    const key = senderKey("c1", "guest");

    limiter.recordBlock(key);
    limiter.recordBlock(key);
    clock += 2000;
    expect(limiter.recentBlocks(key)).toBe(0);
  });

  it("tracks senders independently", () => {
    const limiter = new RateLimiter(2, 10_000);
    limiter.recordBlock(senderKey("c1", "guest"));
    limiter.recordBlock(senderKey("c1", "guest"));

    expect(limiter.isInCooldown(senderKey("c1", "guest"))).toBe(true);
    expect(limiter.isInCooldown(senderKey("c1", "host"))).toBe(false);
    expect(limiter.isInCooldown(senderKey("c2", "guest"))).toBe(false);
  });
});

describe("async mode", () => {
  it("returns allow with pending set, preserving the real verdict", () => {
    const original = result({ verdict: "block", categories: ["contact.phone"] });
    const pending = toPendingResult(original);

    expect(pending.verdict).toBe("allow");
    expect(pending.pending).toBe(true);
    expect(pending.categories).toEqual(["contact.phone"]);
  });
});

/**
 * Detector spans are found on normalized views. Removing noise digits shifts
 * every later offset left, so an unmapped span masks the WRONG substring —
 * and can leave the recovered number visible in the delivered message. Tier 1
 * maps run spans back to raw offsets; this locks that in.
 */
describe("span alignment against the raw message", () => {
  it("masks the number, not the surrounding words", async () => {
    const { moderate } = await import("../src/index.js");
    const trigramModel = (await import("../../../data/trigrams/model.json", { with: { type: "json" } })).default;

    const text = "hi i a92m a121ksh35ay call me on nine eight 7 six zero";
    const engineResult = moderate(
      {
        message_id: "m",
        conversation_id: "c",
        sender_role: "guest",
        booking_stage: "pre_booking",
        text,
      },
      { trigramModel: trigramModel as never },
    );

    const phone = engineResult.spans.find((s) => s.type.startsWith("contact.phone"));
    expect(phone).toBeDefined();
    expect(text.slice(phone!.start, phone!.end)).toBe("nine eight 7 six zero");

    const masked = applyPolicy(engineResult, text, { preferMasking: true }).deliveredText!;
    // The spelled-out number must be gone from the delivered text.
    expect(masked).not.toContain("nine eight");
    expect(masked).not.toContain("six zero");
  });
});

describe("masking hides identifiers, not intent", () => {
  it("leaves the surrounding phrase readable", () => {
    const { text } = maskSpans("my number is 9876543210", [
      { start: 0, end: 12, type: "intent.contact" },
      { start: 13, end: 23, type: "contact.phone" },
    ]);
    // Redacting "my number is" makes the delivered message unreadable for no
    // security benefit — only the identifier is sensitive.
    expect(text).toBe("my number is ••••••••••");
  });
});
