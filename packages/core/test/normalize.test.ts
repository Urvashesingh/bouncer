import { describe, expect, it } from "vitest";

import { denoiseToken, extractDigitRuns, normalize } from "../src/normalize/index.js";

/**
 * SPEC §3 requires BOTH Bouncer benchmark strings to pass before anything else
 * is built. These two blocks are that gate.
 */
describe("benchmark string #1 — noise injection + mixed-form number", () => {
  const INPUT = "hi i a92m a121ksh35ay call me on nine eight 7 six zero";
  const views = normalize(INPUT);

  it("denoises interior noise digits to recover the plain text", () => {
    expect(views.denoised).toBe("hi i am akshay call me on nine eight 7 six zero");
  });

  it("counts exactly 7 noise digits removed", () => {
    // a92m → am (+2), a121ksh35ay → akshay (+5). The standalone "7" in the
    // spoken number is a candidate, not noise, so it must NOT be counted.
    expect(views.signals.noiseDigitsRemoved).toBe(7);
  });

  it("extracts the mixed-form digit run 98760", () => {
    const run = views.digitRuns.find((r) => r.digits === "98760");
    expect(run).toBeDefined();
    expect(run!.mixedForm).toBe(true);
  });

  it("preserves the intent word 'call' through normalization", () => {
    expect(views.denoised).toContain("call");
    expect(views.deleet).toContain("call");
  });
});

describe("benchmark string #2 — handle smuggling with separator + word tail", () => {
  const INPUT = "reach out at insta: akshay_98_76_five_four";
  const views = normalize(INPUT);

  it("extracts the digit run 987654 across underscores and word forms", () => {
    const run = views.digitRuns.find((r) => r.digits === "987654");
    expect(run).toBeDefined();
  });

  it("records underscore separators and a word-form tail", () => {
    const run = views.digitRuns.find((r) => r.digits === "987654")!;
    expect(run.separatorTypes).toContain("underscore");
    expect(run.wordFormCount).toBeGreaterThan(0);
    expect(run.numeralCount).toBeGreaterThan(0);
    expect(run.mixedForm).toBe(true);
  });

  it("keeps the platform marker and handle stem visible for Tier 2", () => {
    expect(views.folded).toContain("insta");
    expect(views.denoised).toContain("akshay");
  });
});

// ---------------------------------------------------------------------------
// Supporting behaviour
// ---------------------------------------------------------------------------

describe("denoiseToken", () => {
  it("removes interior digit runs with letters on both sides", () => {
    expect(denoiseToken("a92m")).toMatchObject({ text: "am", noiseDigitsRemoved: 2 });
    expect(denoiseToken("a121ksh35ay")).toMatchObject({ text: "akshay", noiseDigitsRemoved: 5 });
  });

  it("keeps digits at token boundaries", () => {
    expect(denoiseToken("iphone15")).toMatchObject({ text: "iphone15", noiseDigitsRemoved: 0 });
    expect(denoiseToken("15pro")).toMatchObject({ text: "15pro", noiseDigitsRemoved: 0 });
  });

  it("never touches purely numeric tokens", () => {
    expect(denoiseToken("98765")).toMatchObject({ text: "98765", noiseDigitsRemoved: 0 });
    expect(denoiseToken("403507")).toMatchObject({ text: "403507", noiseDigitsRemoved: 0 });
  });

  it("maps every surviving character back to its source offset", () => {
    // "a92m" -> "am": the 'm' at output index 1 came from input index 3.
    expect(denoiseToken("a92m").offsetMap).toEqual([0, 3]);
  });

  it("keeps interior runs longer than 3 digits (likely real content)", () => {
    expect(denoiseToken("abc12345def").noiseDigitsRemoved).toBe(0);
  });
});

describe("unicode handling", () => {
  it("NFKC-folds fullwidth and math-bold digits", () => {
    expect(normalize("call ９８７６").denoised).toContain("9876");
    expect(normalize("call 𝟗𝟖𝟕𝟔").denoised).toContain("9876");
  });

  it("maps devanagari digits by unicode digit value", () => {
    const views = normalize("mera number ९८७६० hai");
    expect(views.folded).toContain("98760");
  });

  it("strips zero-width characters and counts them", () => {
    const views = normalize("9​8​7​6​0");
    expect(views.signals.zeroWidthCount).toBe(4);
    expect(views.digitRuns[0]?.digits).toBe("98760");
  });

  it("folds cyrillic confusables to ascii", () => {
    const views = normalize("whаtsаpp me"); // cyrillic а
    expect(views.folded).toContain("whatsapp");
    expect(views.signals.confusablesFolded).toBe(2);
  });
});

