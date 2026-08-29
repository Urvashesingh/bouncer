/**
 * Tier 4 classifier trainer (SPEC §7, build-order step 7).
 *
 * Logistic regression by minibatch SGD with L2 regularisation, trained on the
 * labeled corpus and exported to data/classifier/model.json.
 *
 * IMPORTANT: the model is trained on the messages Tier 4 actually SEES — the
 * ones Tier 3 could not resolve. Training on the whole corpus instead would
 * optimise for cases the cheap tiers already handle, and would learn nothing
 * about the genuinely ambiguous band that is the entire reason this tier
 * exists. A held-out split guards against memorising the corpus.
 *
 * Run: pnpm train:classifier
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdversarialEntry } from "../data/corpus/generators/adversarial.js";
import type { NegativeEntry } from "../data/corpus/generators/negatives.js";
// Imported from the defining modules rather than the barrel: the barrel
// re-exports both, and going through it makes DENSE_FEATURES resolve as
// undefined under the CJS interop tsx uses.
import { DENSE_FEATURES, extractFeatures, type SparseVector } from "../packages/core/src/classifier/features.js";
import { predictProbability, type ClassifierModel } from "../packages/core/src/classifier/index.js";
import { runDetectors } from "../packages/core/src/detectors/index.js";
import { normalize } from "../packages/core/src/normalize/index.js";
import { DEFAULT_RISK_CONFIG } from "../packages/core/src/risk/config.js";
import { bandFor, scoreMessage } from "../packages/core/src/risk/score.js";
import { messageWeirdness, type TrigramModel } from "../packages/core/src/weirdness/index.js";
import type { BookingStage, SenderRole } from "../packages/core/src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = resolve(ROOT, "data/classifier/model.json");

const EPOCHS = 60;
const LEARNING_RATE = 0.35;
const L2 = 1e-6;
const HELD_OUT_FRACTION = 0.2;
/** SPEC §7 decision thresholds. */
const THRESHOLDS = { allow: 0.3, block: 0.85 };

interface Sample {
  vector: SparseVector;
  label: number;
  escalated: boolean;
  group: string;
}

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    console.error(`missing ${path} — run \`pnpm build:corpus\` first`);
    process.exit(1);
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

