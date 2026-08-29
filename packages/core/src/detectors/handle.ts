/**
 * SPEC §4 `handle` detector.
 *
 * `@handle`, platform-prefixed handles (`insta: X`, `ig X`, `telegram X`), and
 * the benchmark-#2 case: underscore-heavy usernames with embedded digit runs,
 * where the digits themselves are the payload and get extracted too.
 */

import type { Detection, NormalizedViews } from "../types.js";

/** platform marker → canonical platform name. */
const PLATFORM_MARKERS: Array<[RegExp, string]> = [
  [/\b(?:insta|instagram|ig|igdm)\b/gi, "instagram"],
  [/\b(?:telegram|tg|tele)\b/gi, "telegram"],
  [/\b(?:whatsapp|whats\s?app|wsp|wapp|watsapp)\b/gi, "whatsapp"],
  [/\b(?:snapchat|snap|sc)\b/gi, "snapchat"],
  [/\b(?:facebook|fb|messenger)\b/gi, "facebook"],
  [/\b(?:twitter|x)\b/gi, "twitter"],
  [/\b(?:discord)\b/gi, "discord"],
  [/\b(?:signal)\b/gi, "signal"],
];

/** Bare @mention. SPEC §4 says @\w{3,}. */
const AT_HANDLE_RE = /(?<![\w.])@([a-z0-9._]{3,30})\b/gi;

/**
 * A handle immediately following a platform marker, optionally after a colon,
 * "is", "id", "handle", "me at", etc.
 */
const PLATFORM_HANDLE_RE =
  /\b(insta|instagram|ig|telegram|tg|whatsapp|wsp|snapchat|snap|facebook|fb|discord|signal|twitter)\b\s*(?:id|handle|username|user|is|at|:|-|=)*\s*@?([a-z0-9._]{3,30})\b/gi;

/** "same handle as my name" style pointers — intent without a literal handle. */
const IMPLICIT_HANDLE_RE =
  /\b(?:(?:handle|username|user\s*id|id|name)\s+(?:is\s+)?(?:the\s+)?same\s+as\s+my\s+\w+|same\s+(?:handle|username|id|name)\s+as|(?:handle|username|id)\s+is\s+my\s+name|search\s+(?:for\s+)?my\s+name\s+on|find\s+me\s+by\s+my\s+name)\b/gi;

/** Words that follow a platform marker but are not handles. */
const NOT_A_HANDLE = new Set([
  "com", "the", "and", "for", "you", "your", "our", "app", "chat", "message",
  "group", "link", "profile", "page", "account", "story", "post", "reel",
  "please", "thanks", "hai", "hain", "kar", "karo", "par", "pe", "me", "on",
  "id", "handle", "username", "user", "is", "at",
  // Ordinary verbs and connectives that follow a platform name in normal
  // sentences. Without these, "someone messaged me on whatsapp claiming to be
  // you" reads "claiming" as a handle — and a guest REPORTING a scam gets
  // flagged for committing one.
  "claiming", "pretending", "saying", "asking", "telling", "offering",
  "instead", "about", "because", "before", "after", "today", "yesterday",
  "tomorrow", "again", "already", "also", "but", "just", "not", "never",
  "was", "were", "said", "says", "sent", "sends", "got", "get", "gets",
  "from", "with", "that", "this", "they", "them", "then", "when", "where",
  "which", "would", "could", "should", "some", "someone", "somebody",
  "anyone", "anybody", "everyone", "nobody", "myself", "yourself",
  "number", "numbers", "contact", "contacts", "details", "info",
]);

export function detectHandle(views: NormalizedViews): Detection[] {
  const detections: Detection[] = [];
  const seen = new Set<string>();

  const push = (d: Detection) => {
    const key = `${d.type}:${d.span.start}:${d.span.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    detections.push(d);
  };

  const text = views.folded;

  // --- @mentions -----------------------------------------------------------
  for (const match of text.matchAll(AT_HANDLE_RE)) {
    const handle = (match[1] ?? "").toLowerCase();
    // An @ followed by a known TLD pattern is an email, handled elsewhere.
    if (/\.[a-z]{2,}$/.test(handle)) continue;
    push({
      type: "contact.handle",
      span: { start: match.index, end: match.index + match[0].length },
      confidence: 0.85,
      evidence: `@${handle}`,
    });
  }

  // --- platform-prefixed handles ------------------------------------------
  for (const match of text.matchAll(PLATFORM_HANDLE_RE)) {
    const platform = normalizePlatform((match[1] ?? "").toLowerCase());
    const handle = (match[2] ?? "").toLowerCase();
    if (NOT_A_HANDLE.has(handle)) continue;
    if (handle.length < 3) continue;

    push({
      type: "contact.handle",
      span: { start: match.index, end: match.index + match[0].length },
      confidence: 0.9,
      evidence: `${platform}: ${handle}`,
    });

    // SPEC §4 (benchmark #2): underscore-heavy usernames with embedded digit
    // runs — surface the digits as their own signal so Tier 3 can accumulate
    // them and the phone detector's partial logic can see them.
    const embedded = extractEmbeddedDigits(handle);
    if (embedded.length >= 4) {
      push({
        type: "contact.handle.embedded_digits",
        span: { start: match.index, end: match.index + match[0].length },
        confidence: 0.8,
        evidence: `digits inside ${platform} handle: ${embedded}`,
      });
    }
  }

  // --- platform mention with a digit run in the same message ---------------
  // Covers "insta: akshay_98_76_five_four", where Tier 1 already merged the
  // digits into a run but the handle token itself is split by underscores.
  for (const [marker, platform] of PLATFORM_MARKERS) {
    marker.lastIndex = 0;
    const markerMatch = marker.exec(text);
    if (markerMatch === null) continue;

    for (const run of views.digitRuns) {
      if (run.digits.length < 4) continue;
      push({
        type: "contact.handle.embedded_digits",
        span: run.sourceSpan,
        confidence: run.mixedForm ? 0.88 : 0.75,
        evidence: `${platform} handle carrying digit run ${run.digits}`,
      });
    }
  }

  // --- implicit handles ----------------------------------------------------
  for (const match of text.matchAll(IMPLICIT_HANDLE_RE)) {
    push({
      type: "contact.handle.implicit",
      span: { start: match.index, end: match.index + match[0].length },
      confidence: 0.75,
      evidence: match[0].trim(),
    });
  }

  return detections;
}

function normalizePlatform(marker: string): string {
  if (["insta", "instagram", "ig"].includes(marker)) return "instagram";
  if (["telegram", "tg"].includes(marker)) return "telegram";
  if (["whatsapp", "wsp"].includes(marker)) return "whatsapp";
  if (["snapchat", "snap"].includes(marker)) return "snapchat";
  if (["facebook", "fb"].includes(marker)) return "facebook";
  return marker;
}

/** Pull every digit out of a handle-like token. */
function extractEmbeddedDigits(handle: string): string {
  return handle.replace(/\D/g, "");
}
