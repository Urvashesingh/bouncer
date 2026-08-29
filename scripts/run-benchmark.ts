/**
 * Benchmark harness (SPEC §10). This table goes straight into the deck.
 *
 * Reports: per-category precision/recall/F1, leak rate, friction rate,
 * measured latency percentiles, tier distribution, and projected cost per
 * 100k messages.
 *
 * Run: pnpm bench
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdversarialEntry } from "../data/corpus/generators/adversarial.js";
import type { NegativeEntry } from "../data/corpus/generators/negatives.js";
import { moderate, moderateStateful } from "../packages/core/src/index.js";
import { DEFAULT_RISK_CONFIG } from "../packages/core/src/risk/config.js";
import { MemorySessionStore } from "../packages/core/src/risk/state.js";
import type { TrigramModel } from "../packages/core/src/weirdness/index.js";
import type { ClassifierModel } from "../packages/core/src/classifier/index.js";
import type { ModerateResult, Verdict } from "../packages/core/src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** SPEC §10 acceptance targets. */
const TARGETS = {
  precision: 0.99,
  recall: 0.97,
  friction: 0.005,
  p95Ms: 25,
  tier5Share: 0.02,
  costPer100k: 0.15,
};

/**
 * Groq llama-3.1-8b-instant pricing (SPEC §8). Used to project Tier 5 cost
 * from the measured tier distribution.
 */
const GROQ_PRICING = {
  inputPerMillion: 0.05,
  outputPerMillion: 0.08,
  /** Prompt is capped at ~250 tokens (SPEC §8) plus the message itself. */
  avgInputTokens: 320,
  avgOutputTokens: 60,
};

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

