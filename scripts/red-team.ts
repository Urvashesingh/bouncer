/**
 * Red-team self-play (SPEC §10).
 *
 * Uses Groq to GENERATE novel evasions against the current rules, runs them
 * through the engine, reports the catch rate, and appends every miss to the
 * corpus so the next training round closes the gap.
 *
 * This is the honest version of the demo: the attacker is told what the
 * defence already catches and asked to find something else. A generator that
 * only re-emits techniques already in the corpus would produce a flattering
 * number and teach the system nothing.
 *
 * Run: pnpm redteam            (1 round, 24 attacks)
 *      pnpm redteam -- 3       (3 rounds, adapting each time)
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGroqTransport } from "../packages/core/src/llm/groq.js";
import { moderate } from "../packages/core/src/index.js";
import { normalize } from "../packages/core/src/normalize/index.js";
import type { ClassifierModel } from "../packages/core/src/classifier/index.js";
import type { TrigramModel } from "../packages/core/src/weirdness/index.js";
import type { ModerateResult } from "../packages/core/src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MINED_PATH = resolve(ROOT, "data/corpus/mined.jsonl");

const ATTACKS_PER_ROUND = 24;

function loadEnv(): Record<string, string> {
  const path = resolve(ROOT, ".env");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match === null) continue;
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value !== "") env[match[1]!] = value;
  }
  return env;
}

function loadJson<T>(relative: string): T | undefined {
  const path = resolve(ROOT, relative);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * The attacker prompt.
 *
 * Names the techniques already covered and asks for something outside that
 * list, because the interesting number is the catch rate on NOVEL attacks.
 */
const ATTACKER_SYSTEM = `You are a red-team researcher testing a contact-sharing filter for a stay-booking platform in India. Your job is to find gaps.

Write messages a real guest or host might send that leak a phone number, email, social handle, UPI ID, or push the conversation off-platform — phrased so a filter misses them.

The filter ALREADY catches these, so do not just repeat them:
- digits split by spaces, dashes, dots, underscores
- numbers spelled in English, Hindi or Hinglish words
- noise digits inserted inside words (a92m, a121ksh35ay)
- leetspeak, Cyrillic/Greek homoglyphs, zero-width characters
- (at)/(dot) email spellings, "gmail dot com"
- @handles, "insta: name_98_76"
- name@ybl style UPI IDs, wa.me and t.me links
- "book direct", "take this offline"

Find something ELSE. Be creative and realistic: think about indirection, context that only a human would resolve, references to earlier messages, cultural shorthand, ambiguity, encoding tricks, or framings that look like ordinary hospitality talk.

Return ONLY a JSON object: {"attacks":[{"text":"...","technique":"short-name","why":"one line on why this might slip through"}]}`;

interface Attack {
  text: string;
  technique: string;
  why: string;
}

function parseAttacks(raw: string): Attack[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return [];

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { attacks?: unknown };
    if (!Array.isArray(parsed.attacks)) return [];

    return parsed.attacks
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .map((a) => ({
        text: typeof a["text"] === "string" ? a["text"].slice(0, 400) : "",
        technique: typeof a["technique"] === "string" ? a["technique"].slice(0, 40) : "unknown",
        why: typeof a["why"] === "string" ? a["why"].slice(0, 200) : "",
      }))
      .filter((a) => a.text.trim() !== "");
  } catch {
    return [];
  }
}

interface Outcome {
  attack: Attack;
  result: ModerateResult;
  caught: boolean;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const apiKey = env["GROQ_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    console.error("GROQ_API_KEY not set — add it to .env");
    process.exit(1);
  }

  const rounds = Math.max(1, Number(process.argv[2] ?? 1));
  const model = env["GROQ_MODEL"] ?? "llama-3.1-8b-instant";
  // The default 200-token cap silently truncates a 24-attack list to about
  // four items — the generator was not being lazy, the ceiling was too low.
  const transport = createGroqTransport({ apiKey, maxTokens: 3000 });

  const trigramModel = loadJson<TrigramModel>("data/trigrams/model.json");
  const classifierModel = loadJson<ClassifierModel>("data/classifier/model.json");
  const options = {
    ...(trigramModel !== undefined ? { trigramModel } : {}),
    ...(classifierModel !== undefined ? { classifierModel } : {}),
  };

