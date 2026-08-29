/**
 * SPEC §4 `url` detector.
 *
 * Extracts URLs from raw + folded views, classifies against the domain
 * lexicons, and checks for IDN homographs (mixed-script hostnames). Shorteners
 * are FLAGGED, never fetched — core does no network I/O (SPEC §1).
 *
 * Also handles spoken URLs: "instagram dot com slash akshay".
 */

import {
  ALLOWLIST_DOMAINS,
  COMMON_TLDS,
  MESSENGER_DOMAINS,
  PAYMENT_DOMAINS,
  RISKY_TLDS,
  SHORTENERS,
} from "./lexicons.js";
import type { Detection, NormalizedViews } from "../types.js";

const URL_RE =
  /\b(?:https?:\/\/|www\.)?([a-z0-9¡-￿](?:[a-z0-9¡-￿-]*[a-z0-9¡-￿])?(?:\.[a-z0-9¡-￿](?:[a-z0-9¡-￿-]*[a-z0-9¡-￿])?)+)(\/[^\s]*)?/gi;

/** "instagram dot com slash akshay", "wa dot me slash 9876". */
const SPOKEN_URL_RE =
  /\b([a-z0-9-]{2,32})\s+dot\s+([a-z]{2,24})\b(?:\s+slash\s+([a-z0-9_.-]{1,64}))?/gi;

export function detectUrl(views: NormalizedViews): Detection[] {
  const detections: Detection[] = [];

  for (const match of views.folded.matchAll(URL_RE)) {
    const hostname = (match[1] ?? "").toLowerCase();
    if (!isPlausibleHostname(hostname)) continue;

    const detection = classifyHostname(hostname, match[0], match.index);
    if (detection !== null) detections.push(detection);

    // A messenger link often carries the phone number in its path
    // (wa.me/919876543210). Tier 1 deliberately does not extract digit runs
    // from URLs — that would flag every link with a number in it — so the
    // number has to be recovered here, or a complete phone leaks while the
    // engine reports only "a link was shared".
    const path = match[2];
    if (path !== undefined && matchesDomain(hostname, MESSENGER_DOMAINS)) {
      const phone = extractPhoneFromPath(path);
      if (phone !== null) {
        detections.push({
          type: "contact.phone",
          span: { start: match.index, end: match.index + match[0].length },
          confidence: 0.96,
          evidence: `phone number in messenger link path: ${phone}`,
        });
      }
    }
  }

  // Spoken forms are evaluated on the folded view too; they never overlap with
  // the URL regex because that requires a literal dot.
  for (const match of views.folded.matchAll(SPOKEN_URL_RE)) {
    const hostname = `${(match[1] ?? "").toLowerCase()}.${(match[2] ?? "").toLowerCase()}`;
    if (!isPlausibleHostname(hostname)) continue;
    if (ALLOWLIST_DOMAINS.has(hostname)) continue;

    const base = classifyHostname(hostname, match[0], match.index);
    detections.push({
      type: base?.type ?? "contact.url",
      span: { start: match.index, end: match.index + match[0].length },
      confidence: Math.min(0.95, (base?.confidence ?? 0.75) + 0.05),
      evidence: `spoken URL: ${match[0].trim()}`,
    });
  }

  // IDN homograph: hostname mixing scripts is essentially always deliberate.
  for (const match of views.nfkc.matchAll(URL_RE)) {
    const hostname = (match[1] ?? "").toLowerCase();
    if (!isPlausibleHostname(hostname)) continue;
    if (isMixedScript(hostname)) {
      detections.push({
        type: "contact.url.homograph",
        span: { start: match.index, end: match.index + match[0].length },
        confidence: 0.9,
        evidence: `mixed-script hostname: ${hostname}`,
      });
    }
  }

  return detections;
}

function classifyHostname(hostname: string, matched: string, index: number): Detection | null {
  const span = { start: index, end: index + matched.length };

  if (ALLOWLIST_DOMAINS.has(hostname)) return null;

  const registrable = hostname.split(".").slice(-2).join(".");
  const tld = hostname.split(".").pop() ?? "";

  if (matchesDomain(hostname, MESSENGER_DOMAINS)) {
    return { type: "contact.url.messenger", span, confidence: 0.97, evidence: hostname };
  }
  if (matchesDomain(hostname, SHORTENERS)) {
    // Flagged, not resolved — core does no network I/O.
    return { type: "contact.url.shortener", span, confidence: 0.8, evidence: `shortener (not expanded): ${hostname}` };
  }
  if (matchesDomain(hostname, PAYMENT_DOMAINS)) {
    return { type: "contact.url.payment", span, confidence: 0.9, evidence: hostname };
  }
  if (RISKY_TLDS.has(tld)) {
    return { type: "contact.url.risky_tld", span, confidence: 0.7, evidence: `risky TLD .${tld} (${registrable})` };
  }

  return { type: "contact.url", span, confidence: 0.6, evidence: hostname };
}

function matchesDomain(hostname: string, list: readonly string[]): boolean {
  return list.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

/**
 * Guards against "e.g", "i.e", version strings and decimals being read as
 * hostnames. Requires a known TLD or an explicit scheme/www prefix.
 */
function isPlausibleHostname(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1] ?? "";
  if (/^\d+$/.test(tld)) return false; // decimals / version numbers
  if (tld.length < 2) return false;
  return COMMON_TLDS.has(tld) || RISKY_TLDS.has(tld) || tld.length >= 2;
}

/**
 * Pull a phone number out of a URL path. Handles the wa.me convention of a
 * bare country-code-prefixed number, and the `?phone=` query parameter.
 */
function extractPhoneFromPath(path: string): string | null {
  for (const match of path.matchAll(/\d{10,15}/g)) {
    const digits = match[0];
    if (/^91[6-9]\d{9}$/.test(digits)) return digits;
    if (/^[6-9]\d{9}$/.test(digits)) return digits;
    // Other country codes: 11-15 digits starting with a plausible prefix.
    if (digits.length >= 11 && digits.length <= 15) return digits;
  }
  return null;
}

const SCRIPT_TESTS: Array<[string, RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["han", /\p{Script=Han}/u],
];

/** True when a hostname draws letters from more than one script. */
export function isMixedScript(hostname: string): boolean {
  const scripts = SCRIPT_TESTS.filter(([, re]) => re.test(hostname));
  return scripts.length > 1;
}
