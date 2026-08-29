/**
 * Groq transport (SPEC §8).
 *
 * This is the ONE place in the package that touches the network, and it is
 * opt-in: nothing imports it unless the host explicitly wires it up. The
 * engine itself only ever sees the `LlmTransport` function type, so the
 * browser playground can run every other tier with no network at all.
 *
 * Env: GROQ_API_KEY, GROQ_MODEL (SPEC §13). The key is passed in by the host
 * rather than read from process.env here, keeping core env-free.
 */

import type { LlmRequest, LlmResponse, LlmTransport } from "./index.js";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Minimal structural types for fetch.
 *
 * Declared here rather than pulling in the DOM or @types/node libs, which the
 * rest of core deliberately does without (SPEC §1). Only the fields this
 * transport actually reads are described.
 */
interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export interface GroqTransportOptions {
  apiKey: string;
  endpoint?: string;
  /** Injected so tests can supply a stub. Defaults to the global fetch. */
  fetchFn?: FetchLike;
  maxTokens?: number;
}

/**
 * Build a transport bound to a Groq API key.
 *
 * `response_format: json_object` is part of the injection defense (SPEC §8):
 * a successfully-injected model still has to emit JSON in our schema, and
 * `parseVerdict` validates every field before any of it is trusted.
 */
export function createGroqTransport(options: GroqTransportOptions): LlmTransport {
  const endpoint = options.endpoint ?? GROQ_ENDPOINT;
  const fetchFn = options.fetchFn ?? (globalThis as { fetch?: FetchLike }).fetch;
  const maxTokens = options.maxTokens ?? 200;

  if (typeof fetchFn !== "function") {
    throw new Error("no fetch implementation available for the Groq transport");
  }

  return async (request: LlmRequest): Promise<LlmResponse> => {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        // Deterministic adjudication: the same message must not flip verdicts
        // between calls, which would also poison the cache.
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`groq ${response.status}: ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = payload.choices?.[0]?.message?.content ?? "";
    const usage = payload.usage;

    return {
      content,
      ...(usage !== undefined
        ? {
            usage: {
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
            },
          }
        : {}),
    };
  };
}
