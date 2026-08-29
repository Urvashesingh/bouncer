/**
 * Tier 2 — deterministic detectors (SPEC §4).
 *
 * Every detector has the shape (views) → Detection[]. They are conceptually
 * parallel; being sync and fast, they just run in sequence. Total budget here
 * is well under the p95 ≤ 25ms target in SPEC §10.
 */

import { detectAddress } from "./address.js";
import { detectEmail } from "./email.js";
import { detectHandle } from "./handle.js";
import { detectIntent, intentHits } from "./intent.js";
import { detectPhone, markObfuscation } from "./phone.js";
import { detectExtortion, detectHostility, detectScamLink } from "./safety.js";
import { detectUpi } from "./upi.js";
import { detectUrl } from "./url.js";
import type { Detection, NormalizedViews } from "../types.js";

export interface DetectionResult {
  detections: Detection[];
  /** Distinct intent terms, surfaced for SPEC §2 `signals.intent_hits`. */
  intentHits: string[];
}

export function runDetectors(views: NormalizedViews): DetectionResult {
  const phone = markObfuscation(views, detectPhone(views));
  const email = detectEmail(views);
  const url = detectUrl(views);
  const handle = detectHandle(views);
  const upi = detectUpi(views);
  const address = detectAddress(views);
  const intent = detectIntent(views);
  const hostility = detectHostility(views);
  const extortion = detectExtortion(views);
  // scamlink composes on top of url rather than re-parsing.
  const scamlink = detectScamLink(views, url);

  const detections = dedupe([
    ...phone,
    ...email,
    ...url,
    ...handle,
    ...upi,
    ...address,
    ...intent,
    ...hostility,
    ...extortion,
    ...scamlink,
  ]);

  return { detections, intentHits: intentHits(intent) };
}

/** Collapse identical (type, span) hits, keeping the most confident. */
function dedupe(detections: Detection[]): Detection[] {
  const best = new Map<string, Detection>();
  for (const d of detections) {
    const key = `${d.type}:${d.span.start}:${d.span.end}`;
    const existing = best.get(key);
    if (existing === undefined || d.confidence > existing.confidence) best.set(key, d);
  }
  return [...best.values()].sort((a, b) => a.span.start - b.span.start || b.confidence - a.confidence);
}

export { detectAddress } from "./address.js";
export { detectEmail } from "./email.js";
export { detectHandle } from "./handle.js";
export { detectIntent, intentHits } from "./intent.js";
export { detectPhone } from "./phone.js";
export { detectExtortion, detectHostility, detectScamLink } from "./safety.js";
export { detectUpi } from "./upi.js";
export { detectUrl, isMixedScript } from "./url.js";
export { AhoCorasick, keepLongest } from "./aho.js";
