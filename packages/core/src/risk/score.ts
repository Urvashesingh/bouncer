/**
 * Tier 3 scoring (SPEC §6).
 *
 * Weighted linear model over Tier 1-2 signals plus relationship-level state.
 * Contact risk and safety risk are scored SEPARATELY and combined at the end,
 * because the stage modifier must relax contact rules post-booking (a host
 * legitimately shares an address and gate code) while safety rules stay fully
 * armed at every stage.
 */

import type { RiskConfig } from "./config.js";
import type { Detection, DigitRun, NormalizationSignals } from "../types.js";
import type { BookingStage, SenderRole } from "../types.js";

export interface ScoreInput {
  detections: readonly Detection[];
  signals: NormalizationSignals;
  digitRuns: readonly DigitRun[];
  /** Count of tokens judged weird (NOT the raw max score — see weirdness §5). */
  weirdTokenCount: number;
  /** Decayed digit pressure carried by the conversation. */
  digitPressure: number;
  /** Cumulative intent hits across the conversation. */
  sessionIntentHits: number;
  role: SenderRole;
  stage: BookingStage;
  /** Folded text, used only for framing checks. Optional for callers that
   *  score detections alone. */
  text?: string;
}

export interface ScoreBreakdown {
  /** Final score after modifiers. */
  score: number;
  /** Contact-risk subtotal, before the stage/role modifiers. */
  contactRaw: number;
  /** Safety-risk subtotal. Never relaxed by stage. */
  safetyRaw: number;
  /** Per-feature contributions, for the playground trace panel. */
  contributions: Record<string, number>;
  stageModifier: number;
  roleModifier: number;
}

/**
 * Third-party framing: the sender is describing someone ELSE's off-platform
 * approach, or asking whether one is legitimate. Reporting a scam must not be
 * treated as committing one.
 */
const REPORT_FRAMING = new RegExp(
  [
    // "someone messaged me on whatsapp…", "a stranger called me…"
    String.raw`\b(?:someone|somebody|a person|another guest|another host|some guy|this guy|a stranger|scammer|fraudster|fraud)\b[^.?!]{0,60}\b(?:messaged|contacted|called|texted|dmed|dmd|dm|reached out|approached|asked|sent)\b`,
    // "…is that real?", "…are they you?"
    String.raw`\b(?:is that|is this|are they|was that)\s+(?:real|legit|genuine|actually you|you)\b`,
    // impersonation and policy-confirmation framings
    String.raw`\bclaiming to be\b`,
    String.raw`\bpretending to be\b`,
    String.raw`\bnever ask(?:s|ed)? for\b`,
    String.raw`\bis it legitimate\b`,
    String.raw`\bis this a scam\b`,
    String.raw`\bi got a (?:text|message|call|dm)\b`,
  ].join("|"),
  "i",
);

/**
 * Ceiling on the effective digit-pressure term, in "equivalent digits".
 *
 * At w.digitPressure = 0.35 this caps the contribution at ~2.1 — meaningful
 * corroboration, but below the 3.0 allow band, so accumulated pressure can
 * never by itself push a message out of `allow`. That property is what makes
 * the relationship signal safe to carry across turns.
 */
const DIGIT_PRESSURE_CAP = 6;

/** Digits of pressure at which the term reaches ~63% of its ceiling. */
const DIGIT_PRESSURE_SCALE = 12;

/**
 * Ceiling on the accumulated-intent term, for the same reason.
 *
 * Session intent is a count of intent hits across the conversation. Unbounded,
 * a chatty pair discussing "call", "contact" and "message" in ordinary senses
 * accumulates enough to block on a message containing none of them.
 */
const SESSION_INTENT_CAP = 3;

