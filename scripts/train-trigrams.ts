/**
 * Trigram trainer (SPEC §5, build-order step 4).
 *
 * Counts character-trigram frequencies over legitimate chat text with add-one
 * smoothing, converts to log-probs, calibrates the weirdness threshold at the
 * 99.5th percentile of legit token scores, and emits data/trigrams/model.json.
 *
 * Sources, in order of preference:
 *   1. data/corpus/negatives.jsonl  (arrives at build-order step 6)
 *   2. synthetic chat text from data/corpus/generators/chat-text.ts
 *
 * Run: pnpm train:trigrams
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateChatCorpus } from "../data/corpus/generators/chat-text.js";
import {
  MIN_TOKEN_LENGTH,
  percentile,
  scoreToken,
  type TrigramModel,
} from "../packages/core/src/weirdness/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NEGATIVES_PATH = resolve(ROOT, "data/corpus/negatives.jsonl");
const OUT_PATH = resolve(ROOT, "data/trigrams/model.json");

/** SPEC §5: lowercase, keep a-z, space, digits. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789 ";
const ALPHABET_SET = new Set(ALPHABET);

/** SPEC §5: sub-0.5% token FP by construction. */
const CALIBRATION_PERCENTILE = 99.5;

function cleanText(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) {
    out += ALPHABET_SET.has(ch) ? ch : " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Load labeled negatives if step 6 has produced them; otherwise nothing. */
function loadNegatives(): string[] {
  if (!existsSync(NEGATIVES_PATH)) return [];
  const lines = readFileSync(NEGATIVES_PATH, "utf8").split("\n").filter((l) => l.trim() !== "");
  const texts: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { text?: string };
      if (typeof parsed.text === "string") texts.push(parsed.text);
    } catch {
      // Skip malformed rows rather than failing the whole training run.
    }
  }
  return texts;
}

function main(): void {
  const negatives = loadNegatives();

  // SPEC §5 asks for "a few MB" of casual chat text. Synthetic lines fill the
  // gap until the labeled corpus exists; once it does, both are used.
  const synthetic = generateChatCorpus(120_000);
  const corpus = [...negatives, ...synthetic];

  console.log(`training on ${corpus.length} lines`);
  console.log(`  ${negatives.length} from negatives.jsonl`);
  console.log(`  ${synthetic.length} synthetic`);

  // --- count trigrams ------------------------------------------------------
  const counts = new Map<string, number>();
  let totalTrigrams = 0;

  for (const line of corpus) {
    const cleaned = ` ${cleanText(line)} `;
    for (let i = 0; i + 3 <= cleaned.length; i++) {
      const trigram = cleaned.slice(i, i + 3);
      counts.set(trigram, (counts.get(trigram) ?? 0) + 1);
      totalTrigrams++;
    }
  }

  // --- add-one smoothing → log probs --------------------------------------
  // Vocabulary is every possible trigram over the alphabet, so unseen trigrams
  // get a real (small) probability rather than -Infinity.
  const vocabularySize = ALPHABET.length ** 3;
  const denominator = totalTrigrams + vocabularySize;

  const logProbs: Record<string, number> = {};
  for (const [trigram, count] of counts) {
    logProbs[trigram] = Math.log((count + 1) / denominator);
  }
  const unseenLogProb = Math.log(1 / denominator);

  console.log(`  ${counts.size} distinct trigrams over ${totalTrigrams} observations`);

  // --- calibrate threshold on legitimate tokens ---------------------------
  const draft: TrigramModel = {
    logProbs,
    unseenLogProb,
    threshold: Number.POSITIVE_INFINITY,
    meta: { trainedOn: corpus.length, distinctTrigrams: counts.size, percentile: CALIBRATION_PERCENTILE },
  };

  const tokenScores: number[] = [];
  for (const line of corpus) {
    for (const token of cleanText(line).split(" ")) {
      if (token.length < MIN_TOKEN_LENGTH) continue;
      if (!/[a-z]/.test(token)) continue;
      tokenScores.push(scoreToken(token, draft));
    }
  }
  tokenScores.sort((a, b) => a - b);

  const threshold = percentile(tokenScores, CALIBRATION_PERCENTILE);
  const percentiles: Record<string, number> = {};
  for (const p of [50, 75, 90, 95, 99, 99.5, 99.9]) {
    percentiles[String(p)] = round(percentile(tokenScores, p));
  }

  const model: TrigramModel = {
    logProbs,
    unseenLogProb: round(unseenLogProb),
    threshold: round(threshold),
    meta: {
      trainedOn: corpus.length,
      distinctTrigrams: counts.size,
      percentile: CALIBRATION_PERCENTILE,
      percentiles,
    },
  };

  // Round log-probs to keep model.json inside the SPEC §5 size budget.
  for (const key of Object.keys(model.logProbs)) {
    model.logProbs[key] = round(model.logProbs[key]!);
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(model));

  const sizeKb = Buffer.byteLength(JSON.stringify(model)) / 1024;

  console.log("\ncalibration (legit token weirdness scores):");
  for (const [p, value] of Object.entries(percentiles)) {
    console.log(`  p${p.padEnd(5)} ${value.toFixed(3)}`);
  }
  console.log(`\nthreshold  ${threshold.toFixed(3)}  (p${CALIBRATION_PERCENTILE})`);
  console.log(`scored     ${tokenScores.length} legit tokens`);
  console.log(`wrote      ${OUT_PATH} (${sizeKb.toFixed(0)} KB)`);

  // --- sanity check against the benchmark strings -------------------------
  console.log("\nsanity check:");
  const samples = ["akshay", "a121ksh35ay", "a92m", "whatsapp", "wh4tsapp", "booking", "xkqzjvw"];
  for (const sample of samples) {
    const score = scoreToken(sample, model);
    const flag = score > threshold ? "WEIRD" : "ok";
    console.log(`  ${sample.padEnd(14)} ${score.toFixed(3)}  ${flag}`);
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

main();
