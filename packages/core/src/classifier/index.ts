/**
 * Tier 4 — tiny classifier (SPEC §7).
 *
 * Hand-rolled logistic regression. Inference is one dot product over a sparse
 * vector: no ML framework, no native deps, no ONNX. Well under the 1ms budget.
 *
 * This slot upgrades to a distilled transformer via onnxruntime-node behind
 * the same interface — see README.
 *
 * Output p ∈ [0,1]: p < 0.3 allow, p > 0.85 block, otherwise → Tier 5.
 */

import { extractFeatures, type FeatureInput, type SparseVector } from "./features.js";

export interface ClassifierModel {
  /** Sparse weight map: feature index → weight. */
  weights: Record<string, number>;
  bias: number;
  /** Decision thresholds (SPEC §7). */
  thresholds: { allow: number; block: number };
  meta: {
    trainedOn: number;
    epochs: number;
    learningRate: number;
    l2: number;
    dims: number;
    /** Training-set metrics, printed by the trainer. */
    trainAccuracy?: number;
    heldOutAccuracy?: number;
  };
}

export type ClassifierDecision = "allow" | "escalate" | "block";

export interface ClassifierResult {
  /** Probability the message is a violation. */
  probability: number;
  decision: ClassifierDecision;
}

export function sigmoid(z: number): number {
  // Numerically stable for large |z|.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Dot product of a sparse vector with the model's sparse weights. */
export function dot(vector: SparseVector, weights: Record<string, number>): number {
  let sum = 0;
  for (const [index, value] of vector) {
    const weight = weights[String(index)];
    if (weight !== undefined) sum += weight * value;
  }
  return sum;
}

export function predictProbability(vector: SparseVector, model: ClassifierModel): number {
  return sigmoid(dot(vector, model.weights) + model.bias);
}

/** Run Tier 4 over Tier 1-3 output. */
export function classify(input: FeatureInput, model: ClassifierModel): ClassifierResult {
  const probability = predictProbability(extractFeatures(input), model);

  const decision: ClassifierDecision =
    probability < model.thresholds.allow
      ? "allow"
      : probability > model.thresholds.block
        ? "block"
        : "escalate";

  return { probability, decision };
}

export {
  extractFeatures,
  extractDense,
  extractNgrams,
  hashString,
  DENSE_FEATURES,
  HASH_DIMS,
  FEATURE_DIMS,
} from "./features.js";
export type { FeatureInput, SparseVector } from "./features.js";
