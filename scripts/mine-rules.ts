/**
 * Rule-mining loop (SPEC §8, v1 = simplest thing that works).
 *
 * Every Tier 5 positive is appended to data/corpus/adversarial.jsonl with its
 * normalized form; this script reads those entries and SUGGESTS deterministic
 * rule candidates for human review.
 *
 * Deliberately semi-automatic: it proposes, a human disposes. Auto-promoting
 * mined rules straight into the lexicon would let a single LLM
 * misclassification permanently widen the filter, and SPEC §14 lists full
 * automation as a non-goal for v1.
 *
 * Run: pnpm mine:rules
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDetectors } from "../packages/core/src/detectors/index.js";
import { normalize } from "../packages/core/src/normalize/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MINED_PATH = resolve(ROOT, "data/corpus/mined.jsonl");

interface MinedEntry {
  text: string;
  folded?: string;
  contact_type?: string | null;
  safety_type?: string | null;
  minedAt?: string;
}

/** Tokens that carry no discriminating signal on their own. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "me", "my", "you", "your",
  "i", "we", "us", "it", "is", "are", "was", "be", "to", "of", "in", "on", "at",
  "for", "with", "this", "that", "can", "will", "just", "please", "hi", "hello",
  "hai", "hain", "ka", "ki", "ke", "ko", "se", "par", "pe", "hi", "bhi", "kar",
]);

function main(): void {
  if (!existsSync(MINED_PATH)) {
    console.log(`no mined entries yet (${MINED_PATH})`);
    console.log("Tier 5 positives are appended here as they occur.");
    return;
  }

  const entries: MinedEntry[] = readFileSync(MINED_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as MinedEntry);

  console.log(`${entries.length} mined Tier 5 positives\n`);

  // --- which of these do the deterministic tiers ALREADY catch? -----------
  const stillMissed: MinedEntry[] = [];
  for (const entry of entries) {
    const views = normalize(entry.text);
    const { detections } = runDetectors(views);
    const caught = detections.some(
      (d) => d.type.startsWith("contact.") || d.type.startsWith("safety.") || d.type.startsWith("payment."),
    );
    if (!caught) stillMissed.push(entry);
  }

  console.log(`${entries.length - stillMissed.length} already covered by Tiers 1-2`);
  console.log(`${stillMissed.length} still need a rule\n`);

  if (stillMissed.length === 0) {
    console.log("nothing to suggest — the deterministic tiers have caught up.");
    return;
  }

  // --- candidate phrases ---------------------------------------------------
  // Count n-grams across the misses: a phrase recurring in several independent
  // evasions is a rule candidate; one appearing once is probably noise.
  const phraseCounts = new Map<string, number>();

  for (const entry of stillMissed) {
    const tokens = normalize(entry.text)
      .folded.split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t));

    const seen = new Set<string>();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const phrase = tokens.slice(i, i + n).join(" ");
        if (phrase.length < 4) continue;
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
      }
    }
  }

  const candidates = [...phraseCounts]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  console.log("SUGGESTED LEXICON CANDIDATES (review before adding):");
  console.log("─".repeat(60));
  for (const [phrase, count] of candidates) {
    console.log(`  ${String(count).padStart(4)}×  ${phrase}`);
  }

  console.log("\nSUGGESTED REVIEW SAMPLE:");
  console.log("─".repeat(60));
  for (const entry of stillMissed.slice(0, 15)) {
    console.log(`  [${entry.contact_type ?? entry.safety_type ?? "?"}] ${JSON.stringify(entry.text.slice(0, 70))}`);
  }

  console.log(
    `\nAdd confirmed phrases to data/lexicons/*.json and mirror them into` +
      `\npackages/core/src/detectors/lexicons.ts, then re-run \`pnpm bench\`.`,
  );
}

main();
