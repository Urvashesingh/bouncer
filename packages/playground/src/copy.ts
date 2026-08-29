/**
 * Plain-language copy for the trace UI.
 *
 * The engine's category strings ("contact.phone.partial") are precise for
 * debugging but meaningless to a visitor. This maps every category the
 * detectors emit to a short human sentence, so the UI can explain a verdict
 * without ever showing a dotted identifier.
 */

export function explainCategory(category: string): string {
  if (category.startsWith("contact.phone")) return "Looks like a phone number";
  if (category.startsWith("contact.email")) return "Looks like an email address";
  if (category.startsWith("contact.handle")) return "Looks like a social media handle";
  if (category.startsWith("contact.url.messenger")) return "Links to a messaging app";
  if (category.startsWith("contact.url.shortener")) return "Shortened link (destination hidden)";
  if (category.startsWith("contact.url.homograph")) return "Link uses lookalike characters";
  if (category.startsWith("contact.url")) return "Contains a link";
  if (category.startsWith("payment.upi")) return "Looks like a payment ID";
  if (category === "intent.offplatform") return "Suggests moving off the platform";
  if (category === "intent.channel") return "Names a messaging app";
  if (category === "intent.contact") return "Asks for or offers contact info";
  if (category === "intent.payment") return "Mentions paying outside the app";
  if (category.startsWith("safety.hostility")) return "Contains hostile language";
  if (category.startsWith("safety.extortion")) return "Reads like a threat tied to a review or refund";
  if (category.startsWith("safety.scamlink")) return "Link paired with urgent or payment language";
  return category;
}

export function verdictLabel(verdict: string): string {
  switch (verdict) {
    case "allow":
      return "Sent";
    case "warn":
      return "Sent with a warning";
    case "mask":
      return "Sent with details hidden";
    case "block":
      return "Not delivered";
    case "review":
      return "Held for review";
    default:
      return verdict;
  }
}

export function verdictTone(verdict: string): "good" | "caution" | "stop" {
  if (verdict === "allow") return "good";
  if (verdict === "warn" || verdict === "mask" || verdict === "review") return "caution";
  return "stop";
}

/** One short line, no jargon, for the collapsed default state of a message. */
export function summarize(categories: readonly string[], verdict: string): string {
  if (verdict === "allow") return "Nothing concerning found.";
  if (categories.length === 0) return "Flagged by the risk model.";
  const first = explainCategory(categories[0]!);
  return categories.length > 1 ? `${first}, and ${categories.length - 1} more.` : `${first}.`;
}
