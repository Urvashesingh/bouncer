/**
 * Engine wiring for the browser (SPEC §11).
 *
 * core has zero I/O dependencies, so the whole cascade runs client-side with
 * no backend: the models are ordinary JSON imports and the moderation call is
 * a plain function. Only Tier 5 would need a proxy route, and the deployed
 * demo runs Tiers 1-4, which is where 100% of benchmark traffic resolves.
 */

import {
  MemorySessionStore,
  applyPolicy,
  moderateStateful,
  type ClassifierModel,
  type ModerateResult,
  type TrigramModel,
} from "@bouncer/core";

import classifierJson from "../../../data/classifier/model.json";
import trigramJson from "../../../data/trigrams/model.json";
import type { BookingStage, SenderRole } from "@bouncer/core";

const trigramModel = trigramJson as unknown as TrigramModel;
const classifierModel = classifierJson as unknown as ClassifierModel;

/** One store for the session, so relationship state accumulates as you chat. */
export const store = new MemorySessionStore();

export interface TraceEntry {
  id: string;
  text: string;
  role: SenderRole;
  stage: BookingStage;
  result: ModerateResult;
  action: ReturnType<typeof applyPolicy>;
  at: number;
}

let counter = 0;

export async function runEngine(
  text: string,
  role: SenderRole,
  stage: BookingStage,
  conversationId: string,
): Promise<TraceEntry> {
  const id = `m_${++counter}`;

  const result = await moderateStateful(
    {
      message_id: id,
      conversation_id: conversationId,
      sender_role: role,
      booking_stage: stage,
      text,
    },
    { store, trigramModel, classifierModel },
  );

  const action = applyPolicy(result, text, { preferMasking: true });

  return { id, text, role, stage, result, action, at: Date.now() };
}

export function resetConversation(): void {
  store.clear();
  counter = 0;
}

/** The five rungs of the ladder, in cost order. */
export const TIERS = [
  { key: "tier1.normalize", label: "Normalize", cost: "free" },
  { key: "tier2", label: "Detectors", cost: "free" },
  { key: "tier3.risk", label: "Risk", cost: "free" },
  { key: "tier4.classifier", label: "Classifier", cost: "free" },
  { key: "tier5.llm", label: "LLM", cost: "$0.00002" },
] as const;

/** Index of the tier that produced the verdict. */
export function resolvedTierIndex(result: ModerateResult): number {
  const resolved = result.resolved_by;
  if (resolved === "cache") return 4;
  if (resolved.startsWith("tier5")) return 4;
  if (resolved.startsWith("tier4")) return 3;
  if (resolved.startsWith("tier3")) return 2;
  if (resolved.startsWith("tier2")) return 1;
  return 0;
}
