/**
 * report.mjs — grade the recorded responses and print the tables.
 *
 * Every number in README.md comes from here, the way every number in
 * ../filter-to-sql/README.md comes from its `--metrics`. Nothing is typed into
 * the prose by hand, so the write-up cannot drift from the run.
 *
 *   node experiments/intent-to-filter/report.mjs
 *   node experiments/intent-to-filter/report.mjs --file results/turn1.jsonl
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { openDatabase } from "../filter-to-sql/harness.mjs";
import { openDifferential } from "./differential.mjs";
import { CORPUS, BY_ID, EXCLUDED, isOrdinaryTraffic } from "./corpus.mjs";
import { ARMS, BY_NAME, approxTokens } from "./arms/index.mjs";
import { grade, wilson } from "./grade.mjs";
import { PROVIDERS } from "./providers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "results");

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const bar = (width = 78) => console.log("─".repeat(width));

// ---------------------------------------------------------------------------
// The part that runs with no results — the pre-registration report
// ---------------------------------------------------------------------------

function corpusReport() {
  console.log("\nCorpus\n");
  const groups = new Map();
  for (const c of CORPUS) groups.set(c.group, (groups.get(c.group) ?? 0) + 1);
  for (const [group, n] of groups) console.log(`  ${String(n).padStart(3)}  ${group}`);
  console.log(`  ${String(CORPUS.length).padStart(3)}  total asked`);
  console.log(`  ${String(Object.keys(EXCLUDED).length).padStart(3)}  excluded, with reasons`);

  const probes = new Map();
  for (const c of CORPUS) probes.set(c.probe, (probes.get(c.probe) ?? 0) + 1);
  console.log("");
  for (const [probe, n] of probes) console.log(`  ${String(n).padStart(3)}  ${probe}`);
  console.log(`\n  ${CORPUS.filter(isOrdinaryTraffic).length} of ${CORPUS.length} are ordinary traffic (groups A and B); the rest probe semantic edges.`);
  console.log(`  ${CORPUS.filter((c) => c.origin === "inherited").length} inherited from a corpus written before this experiment; ${CORPUS.filter((c) => c.origin === "authored").length} authored for it.`);

  console.log("\nWhat each arm can and cannot express\n");
  console.log(`  ${"arm".padEnd(15)} ${"expressible".padStart(11)}  ${"ceiling".padStart(7)}  tool tokens`);
  for (const arm of ARMS) {
    let reachable = 0;
    for (const c of CORPUS) if (arm.gold(c) !== null && arm.gold(c) !== undefined) reachable += 1;
    const ceiling = CORPUS.length - reachable;
    console.log(
      `  ${arm.name.padEnd(15)} ${String(reachable).padStart(6)}/${CORPUS.length}  ${String(ceiling).padStart(7)}  ${String(approxTokens(JSON.stringify(arm.tool))).padStart(11)}`,
    );
  }
  console.log("\n  `ceiling` counts questions the interface cannot put at all. They are");
  console.log("  excluded from that arm's accuracy denominator and reported here instead,");
  console.log("  so an arm is never marked wrong for a question it was never able to ask.\n");
}

// ---------------------------------------------------------------------------
// Grading a run
// ---------------------------------------------------------------------------

function load(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function gradeAll(rows) {
  const db = openDatabase();
  const differentialDb = openDifferential();
  const graded = [];

  for (const row of rows) {
    const testCase = BY_ID[row.caseId];
    const arm = BY_NAME[row.arm];
    if (!testCase || !arm) continue;

    // The provider cannot carry this arm's tool definition at all. Recorded as
    // its own outcome and kept out of every accuracy denominator: it says
    // something about the provider, not about the model's competence.
    if (row.incompatible) {
      graded.push({ ...row, outcome: "provider-incompatible" });
      continue;
    }

    // A question this arm cannot put is not scored against it either.
    const gold = arm.gold(testCase);
    if (gold === null || gold === undefined) {
      graded.push({ ...row, outcome: "beyond-ceiling" });
      continue;
    }

    if (row.error) {
      // Some errors are not transport trouble, they are the provider saying it
      // cannot carry this tool definition. Discovered at run time rather than
      // predicted, so classified here rather than pre-declared.
      const code = row.error.slice(0, 3);
      const cannotCarry =
        code === "413" ? "the flattened schema exceeds the provider's per-request input limit"
        : /Tool call validation failed/.test(row.error) ? "the provider validates tool calls against the declared schema and cannot resolve its $refs"
        : null;
      graded.push(cannotCarry
        ? { ...row, outcome: "provider-incompatible", incompatible: cannotCarry }
        : { ...row, outcome: "api-error", note: row.error.slice(0, 80) });
      continue;
    }

    const verdict = grade({
      testCase, arm, db, differentialDb,
      input: row.input, text: row.text, stopReason: row.stopReason,
    });

    // If a repair turn was taken, grade it too — H3 is the difference.
    let repaired;
    if (row.repair && !row.repair.error) {
      repaired = grade({
        testCase, arm, db, differentialDb,
        input: row.repair.input, text: row.repair.text, stopReason: row.repair.stopReason,
      });
    }
    graded.push({ ...row, ...verdict, repaired: repaired?.outcome });
  }
  return graded;
}

function tally(graded, filter = () => true) {
  const rows = graded
    .filter(filter)
    // Three things are not the model's answer and are kept out of every
    // denominator: a question the arm cannot put, a tool the provider cannot
    // carry, and a call that never completed.
    .filter((r) => !["beyond-ceiling", "provider-incompatible", "api-error"].includes(r.outcome));
  const counts = {};
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return { n: rows.length, counts };
}

function outcomeTable(graded, providers) {
  for (const provider of providers) {
    const failed = graded.filter((r) => r.provider === provider && r.outcome === "api-error").length;
    console.log(`\n${PROVIDERS[provider]?.label ?? provider}${failed ? `  —  ${failed} calls never completed and are excluded` : ""}\n`);
    console.log(`  ${"arm".padEnd(15)} ${"n".padStart(5)} ${"correct".padStart(9)} ${"loud".padStart(7)} ${"silent".padStart(8)} ${"loud:silent".padStart(12)}`);
    for (const arm of ARMS) {
      const { n, counts } = tally(graded, (r) => r.provider === provider && r.arm === arm.name);
      if (n === 0) continue;
      const correct = counts.correct ?? 0;
      const loud = counts["loud-failure"] ?? 0;
      const silent = counts["silent-failure"] ?? 0;
      const ci = wilson(correct, n);
      const ratio = silent === 0 ? (loud === 0 ? "—" : "all loud") : (loud / silent).toFixed(1);
      console.log(
        `  ${arm.name.padEnd(15)} ${String(n).padStart(5)} ${`${pct(correct / n)}`.padStart(5)} ±${String(Math.round(((ci.high - ci.low) / 2) * 100)).padStart(2)} ${pct(loud / n).padStart(7)} ${pct(silent / n).padStart(8)} ${ratio.padStart(12)}`,
      );
    }
  }
}

function mistakeTable(graded) {
  console.log("\nCatalogued mistakes, as a share of the attempts that made them\n");
  console.log("  Upper bounds: the detector reads shape, not intent, so a question that");
  console.log("  genuinely asked to exclude the unknowns counts as ne-drops-nulls too.\n");
  const kinds = ["value-outside-domain", "ne-drops-nulls", "in-as-membership"];
  console.log(`  ${"arm".padEnd(15)} ${kinds.map((k) => k.padStart(21)).join("")}`);
  for (const arm of ARMS) {
    const rows = graded.filter((r) => r.arm === arm.name && Array.isArray(r.mistakes));
    if (rows.length === 0) continue;
    const cells = kinds.map((kind) => {
      const hits = rows.filter((r) => r.mistakes.includes(kind)).length;
      return `${pct(hits / rows.length)} (${hits})`.padStart(21);
    });
    console.log(`  ${arm.name.padEnd(15)} ${cells.join("")}`);
  }
}

function probeTable(graded) {
  console.log("\nThe three authored mistake probes\n");
  for (const id of ["m01", "m02", "m03"]) {
    const testCase = BY_ID[id];
    console.log(`  ${id} — ${testCase.tempts}: "${testCase.ask.slice(0, 62)}${testCase.ask.length > 62 ? "…" : ""}"`);
    for (const arm of ARMS) {
      const { n, counts } = tally(graded, (r) => r.caseId === id && r.arm === arm.name);
      if (n === 0) continue;
      console.log(`      ${arm.name.padEnd(15)} correct ${String(counts.correct ?? 0).padStart(2)}/${n}  loud ${String(counts["loud-failure"] ?? 0).padStart(2)}  silent ${String(counts["silent-failure"] ?? 0).padStart(2)}`);
    }
    console.log("");
  }
}

/**
 * H3: "enough for an agent to repair its own request in one round trip". The
 * claim appears five times in the repository and has never been measured.
 */
