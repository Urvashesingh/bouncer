/**
 * SPEC §4 `intent` detector.
 *
 * Aho-Corasick over the intent lexicon, run on the DELEET view so leet
 * spellings (`c4ll`, `wh4tsapp`) are caught. Matches falling inside a known
 * benign phrase are suppressed — "call it a day" is called out as an explicit
 * FP trap in SPEC §10.
 */

import { AhoCorasick, keepLongest } from "./aho.js";
import {
  INTENT_ACTION,
  INTENT_CHANNEL,
  INTENT_NEGATIVE_CONTEXT,
  INTENT_OFFPLATFORM,
  INTENT_PAYMENT,
} from "./lexicons.js";
import type { Detection, NormalizedViews } from "../types.js";

const automaton = new AhoCorasick();
automaton.addAll(INTENT_CHANNEL, "intent.channel");
automaton.addAll(INTENT_ACTION, "intent.contact");
automaton.addAll(INTENT_OFFPLATFORM, "intent.offplatform");
automaton.addAll(INTENT_PAYMENT, "intent.payment");
automaton.build();

const negatives = new AhoCorasick();
negatives.addAll(INTENT_NEGATIVE_CONTEXT, "negative");
negatives.build();

const CONFIDENCE: Record<string, number> = {
  "intent.channel": 0.7,
  "intent.contact": 0.8,
  "intent.offplatform": 0.9,
  "intent.payment": 0.75,
};

/**
 * Proposing to CONTINUE THE CONVERSATION on a named channel.
 *
 * The action lexicon covers fixed phrases like "dm me on whatsapp" and
 * "message me on", but a host does not usually phrase it that way. "it'll be
 * easier if we just chat on WhatsApp instead" names the channel and proposes
 * moving to it, yet matched only `intent.channel` — worth 2.0, comfortably
 * inside the allow band — and was delivered. So were "talk on telegram",
 * "text on whatsapp" and "move this to whatsapp".
 *
 * That is the disintermediation this product exists to stop, arriving in the
 * most natural possible wording. Enumerating verb×channel phrases does not
 * scale, so this matches the RELATIONSHIP instead: a conversation-moving verb
 * within a short window of a channel name.
 *
 * Scoped deliberately tight. The verb must be about continuing the
 * conversation elsewhere, and `INTENT_NEGATIVE_CONTEXT` still suppresses
 * benign hits, so "we chatted on whatsapp about the booking" — past tense,
 * reporting — is not what this pattern is aimed at, and a report framing is
 * suppressed at the scoring layer besides.
 */
const MOVE_VERB =
  /\b(?:chat|chatting|talk|talking|speak|speaking|text|texting|message|messaging|msg|connect|continue|move|switch|shift|take (?:this|it)|do (?:this|it))\b/;

/** Channel names, as a group, for the proximity rule. */
const CHANNEL_NAME = new RegExp(
  `\\b(?:${INTENT_CHANNEL.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
);

/** How far apart the verb and the channel may sit and still be one thought. */
const MOVE_WINDOW = 40;

/**
 * Someone ELSE did the messaging, or it already happened.
 *
 * "i got a text from someone on whatsapp" contains a move verb ("text") near a
 * channel, but reports an approach rather than proposing one — and reporting a
 * scam is the message a platform most wants delivered. Tier 3 has a broader
 * report-framing guard, but it suppresses only the off-platform FLOOR; the raw
 * weight from this detection still landed the message in `block`. Cheaper and
 * clearer to not fire in the first place.
 */
const THIRD_PARTY_OR_PAST =
  /\b(?:someone|somebody|a stranger|another guest|another host|some guy|this guy|scammer|fraudster)\b|\bi (?:got|received|had)\b|\bclaiming to be\b|\bpretending to be\b|\b(?:was|were|had been) (?:messaged|texted|contacted|called)\b/;

/**
 * Find "move the conversation to <channel>" as a proximity relationship.
 * Returns the span of the channel mention, so masking targets the channel.
 */
function detectChannelMove(text: string): Detection | null {
  // Reporting an approach is not making one.
  if (THIRD_PARTY_OR_PAST.test(text)) return null;

  const channel = CHANNEL_NAME.exec(text);
  if (channel === null) return null;

  // The verb must precede the channel: "chat on whatsapp", not "whatsapp is
  // how my last guest tried to reach me".
  const before = text.slice(Math.max(0, channel.index - MOVE_WINDOW), channel.index);
  if (!MOVE_VERB.test(before)) return null;

  return {
    type: "intent.offplatform",
    span: { start: channel.index, end: channel.index + channel[0].length },
    confidence: 0.85,
    evidence: `proposes continuing on ${channel[0]}`,
  };
}

export function detectIntent(views: NormalizedViews): Detection[] {
  // deleet recovers leet-spelled intent words; it is the right view here and
  // (unlike denoised) leaves word boundaries intact.
  const text = views.deleet;

  // Negative phrases are matched WITHOUT the whole-word requirement on the
  // trailing edge, so "book direct flight" still suppresses inside "book
  // direct flights". Ordinary inflections are the common case in real chat and
  // an exact-form-only list would leak one false positive per plural.
  const suppressed = negatives.search(text, false);
  const matches = keepLongest(automaton.search(text));

  const detections: Detection[] = [];
  for (const match of matches) {
    // Suppress when the hit sits entirely inside a benign phrase.
    const inNegative = suppressed.some((n) => n.start <= match.start && n.end >= match.end);
    if (inNegative) continue;

    detections.push({
      type: match.tag,
      span: { start: match.start, end: match.end },
      confidence: CONFIDENCE[match.tag] ?? 0.7,
      evidence: match.term,
    });
  }

  // Proximity rule, added only when the lexicon did not already call this
  // off-platform — so "dm me on whatsapp" is not double-counted.
  if (!detections.some((d) => d.type === "intent.offplatform")) {
    const move = detectChannelMove(text);
    if (move !== null) {
      const inNegative = suppressed.some((n) => n.start <= move.span.start && n.end >= move.span.end);
      if (!inNegative) detections.push(move);
    }
  }

  return detections;
}

/** Distinct intent terms hit, for the `signals.intent_hits` field (SPEC §2). */
export function intentHits(detections: Detection[]): string[] {
  return [...new Set(detections.filter((d) => d.type.startsWith("intent.")).map((d) => d.evidence))];
}
