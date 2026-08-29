/**
 * Writes the labeled corpora to data/corpus/*.jsonl (SPEC §10).
 *
 * Deterministic: same seed in, same corpus out, so benchmark numbers are
 * reproducible between runs and between machines.
 *
 * Run: pnpm build:corpus
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateAdversarial } from "../data/corpus/generators/adversarial.js";
import { generateNegatives } from "../data/corpus/generators/negatives.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = resolve(ROOT, "data/corpus");

function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function main(): void {
  const adversarial = generateAdversarial(1000);
  const negatives = generateNegatives(1000);

  writeJsonl(resolve(CORPUS_DIR, "adversarial.jsonl"), adversarial);
  writeJsonl(resolve(CORPUS_DIR, "negatives.jsonl"), negatives);

  console.log(`adversarial.jsonl  ${adversarial.length} entries`);
  const byTechnique = new Map<string, number>();
  for (const entry of adversarial) {
    byTechnique.set(entry.technique, (byTechnique.get(entry.technique) ?? 0) + 1);
  }
  for (const [technique, count] of [...byTechnique].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${technique.padEnd(26)} ${count}`);
  }

  console.log(`\nnegatives.jsonl    ${negatives.length} entries`);
  const byKind = new Map<string, number>();
  for (const entry of negatives) {
    byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
  }
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(26)} ${count}`);
  }
}

main();
