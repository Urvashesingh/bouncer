/**
 * Server entry point (SPEC §2).
 *
 * Run: pnpm --filter @bouncer/server start
 */

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp({ config });

  await app.listen({ port: config.port, host: config.host });

  // Echo the operating mode at startup: fail-closed vs fail-open and which
  // tiers are live should never be a surprise during an incident.
  console.log(`bouncer listening on http://${config.host}:${config.port}`);
  console.log(`  tier 4 classifier: ${config.classifierModel !== undefined ? "loaded" : "OFF"}`);
  console.log(`  tier 5 llm:        ${config.tier5Enabled && config.groqApiKey !== undefined ? config.groqModel : "OFF"}`);
  console.log(`  weirdness model:   ${config.trigramModel !== undefined ? "loaded" : "OFF"}`);
  console.log(`  fail mode:         pre_booking=${config.riskConfig.failMode.pre_booking} post_booking=${config.riskConfig.failMode.post_booking}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