describe("leet folding is letter-context only", () => {
  it("recovers intent words", () => {
    expect(normalize("c4ll me").deleet).toContain("call");
    expect(normalize("wh4tsapp me").deleet).toContain("whatsapp");
  });

  it("leaves prices and numeric codes intact", () => {
    expect(normalize("the room is 4500 per night").deleet).toContain("4500");
    expect(normalize("pin code 403507").deleet).toContain("403507");
  });
});

describe("digit run merging", () => {
  it("merges across dashes, dots and spaces", () => {
    expect(extractDigitRuns("9-8-7-6-0")[0]?.digits).toBe("98760");
    expect(extractDigitRuns("9 . 8 . 7")[0]?.digits).toBe("987");
    expect(extractDigitRuns("98_76")[0]?.digits).toBe("9876");
  });

  it("expands double/triple multipliers", () => {
    expect(extractDigitRuns("double five triple 9")[0]?.digits).toBe("55999");
  });

  it("keeps a multiplied chunk inside the surrounding dictated run", () => {
    // "double three" expands to 33, but that is dictation, not a quantity.
    // Treating it as multi-digit split the run into 9733 + 24568 and dropped
    // the number below the block band.
    expect(extractDigitRuns("nine seven double three one two four five six eight")[0]?.digits).toBe(
      "9733124568",
    );
  });

  it("does not invent runs from ordinary words", () => {
    expect(extractDigitRuns("do you want to book for one")).toEqual([]);
    expect(extractDigitRuns("call it a day")).toEqual([]);
  });

  it("does not expand an ambiguous word next to a multi-digit quantity", () => {
    // "₹98,765 for 5 nights" must not read as 765 + for(4) + 5. Ambiguous
    // number-words are only digits inside a dictated single-digit sequence.
    const runs = extractDigitRuns("98,765 for 5 nights");
    expect(runs.map((r) => r.digits)).not.toContain("76545");
    expect(runs.every((r) => !r.mixedForm)).toBe(true);
  });

  it("splits rather than glues when a chunk is rejected", () => {
    // Dropping "for" must break the run, not join 765 to 5 as "7655" —
    // otherwise Tier 3 accumulates digits that were never adjacent.
    const runs = extractDigitRuns("98,765 for 5 nights");
    expect(runs.map((r) => r.digits)).not.toContain("7655");
  });

  it("still expands ambiguous words inside a dictated sequence", () => {
    // Every neighbour is a single digit, so this IS dictation.
    expect(extractDigitRuns("nine eight one six zero")[0]?.digits).toBe("98160");
  });

  it("does not read common English words as digits next to a lone number", () => {
    // "for"/"no" are digits in Hinglish but ordinary English words. A single
    // digit neighbour is not enough evidence — these produced the phantom runs
    // "47" and "91" and cost 24 false positives on the benchmark.
    expect(extractDigitRuns("booking for 7 people")).toEqual([]);
    expect(extractDigitRuns("house no 1, near the temple")).toEqual([]);
    expect(extractDigitRuns("price for 4 nights is 23,774 rupees").map((r) => r.digits)).toEqual([
      "23774",
    ]);
  });

  it("expands devanagari number-words with vowel signs", () => {
    // Devanagari maatras are combining marks (\p{M}), not letters, so
    // stripping on \p{L} alone turned "पांच" into "पच" and silently broke
    // every Devanagari number-word — 68% of that technique leaked.
    const runs = extractDigitRuns("सात दो तीन छह एक पांच पांच चार नौ पांच");
    expect(runs[0]?.digits).toBe("7236155495");
  });

  it("marks pure-numeral runs as not mixed-form", () => {
    const run = extractDigitRuns("9876543210")[0]!;
    expect(run.mixedForm).toBe(false);
    expect(run.wordFormCount).toBe(0);
  });
});

describe("hard negatives survive normalization", () => {
  it("leaves prices unmangled", () => {
    const views = normalize("₹98,765 for 5 nights");
    expect(views.signals.noiseDigitsRemoved).toBe(0);
  });

  it("leaves flight numbers and PIN codes unmangled", () => {
    expect(normalize("flight 6E 2134").signals.noiseDigitsRemoved).toBe(0);
    expect(normalize("pin 403507").signals.noiseDigitsRemoved).toBe(0);
  });

  it("leaves phone-model names unmangled", () => {
    expect(normalize("iPhone 15 Pro, 256GB").signals.noiseDigitsRemoved).toBe(0);
  });
});