function repairTable(graded, providers) {
  const attempted = graded.filter((r) => r.repaired !== undefined);
  if (attempted.length === 0) return;
  console.log("\nRepair after one round trip, over the attempts that were rejected\n");
  console.log(`  ${"provider".padEnd(18)} ${"arm".padEnd(15)} ${"rejected".padStart(9)} ${"fixed".padStart(7)} ${"yield".padStart(7)}`);
  for (const provider of providers) {
    for (const arm of ARMS) {
      const rows = attempted.filter((r) => r.provider === provider && r.arm === arm.name);
      if (rows.length === 0) continue;
      const fixed = rows.filter((r) => r.repaired === "correct").length;
      console.log(`  ${provider.padEnd(18)} ${arm.name.padEnd(15)} ${String(rows.length).padStart(9)} ${String(fixed).padStart(7)} ${pct(fixed / rows.length).padStart(7)}`);
    }
  }
}

function costTable(graded) {
  console.log("\nInput tokens per call — the price of the schema\n");
  console.log(`  ${"arm".padEnd(15)} ${"tok/call".padStart(10)} ${"correct".padStart(10)} ${"tok/correct".padStart(12)}`);
  for (const arm of ARMS) {
    const rows = graded.filter((r) => r.arm === arm.name && r.usage?.input_tokens);
    if (rows.length === 0) continue;
    const perCall = rows.reduce((sum, r) => sum + r.usage.input_tokens, 0) / rows.length;
    const correct = rows.filter((r) => r.outcome === "correct").length;
    console.log(
      `  ${arm.name.padEnd(15)} ${String(Math.round(perCall)).padStart(10)} ${`${correct}/${rows.length}`.padStart(10)} ${(correct ? Math.round((perCall * rows.length) / correct) : "—").toString().padStart(12)}`,
    );
  }
}

