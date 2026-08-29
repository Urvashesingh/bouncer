/**
 * SPEC §3.4 — token-level noise strip. "The benchmark killer."
 *
 * Within an alphabetic token, a digit run of length ≤3 that has LETTERS ON
 * BOTH SIDES is noise → remove it and count it. Digits at token boundaries or
 * standalone are KEPT, because those are the real contact-info candidates.
 *
 *   a92m        → am      (+2 noise)
 *   a121ksh35ay → akshay  (+5 noise)
 *   98760       → 98760   (+0 — standalone, a candidate)
 *   iphone15    → iphone15 (+0 — trailing digits, not interior)
 *
 * noiseDigitsRemoved > 0 is itself a strong evasion signal: you do not need to
 * recover the hidden number, the mangling proves intent.
 */

/** Token separators per SPEC §3.4: whitespace and [_\-.,;:] */
const SEPARATOR_RE = /[\s_\-.,;:]/u;

const MAX_NOISE_RUN = 3;

export interface DenoiseResult {
  text: string;
  noiseDigitsRemoved: number;
  /**
   * offsetMap[i] is the index in the SOURCE text of character i in `text`.
   *
   * Removing noise digits shifts every subsequent offset left, so a span found
   * in the denoised view points at the wrong characters in the raw message.
   * The policy layer masks on raw offsets, so without this map it redacts the
   * wrong substring — and can leave the recovered number visible.
   */
  offsetMap: number[];
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{L}/u.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * Strip interior noise digits from a single token.
 * Returns the cleaned token and how many digits were dropped.
 */
export function denoiseToken(token: string, baseOffset = 0): DenoiseResult {
  const chars = [...token];

  // Only alphabetic tokens are candidates — a token with no letters is a
  // number, price, or PIN code and must survive untouched.
  if (!chars.some((c) => /\p{L}/u.test(c))) {
    return {
      text: token,
      noiseDigitsRemoved: 0,
      offsetMap: chars.map((_, i) => baseOffset + i),
    };
  }

  let out = "";
  let removed = 0;
  let i = 0;
  const offsetMap: number[] = [];

  while (i < chars.length) {
    const ch = chars[i]!;

    if (!isDigit(ch)) {
      out += ch;
      offsetMap.push(baseOffset + i);
      i++;
      continue;
    }

    // Measure the full digit run starting here.
    let j = i;
    while (j < chars.length && isDigit(chars[j])) j++;
    const runLength = j - i;

    const hasLetterBefore = isLetter(chars[i - 1]);
    const hasLetterAfter = isLetter(chars[j]);

    if (runLength <= MAX_NOISE_RUN && hasLetterBefore && hasLetterAfter) {
      removed += runLength; // interior noise → drop
    } else {
      // boundary/standalone → keep
      for (let k = i; k < j; k++) {
        out += chars[k]!;
        offsetMap.push(baseOffset + k);
      }
    }

    i = j;
  }

  return { text: out, noiseDigitsRemoved: removed, offsetMap };
}

/**
 * Apply the noise strip across a whole message, preserving separators exactly
 * so downstream spans stay meaningful.
 */
export function denoise(text: string): DenoiseResult {
  const chars = [...text];
  let out = "";
  let removed = 0;
  let buffer = "";
  let bufferStart = 0;
  const offsetMap: number[] = [];

  const flush = () => {
    if (buffer === "") return;
    const result = denoiseToken(buffer, bufferStart);
    out += result.text;
    removed += result.noiseDigitsRemoved;
    offsetMap.push(...result.offsetMap);
    buffer = "";
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (SEPARATOR_RE.test(ch)) {
      flush();
      out += ch;
      offsetMap.push(i);
    } else {
      if (buffer === "") bufferStart = i;
      buffer += ch;
    }
  }
  flush();

  return { text: out, noiseDigitsRemoved: removed, offsetMap };
}