export function scoreMessage(input: ScoreInput, config: RiskConfig): ScoreBreakdown {
  const w = config.weights;
  const sw = config.safetyWeights;
  const contributions: Record<string, number> = {};

  const add = (key: string, value: number) => {
    if (value === 0) return;
    contributions[key] = (contributions[key] ?? 0) + value;
  };

  const has = (prefix: string) => input.detections.some((d) => d.type.startsWith(prefix));
  const count = (prefix: string) => input.detections.filter((d) => d.type.startsWith(prefix)).length;

  // --- contact risk --------------------------------------------------------
  let contact = 0;

  // w1 · validPhone — a complete, valid number.
  if (input.detections.some((d) => d.type === "contact.phone" || d.type === "contact.phone.obfuscated")) {
    contact += w.validPhone;
    add("validPhone", w.validPhone);
  }

  // w2 · partialPhone, scaled by how much of a number is present.
  //
  // Scaling is superlinear past 7 digits: a 5-6 digit run overlaps PIN codes,
  // prices and booking refs and must stay quiet, but an 8+ digit run with no
  // benign context has no innocent reading. A plain "22352352" scored 2.0
  // under a flat len/10 scale and was silently ALLOWED, which is the one
  // outcome a partial should never produce — SPEC §4 says partials must not
  // auto-block, not that they should pass unremarked.
  const partials = input.detections.filter((d) => d.type.startsWith("contact.phone.partial"));
  if (partials.length > 0) {
    const longest = Math.max(...input.digitRuns.map((r) => r.digits.length), 0);
    const ratio = Math.min(1, longest / 10);
    const value = longest >= 8 ? w.partialPhone * (1 + ratio) : w.partialPhone * ratio;
    contact += value;
    add("partialPhone", value);
  }

  // w3 · mixedForm — words and numerals interleaved almost never occurs in
  // legit text, so this is the highest-value Tier 1 signal (SPEC §3.6).
  const mixedForms = input.digitRuns.filter((r) => r.mixedForm).length;
  if (mixedForms > 0) {
    const value = w.mixedForm * mixedForms;
    contact += value;
    add("mixedForm", value);
  }

  // w4 · noiseDigitsRemoved — mangling proves intent (SPEC §3.4).
  if (input.signals.noiseDigitsRemoved > 0) {
    const value = w.noiseDigitsRemoved * input.signals.noiseDigitsRemoved;
    contact += value;
    add("noiseDigitsRemoved", value);
  }

  // w5 · weirdnessFlags
  if (input.weirdTokenCount > 0) {
    const value = w.weirdnessFlags * input.weirdTokenCount;
    contact += value;
    add("weirdnessFlags", value);
  }

  // w6 · intentHits — message-level hits plus what the pair has accumulated.
  //
  // The carried-over part is capped (see SESSION_INTENT_CAP): message-level
  // hits are evidence about THIS message and count in full, but history is
  // corroboration and must not grow without limit. Uncapped, a long
  // conversation that mentions "call" or "contact" in ordinary senses builds
  // a permanent surcharge applied to every subsequent message.
  const messageIntent = count("intent.");
  const offPlatform = count("intent.offplatform");
  const carriedIntent = Math.min(input.sessionIntentHits, SESSION_INTENT_CAP);
  const totalIntent = messageIntent + carriedIntent;
  // Tracked separately so the carryover guard below can tell what this message
  // earned from what it merely inherited.
  let carriedIntentValue = 0;
  if (totalIntent > 0) {
    // Off-platform intent is the highest-value family, so it counts double.
    const value = w.intentHits * (totalIntent + offPlatform);
    carriedIntentValue = w.intentHits * carriedIntent;
    contact += value;
    add("intentHits", value);
  }

  // "book direct", "take this offline" carry no contact info at all, so they
  // accumulate no other signal — yet they are exactly the disintermediation
  // the product exists to stop. Without a floor they score below the allow
  // band and are delivered untouched.
  //
  // The same applies to naming a channel AND asking to move to it ("dm me on
  // whatsapp"): neither hit is decisive alone, but together they are a request
  // to leave the platform, and the red team walked straight through the gap
  // between them.
  // Explicitly asking for a phone number is unambiguous on its own — no
  // channel, no digits, no second signal to accumulate. "can you send me your
  // number?" scored 1.1 and was delivered until the red team found it.
  const asksForNumber = input.detections.some(
    (d) =>
      d.type.startsWith("intent.contact") &&
      /\b(?:number|contact|handle|details)\b/.test(d.evidence) &&
      /\b(?:send|give|share|drop|have|whats|what is|bhej|de do)\b/.test(d.evidence),
  );

  // A guest REPORTING an off-platform approach ("someone messaged me on
  // whatsapp claiming to be you") names a channel and an action, but is
  // warning the host rather than soliciting contact — and is exactly the
  // message a platform most wants delivered. Third-party framing suppresses
  // the floor; the underlying detections still score normally.
  const isReport = REPORT_FRAMING.test(input.text ?? "");

  const channelPlusAction = count("intent.channel") > 0 && count("intent.contact") > 0;
  if (!isReport && (offPlatform > 0 || channelPlusAction || asksForNumber)) {
    const floor = w.offPlatformFloor - contact;
    if (floor > 0) {
      contact += floor;
      add("offPlatformFloor", floor);
    }
  }

  // A contact request sitting next to a full-length digit run is a number
  // being shared, even when it fails country validation ("my number is
  // 1234567890"). Requiring a VALID number here would mean any non-IN or
  // fictional number sails through next to an explicit "my number is".
  const longRun = input.digitRuns.some((r) => r.digits.length >= 10);
  const askingForContact = count("intent.contact") > 0;
  if (longRun && askingForContact && !has("contact.phone")) {
    contact += w.validPhone * 0.75;
    add("unvalidatedNumber", w.validPhone * 0.75);
  }

  // w7 · handle
  if (has("contact.handle")) {
    contact += w.handle;
    add("handle", w.handle);
  }

  // Property address / access code. Scored inside the contact block on
  // purpose: the stage modifier then discounts it heavily post-booking, which
  // is exactly SPEC §6's "host must share address/gate code" case, while a
  // host handing out the location BEFORE a booking exists still scores.
  if (has("contact.address")) {
    contact += w.address;
    add("address", w.address);
  }

  // w8 · upi
  if (has("payment.upi")) {
    contact += w.upi;
    add("upi", w.upi);
  }

  // w9 · riskyUrl — messenger/shortener/payment/homograph/risky-TLD links.
  const riskyUrl = input.detections.filter(
    (d) =>
      d.type.startsWith("contact.url.") &&
      d.type !== "contact.url",
  ).length;
  if (riskyUrl > 0) {
    const value = w.riskyUrl * Math.min(2, riskyUrl);
    contact += value;
    add("riskyUrl", value);
  }

  // w10 · digitPressure — relationship-level accumulation.
  //
  // SATURATING, not linear. Pressure counts raw digits, and ordinary booking
  // chat is full of them: dates, prices, guest counts, PIN codes, flight
  // numbers. A linear term added ~5 digits per message, so after ten turns of
  // entirely innocent conversation the carryover alone was 34 × 0.35 = 11.9 —
  // four times the block band, before the message itself contributed anything.
  // Every later message in that conversation then scored as a violation
  // regardless of content, which is precisely the runaway seen in testing.
  //
  // The signal worth keeping is "this pair trades an unusual VOLUME of
  // digits", which is a bounded observation: past a point, more digits say
  // nothing further. Saturating at DIGIT_PRESSURE_CAP keeps the evidence while
  // making it structurally impossible for carryover to dominate the score.
  // It is corroboration, never a verdict on its own.
  if (input.digitPressure > 0) {
    const saturated = DIGIT_PRESSURE_CAP * (1 - Math.exp(-input.digitPressure / DIGIT_PRESSURE_SCALE));
    const value = w.digitPressure * saturated;
    contact += value;
    add("digitPressure", value);
  }

  // w11 · zeroWidthCount — invisible characters are never accidental.
  if (input.signals.zeroWidthCount > 0) {
    const value = w.zeroWidthCount * input.signals.zeroWidthCount;
    contact += value;
    add("zeroWidthCount", value);
  }

  // email + confusables (beyond the SPEC's w1..w11 sketch, same mechanism).
  if (has("contact.email")) {
    contact += w.email;
    add("email", w.email);
  }
  if (input.signals.confusablesFolded > 0) {
    const value = w.confusablesFolded * input.signals.confusablesFolded;
    contact += value;
    add("confusablesFolded", value);
  }

  // --- safety risk ---------------------------------------------------------
  // Scored separately: safety is NOT relaxed post-booking (SPEC §6).
  let safety = 0;

  const sevWeights: Array<[string, number]> = [
    ["safety.hostility.sev3", sw.hostilitySev3],
    ["safety.hostility.sev2", sw.hostilitySev2],
    ["safety.hostility.sev1", sw.hostilitySev1],
    // sev0 is coarse register aimed at a THING ("we had a shitty flight").
    // Deliberately well below the allow band: it must never action alone, but
    // it is still counted so it corroborates alongside real hostility.
    ["safety.hostility.sev0", sw.hostilitySev0 ?? 0.6],
  ];
  for (const [type, weight] of sevWeights) {
    if (input.detections.some((d) => d.type === type)) {
      safety += weight;
      add(type, weight);
      break; // highest severity only, not cumulative
    }
  }

  if (input.detections.some((d) => d.type === "safety.extortion")) {
    safety += sw.extortion;
    add("extortion", sw.extortion);
  } else if (input.detections.some((d) => d.type === "safety.extortion.implied")) {
    safety += sw.extortionImplied;
    add("extortionImplied", sw.extortionImplied);
  }

  if (has("safety.scamlink")) {
    safety += sw.scamlink;
    add("scamlink", sw.scamlink);
  }

  // --- modifiers -----------------------------------------------------------
  const stageModifier = config.modifiers.stage[input.stage] ?? 1;
  const roleModifier = config.modifiers.role[input.role] ?? 1;

  // Stage relaxes contact only. Role asymmetry (a host pushing off-platform is
  // worse than a guest) applies to contact risk, where the fraud lives.
  let score = contact * stageModifier * roleModifier + safety;

  // --- carryover may corroborate, never convict -----------------------------
  //
  // Relationship signals (digitPressure, sessionIntentHits) describe the
  // CONVERSATION, not this message. They exist to tip a message that is
  // already suspicious on its own evidence — not to convict one that is not.
  //
  // This replaces an earlier guard that clamped the score only when a message
  // had ZERO detections. That guard was load-bearing in the worst way: it hid
  // an unbounded-carryover bug rather than fixing it, and it protected only
  // the empty-detection case. A message carrying one weak, entirely innocent
  // detection — "someone messaged me on whatsapp claiming to be you", or a
  // host's post-booking gate code — fell straight through it and was convicted
  // by accumulated pressure from earlier, unrelated messages.
  //
  // The rule: subtract carryover and re-check. If the message cannot reach the
  // allow band on its OWN evidence, carryover may not push it out of allow.
  const carryover = (contributions["digitPressure"] ?? 0) + carriedIntentValue;
  const ownEvidence = (contact - carryover) * stageModifier * roleModifier + safety;

  if (ownEvidence < config.bands.low && score >= config.bands.low) {
    // Let carryover raise the score toward the band, but not across it.
    score = Math.min(score, config.bands.low - 0.01);
  }

  return {
    score,
    contactRaw: contact,
    safetyRaw: safety,
    contributions,
    stageModifier,
    roleModifier,
  };
}

/** Band the score into a tier decision (SPEC §6). */
export type Band = "allow" | "escalate" | "block";

export function bandFor(score: number, config: RiskConfig): Band {
  if (score < config.bands.low) return "allow";
  if (score > config.bands.high) return "block";
  return "escalate";
}