function incompatibilityNote(graded) {
  const blocked = graded.filter((r) => r.outcome === "provider-incompatible");
  if (blocked.length === 0) return;
  console.log("\nProvider incompatibility\n");
  const seen = new Map();
  for (const r of blocked) seen.set(`${r.provider}|${r.arm}`, r.incompatible);
  for (const [pair, reason] of seen) {
    const [provider, arm] = pair.split("|");
    console.log(`  ${provider} x ${arm}: ${reason}`);
  }
  console.log(`\n  ${blocked.length} cells were never called for this reason.`);
}

// ---------------------------------------------------------------------------

const { values } = parseArgs({ options: { file: { type: "string" } } });

const file = values.file
  ? join(process.cwd(), values.file)
  : existsSync(RESULTS)
    ? readdirSync(RESULTS).filter((f) => f.endsWith(".jsonl")).map((f) => join(RESULTS, f)).sort().at(-1)
    : undefined;

bar();
console.log("intent-to-filter");
bar();

corpusReport();

if (!file) {
  bar();
  console.log("\nNo results yet. The tables above are the pre-registration report:");
  console.log("what is being asked, of which arms, and what each arm is able to answer.");
  console.log("\n  node experiments/intent-to-filter/runner.mjs --dry-run   cost estimate");
  console.log("  node experiments/intent-to-filter/runner.mjs --pilot     15 cases, one model");
  console.log("  node experiments/intent-to-filter/runner.mjs --run       the full run\n");
  process.exit(0);
}

const rows = load(file);
const graded = gradeAll(rows);
const providers = [...new Set(graded.map((r) => r.provider))];

bar();
console.log(`\nResults — ${rows.length} responses from ${file.replace(process.cwd() + "/", "")}`);
outcomeTable(graded, providers);
repairTable(graded, providers);
mistakeTable(graded);
probeTable(graded);
costTable(graded);
incompatibilityNote(graded);
console.log("");
