/**
 * runner.mjs — put the questions to the models, and write down what came back.
 *
 *   node experiments/intent-to-filter/runner.mjs --dry-run
 *   node experiments/intent-to-filter/runner.mjs --pilot
 *   node experiments/intent-to-filter/runner.mjs --run
 *
 * Two decisions here are deliberate, and each would corrupt the measurement if
 * taken the other way.
 *
 * **No structured-output or strict-schema mode.** Constrained decoding would
 * drive the two schema arms to structural validity by construction, and it is
 * available to them and to no other arm at any price. That is a real advantage
 * the design declines to bank, because it is not what MCP servers do today.
 *
 * **Tool choice left on auto.** Two questions cannot be answered by the tool at
 * all, and saying so is the correct response. Forcing a call would turn the
 * abstention probe into a fabrication probe.
 *
 * Results are appended to JSONL as they arrive, so an interrupted run loses
 * nothing and can be resumed against the same file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { CORPUS } from "./corpus.mjs";
import { ARMS, BY_NAME, approxTokens } from "./arms/index.mjs";
import { PROVIDERS, ask, incompatibility, pooled } from "./providers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "results");

/** Concurrency, per provider. Groq rate-limits on input tokens per minute, and
 *  the generated schema is 15k tokens a call, so it gets the smallest pool. */
const CONCURRENCY = { "gpt-5.5": 8, "gpt-5.4-mini": 8, "gpt-oss-120b": 2, "gemini-3.8-flash": 2 };

const key = (provider, arm, caseId, trial) => `${provider}|${arm}|${caseId}|t${trial}`;

// ---------------------------------------------------------------------------
// Repair: hand the rejection back the way an MCP server would
// ---------------------------------------------------------------------------