function loadTrigramModel(): TrigramModel | undefined {
  const path = resolve(ROOT, "data/trigrams/model.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as TrigramModel;
}

/** Build a training sample by running Tiers 1-3, exactly as production does. */
function buildSample(
  text: string,
  label: number,
  group: string,
  role: SenderRole,
  stage: BookingStage,
  trigramModel: TrigramModel | undefined,
): Sample {
  const views = normalize(text);
  const { detections } = runDetectors(views);
  const weirdTokenCount =
    trigramModel !== undefined ? messageWeirdness(views.folded, trigramModel).weirdTokenCount : 0;

  const breakdown = scoreMessage(
    {
      detections,
      signals: views.signals,
      digitRuns: views.digitRuns,
      weirdTokenCount,
      digitPressure: 0,
      sessionIntentHits: 0,
      role,
      stage,
    },
    DEFAULT_RISK_CONFIG,
  );

  const vector = extractFeatures({
    detections,
    signals: views.signals,
    digitRuns: views.digitRuns,
    text: views.folded,
    weirdTokenCount,
    riskScore: breakdown.score,
    digitPressure: 0,
    role,
    stage,
  });

  return {
    vector,
    label,
    escalated: bandFor(breakdown.score, DEFAULT_RISK_CONFIG) === "escalate",
    group,
  };
}

/**
 * True when the deterministic tiers found any contact/safety/intent signal.
 * Used to filter red-team output, whose labels are the generator's opinion.
 */
function hasAnySignal(text: string, trigramModel: TrigramModel | undefined): boolean {
  void trigramModel;
  const views = normalize(text);
  const { detections } = runDetectors(views);
  return detections.length > 0 || views.signals.noiseDigitsRemoved > 0 || views.digitRuns.length > 0;
}

/** Deterministic shuffle, so training runs are reproducible. */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function main(): void {
  const trigramModel = loadTrigramModel();
  const adversarial = loadJsonl<AdversarialEntry>(resolve(ROOT, "data/corpus/adversarial.jsonl"));
  const negatives = loadJsonl<NegativeEntry>(resolve(ROOT, "data/corpus/negatives.jsonl"));

  console.log("building feature vectors…");

  const samples: Sample[] = [];

  // Red-team misses first: these are the messages the engine demonstrably got
  // wrong, so they carry more information per example than anything the
  // generators produce. The SPEC §8 loop is only real if they feed back in.
  const minedPath = resolve(ROOT, "data/corpus/mined.jsonl");
  let minedCount = 0;
  if (existsSync(minedPath)) {
    for (const line of readFileSync(minedPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as { text?: string; technique?: string };
        if (typeof entry.text !== "string") continue;

        // A red-team generator mislabels: it returns ordinary messages
        // ("what's your time zone?") as attacks. Training those as positives
        // teaches the classifier that innocuous text is a violation, which is
        // how a self-play loop poisons itself. Only keep messages the
        // deterministic tiers found SOMETHING in — a human still reviews the
        // rest via `pnpm mine:rules`.
        const sample = buildSample(
          entry.text,
          1,
          `mined:${entry.technique ?? "?"}`,
          "guest",
          "pre_booking",
          trigramModel,
        );
        if (!hasAnySignal(entry.text, trigramModel)) continue;

        samples.push(sample);
        minedCount++;
      } catch {
        // Skip malformed rows rather than failing the run.
      }
    }
  }
  if (minedCount > 0) console.log(`  ${minedCount} red-team misses folded in`);

  for (const entry of adversarial) {
    // The first half of a split number is genuinely innocuous on its own; it
    // is relationship state that convicts it, not the text. Labeling it
    // positive would teach the classifier that a bare 5-digit run is a
    // violation, which is exactly the PIN-code false positive we fixed.
    if (entry.conversation !== undefined && entry.conversation.turn === 0) continue;
    samples.push(buildSample(entry.text, 1, entry.technique, "guest", "pre_booking", trigramModel));
  }
  for (const entry of negatives) {
    samples.push(
      buildSample(
        entry.text,
        0,
        entry.kind,
        entry.sender ?? "guest",
        entry.stage ?? "pre_booking",
        trigramModel,
      ),
    );
  }

  const escalatedSamples = samples.filter((s) => s.escalated);
  console.log(`  ${samples.length} total, ${escalatedSamples.length} in the escalation band`);
  console.log(
    `  escalated: ${escalatedSamples.filter((s) => s.label === 1).length} positive, ` +
      `${escalatedSamples.filter((s) => s.label === 0).length} negative`,
  );

  // Train on the escalation band — the traffic this tier actually sees — plus
  // a sample of resolved traffic so the model stays calibrated at the extremes
  // and does not drift into predicting "uncertain" for everything.
  //
  // The context sample is drawn PER LABEL, in equal parts. Drawing it blind to
  // the label (as this once did) inherited the corpus's own skew: the band
  // held 250 positives against 6 negatives, so the model reached 100% accuracy
  // by answering "block" unconditionally and never learned what an allowable
  // borderline message looks like. Class weights alone could not fix that —
  // with six examples there is nothing to weight. The fix is to supply enough
  // negatives that "allow" is a learnable outcome at all.
  const resolved = shuffle(samples.filter((s) => !s.escalated), 7);
  const perLabel = Math.max(escalatedSamples.length, 200);
  const context = [
    ...resolved.filter((s) => s.label === 0).slice(0, perLabel * 2),
    ...resolved.filter((s) => s.label === 1).slice(0, perLabel),
  ];
  const trainingPool = shuffle([...escalatedSamples, ...context], 99);

  const poolPos = trainingPool.filter((s) => s.label === 1).length;
  console.log(
    `  training pool: ${trainingPool.length} (${poolPos} positive, ${trainingPool.length - poolPos} negative)`,
  );

  if (trainingPool.length === 0) {
    console.error("no training samples — is the corpus built?");
    process.exit(1);
  }

  const splitAt = Math.floor(trainingPool.length * (1 - HELD_OUT_FRACTION));
  const trainSet = trainingPool.slice(0, splitAt);
  const heldOut = trainingPool.slice(splitAt);

  console.log(`  training on ${trainSet.length}, holding out ${heldOut.length}\n`);

  // --- SGD -----------------------------------------------------------------
  const weights = new Map<number, number>();
  let bias = 0;

  const positives = trainSet.filter((s) => s.label === 1).length;
  const negativesCount = trainSet.length - positives;
  // Class weighting: the escalation band is usually imbalanced, and an
  // unweighted fit would happily predict the majority class everywhere.
  const posWeight = positives > 0 ? trainSet.length / (2 * positives) : 1;
  const negWeight = negativesCount > 0 ? trainSet.length / (2 * negativesCount) : 1;

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const shuffled = shuffle(trainSet, 1000 + epoch);
    let loss = 0;

    for (const sample of shuffled) {
      let z = bias;
      for (const [index, value] of sample.vector) {
        z += (weights.get(index) ?? 0) * value;
      }
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const weight = sample.label === 1 ? posWeight : negWeight;
      const error = (p - sample.label) * weight;

      loss -= weight * (sample.label * Math.log(p + 1e-12) + (1 - sample.label) * Math.log(1 - p + 1e-12));

      bias -= LEARNING_RATE * error;
      for (const [index, value] of sample.vector) {
        const current = weights.get(index) ?? 0;
        weights.set(index, current - LEARNING_RATE * (error * value + L2 * current));
      }
    }

    if (epoch % 10 === 0 || epoch === EPOCHS - 1) {
      console.log(`  epoch ${String(epoch).padStart(3)}  loss ${(loss / shuffled.length).toFixed(5)}`);
    }
  }

  // --- export --------------------------------------------------------------
  const weightRecord: Record<string, number> = {};
  for (const [index, value] of weights) {
    // Drop negligible weights: they are noise and they bloat the JSON.
    if (Math.abs(value) < 1e-4) continue;
    weightRecord[String(index)] = Math.round(value * 1e6) / 1e6;
  }

  const model: ClassifierModel = {
    weights: weightRecord,
    bias: Math.round(bias * 1e6) / 1e6,
    thresholds: THRESHOLDS,
    meta: {
      trainedOn: trainSet.length,
      epochs: EPOCHS,
      learningRate: LEARNING_RATE,
      l2: L2,
      dims: DENSE_FEATURES.length,
    },
  };

  const accuracyOf = (set: Sample[]): number => {
    if (set.length === 0) return 1;
    let correct = 0;
    for (const sample of set) {
      const p = predictProbability(sample.vector, model);
      if ((p >= 0.5 ? 1 : 0) === sample.label) correct++;
    }
    return correct / set.length;
  };

  model.meta.trainAccuracy = Math.round(accuracyOf(trainSet) * 1e4) / 1e4;
  model.meta.heldOutAccuracy = Math.round(accuracyOf(heldOut) * 1e4) / 1e4;

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(model));

  const sizeKb = Buffer.byteLength(JSON.stringify(model)) / 1024;

  console.log(`\ntrain accuracy     ${(model.meta.trainAccuracy * 100).toFixed(2)}%`);
  console.log(`held-out accuracy  ${(model.meta.heldOutAccuracy * 100).toFixed(2)}%`);
  console.log(`non-zero weights   ${Object.keys(weightRecord).length}`);
  console.log(`wrote              ${OUT_PATH} (${sizeKb.toFixed(0)} KB)`);

  // --- how the escalation band would now resolve --------------------------
  const bandOnly = escalatedSamples;
  let wouldAllow = 0;
  let wouldBlock = 0;
  let stillEscalate = 0;
  let bandErrors = 0;

  for (const sample of bandOnly) {
    const p = predictProbability(sample.vector, model);
    if (p < THRESHOLDS.allow) {
      wouldAllow++;
      if (sample.label === 1) bandErrors++;
    } else if (p > THRESHOLDS.block) {
      wouldBlock++;
      if (sample.label === 0) bandErrors++;
    } else {
      stillEscalate++;
    }
  }

  console.log(`\nescalation band (${bandOnly.length} messages) resolves as:`);
  console.log(`  allow      ${wouldAllow}`);
  console.log(`  block      ${wouldBlock}`);
  console.log(`  → tier 5   ${stillEscalate}   (${((stillEscalate / Math.max(1, samples.length)) * 100).toFixed(2)}% of all traffic)`);
  console.log(`  errors     ${bandErrors}`);
}

main();
