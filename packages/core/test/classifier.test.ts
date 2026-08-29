import { describe, expect, it } from "vitest";

import cmodel from "../../../data/classifier/model.json" with { type: "json" };
import tmodel from "../../../data/trigrams/model.json" with { type: "json" };
import { classify, extractNgrams, hashString, sigmoid } from "../src/classifier/index.js";
import { extractDense, DENSE_FEATURES } from "../src/classifier/features.js";
import { moderate } from "../src/index.js";
import { normalize } from "../src/normalize/index.js";
import { runDetectors } from "../src/detectors/index.js";
import type { ClassifierModel } from "../src/classifier/index.js";
import type { TrigramModel } from "../src/weirdness/index.js";
import type { ModerateRequest } from "../src/types.js";

const CLASSIFIER = cmodel as ClassifierModel;
const TRIGRAMS = tmodel as TrigramModel;

const OPTIONS = { trigramModel: TRIGRAMS, classifierModel: CLASSIFIER };

function req(text: string, overrides: Partial<ModerateRequest> = {}): ModerateRequest {
  return {
    message_id: "m1",
    conversation_id: "c1",
    sender_role: "guest",
    booking_stage: "pre_booking",
    text,
    ...overrides,
  };
}

describe("classifier primitives", () => {
  it("sigmoid is stable at the extremes", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
    expect(sigmoid(1000)).toBeCloseTo(1, 10);
    expect(sigmoid(-1000)).toBeCloseTo(0, 10);
    expect(Number.isNaN(sigmoid(-1e308))).toBe(false);
  });

  it("hashes deterministically", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });

  it("L2-normalises the n-gram bag", () => {
    const vector = extractNgrams("hello there");
    const norm = Math.sqrt([...vector.values()].reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("emits one dense value per named feature", () => {
    const views = normalize("call me on 9876543210");
    const { detections } = runDetectors(views);
    const dense = extractDense({
      detections,
      signals: views.signals,
      digitRuns: views.digitRuns,
      text: views.folded,
      weirdTokenCount: 0,
      riskScore: 5,
      digitPressure: 0,
      role: "guest",
      stage: "pre_booking",
    });
    expect(dense).toHaveLength(DENSE_FEATURES.length);
    expect(dense.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("model quality", () => {
  it("ships a trained model with held-out accuracy reported", () => {
    expect(Object.keys(CLASSIFIER.weights).length).toBeGreaterThan(100);
    expect(CLASSIFIER.meta.heldOutAccuracy).toBeGreaterThan(0.9);
  });

  it("uses the SPEC §7 thresholds", () => {
    expect(CLASSIFIER.thresholds).toEqual({ allow: 0.3, block: 0.85 });
  });
});

describe("tier 4 in the cascade", () => {
  it("only runs on the escalation band", () => {
    // Clear allow — resolved before tier 4, so no classifier probability.
    expect(moderate(req("what time is check in?"), OPTIONS).signals.classifier_p).toBeUndefined();
    // Clear block — resolved by tier 3.
    expect(moderate(req("my number is 9876543210"), OPTIONS).resolved_by).toBe("tier3.risk");
  });

  it("resolves borderline messages that tier 3 could not", () => {
    const withoutTier4 = moderate(req("call me on nine eight 7 six zero"), {
      trigramModel: TRIGRAMS,
    });
    const withTier4 = moderate(req("call me on nine eight 7 six zero"), OPTIONS);

    expect(withoutTier4.verdict).toBe("review");
    expect(withTier4.verdict).toBe("block");
    expect(withTier4.resolved_by).toBe("tier4.classifier");
  });

  /**
   * Tier 4 resolves uncertainty; it must never overturn hard evidence. A model
   * trained on a finite corpus will confidently allow patterns it has not
   * seen, and letting that downgrade a deterministic Tier 2 detection would
   * subordinate the reliable tiers to the one that generalises worst.
   */
  it("never downgrades a message carrying hard contact evidence to allow", () => {
    const text = "my digits: nine seven double three one two four five six eight";
    const result = moderate(req(text), OPTIONS);

    expect(result.categories.some((c) => c.startsWith("contact."))).toBe(true);
    expect(result.verdict).not.toBe("allow");
  });

  it("still allows borderline messages with no contact evidence", () => {
    for (const text of [
      "is there a landline in the room i can use?",
      "can you call me through the app if there is a problem?",
    ]) {
      expect(moderate(req(text), OPTIONS).verdict).toBe("allow");
    }
  });
});

describe("tier 4 brings independent evidence, not tier 3's verdict", () => {
  function featuresFor(text: string, riskScore: number) {
    const views = normalize(text);
    const { detections } = runDetectors(views);
    return {
      detections,
      signals: views.signals,
      digitRuns: views.digitRuns,
      text: views.folded,
      weirdTokenCount: 0,
      riskScore,
      digitPressure: 0,
      role: "guest" as const,
      stage: "pre_booking" as const,
    };
  }

  /**
   * riskScore was a dense feature. Because Tier 4 only ever sees messages
   * Tier 3 escalated, that feature was bounded below by bands.low on every
   * row the trainer saw, so it learned a large positive weight on it and the
   * sigmoid saturated: p=1.0000 on "thanks, see you on the 14th". The tier
   * meant to second-guess Tier 3 was just restating it, and its 100%
   * accuracy was the tautology "escalated ⇒ violation".
   */
  it("does not expose tier 3's score as a feature", () => {
    expect(DENSE_FEATURES).not.toContain("riskScore");
  });

  it("returns the same probability whatever tier 3 scored", () => {
    const text = "is there a landline in the room?";
    const probabilities = [3.1, 5.0, 7.9, 50].map(
      (risk) => classify(featuresFor(text, risk), CLASSIFIER).probability,
    );
    for (const p of probabilities) {
      expect(p).toBeCloseTo(probabilities[0]!, 10);
    }
  });

  it("allows ordinary messages instead of blocking by reflex", () => {
    // Each of these scored p=1.0000 and blocked before the leakage was removed.
    for (const text of [
      "thanks, see you on the 14th",
      "what is the check in time?",
      "is there a landline in the room?",
    ]) {
      const result = classify(featuresFor(text, 5), CLASSIFIER);
      expect(result.decision, `${text} -> p=${result.probability}`).toBe("allow");
    }
  });
});
