/**
 * Server configuration (SPEC §13).
 *
 * All fs and env access lives here and in index.ts — core stays pure, which is
 * what lets the same engine run in the browser playground with no backend.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_RISK_CONFIG } from "@bouncer/core";
import type { ClassifierModel, RiskConfig, TrigramModel } from "@bouncer/core";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");

export interface ServerConfig {
  port: number;
  host: string;
  groqApiKey: string | undefined;
  groqModel: string;
  tier5Enabled: boolean;
  riskConfig: RiskConfig;
  trigramModel: TrigramModel | undefined;
  classifierModel: ClassifierModel | undefined;
  corsOrigin: string;
}

/** Read .env without a dependency. Real env vars win over the file. */
export function loadDotEnv(path = resolve(REPO_ROOT, ".env")): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match === null) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value !== "") process.env[key] = value;
  }
}

function loadJson<T>(path: string, label: string): T | undefined {
  if (!existsSync(path)) {
    console.warn(`[config] ${label} not found at ${path}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    console.warn(`[config] failed to parse ${label}: ${String(error)}`);
    return undefined;
  }
}

/**
 * Merge the thresholds file over the defaults.
 *
 * Shallow-merged per section so a partial file is valid: an operator tuning
 * one band should not have to restate every weight, and a typo in one key
 * must not silently zero the rest.
 */
function loadRiskConfig(path: string): RiskConfig {
  const raw = loadJson<Partial<RiskConfig>>(path, "thresholds");
  if (raw === undefined) return DEFAULT_RISK_CONFIG;

  return {
    weights: { ...DEFAULT_RISK_CONFIG.weights, ...strip(raw.weights) },
    safetyWeights: { ...DEFAULT_RISK_CONFIG.safetyWeights, ...strip(raw.safetyWeights) },
    modifiers: {
      stage: { ...DEFAULT_RISK_CONFIG.modifiers.stage, ...strip(raw.modifiers?.stage) },
      role: { ...DEFAULT_RISK_CONFIG.modifiers.role, ...strip(raw.modifiers?.role) },
    },
    bands: { ...DEFAULT_RISK_CONFIG.bands, ...strip(raw.bands) },
    session: { ...DEFAULT_RISK_CONFIG.session, ...strip(raw.session) },
    policy: { ...DEFAULT_RISK_CONFIG.policy, ...strip(raw.policy) },
    failMode: { ...DEFAULT_RISK_CONFIG.failMode, ...strip(raw.failMode) },
  };
}

/**
 * Drop `$comment` keys.
 *
 * thresholds.json documents itself inline, and without this those keys ride
 * straight through the config into the /v1/health response body.
 */
function strip<T extends object>(section: T | undefined): Partial<T> {
  if (section === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(section)) {
    if (key.startsWith("$")) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

export function loadConfig(): ServerConfig {
  loadDotEnv();

  const thresholdsPath = resolve(
    REPO_ROOT,
    process.env["THRESHOLDS_PATH"] ?? "config/thresholds.json",
  );

  const riskConfig = loadRiskConfig(thresholdsPath);

  // SPEC §2: pre_booking fails CLOSED. The env var can override, and the
  // effective value is echoed at startup so the operating mode is never a
  // surprise in an incident.
  const failModePreBooking = process.env["FAIL_MODE_PREBOOKING"];
  if (failModePreBooking === "open" || failModePreBooking === "closed") {
    riskConfig.failMode.pre_booking = failModePreBooking;
  }

  return {
    port: Number(process.env["PORT"] ?? 8080),
    host: process.env["HOST"] ?? "0.0.0.0",
    groqApiKey: process.env["GROQ_API_KEY"],
    groqModel: process.env["GROQ_MODEL"] ?? "llama-3.1-8b-instant",
    tier5Enabled: process.env["TIER5_ENABLED"] !== "false",
    riskConfig,
    trigramModel: loadJson<TrigramModel>(
      resolve(REPO_ROOT, "data/trigrams/model.json"),
      "trigram model",
    ),
    classifierModel: loadJson<ClassifierModel>(
      resolve(REPO_ROOT, "data/classifier/model.json"),
      "classifier model",
    ),
    corsOrigin: process.env["CORS_ORIGIN"] ?? "*",
  };
}
