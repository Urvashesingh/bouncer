/**
 * SPEC §4 `upi` detector.
 *
 * A UPI VPA (`name@ybl`, `9876543210@paytm`) is India-specific and doubly
 * dangerous: it is often literally the phone number, and it moves payment
 * off-platform. Distinguished from email by the PSP handle having no dot TLD.
 */

import { UPI_PSP_HANDLES } from "./lexicons.js";
import type { Detection, NormalizedViews } from "../types.js";

const PSP_SET = new Set(UPI_PSP_HANDLES);

/** VPA shape: local part @ psp, where psp has no dot (that would be email). */
const VPA_RE = /\b([\w.\-]{3,64})@([a-z]{2,20})\b(?!\.)/gi;

export function detectUpi(views: NormalizedViews): Detection[] {
  const detections: Detection[] = [];

  for (const match of views.folded.matchAll(VPA_RE)) {
    const local = (match[1] ?? "").toLowerCase();
    const psp = (match[2] ?? "").toLowerCase();
    if (!PSP_SET.has(psp)) continue;

    const span = { start: match.index, end: match.index + match[0].length };

    // A VPA whose local part is a 10-digit IN mobile leaks BOTH a payment
    // rail and a phone number.
    const isPhoneVpa = /^[6-9]\d{9}$/.test(local);

    detections.push({
      type: "payment.upi",
      span,
      confidence: 0.95,
      evidence: `${local}@${psp}`,
    });

    if (isPhoneVpa) {
      detections.push({
        type: "contact.phone",
        span,
        confidence: 0.95,
        evidence: `phone number embedded in UPI VPA: ${local}`,
      });
    }
  }

  return detections;
}