function loadClassifier(): ClassifierModel | undefined {
  const path = resolve(ROOT, "data/classifier/model.json");
  if (!existsSync(path)) {
    console.warn("no classifier model — run `pnpm train:classifier` for Tier 4\n");
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as ClassifierModel;
}

function loadModel(): TrigramModel | undefined {
  const path = resolve(ROOT, "data/trigrams/model.json");
  if (!existsSync(path)) {
    console.warn("no trigram model — run `pnpm train:trigrams` for weirdness scoring\n");
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as TrigramModel;
}

/** A verdict counts as "actioned" if the message would not be delivered as-is. */
function isActioned(verdict: Verdict): boolean {
  return verdict === "block" || verdict === "mask" || verdict === "review" || verdict === "warn";
}

interface Row {
  id: string;
  group: string;
  expectedActioned: boolean;
  result: ModerateResult;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (rank - low) * (sorted[high]! - sorted[low]!);
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const model = loadModel();
  const classifierModel = loadClassifier();
  const adversarial = loadJsonl<AdversarialEntry>(resolve(ROOT, "data/corpus/adversarial.jsonl"));
  const negatives = loadJsonl<NegativeEntry>(resolve(ROOT, "data/corpus/negatives.jsonl"));

  const options = {
    ...(model !== undefined ? { trigramModel: model } : {}),
    ...(classifierModel !== undefined ? { classifierModel } : {}),
  };
  const rows: Row[] = [];
  const latencies: number[] = [];

  // --- adversarial ---------------------------------------------------------
  // Multi-message entries run through the stateful path with a shared store,
  // so split numbers are evaluated the way they would be in production.
  const store = new MemorySessionStore();
  const multiMessage = adversarial.filter((e) => e.conversation !== undefined);
  const singleMessage = adversarial.filter((e) => e.conversation === undefined);

  for (const entry of singleMessage) {
    const started = performance.now();
    const result = moderate(
      {
        message_id: entry.id,
        conversation_id: `bench_${entry.id}`,
        sender_role: "guest",
        booking_stage: "pre_booking",
        text: entry.text,
      },
      options,
    );
    latencies.push(performance.now() - started);
    rows.push({ id: entry.id, group: entry.technique, expectedActioned: true, result });
  }

  // Multi-message: order by turn so the second half arrives after the first.
  const sortedMulti = [...multiMessage].sort(
    (a, b) => (a.conversation!.turn ?? 0) - (b.conversation!.turn ?? 0),
  );
  const finalTurn = new Map<string, AdversarialEntry>();
  for (const entry of sortedMulti) {
    const started = performance.now();
    const result = await moderateStateful(
      {
        message_id: entry.id,
        conversation_id: entry.conversation!.id,
        sender_role: entry.conversation!.sender,
        booking_stage: "pre_booking",
        text: entry.text,
      },
      { ...options, store, nowMs: Date.now() + entry.conversation!.turn * 1000 },
    );
    latencies.push(performance.now() - started);

    // Only the LAST turn is expected to be actioned: the first half of a split
    // number is genuinely innocuous, and demanding a block there would be
    // asking the engine to guess.
    const isFinal = entry.conversation!.turn > 0;
    if (isFinal) finalTurn.set(entry.conversation!.id, entry);
    rows.push({
      id: entry.id,
      group: entry.technique,
      expectedActioned: isFinal,
      result,
    });
  }

  // --- negatives -----------------------------------------------------------
  for (const entry of negatives) {
    const started = performance.now();
    const result = moderate(
      {
        message_id: entry.id,
        conversation_id: `bench_${entry.id}`,
        sender_role: entry.sender ?? "guest",
        booking_stage: entry.stage ?? "pre_booking",
        text: entry.text,
      },
      options,
    );
    latencies.push(performance.now() - started);
    rows.push({ id: entry.id, group: entry.kind, expectedActioned: false, result });
  }

  // --- negatives, replayed AS CONVERSATIONS ---------------------------------
  // Every negative above is scored through `moderate()` in a conversation of
  // its own, so relationship state is always empty. That measures the engine
  // on a message in isolation — which is not how it is used, and is blind by
  // construction to anything that accumulates across turns.
  //
  // It reported 0.00% friction while ordinary multi-turn conversations were
  // being blocked wholesale by runaway digit pressure: the bug lived entirely
  // in the state the harness never built up. These rows replay the same
  // hard negatives through the stateful path, in batches sharing one
  // conversation, so carryover is exercised the way production exercises it.
  const CONVERSATION_LENGTH = 12;
  const conversationalStore = new MemorySessionStore();
  for (let i = 0; i < negatives.length; i++) {
    const entry = negatives[i]!;
    const conversationId = `conv_${Math.floor(i / CONVERSATION_LENGTH)}`;
    const started = performance.now();
    const result = await moderateStateful(
      {
        message_id: `conv_${entry.id}`,
        conversation_id: conversationId,
        sender_role: entry.sender ?? "guest",
        booking_stage: entry.stage ?? "pre_booking",
        text: entry.text,
      },
      { ...options, store: conversationalStore, nowMs: Date.now() + i * 1000 },
    );
    latencies.push(performance.now() - started);
    rows.push({
      id: `conv_${entry.id}`,
      group: `conv:${entry.kind}`,
      expectedActioned: false,
      result,
    });
  }

  // --- confusion matrix ----------------------------------------------------
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const row of rows) {
    const actioned = isActioned(row.result.verdict);
    if (row.expectedActioned && actioned) tp++;
    else if (row.expectedActioned && !actioned) fn++;
    else if (!row.expectedActioned && actioned) fp++;
    else tn++;
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // --- per-group breakdown -------------------------------------------------
  const groups = new Map<string, { total: number; caught: number; expected: boolean }>();
  for (const row of rows) {
    const g = groups.get(row.group) ?? { total: 0, caught: 0, expected: row.expectedActioned };
    g.total++;
    if (isActioned(row.result.verdict) === row.expectedActioned) g.caught++;
    groups.set(row.group, g);
  }

  // --- tier distribution ---------------------------------------------------
  const tiers = new Map<string, number>();
  for (const row of rows) {
    tiers.set(row.result.resolved_by, (tiers.get(row.result.resolved_by) ?? 0) + 1);
  }

  const tier5Count = tiers.get("tier5.llm") ?? 0;
  const tier5Share = tier5Count / rows.length;
  // Anything still `review` after Tier 4 is what Tier 5 would adjudicate.
  const escalatedShare =
    rows.filter((r) => r.result.verdict === "review").length / rows.length;
  const tier4Count = tiers.get("tier4.classifier") ?? 0;
  const resolvedBelowTier4 = (rows.length - tier4Count) / rows.length;

  // --- cost ----------------------------------------------------------------
  // Only Tier 5 costs money. Until it lands (build step 8), the escalated
  // share is what WOULD reach the LLM, so cost is projected from that.
  const llmShare = tier5Share > 0 ? tier5Share : escalatedShare;
  const costPerLlmCall =
    (GROQ_PRICING.avgInputTokens / 1_000_000) * GROQ_PRICING.inputPerMillion +
    (GROQ_PRICING.avgOutputTokens / 1_000_000) * GROQ_PRICING.outputPerMillion;
  const costPer100k = llmShare * 100_000 * costPerLlmCall;

  // --- latency -------------------------------------------------------------
  const sortedLatency = [...latencies].sort((a, b) => a - b);

  // --- output --------------------------------------------------------------
  const line = "─".repeat(72);
  console.log(`\n${line}`);
  console.log("BOUNCER BENCHMARK");
  console.log(line);
  console.log(`corpus: ${adversarial.length} adversarial + ${negatives.length} negatives = ${rows.length} evaluations`);
  console.log(`weirdness model: ${model !== undefined ? `loaded (threshold ${model.threshold})` : "NOT LOADED"}`);
  console.log(`classifier:      ${classifierModel !== undefined ? `loaded (${Object.keys(classifierModel.weights).length} weights, held-out ${((classifierModel.meta.heldOutAccuracy ?? 0) * 100).toFixed(1)}%)` : "NOT LOADED"}`);
  console.log(`bands: allow < ${DEFAULT_RISK_CONFIG.bands.low} | block > ${DEFAULT_RISK_CONFIG.bands.high}`);

  console.log(`\n${line}`);
  console.log("OVERALL");
  console.log(line);
  const leakRate = fn / (tp + fn);
  const frictionRate = fp / (fp + tn);
  const verdictOf = (ok: boolean) => (ok ? "PASS" : "FAIL");

  console.log(`precision      ${precision.toFixed(4)}   target ≥ ${TARGETS.precision}   ${verdictOf(precision >= TARGETS.precision)}`);
  console.log(`recall         ${recall.toFixed(4)}   target ≥ ${TARGETS.recall}   ${verdictOf(recall >= TARGETS.recall)}`);
  console.log(`f1             ${f1.toFixed(4)}`);
  console.log(`leak rate      ${pct(leakRate)}   (adversarial delivered)`);
  console.log(`friction rate  ${pct(frictionRate)}   target ≤ ${pct(TARGETS.friction)}   ${verdictOf(frictionRate <= TARGETS.friction)}`);
  console.log(`\nconfusion: tp ${tp}  fp ${fp}  tn ${tn}  fn ${fn}`);

  console.log(`\n${line}`);
  console.log("PER TECHNIQUE (adversarial) — recall");
  console.log(line);
  const adversarialGroups = [...groups].filter(([, g]) => g.expected).sort((a, b) => a[1].caught / a[1].total - b[1].caught / b[1].total);
  for (const [name, g] of adversarialGroups) {
    const rate = g.caught / g.total;
    const flag = rate < TARGETS.recall ? "  ← below target" : "";
    console.log(`  ${pad(name, 26)} ${pad(`${g.caught}/${g.total}`, 10)} ${pct(rate)}${flag}`);
  }

  console.log(`\n${line}`);
  console.log("PER KIND (hard negatives) — pass rate");
  console.log(line);
  const negativeGroups = [...groups].filter(([, g]) => !g.expected).sort((a, b) => a[1].caught / a[1].total - b[1].caught / b[1].total);
  for (const [name, g] of negativeGroups) {
    const rate = g.caught / g.total;
    const flag = rate < 1 ? `  ← ${g.total - g.caught} false positives` : "";
    console.log(`  ${pad(name, 26)} ${pad(`${g.caught}/${g.total}`, 10)} ${pct(rate)}${flag}`);
  }

  console.log(`\n${line}`);
  console.log("LATENCY (measured)");
  console.log(line);
  console.log(`p50   ${percentile(sortedLatency, 50).toFixed(3)} ms`);
  console.log(`p95   ${percentile(sortedLatency, 95).toFixed(3)} ms   target ≤ ${TARGETS.p95Ms} ms   ${verdictOf(percentile(sortedLatency, 95) <= TARGETS.p95Ms)}`);
  console.log(`p99   ${percentile(sortedLatency, 99).toFixed(3)} ms`);
  console.log(`max   ${percentile(sortedLatency, 100).toFixed(3)} ms`);

  console.log(`\n${line}`);
  console.log("TIER DISTRIBUTION");
  console.log(line);
  for (const [tier, count] of [...tiers].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(tier, 26)} ${pad(String(count), 8)} ${pct(count / rows.length)}`);
  }
  console.log(`\nresolved at ≤ tier 3   ${pct(resolvedBelowTier4)}   target ≥ 92.00%   ${verdictOf(resolvedBelowTier4 >= 0.92)}`);
  console.log(`handled by tier 4      ${pct(tier4Count / rows.length)}`);
  // Tiers 1-4 are all free and local; only Tier 5 costs money or latency.
  // The ≥92% target exists to bound LLM spend, so the number that matters
  // operationally is this one, reported alongside the literal SPEC §6 metric.
  const resolvedLocally = 1 - escalatedShare;
  console.log(`resolved without llm   ${pct(resolvedLocally)}   (tiers 1-4, all free)`);
  console.log(`would reach tier 5     ${pct(escalatedShare)}   target ≤ ${pct(TARGETS.tier5Share)}   ${verdictOf(escalatedShare <= TARGETS.tier5Share)}`);

  console.log(`\n${line}`);
  console.log("COST (projected from tier distribution × Groq pricing)");
  console.log(line);
  console.log(`llm share            ${pct(llmShare)}`);
  console.log(`cost per llm call    $${costPerLlmCall.toFixed(8)}`);
  console.log(`cost per 100k msgs   $${costPer100k.toFixed(4)}   target ≤ $${TARGETS.costPer100k}   ${verdictOf(costPer100k <= TARGETS.costPer100k)}`);
  console.log(`${line}\n`);

  // --- misses, so the next tuning pass has somewhere to start -------------
  const misses = rows.filter((r) => r.expectedActioned && !isActioned(r.result.verdict));
  if (misses.length > 0) {
    console.log(`MISSES (${misses.length}) — first 25:`);
    for (const miss of misses.slice(0, 25)) {
      console.log(`  [${miss.group}] score=${miss.result.signals["risk_score"]} ${miss.id}`);
    }
    console.log();
  }

  const falsePositives = rows.filter((r) => !r.expectedActioned && isActioned(r.result.verdict));
  if (falsePositives.length > 0) {
    console.log(`FALSE POSITIVES (${falsePositives.length}) — first 25:`);
    for (const fpRow of falsePositives.slice(0, 25)) {
      console.log(`  [${fpRow.group}] score=${fpRow.result.signals["risk_score"]} verdict=${fpRow.result.verdict} ${fpRow.id}`);
    }
    console.log();
  }
}

void main();
