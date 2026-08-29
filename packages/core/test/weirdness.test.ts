import { describe, expect, it } from "vitest";

import model from "../../../data/trigrams/model.json" with { type: "json" };
import { messageWeirdness, percentile, scoreToken } from "../src/weirdness/index.js";
import type { TrigramModel } from "../src/weirdness/index.js";

const MODEL = model as TrigramModel;

describe("weirdness meter", () => {
  it("loads a calibrated model", () => {
    expect(MODEL.threshold).toBeGreaterThan(0);
    expect(MODEL.meta.percentile).toBe(99.5);
    expect(Object.keys(MODEL.logProbs).length).toBeGreaterThan(1000);
  });

  /**
   * The core SPEC §5 claim: a mangled token is astronomically improbable
   * relative to its clean form, WITHOUT any rule describing the mangling.
   */
  it("separates mangled tokens from their clean forms", () => {
    const clean = scoreToken("akshay", MODEL);
    const mangled = scoreToken("a121ksh35ay", MODEL);

    expect(clean).toBeLessThan(MODEL.threshold);
    expect(mangled).toBeGreaterThan(MODEL.threshold);
    // Separation should be decisive, not marginal.
    expect(mangled - clean).toBeGreaterThan(3);
  });

  it("scores ordinary chat words below threshold", () => {
    const ordinary = [
      "booking", "check", "room", "beach", "please", "thanks", "morning",
      "akshay", "priya", "rahul", "mumbai", "goa", "available", "confirm",
      "kitchen", "towels", "parking", "wifi", "arrive", "family",
      "acha", "theek", "khana", "paisa", "shukriya", "kamra",
    ];

    const flagged = ordinary.filter((t) => scoreToken(t, MODEL) > MODEL.threshold);
    expect(flagged).toEqual([]);
  });

  it("flags deliberately mangled tokens", () => {
    const mangled = [
      "a121ksh35ay", "a92m", "n1ne", "wh4t5app", "c0nt4ct", "nu3mb3er",
      "xkqzjvw", "zxcvbnm", "qwrtypsdf",
    ];

    const missed = mangled.filter((t) => scoreToken(t, MODEL) <= MODEL.threshold);
    expect(missed).toEqual([]);
  });

  it("scores the letters-only projection alongside the raw form", () => {
    const result = messageWeirdness("a121ksh35ay", MODEL);
    const token = result.tokens[0]!;

    expect(token.token).toBe("a121ksh35ay");
    expect(token.lettersOnlyScore).not.toBeNull();
    // Raw form is far weirder than its projection — the mangling IS the signal.
    expect(token.score).toBeGreaterThan(token.lettersOnlyScore!);
  });

  /**
   * Digit POSITION, not just probability, decides weirdness. Judging the raw
   * score alone flags every product code; judging the projection alone lets
   * "a121ksh35ay" through, since it projects to the perfectly ordinary
   * "akshay". Both failure modes are regressions worth locking down.
   */
  describe("digit position decides how a token is judged", () => {
    it("judges interleaved digits on the RAW form", () => {
      const result = messageWeirdness("a121ksh35ay", MODEL).tokens[0]!;
      // Its projection is ordinary; only the raw form reveals the mangling.
      expect(result.lettersOnlyScore).toBeLessThan(MODEL.threshold);
      expect(result.weird).toBe(true);
    });

    it("judges boundary digits on the letters-only projection", () => {
      // "sunshine2024" is a wifi password, not evasion.
      expect(messageWeirdness("sunshine2024", MODEL).tokens[0]!.weird).toBe(false);
    });

    it("does not flag unit-suffixed tokens whose projection is too short", () => {
      // "256gb" projects to "gb" — too short to judge, so absence of evidence
      // must not become evidence of weirdness.
      expect(messageWeirdness("256gb", MODEL).tokens[0]!.weird).toBe(false);
      expect(messageWeirdness("iphone 15 pro 256gb", MODEL).weirdTokenCount).toBe(0);
    });

    it("still flags mangling that survives projection", () => {
      expect(messageWeirdness("a92m", MODEL).tokens[0]!.weird).toBe(true);
    });
  });

  it("reports max token score and weird token count per message", () => {
    const result = messageWeirdness("hi i a92m a121ksh35ay call me", MODEL);

    expect(result.weirdTokenCount).toBeGreaterThanOrEqual(2);
    expect(result.score).toBeGreaterThan(MODEL.threshold);
  });

  it("skips short and purely numeric tokens", () => {
    // SPEC §5: alphabetic tokens of length >= 4 only.
    const result = messageWeirdness("hi ok 403507 98765 4500", MODEL);
    expect(result.tokens).toEqual([]);
    expect(result.score).toBe(0);
  });

  it("keeps legitimate messages quiet", () => {
    const legit = [
      "the total is 98765 for 5 nights",
      "check in is at 2 pm and check out at 11 am",
      "we are 4 adults and 2 kids arriving on monday",
      "pin code 403507 near the market",
      "iphone 15 pro 256gb",
      "hum log kal subah pahunch jayenge",
    ];

    for (const text of legit) {
      expect(messageWeirdness(text, MODEL).weirdTokenCount).toBe(0);
    }
  });
});

describe("percentile", () => {
  it("interpolates between ranks", () => {
    const sorted = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(sorted, 0)).toBe(0);
    expect(percentile(sorted, 100)).toBe(9);
    expect(percentile(sorted, 50)).toBeCloseTo(4.5, 5);
  });

  it("handles an empty array", () => {
    expect(percentile([], 99.5)).toBe(0);
  });
});
