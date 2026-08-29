import { beforeEach, describe, expect, it } from "vitest";

import model from "../../../data/trigrams/model.json" with { type: "json" };
import { moderate, moderateStateful } from "../src/index.js";
import { DEFAULT_RISK_CONFIG } from "../src/risk/config.js";
import { mergeFragments } from "../src/risk/rescan.js";
import { bandFor, scoreMessage } from "../src/risk/score.js";
import { MemorySessionStore, decayDigitPressure, emptyPairState } from "../src/risk/state.js";
import { normalize } from "../src/normalize/index.js";
import { runDetectors } from "../src/detectors/index.js";
import type { TrigramModel } from "../src/weirdness/index.js";
import type { BookingStage, ModerateRequest, SenderRole } from "../src/types.js";

const MODEL = model as TrigramModel;
const T0 = 1_700_000_000_000;

function req(
  text: string,
  overrides: Partial<ModerateRequest> = {},
): ModerateRequest {
  return {
    message_id: "m1",
    conversation_id: "c1",
    sender_role: "guest",
    booking_stage: "pre_booking",
    text,
    ...overrides,
  };
}

function score(text: string, role: SenderRole = "guest", stage: BookingStage = "pre_booking") {
  const views = normalize(text);
  const { detections } = runDetectors(views);
  return scoreMessage(
    {
      detections,
      signals: views.signals,
      digitRuns: views.digitRuns,
      weirdTokenCount: 0,
      digitPressure: 0,
      sessionIntentHits: 0,
      role,
      stage,
    },
    DEFAULT_RISK_CONFIG,
  );
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe("tier 3 scoring", () => {
  it("blocks a bare valid phone number pre-booking", () => {
    const result = moderate(req("my number is 9876543210"), { trigramModel: MODEL });
    expect(result.verdict).toBe("block");
    expect(result.resolved_by).toBe("tier3.risk");
  });

  it("allows ordinary chat", () => {
    const result = moderate(req("what time is check in?"), { trigramModel: MODEL });
    expect(result.verdict).toBe("allow");
  });

  it("scores both benchmark strings above the allow band", () => {
    for (const text of [
      "hi i a92m a121ksh35ay call me on nine eight 7 six zero",
      "reach out at insta: akshay_98_76_five_four",
    ]) {
      const result = moderate(req(text), { trigramModel: MODEL });
      expect(result.verdict).not.toBe("allow");
    }
  });

  /**
   * A fully-recovered contact identifier is the most certain violation there
   * is. If any of these merely escalate, the cascade spends Tier 4/5 budget
   * on the easiest cases in the product — the opposite of the cost-descending
   * design in SPEC §0.
   */
  it("blocks every unambiguous contact identifier without escalating", () => {
    const unambiguous = [
      "my number is 9876543210",
      "mail me at akshay@gmail.com",
      "pay me at akshay@ybl",
      "https://wa.me/919876543210",
    ];

    for (const text of unambiguous) {
      const result = moderate(req(text), { trigramModel: MODEL });
      expect(result.verdict, text).toBe("block");
    }
  });

  it("reports per-feature contributions for the trace panel", () => {
    const breakdown = score("call me on nine eight 7 six zero");
    expect(Object.keys(breakdown.contributions).length).toBeGreaterThan(0);
    expect(breakdown.contributions["mixedForm"]).toBeGreaterThan(0);
  });
});

describe("stage modifier", () => {
  it("relaxes contact rules post-booking", () => {
    const pre = score("the gate code is at 9876543210", "host", "pre_booking");
    const post = score("the gate code is at 9876543210", "host", "post_booking");
    expect(post.score).toBeLessThan(pre.score);
  });

  it("does NOT relax safety rules post-booking", () => {
    const pre = score("refund me or i will leave a 1 star review", "guest", "pre_booking");
    const post = score("refund me or i will leave a 1 star review", "guest", "post_booking");
    // Safety is scored outside the stage modifier, so it survives intact.
    expect(post.safetyRaw).toBe(pre.safetyRaw);
    expect(post.safetyRaw).toBeGreaterThan(0);
  });

  it("still blocks threats post-booking", () => {
    const result = moderate(
      req("i will kill you", { booking_stage: "post_booking" }),
      { trigramModel: MODEL },
    );
    expect(result.verdict).toBe("block");
  });
});

describe("role modifier", () => {
  it("weights a host pushing off-platform above a guest", () => {
    const guest = score("lets book direct next time", "guest");
    const host = score("lets book direct next time", "host");
    expect(host.score).toBeGreaterThan(guest.score);
  });
});

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

describe("digit pressure decay", () => {
  it("halves over one half-life", () => {
    const state = { ...emptyPairState(T0), digitPressure: 10 };
    const halfLife = DEFAULT_RISK_CONFIG.session.digitPressureHalfLifeMs;
    expect(decayDigitPressure(state, T0 + halfLife, halfLife)).toBeCloseTo(5, 5);
  });

  it("does not grow over time", () => {
    const state = { ...emptyPairState(T0), digitPressure: 10 };
    expect(decayDigitPressure(state, T0, 1000)).toBe(10);
  });
});

describe("relationship-level accumulation", () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("accumulates digit pressure across messages", async () => {
    const first = await moderateStateful(req("my room is 4455"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });
    const second = await moderateStateful(req("and 7788", { message_id: "m2" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0 + 1000,
    });

    expect(second.signals.digit_pressure as number).toBeGreaterThan(
      first.signals.digit_pressure as number,
    );
  });

  it("keeps state separate per conversation", async () => {
    await moderateStateful(req("9876543210"), { store, nowMs: T0 });
    const other = await moderateStateful(
      req("hello there", { conversation_id: "c2" }),
      { store, nowMs: T0 },
    );
    expect(other.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Multi-message tests (SPEC §12 step 5)
// ---------------------------------------------------------------------------

describe("split-number detection across messages", () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("catches a number split across two messages by the same sender", async () => {
    // "98765" ... (later) ... "43210" — invisible to any per-message detector.
    const first = await moderateStateful(req("98765"), { store, nowMs: T0 });
    expect(first.verdict).not.toBe("block");

    const second = await moderateStateful(req("43210", { message_id: "m2" }), {
      store,
      nowMs: T0 + 60_000,
    });

    expect(second.verdict).toBe("block");
    expect(second.signals.merged_fragments).toBe("9876543210");
  });

  it("does not merge fragments from different senders", async () => {
    await moderateStateful(req("98765", { sender_role: "guest" }), { store, nowMs: T0 });
    const hostReply = await moderateStateful(
      req("43210", { message_id: "m2", sender_role: "host" }),
      { store, nowMs: T0 + 60_000 },
    );

    // Merging across senders would manufacture a number nobody sent.
    expect(hostReply.signals.merged_fragments).toBeUndefined();
  });

  it("does not merge fragments outside the 30-minute window", async () => {
    await moderateStateful(req("98765"), { store, nowMs: T0 });
    const late = await moderateStateful(req("43210", { message_id: "m2" }), {
      store,
      nowMs: T0 + 31 * 60 * 1000,
    });

    expect(late.signals.merged_fragments).toBeUndefined();
  });

  it("does not fabricate a number from unrelated digits", async () => {
    // Prices and guest counts must not merge into a phone number.
    await moderateStateful(req("the rate is 4500 per night"), { store, nowMs: T0 });
    const second = await moderateStateful(
      req("we are 4 adults", { message_id: "m2" }),
      { store, nowMs: T0 + 1000 },
    );

    expect(second.signals.merged_fragments).toBeUndefined();
    expect(second.verdict).toBe("allow");
  });
});

describe("windowed re-scan", () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("sees intent that spans a message boundary", async () => {
    await moderateStateful(req("hey quick question"), { store, nowMs: T0 });
    const second = await moderateStateful(
      req("can we take this offline", { message_id: "m2" }),
      { store, nowMs: T0 + 1000 },
    );

    expect(second.categories).toContain("intent.offplatform");
  });
});

describe("mergeFragments", () => {
  const run = (digits: string) => ({
    digits,
    sourceSpan: { start: 0, end: digits.length },
    wordFormCount: 0,
    numeralCount: 1,
    separatorTypes: ["none" as const],
    mixedForm: false,
  });

  it("recognises a valid IN mobile assembled from two fragments", () => {
    const merged = mergeFragments(
      [
        { run: run("98765"), timestamp: T0, sender: "guest" },
        { run: run("43210"), timestamp: T0 + 1000, sender: "guest" },
      ],
      "guest",
      T0 + 2000,
      30 * 60 * 1000,
    );

    expect(merged[0]?.digits).toBe("9876543210");
    expect(merged[0]?.validPhone).toBe(true);
  });

  it("returns nothing for a single fragment", () => {
    expect(
      mergeFragments([{ run: run("98765"), timestamp: T0, sender: "guest" }], "guest", T0, 60_000),
    ).toEqual([]);
  });

  it("does not mark a short combination as a valid phone", () => {
    const merged = mergeFragments(
      [
        { run: run("123"), timestamp: T0, sender: "guest" },
        { run: run("456"), timestamp: T0, sender: "guest" },
      ],
      "guest",
      T0,
      60_000,
    );
    expect(merged.every((m) => !m.validPhone)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

describe("bands", () => {
  it("maps scores to allow / escalate / block", () => {
    expect(bandFor(0, DEFAULT_RISK_CONFIG)).toBe("allow");
    expect(bandFor(5, DEFAULT_RISK_CONFIG)).toBe("escalate");
    expect(bandFor(20, DEFAULT_RISK_CONFIG)).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// Hard negatives must survive Tier 3 (SPEC §10 friction budget)
// ---------------------------------------------------------------------------

describe("hard negatives are allowed at tier 3", () => {
  const negatives = [
    "the total is ₹98,765 for 5 nights",
    "check in is at 2pm on 15 March",
    "pin code 403507",
    "booking ref WYZ8842",
    "villa 12, second floor",
    "flight 6E 2134 lands at 9pm",
    "we are 4 adults and 2 kids",
    "the beach is 700m away",
    "wifi password is sunshine2024",
    "iPhone 15 Pro, 256GB",
    "lets call it a day",
    "i left a 5 star review already, loved it",
    "could i get a refund for the extra night?",
  ];

  for (const text of negatives) {
    it(`allows: "${text}"`, () => {
      const result = moderate(req(text), { trigramModel: MODEL });
      expect(result.verdict).toBe("allow");
    });
  }
});

/**
 * Gaps the live red team found (SPEC §10). Each was a real leak the labelled
 * corpus did not contain, which is the argument for running the loop at all:
 * a corpus can only test the evasions someone already thought of.
 */
describe("red-team regressions", () => {
  const cases: string[] = [
    // The lexicon covered OFFERING contact info but not REQUESTING it.
    "can you send me your number?",
    "whats your number",
    "aapka number bhej do",
    "Can you send me a link to your profile on LinkedIn?",
    "Can you send me a message on Telegram?",
    // Naming a channel AND asking to move to it: neither hit is decisive
    // alone, and the attacker walked through the gap between them.
    "dm me on whatsapp",
    "Can you DM me on WhatsApp for the booking?",
    // A full-length run next to "my number is", failing country validation.
    "My number is 1234567890, but you can call me on +91 1234567890",
  ];

  for (const text of cases) {
    it(`stops: "${text.slice(0, 46)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).not.toBe("allow");
    });
  }

  /** The same fixes must not start flagging ordinary hospitality talk. */
  const stillAllowed: string[] = [
    "I'm available on 9 PM IST, what's your time?",
    "Can you send me a screenshot of your ID?",
    "My friend is coming with me, can you accommodate 3 people?",
    "is there a landline in the room i can use?",
    "the emergency contact number in the house manual is smudged",
    "do you have a direct line for the caretaker in case of emergency?",
  ];

  for (const text of stillAllowed) {
    it(`allows: "${text.slice(0, 46)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).toBe("allow");
    });
  }
});

/**
 * A guest reporting a scam is the message a platform MOST wants delivered.
 * Third-party framing names a channel and an action, so the off-platform floor
 * would otherwise fire on someone warning the host about a fraud attempt.
 */
describe("reporting an approach is not making one", () => {
  const reports = [
    "someone messaged me on whatsapp claiming to be you, is that real?",
    "please confirm you never ask for payment over whatsapp",
  ];

  for (const text of reports) {
    it(`allows: "${text.slice(0, 44)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).toBe("allow");
    });
  }

  it("does not BLOCK a report that also names off-platform payment", () => {
    // "i got a text asking for payment outside the app, is it legitimate?"
    // still scores from the off-platform hit itself, which is defensible — a
    // second look is reasonable. What must not happen is a block, which would
    // silence someone reporting fraud.
    const result = moderate(
      req("i got a text asking for payment outside the app, is it legitimate?"),
      { trigramModel: MODEL },
    );
    expect(result.verdict).not.toBe("block");
  });

  it("still stops the same channel used as a first-person request", () => {
    expect(moderate(req("message me on whatsapp"), { trigramModel: MODEL }).verdict).not.toBe(
      "allow",
    );
  });
});

/**
 * A message with no detections of its own must never be escalated purely by
 * relationship carryover (digitPressure, sessionIntentHits). Found via manual
 * testing: "hi and welcome to this property" was blocking because it inherited
 * a stale intent hit and digit pressure from an EARLIER, unrelated message in
 * the same conversation.
 */
describe("contentless messages never inherit a block from session state", () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("allows ordinary greetings immediately after a real evasion in the same conversation", async () => {
    await moderateStateful(req("hi i a92m a121ksh35ay call me on nine eight 7 six zero"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });

    for (const text of ["hi and welcome to this property", "hello", "hi", "good morning", "thank you"]) {
      const result = await moderateStateful(
        req(text, { message_id: `m_${text}`, sender_role: "host" }),
        { store, trigramModel: MODEL, nowMs: T0 + 1000 },
      );
      expect(result.verdict, text).toBe("allow");
    }
  });

  it("still blocks a genuine evasion in the same conversation right after", async () => {
    await moderateStateful(req("hi i a92m a121ksh35ay call me on nine eight 7 six zero"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });
    await moderateStateful(req("hi and welcome!", { message_id: "m2", sender_role: "host" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0 + 1000,
    });

    const result = await moderateStateful(
      req("my number is 9876543210", { message_id: "m3" }),
      { store, trigramModel: MODEL, nowMs: T0 + 2000 },
    );
    expect(result.verdict).toBe("block");
  });
});

/**
 * Reported from manual testing: a bare 8-digit run was silently ALLOWED.
 * SPEC §4 says partials must not auto-block; it does not say they should pass
 * unremarked. 5-6 digit runs still stay quiet because they overlap PIN codes,
 * prices and booking refs.
 */
describe("long unexplained digit runs are not silently allowed", () => {
  for (const text of ["22352352", "12345678", "987654321"]) {
    it(`stops: "${text}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).not.toBe("allow");
    });
  }

  for (const text of [
    "the pin code here is 403507",
    "booking ref WYZ8842",
    "the total is ₹98,765 for 5 nights",
    "flight 6E 2134 lands at 9pm",
    "we are 4 adults and 2 kids",
  ]) {
    it(`still allows: "${text.slice(0, 40)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).toBe("allow");
    });
  }
});

/**
 * The windowed re-scan finds evidence across turns, but that evidence belongs
 * to EARLIER messages. Reporting it in `categories` made the engine claim
 * "looks like a phone number" about a message containing no number, and
 * produced spans that do not index into this message's text.
 */
describe("cross-message evidence is reported separately", () => {
  it("does not attribute an earlier message's categories to this one", async () => {
    const store = new MemorySessionStore();
    await moderateStateful(req("this is my phone no 9876543210"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });

    const result = await moderateStateful(
      req("lets book direct next time", { message_id: "m2" }),
      { store, trigramModel: MODEL, nowMs: T0 + 1000 },
    );

    expect(result.categories).toContain("intent.offplatform");
    expect(result.categories).not.toContain("contact.phone");
  });

  /**
   * A number contained entirely within ONE earlier message is not
   * cross-boundary evidence — it was caught on its own turn. Re-charging it
   * to every later message scored innocent prices and flight numbers at full
   * validPhone weight and blocked them at 13+.
   */
  it("does not re-charge an earlier message's own number to later messages", async () => {
    const store = new MemorySessionStore();
    await moderateStateful(req("my number is 9876543210"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });

    for (const text of [
      "the villa is ₹98,765 for 5 nights, 4 adults 2 kids",
      "flight 6E 2134 lands 9:40, can I check in at 2?",
      "pin code 403507",
      ]) {
      const result = await moderateStateful(req(text, { message_id: `m_${text}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + 60_000,
      });
      expect(result.verdict, text).toBe("allow");
    }
  });

  /**
   * Merging must not concatenate unrelated digits into a fake number. One
   * real number in the buffer glued itself to every later price, flight
   * number and clock time, producing 20+ digit strings that still validated
   * because only the leading 10 digits were checked.
   */
  it("never fabricates an over-length number from unrelated digits", async () => {
    const store = new MemorySessionStore();
    const texts = [
      "my number is 9876543210",
      "the villa is ₹98,765 for 5 nights, 4 adults 2 kids",
      "flight 6E 2134 lands 9:40, can I check in at 2?",
    ];

    for (const [i, text] of texts.entries()) {
      const result = await moderateStateful(req(text, { message_id: `m${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });
      const merged = result.signals["merged_fragments"];
      if (typeof merged === "string") {
        expect(merged.length, `${text} -> ${merged}`).toBeLessThanOrEqual(12);
      }
    }
  });
});

/**
 * SPEC §6 says post-booking relaxes address/gate-code sharing — which only
 * means something if sharing them BEFORE a booking is restricted. Nothing
 * detected it, so a host could hand over the property location and door code
 * to anyone who had not booked.
 */
describe("address and access codes are stage-sensitive", () => {
  const disclosures = [
    "gate code 4471, villa 9, lane 8",
    "the address is House 12, Anjuna, near the church",
    "sharing my live location now",
  ];

  for (const text of disclosures) {
    it(`stops pre-booking: "${text.slice(0, 40)}"`, () => {
      expect(
        moderate(req(text, { sender_role: "host" }), { trigramModel: MODEL }).verdict,
      ).not.toBe("allow");
    });

    it(`allows post-booking: "${text.slice(0, 40)}"`, () => {
      expect(
        moderate(req(text, { sender_role: "host", booking_stage: "post_booking" }), {
          trigramModel: MODEL,
        }).verdict,
      ).toBe("allow");
    });
  }

  /** Asking about an address is a request, not a disclosure. */
  for (const text of [
    "what is the exact address for reference?",
    "how many digits is the gate code, 4 or 6?",
    "house no 64, near the temple",
  ]) {
    it(`allows the question: "${text.slice(0, 40)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).toBe("allow");
    });
  }
});

/**
 * Merging tried every contiguous combination of buffered runs, so with enough
 * digit-bearing messages it eventually assembled 10 digits starting 6-9 by
 * pure chance — "62134" (flight) + "940" (time) + "15" (iPhone 15) became
 * 6213494015, and from then on every message blocked.
 */
describe("unrelated digits never assemble into a phantom number", () => {
  it("keeps an ordinary digit-heavy conversation clean", async () => {
    const store = new MemorySessionStore();
    const conversation = [
      "my number is 9876543210",
      "the villa is ₹98,765 for 5 nights, 4 adults 2 kids",
      "flight 6E 2134 lands 9:40, can I check in at 2?",
      "iPhone 15 Pro 256GB",
      "pin code 403507",
      "wow",
      "hi",
    ];

    const verdicts: string[] = [];
    for (const [i, text] of conversation.entries()) {
      const result = await moderateStateful(req(text, { message_id: `m${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });
      verdicts.push(result.verdict);
      const merged = result.signals["merged_fragments"];
      expect(merged, `${text} fabricated ${String(merged)}`).toBeUndefined();
    }

    // Only the real phone number should have been stopped.
    expect(verdicts[0]).toBe("block");
    expect(verdicts.slice(1).every((v) => v === "allow")).toBe(true);
  });
});

describe("relationship carryover corroborates but never convicts", () => {
  /**
   * The defect these cover: digitPressure was added to the score linearly and
   * without bound. Ordinary booking chat carries ~5 digits a message (dates,
   * prices, guest counts, PIN codes), so after ten innocent turns the
   * carryover alone reached 11.9 against a block band of 8.0 — every later
   * message in the conversation was convicted by arithmetic, whatever it said.
   *
   * A clamp hid this for messages with zero detections. Anything carrying one
   * weak, innocent detection fell straight through, which is what manual
   * testing kept hitting.
   */
  const chatter = [
    "hi! is the place available for 3 nights from the 14th?",
    "we're 4 adults and 2 kids, arriving around 9:30 pm",
    "what's the total for 3 nights? is it 12000 or 15000?",
    "great, booking ref is BK-88231 if you need it",
    "the flight lands at 8:45, flight AI 2634",
    "my pin code here is 403507 for the delivery",
    "we'll pay the 5000 deposit today",
    "one more thing, is early checkin at 11 am possible?",
  ];

  async function buildPressure(stage: BookingStage = "pre_booking"): Promise<MemorySessionStore> {
    const store = new MemorySessionStore();
    for (const [i, text] of chatter.entries()) {
      await moderateStateful(req(text, { message_id: `p${i}`, booking_stage: stage }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });
    }
    return store;
  }

  it("never blocks ordinary digit-heavy chat, however long it runs", async () => {
    const store = new MemorySessionStore();
    for (const [i, text] of chatter.entries()) {
      const result = await moderateStateful(req(text, { message_id: `m${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });
      expect(result.verdict, `"${text}" was actioned`).toBe("allow");
    }
  });

  it("keeps the digit-pressure term bounded no matter how many digits accrue", async () => {
    const store = await buildPressure();
    const result = await moderateStateful(
      req("and what time is checkout?", { message_id: "after" }),
      { store, trigramModel: MODEL, nowMs: T0 + 60_000 },
    );
    const contributions = result.signals["contributions"] as Record<string, number>;
    // Below the allow band on its own: pressure may corroborate, never decide.
    expect(contributions["digitPressure"] ?? 0).toBeLessThan(DEFAULT_RISK_CONFIG.bands.low);
  });

  it("still delivers a scam report after a long digit-heavy conversation", async () => {
    // The exact case from manual testing: this message is the one a platform
    // most wants delivered, and it blocked at 20.6 purely on carryover.
    const store = await buildPressure();
    const result = await moderateStateful(
      req("someone messaged me on whatsapp claiming to be you", {
        message_id: "report",
        sender_role: "host",
      }),
      { store, trigramModel: MODEL, nowMs: T0 + 60_000 },
    );
    expect(result.verdict).toBe("allow");
  });

  it("still delivers a post-booking gate code after digit build-up", async () => {
    const store = await buildPressure("post_booking");
    const result = await moderateStateful(
      req("gate code 4471, villa 9, lane 8", {
        message_id: "gate",
        sender_role: "host",
        booking_stage: "post_booking",
      }),
      { store, trigramModel: MODEL, nowMs: T0 + 60_000 },
    );
    expect(result.verdict).toBe("allow");
  });

  it("still blocks a real number once pressure has accumulated", async () => {
    // The guard must not become a blanket amnesty: own evidence still decides.
    const store = await buildPressure();
    const result = await moderateStateful(
      req("call me on 9876543210", { message_id: "leak" }),
      { store, trigramModel: MODEL, nowMs: T0 + 60_000 },
    );
    expect(result.verdict).toBe("block");
  });
});

describe("alphanumeric identifiers are never buffered as fragments", () => {
  /**
   * Flight codes, PNRs and booking refs fuse a letter code to their digits
   * (`G81104`, `IX1982`, `A66617`). BENIGN_NEIGHBOURS cannot see that: it
   * scans for an explaining WORD near the run, and in "we are on G81104
   * arriving tomorrow" the only clue is the `G` welded to the digits.
   *
   * Two such messages in one conversation were buffered as innocent
   * fragments and merged into 8110489892 — a structurally valid IN mobile
   * nobody sent — which then blocked the conversation.
   */
  it("does not assemble a phantom number from flight codes", async () => {
    const store = new MemorySessionStore();
    const conversation = [
      "we are on IX1982 arriving tomorrow",
      "PNR is X29132",
      "we are on G81104 arriving tomorrow",
      "we are on G89892 arriving tomorrow",
    ];

    for (const [i, text] of conversation.entries()) {
      const result = await moderateStateful(req(text, { message_id: `f${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });
      expect(result.signals["merged_fragments"], `${text} fabricated a number`).toBeUndefined();
      expect(result.verdict, `${text} was actioned`).toBe("allow");
    }
  });

  it("still merges a genuinely split bare number", async () => {
    // The guard must not buy its silence by disabling split detection.
    const store = new MemorySessionStore();
    const first = await moderateStateful(req("98765", { message_id: "s0" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });
    expect(first.verdict).toBe("allow");

    const second = await moderateStateful(req("43210", { message_id: "s1" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0 + 1000,
    });
    expect(second.verdict).toBe("block");
    expect(second.signals["merged_fragments"]).toBe("9876543210");
  });
});

describe("the windowed re-scan never fabricates evidence from adjacency", () => {
  /**
   * Joining messages creates adjacency nobody wrote. "wifi password is
   * villa98765" followed by "someone messaged me on whatsapp claiming to be
   * you" concatenates to put `whatsapp` beside `98765`, which the handle
   * detector read as a messaging handle carrying a digit run — a contact
   * identifier assembled from two innocent messages, one of them a scam
   * report. Type-level dedup could not catch it: the fabricated type appears
   * in no single message, so it looked like a genuine cross-boundary find.
   */
  it("does not invent a handle by joining a wifi password to a scam report", async () => {
    const store = new MemorySessionStore();
    const conversation = [
      "gate code 4471, villa 9, lane 8",
      "wifi password is villa98765",
      "someone messaged me on whatsapp claiming to be you",
    ];

    let last: Awaited<ReturnType<typeof moderateStateful>> | undefined;
    for (const [i, text] of conversation.entries()) {
      last = await moderateStateful(
        req(text, { message_id: `w${i}`, sender_role: "host", booking_stage: "post_booking" }),
        { store, trigramModel: MODEL, nowMs: T0 + i * 1000 },
      );
      expect(last.verdict, `"${text}" was actioned`).toBe("allow");
    }

    expect(last?.signals["cross_message_categories"]).toBeUndefined();
  });

  it("still recovers a number genuinely split across turns", async () => {
    // The guard must not buy its silence by disabling the re-scan.
    const store = new MemorySessionStore();
    await moderateStateful(req("my number is 98765", { message_id: "r0" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });
    const second = await moderateStateful(req("43210 ok", { message_id: "r1" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0 + 1000,
    });
    expect(second.verdict).toBe("block");
  });
});

describe("a recovered number is acted on once, not forever", () => {
  /**
   * Fragments that produced a merge stayed in the buffer and re-merged
   * against every later message, re-reporting the same number indefinitely.
   * Four turns after "98765" … "43210" was caught, an innocent "thanks, see
   * you on the 9th!" was still blocked with "combined with an earlier
   * message, this forms the number 9876543210" — a message containing no
   * digits at all, held responsible for evidence already handled.
   */
  it("does not re-report a merged number on later messages", async () => {
    const store = new MemorySessionStore();
    const send = async (text: string, i: number) =>
      moderateStateful(req(text, { message_id: `c${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });

    await send("my number is 98765", 0);
    const completing = await send("43210", 1);
    expect(completing.verdict).toBe("block");
    expect(completing.signals["merged_fragments"]).toBe("9876543210");

    // Everything after must stand on its own evidence.
    for (const [i, text] of [
      "sorry, long day. let's just confirm the booking, I've paid",
      "will do! iPhone 15 Pro 256GB, hope it survives the flight lol",
      "thanks, see you on the 9th!",
    ].entries()) {
      const later = await send(text, i + 2);
      expect(later.signals["merged_fragments"], `${text} re-reported a merge`).toBeUndefined();
      expect(later.verdict, `${text} was actioned`).toBe("allow");
    }
  });

  it("does not charge a re-scan phone to a message with no digits", async () => {
    // The re-scan re-detected contact.phone from history on every later turn
    // and charged the full 9.0 validPhone weight to messages containing no
    // digits — asserting a phone number is present in a message that has none.
    const store = new MemorySessionStore();
    await moderateStateful(req("my number is 98765", { message_id: "d0" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });
    await moderateStateful(req("43210", { message_id: "d1" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0 + 1000,
    });

    const benign = await moderateStateful(
      req("sorry, long day. let's just confirm the booking, I've paid", { message_id: "d2" }),
      { store, trigramModel: MODEL, nowMs: T0 + 2000 },
    );
    expect(benign.verdict).toBe("allow");
    expect(benign.signals["cross_message_categories"]).toBeUndefined();
    const contributions = benign.signals["contributions"] as Record<string, number>;
    expect(contributions["validPhone"]).toBeUndefined();
  });

  it("still catches a second, genuinely new split number", async () => {
    // Consuming fragments must not blind the engine to the next attempt.
    const store = new MemorySessionStore();
    const send = async (text: string, i: number) =>
      moderateStateful(req(text, { message_id: `e${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });

    await send("98765", 0);
    expect((await send("43210", 1)).verdict).toBe("block");

    await send("91234", 2);
    const second = await send("56789", 3);
    expect(second.signals["merged_fragments"]).toBe("9123456789");
  });
});

describe("single digits are not invisible to fragment merging", () => {
  /**
   * extractDigitRuns defaults to minLength: 2 (digitruns.ts). normalize()
   * called it with no override, so a lone digit like "3" produced ZERO
   * DigitRuns — invisible to phone detection, fragment buffering and digit
   * pressure alike. A guest could leak a full number by sending it one digit
   * per message ("9", "8", "7", ...) and every message delivered as
   * "Nothing concerning found," because there was nothing in the pipeline's
   * output for Tier 3 to look at. Found manually: a demo conversation of
   * single-digit replies sailed through entirely.
   */
  it("catches a valid phone number split one digit per message", async () => {
    const store = new MemorySessionStore();
    const digits = "9876543210".split("");
    let last: Awaited<ReturnType<typeof moderateStateful>> | undefined;

    for (const [i, d] of digits.entries()) {
      last = await moderateStateful(req(d, { message_id: `sd${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });
    }

    expect(last?.verdict).toBe("block");
    expect(last?.signals["merged_fragments"]).toBe("9876543210");
  });

  it("does not turn ordinary single-digit replies into fragments on their own", async () => {
    // A single "2" answering "how many guests?" must not itself start
    // accumulating toward a merge — BENIGN_NEIGHBOURS still does its job.
    const store = new MemorySessionStore();
    const conversation = ["how many guests?", "2", "and kids?", "1"];

    for (const [i, text] of conversation.entries()) {
      const result = await moderateStateful(req(text, { message_id: `og${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });
      expect(result.verdict, `"${text}" was actioned`).toBe("allow");
      expect(result.signals["merged_fragments"]).toBeUndefined();
    }
  });
});
