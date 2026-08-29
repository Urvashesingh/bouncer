import { beforeEach, describe, expect, it } from "vitest";

import { MemorySessionStore, DEFAULT_RISK_CONFIG } from "@bouncer/core";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

import trigramModel from "../../../data/trigrams/model.json" with { type: "json" };
import classifierModel from "../../../data/classifier/model.json" with { type: "json" };

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    groqApiKey: undefined,
    groqModel: "llama-3.1-8b-instant",
    tier5Enabled: false,
    riskConfig: structuredClone(DEFAULT_RISK_CONFIG),
    trigramModel: trigramModel as never,
    classifierModel: classifierModel as never,
    corsOrigin: "*",
    ...overrides,
  };
}

function body(text: string, extra: Record<string, unknown> = {}) {
  return {
    message_id: `m_${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: "c_1",
    sender_role: "guest",
    booking_stage: "pre_booking",
    text,
    ...extra,
  };
}

describe("POST /v1/moderate", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ config: makeConfig(), store: new MemorySessionStore() });
  });

  it("returns the SPEC §2 response shape", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/moderate",
      payload: body("my number is 9876543210"),
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();

    for (const field of [
      "verdict",
      "categories",
      "spans",
      "confidence",
      "resolved_by",
      "signals",
      "latency_ms",
      "cost_usd",
    ]) {
      expect(json, field).toHaveProperty(field);
    }
    expect(json.verdict).toBe("block");
  });

  it("allows ordinary messages", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/moderate",
      payload: body("what time is check in?"),
    });
    expect(response.json().verdict).toBe("allow");
    expect(response.json().action).toBe("deliver");
  });

  /**
   * Oracle resistance (SPEC §9): a block must never reveal WHICH pattern
   * tripped, or the endpoint becomes a free detector to grind against.
   */
  it("returns a generic block reason that does not name the detector", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/moderate",
      payload: body("my number is 9876543210"),
    });

    const reason: string = response.json().reason;
    expect(reason.length).toBeGreaterThan(0);
    for (const leak of ["phone", "9876543210", "tier", "regex", "digit", "score", "libphonenumber"]) {
      expect(reason.toLowerCase(), leak).not.toContain(leak);
    }
  });

  it("rejects malformed requests", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["missing conversation_id", { message_id: "m", sender_role: "guest", booking_stage: "pre_booking", text: "hi" }],
      ["bad role", body("hi", { sender_role: "admin" })],
      ["bad stage", body("hi", { booking_stage: "whenever" })],
      ["missing text", { message_id: "m", conversation_id: "c", sender_role: "guest", booking_stage: "pre_booking" }],
      ["oversized text", body("x".repeat(9000))],
    ];

    for (const [label, payload] of cases) {
      const response = await app.inject({ method: "POST", url: "/v1/moderate", payload });
      expect(response.statusCode, label).toBe(400);
    }
  });

  it("accumulates relationship state across requests", async () => {
    // Split number: innocuous alone, a phone number together (SPEC §6).
    const first = await app.inject({
      method: "POST",
      url: "/v1/moderate",
      payload: body("98765", { conversation_id: "c_split" }),
    });
    expect(first.json().verdict).not.toBe("block");

    const second = await app.inject({
      method: "POST",
      url: "/v1/moderate",
      payload: body("43210", { conversation_id: "c_split" }),
    });
    expect(second.json().verdict).toBe("block");
    expect(second.json().signals.merged_fragments).toBe("9876543210");
  });

  it("delivers immediately in async mode with pending set", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/moderate",
      payload: body("my number is 9876543210", { mode: "async" }),
    });

    const json = response.json();
    // SPEC §9: zero user-facing latency, retroactive masking.
    expect(json.verdict).toBe("allow");
    expect(json.pending).toBe(true);
    expect(json.final_verdict).toBe("block");
  });

  it("reports cooldown after repeated blocks", async () => {
    let last;
    for (let i = 0; i < 4; i++) {
      last = await app.inject({
        method: "POST",
        url: "/v1/moderate",
        payload: body("my number is 987654321" + i, { conversation_id: "c_probe" }),
      });
    }
    expect(last!.json().cooldown).toBe(true);
  });
});

describe("GET /v1/health", () => {
  it("reports which tiers are live", async () => {
    const app = buildApp({ config: makeConfig() });
    const json = (await app.inject({ method: "GET", url: "/v1/health" })).json();

    expect(json.status).toBe("ok");
    expect(json.tiers["4_classifier"]).toBe(true);
    expect(json.tiers["5_llm"]).toBe(false); // no API key in tests
    expect(json.fail_mode.pre_booking).toBe("closed");
  });
});

describe("GET /v1/stats", () => {
  it("counts requests per tier and per verdict", async () => {
    const app = buildApp({ config: makeConfig(), store: new MemorySessionStore() });

    await app.inject({ method: "POST", url: "/v1/moderate", payload: body("hello there") });
    await app.inject({ method: "POST", url: "/v1/moderate", payload: body("my number is 9876543210") });

    const json = (await app.inject({ method: "GET", url: "/v1/stats" })).json();

    expect(json.requests).toBe(2);
    expect(Object.keys(json.by_tier).length).toBeGreaterThan(0);
    expect(json.by_verdict.block).toBe(1);
    expect(json.latency_ms.p50).toBeGreaterThanOrEqual(0);
    expect(json.cost.total_usd).toBe(0); // no LLM calls
  });
});