function repairTurns(providerKey, arm, attempt) {
  const problem = JSON.stringify(attempt.problem, null, 2);
  if (PROVIDERS[providerKey].family === "gemini") {
    return [
      { role: "model", parts: [{ functionCall: { name: arm.tool.name, args: attempt.input ?? {} } }] },
      { role: "user", parts: [{ functionResponse: { name: arm.tool.name, response: { error: attempt.problem } } }] },
    ];
  }
  return [
    attempt.assistantMessage,
    { role: "tool", tool_call_id: attempt.toolCallId, content: problem },
  ];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function cells({ providers, arms, cases, trials }) {
  const out = [];
  for (const provider of providers) {
    // Trials can be capped per provider. Groq rate-limits on tokens per minute
    // and jql-raw alone is 61k characters a call, so five trials there would
    // take hours of mostly backoff. Fewer trials is an honest widening of that
    // provider's intervals, reported as such; more concurrency would not help,
    // because the ceiling is tokens, not connections.
    const n = typeof trials === "number" ? trials : (trials[provider] ?? 5);
    for (const armName of arms) {
      const arm = BY_NAME[armName];
      const blocked = incompatibility(provider, arm);
      for (const testCase of cases) {
        for (let trial = 1; trial <= n; trial += 1) {
          out.push({ provider, arm: armName, caseId: testCase.id, trial, blocked, testCase, armModule: arm });
        }
      }
    }
  }
  return out;
}

function dryRun(plan) {
  const all = cells(plan);
  const live = all.filter((c) => !c.blocked);
  console.log("\nCompatibility\n");
  console.log(`  ${"provider".padEnd(18)} ${ARMS.map((a) => a.name.slice(0, 13).padEnd(14)).join("")}`);
  for (const provider of plan.providers) {
    const row = ARMS.map((a) => (incompatibility(provider, BY_NAME[a.name]) ? "—" : "yes").padEnd(14)).join("");
    console.log(`  ${provider.padEnd(18)} ${row}`);
  }

  console.log("\nRequests\n");
  for (const provider of plan.providers) {
    const mine = live.filter((c) => c.provider === provider);
    const tokens = mine.reduce((sum, c) => sum + approxTokens(JSON.stringify(c.armModule.tool)) + 200, 0);
    console.log(`  ${provider.padEnd(18)} ${String(mine.length).padStart(5)} calls  ~${String(Math.round(tokens / 1000)).padStart(5)}k input tokens`);
  }
  console.log(`\n  ${live.length} calls, ${all.length - live.length} cells skipped as provider-incompatible.`);
  console.log("  Nothing was sent.\n");
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function run(plan, { label, repair }) {
  if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
  const path = join(RESULTS, `${label}.jsonl`);

  const done = new Set();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      done.add(key(row.provider, row.arm, row.caseId, row.trial));
    }
    console.log(`resuming: ${done.size} responses already in ${path}`);
  }

  const all = cells(plan);
  const write = (row) => appendFileSync(path, JSON.stringify(row) + "\n");

  // Incompatible cells are recorded once, not called.
  for (const cell of all.filter((c) => c.blocked)) {
    const id = key(cell.provider, cell.arm, cell.caseId, cell.trial);
    if (done.has(id)) continue;
    write({ provider: cell.provider, arm: cell.arm, caseId: cell.caseId, trial: cell.trial, incompatible: cell.blocked });
    done.add(id);
  }

  for (const provider of plan.providers) {
    const todo = all.filter((c) => c.provider === provider && !c.blocked && !done.has(key(c.provider, c.arm, c.caseId, c.trial)));
    if (todo.length === 0) continue;
    console.log(`\n${PROVIDERS[provider].label}: ${todo.length} calls`);

    const tasks = todo.map((cell) => async () => {
      const response = await ask(cell.provider, cell.armModule, cell.testCase.ask);
      const row = {
        provider: cell.provider, arm: cell.arm, caseId: cell.caseId, trial: cell.trial,
        input: response.input, text: response.text, stopReason: response.stopReason,
        usage: response.usage, error: response.error,
      };

      // One repair round trip, if the arm rejected what came back.
      if (repair && !response.error && response.input !== undefined) {
        const rejected = cell.armModule.validate(response.input);
        if (rejected) {
          const second = await ask(cell.provider, cell.armModule, cell.testCase.ask,
            repairTurns(cell.provider, cell.armModule, { ...response, problem: rejected }));
          row.repair = {
            input: second.input, text: second.text, stopReason: second.stopReason,
            usage: second.usage, error: second.error, problemShown: rejected,
          };
        }
      }
      write(row);
      return row;
    });

    await pooled(tasks, CONCURRENCY[provider] ?? 4, (n, total) => {
      if (n % 10 === 0 || n === total) process.stdout.write(`\r  ${n}/${total}`);
    });
    console.log("");
  }

  console.log(`\nwrote ${path}`);
  console.log("report with: node experiments/intent-to-filter/report.mjs");
}

// ---------------------------------------------------------------------------

const FULL = {
  providers: ["gpt-5.5", "gemini-3.8-flash", "gpt-oss-120b"],
  arms: ARMS.map((a) => a.name),
  cases: CORPUS,
  trials: { "gpt-5.5": 5, "gemini-3.8-flash": 5, "gpt-oss-120b": 2 },
};

const PILOT = {
  providers: ["gpt-5.4-mini"],
  arms: ARMS.map((a) => a.name),
  cases: CORPUS.filter((c) => ["a01", "a04", "a09", "a12", "b01", "b06", "b11", "c01", "c05", "c12", "d05", "e03", "m01", "m02", "m03"].includes(c.id)),
  trials: 1,
};

export { FULL, PILOT };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      pilot: { type: "boolean", default: false },
      run: { type: "boolean", default: false },
      "no-repair": { type: "boolean", default: false },
      label: { type: "string" },
    },
  });
  const plan = values.pilot ? PILOT : FULL;
  if (values["dry-run"]) dryRun(plan);
  else if (values.pilot || values.run) {
    await run(plan, { label: values.label ?? (values.pilot ? "pilot" : "full"), repair: !values["no-repair"] });
  } else {
    console.log("choose one of --dry-run, --pilot, --run");
    process.exit(1);
  }
}
