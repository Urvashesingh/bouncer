/**
 * Physical-address detector.
 *
 * SPEC §6 says post-booking "massively relaxes contact rules (host must share
 * address/gate code)" — which only means anything if sharing an address BEFORE
 * a booking exists is restricted in the first place. Nothing detected it, so
 * "gate code 4471, villa 9, lane 8" sailed through pre-booking: a host handing
 * over the property location before any booking is the disintermediation the
 * product exists to stop, and a gate code shared pre-booking is a security
 * problem on its own.
 *
 * The stage modifier (SPEC §6) is what makes this safe: these detections are
 * scored heavily pre-booking and heavily discounted post-booking, so the
 * legitimate case — a host sending directions to a confirmed guest — stays
 * quiet without a second code path.
 */

import { AhoCorasick, keepLongest } from "./aho.js";
import type { Detection, NormalizedViews } from "../types.js";

/** Access credentials. Sensitive on their own, not just as location. */
const ACCESS_TERMS = [
  "gate code", "gate pin", "door code", "door pin", "lock code", "lockbox",
  "lock box", "key code", "keypad code", "access code", "entry code",
  "building code", "smart lock", "keybox", "key box", "gate ka code",
];

/**
 * Phrases that mean an address is being HANDED OVER, not merely mentioned.
 *
 * The distinction matters: "house no 64, near the temple" is ordinary
 * conversation and appears throughout the hard-negative corpus, whereas
 * "the address is …" or "sharing my live location" is the act of giving out
 * the property's location. Matching bare "house no" or "lane" produced 38
 * false positives and pushed friction from 0.00% to 3.80%.
 */
const ADDRESS_TERMS = [
  "address is", "full address", "exact address", "my address",
  "complete address", "address of the property", "property address",
  "here is the address", "sending the address", "sharing the address",
  "google maps", "maps link", "maps.app.goo.gl", "goo.gl/maps",
  "pin location", "share location", "sharing location", "live location",
  "location pin", "drop a pin", "dropping a pin",
  "ghar ka address", "address bhej", "location bhej", "address de dunga",
];

const access = new AhoCorasick();
access.addAll(ACCESS_TERMS, "access");
access.build();

const address = new AhoCorasick();
address.addAll(ADDRESS_TERMS, "address");
address.build();

/**
 * Asking ABOUT an address or code is not sharing one.
 *
 * "what is the exact address for reference?" and "how many digits is the gate
 * code?" are questions a guest asks; "the address is …" is a host handing the
 * location over. Without this distinction the detector fired on 15 ordinary
 * messages — the same reporting-versus-doing confusion that once flagged
 * guests for reporting scams.
 */
const ASKING_ABOUT =
  /\b(?:what(?:'?s| is)|which|where|how many|how long|can i get|could i get|do you have|is there|may i|please send|could you send|can you send|mentioned|forgot|lost|edited?|by mistake)\b/i;

export function detectAddress(views: NormalizedViews): Detection[] {
  const detections: Detection[] = [];
  const text = views.deleet;

  // A question is a request, not a disclosure.
  if (ASKING_ABOUT.test(text)) return detections;

  for (const match of keepLongest(access.search(text))) {
    detections.push({
      type: "contact.address.access_code",
      span: { start: match.start, end: match.end },
      confidence: 0.85,
      evidence: match.term,
    });
  }

  for (const match of keepLongest(address.search(text))) {
    detections.push({
      type: "contact.address",
      span: { start: match.start, end: match.end },
      confidence: 0.75,
      evidence: match.term,
    });
  }

  return detections;
}