  console.log(`red team — ${rounds} round(s), attacker: ${model}\n`);

  const allMisses: Outcome[] = [];
  // A repetitive attacker would otherwise inflate both the denominator and the
  // mined corpus with duplicates of the same message.
  const seenAttacks = new Set<string>();
  let totalAttacks = 0;
  let totalCaught = 0;

  for (let round = 1; round <= rounds; round++) {
    // Feed previous misses back in, so each round attacks the gaps the last
    // one found rather than re-treading the same ground.
    const feedback =
      allMisses.length > 0
        ? `\n\nThese got through last round — push further in these directions:\n${allMisses
            .slice(-8)
            .map((m) => `- ${m.attack.text}`)
            .join("\n")}`
        : "";

    const response = await transport({
      system: ATTACKER_SYSTEM,
      user: `Generate ${ATTACKS_PER_ROUND} distinct attack messages.${feedback}`,
      model,
    });

    const fresh = parseAttacks(response.content);
    const attacks = fresh.filter((a) => {
      const key = a.text.trim().toLowerCase();
      if (seenAttacks.has(key)) return false;
      seenAttacks.add(key);
      return true;
    });

    if (fresh.length > attacks.length) {
      console.log(`round ${round}: dropped ${fresh.length - attacks.length} repeat(s)`);
    }
    if (attacks.length === 0) {
      console.log(`round ${round}: attacker returned nothing parseable, skipping`);
      continue;
    }

    const outcomes: Outcome[] = attacks.map((attack) => {
      const result = moderate(
        {
          message_id: `rt_${round}_${Math.random().toString(36).slice(2, 8)}`,
          conversation_id: `redteam_${round}`,
          sender_role: "guest",
          booking_stage: "pre_booking",
          text: attack.text,
        },
        options,
      );
      return { attack, result, caught: result.verdict !== "allow" };
    });

    const caught = outcomes.filter((o) => o.caught).length;
    const misses = outcomes.filter((o) => !o.caught);

    totalAttacks += outcomes.length;
    totalCaught += caught;
    allMisses.push(...misses);

    console.log(
      `round ${round}: ${caught}/${outcomes.length} caught  (${((caught / outcomes.length) * 100).toFixed(0)}%)`,
    );

    for (const outcome of outcomes) {
      const mark = outcome.caught ? "  caught " : "  MISSED ";
      console.log(
        `${mark} [${outcome.attack.technique.padEnd(22)}] ${JSON.stringify(outcome.attack.text.slice(0, 68))}`,
      );
    }
    console.log();
  }

  // --- append misses to the corpus (SPEC §8 rule-mining loop) -------------
  if (allMisses.length > 0) {
    const rows = allMisses.map((miss) =>
      JSON.stringify({
        text: miss.attack.text,
        folded: normalize(miss.attack.text).folded,
        technique: miss.attack.technique,
        why: miss.attack.why,
        source: "red-team",
        minedAt: new Date().toISOString(),
      }),
    );
    appendFileSync(MINED_PATH, rows.join("\n") + "\n");
  }

  const line = "─".repeat(64);
  console.log(line);
  console.log(`attacks     ${totalAttacks}`);
  console.log(`caught      ${totalCaught}`);
  console.log(`missed      ${allMisses.length}`);
  console.log(
    `catch rate  ${totalAttacks > 0 ? ((totalCaught / totalAttacks) * 100).toFixed(1) : "0.0"}%`,
  );
  console.log(line);

  if (allMisses.length > 0) {
    console.log(`\n${allMisses.length} misses appended to data/corpus/mined.jsonl`);
    console.log("Next: `pnpm mine:rules` suggests deterministic rules for them.\n");

    // Group misses by technique so the pattern is visible, not just the list.
    const byTechnique = new Map<string, number>();
    for (const miss of allMisses) {
      byTechnique.set(miss.attack.technique, (byTechnique.get(miss.attack.technique) ?? 0) + 1);
    }
    console.log("misses by technique:");
    for (const [technique, count] of [...byTechnique].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)}×  ${technique}`);
    }
  }
}

void main();
