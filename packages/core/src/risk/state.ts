/**
 * Relationship-level session state (SPEC §6).
 *
 * The key insight this enables: contact fragments are counted PER GUEST-HOST
 * PAIR across messages, not per message. "98765" in one message and "43210"
 * three messages later is invisible to any per-message detector.
 *
 * The store is injected. The in-memory Map here is for the demo and tests; the
 * interface is deliberately narrow so a Redis-backed implementation drops in
 * without touching the engine (SPEC §6, and core stays I/O-free per SPEC §1).
 */

import type { DigitRun, SenderRole } from "../types.js";

/** A digit run remembered with when and who produced it. */
export interface TimestampedRun {
  run: DigitRun;
  timestamp: number;
  sender: SenderRole;
}

export interface RememberedMessage {
  text: string;
  sender: SenderRole;
  timestamp: number;
}

/** Per-conversation accumulator, keyed by conversation_id (SPEC §6). */
export interface PairState {
  /** Unique digits seen pre-booking, decayed over time. */
  digitPressure: number;
  /** When digitPressure was last updated, for decay. */
  digitPressureUpdatedAt: number;
  /** Last N digit runs with timestamps, for cross-message merging. */
  fragmentBuffer: TimestampedRun[];
  /**
   * Cumulative off-platform intent hits, decayed like digitPressure.
   *
   * Without decay a single "call me" early in a long, otherwise-ordinary
   * conversation stays on the books forever and inflates every later
   * message's score — including a plain "hi and welcome" with zero
   * detections of its own. Decaying it means intent only counts as a
   * pattern of RECENT behaviour, the same rationale as digit pressure.
   */
  intentHits: number;
  /** When intentHits was last updated, for decay. */
  intentHitsUpdatedAt: number;
  /** Blocks/warns accumulated against this pair. */
  strikes: number;
  /** Last N messages, for the windowed re-scan. */
  lastMessages: RememberedMessage[];
  /** Timestamps of recent blocks, for the SPEC §9 rate limit. */
  recentBlocks: number[];
}

export function emptyPairState(nowMs: number): PairState {
  return {
    digitPressure: 0,
    digitPressureUpdatedAt: nowMs,
    fragmentBuffer: [],
    intentHits: 0,
    intentHitsUpdatedAt: nowMs,
    strikes: 0,
    lastMessages: [],
    recentBlocks: [],
  };
}

/**
 * Session store interface.
 *
 * Methods return promises so a Redis implementation satisfies the same shape;
 * the in-memory store resolves synchronously.
 */
export interface SessionStore {
  get(conversationId: string): Promise<PairState | undefined>;
  set(conversationId: string, state: PairState): Promise<void>;
  delete(conversationId: string): Promise<void>;
}

/** In-memory store for the demo and tests (SPEC §6). */
export class MemorySessionStore implements SessionStore {
  private readonly states = new Map<string, PairState>();

  get(conversationId: string): Promise<PairState | undefined> {
    return Promise.resolve(this.states.get(conversationId));
  }

  set(conversationId: string, state: PairState): Promise<void> {
    this.states.set(conversationId, state);
    return Promise.resolve();
  }

  delete(conversationId: string): Promise<void> {
    this.states.delete(conversationId);
    return Promise.resolve();
  }

  /** Test/demo helper — not part of the interface. */
  clear(): void {
    this.states.clear();
  }

  get size(): number {
    return this.states.size;
  }
}

/**
 * Exponential decay of digit pressure.
 *
 * Without decay a long, friendly conversation eventually accumulates enough
 * incidental digits (prices, times, guest counts) to trip the threshold on its
 * own. Decay keeps pressure a measure of RECENT digit-sharing behaviour.
 */
export function decayDigitPressure(
  state: PairState,
  nowMs: number,
  halfLifeMs: number,
): number {
  return decayValue(state.digitPressure, state.digitPressureUpdatedAt, nowMs, halfLifeMs);
}

/**
 * Exponential decay of accumulated intent hits — same rationale as digit
 * pressure. One "call me" early in a conversation must not permanently raise
 * the score of every later, unrelated message.
 */
export function decayIntentHits(state: PairState, nowMs: number, halfLifeMs: number): number {
  return decayValue(state.intentHits, state.intentHitsUpdatedAt, nowMs, halfLifeMs);
}

function decayValue(value: number, updatedAt: number, nowMs: number, halfLifeMs: number): number {
  const elapsed = nowMs - updatedAt;
  if (elapsed <= 0 || value === 0) return value;
  return value * Math.pow(0.5, elapsed / halfLifeMs);
}

/** Drop fragments older than the merge window (SPEC §6: 30 min). */
export function pruneFragments(
  fragments: readonly TimestampedRun[],
  nowMs: number,
  windowMs: number,
  maxSize: number,
): TimestampedRun[] {
  return fragments.filter((f) => nowMs - f.timestamp <= windowMs).slice(-maxSize);
}
