/**
 * Tier 3 configuration (SPEC §6, §13).
 *
 * Mirrors config/thresholds.json. Injected rather than read from disk, because
 * core does no fs I/O (SPEC §1) — the server loads the JSON via THRESHOLDS_PATH
 * and passes it in.
 */

import type { BookingStage, SenderRole } from "../types.js";

export interface RiskWeights {
  validPhone: number;
  partialPhone: number;
  mixedForm: number;
  noiseDigitsRemoved: number;
  weirdnessFlags: number;
  intentHits: number;
  handle: number;
  upi: number;
  riskyUrl: number;
  digitPressure: number;
  zeroWidthCount: number;
  /** Minimum contact score for a pure off-platform-intent message. */
  offPlatformFloor: number;
  /** Property address / access code. Heavily discounted post-booking. */
  address: number;
  email: number;
  confusablesFolded: number;
}

export interface SafetyWeights {
  /** Coarse register aimed at a thing, not a person. Never actions alone. */
  hostilitySev0?: number;
  hostilitySev1: number;
  hostilitySev2: number;
  hostilitySev3: number;
  extortion: number;
  extortionImplied: number;
  scamlink: number;
}

export interface RiskConfig {
  weights: RiskWeights;
  safetyWeights: SafetyWeights;
  modifiers: {
    stage: Record<BookingStage, number>;
    role: Record<SenderRole, number>;
  };
  bands: { low: number; high: number };
  session: {
    fragmentBufferSize: number;
    lastMessagesSize: number;
    fragmentWindowMs: number;
    digitPressureHalfLifeMs: number;
    windowedRescanMessages: number;
  };
  policy: {
    blockCooldownThreshold: number;
    blockCooldownWindowMs: number;
  };
  failMode: Record<BookingStage, "open" | "closed">;
}

/**
 * Defaults matching config/thresholds.json, so core is usable standalone
 * (tests, the browser playground) without loading a config file.
 */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  weights: {
    // A complete, recovered contact identifier is the clearest violation in
    // the product and must clear the block band on its own — it needs no
    // corroborating signal and should never spend Tier 4/5 budget. Obfuscated
    // variants stack bonuses on top and clear it by even more.
    validPhone: 9.0,
    partialPhone: 2.5,
    mixedForm: 3.0,
    noiseDigitsRemoved: 0.45,
    weirdnessFlags: 0.9,
    intentHits: 1.1,
    handle: 2.6,
    upi: 8.5,
    riskyUrl: 3.2,
    digitPressure: 0.35,
    zeroWidthCount: 0.8,
    offPlatformFloor: 3.6,
    address: 4.2,
    email: 8.5,
    confusablesFolded: 0.4,
  },
  safetyWeights: {
    hostilitySev0: 0.6,
    hostilitySev1: 3.5,
    hostilitySev2: 4.0,
    hostilitySev3: 9.0,
    extortion: 8.0,
    extortionImplied: 4.5,
    scamlink: 7.0,
  },
  modifiers: {
    stage: { pre_booking: 1.0, post_booking: 0.35 },
    role: { guest: 1.0, host: 1.25 },
  },
  bands: { low: 3.0, high: 8.0 },
  session: {
    fragmentBufferSize: 10,
    lastMessagesSize: 5,
    fragmentWindowMs: 30 * 60 * 1000,
    digitPressureHalfLifeMs: 60 * 60 * 1000,
    windowedRescanMessages: 3,
  },
  policy: {
    blockCooldownThreshold: 3,
    blockCooldownWindowMs: 10 * 60 * 1000,
  },
  failMode: { pre_booking: "closed", post_booking: "open" },
};
