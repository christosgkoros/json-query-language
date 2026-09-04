#!/usr/bin/env node
/**
 * run.mjs — the experiment's command line.
 *
 *   node run.mjs '<filter json>' [--binding hybrid|document] [--dialect sqlite|postgres]
 *       validate, compile, print the SQL and (for sqlite) run it
 *
 *   node run.mjs --corpus     every case in cases.mjs, both bindings, executed
 *   node run.mjs --metrics    the measurements quoted in README.md
 *   node run.mjs --sql <id>   the emitted SQL for one case, in both dialects
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CASES, expectationFor } from "./cases.mjs";
import { DOCUMENT_BINDING, HYBRID_BINDING } from "./dataset.mjs";
import { openDatabase, search, validateFilter } from "./harness.mjs";
import { compile, QueryProblem } from "./compile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BINDINGS = { hybrid: HYBRID_BINDING, document: DOCUMENT_BINDING };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    binding: { type: "string", default: "hybrid" },
    dialect: { type: "string", default: "sqlite" },
    corpus: { type: "boolean", default: false },
    metrics: { type: "boolean", default: false },
    sql: { type: "string" },
  },
});

const bindingFor = (name, dialect) => ({ ...BINDINGS[name], dialect });

function short(value, width) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function outcome(result) {
  if (result.problem) return `!${result.problem.type.split("/").pop()}`;
  return result.ids.length ? result.ids.join(" ") : "(none)";
}

// ---------------------------------------------------------------------------

if (values.corpus) {
  const db = openDatabase();
  let group = "";
  let ok = 0;
  for (const testCase of CASES) {
    if (testCase.group !== group) {
      group = testCase.group;
      console.log(`\n${group}`);
    }
    const cells = Object.keys(BINDINGS).map((name) => {
      const result = search(db, testCase.filter, BINDINGS[name]);
      const expected = expectationFor(testCase, name);
      const matched = expected.problem
        ? result.problem?.type.endsWith(expected.problem)
        : !result.problem && result.ids.join() === expected.ids.join();
      if (matched) ok += 1;
      return `${matched ? " " : "✗"}${outcome(result).padEnd(34)}`;
    });
    console.log(`  ${testCase.id}  ${short(testCase.title, 46).padEnd(47)} ${cells.join(" ")}`);
  }
  console.log(`\n${ok}/${CASES.length * 2} case-binding pairs match the hand-derived expectation.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

if (values.metrics) {
  const db = openDatabase();
  const source = (file) => readFileSync(join(here, file), "utf8");
  const lines = (file) =>
    source(file)
      .split("\n")
      .filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)).length;

  console.log("Source, non-comment non-blank lines");
  for (const file of ["compile.mjs", "dataset.mjs", "cases.mjs", "harness.mjs", "compile.test.mjs"]) {
    console.log(`  ${file.padEnd(18)} ${String(lines(file)).padStart(4)}`);
  }

  // Only the filters that compile under *both* bindings, so the two columns
  // are measured over the same population (this is the basis README.md quotes).
  const measured = [];
  let rejected = 0;
  for (const testCase of CASES) {
    const row = { id: testCase.id };
    let compiles = true;
    for (const name of Object.keys(BINDINGS)) {
      try {
        const { where, clauses } = compile(testCase.filter, BINDINGS[name]);
        row[name] = { chars: where.length, clauses, guards: (where.match(/CASE WHEN/g) ?? []).length };
      } catch (error) {
        if (!(error instanceof QueryProblem)) throw error;
        compiles = false;
        if (name === "hybrid") rejected += 1;
      }
    }
    if (compiles) measured.push(row);
  }

  const clauses = measured.reduce((a, r) => a + r.hybrid.clauses, 0);
  console.log(`\nEmitted WHERE clause, over the ${measured.length} filters that compile under both bindings (${clauses} clauses)`);
  for (const name of Object.keys(BINDINGS)) {
    const chars = measured.reduce((a, r) => a + r[name].chars, 0);
    const guards = measured.reduce((a, r) => a + r[name].guards, 0);
    const clean = measured.filter((r) => r[name].guards === 0).length;
    console.log(
      `  ${name.padEnd(9)} ${String(chars).padStart(6)} chars` +
        `, ${(chars / clauses).toFixed(1)} per clause` +
        `, ${guards} CASE guards in ${measured.length - clean} filters` +
        `, ${clean} filters with none`,
    );
  }
  const largest = measured.slice().sort((a, b) => b.document.chars - a.document.chars)[0];
  const smallest = measured.slice().sort((a, b) => a.document.chars - b.document.chars)[0];
  console.log(`  largest ${largest.id} at ${largest.document.chars} chars, smallest ${smallest.id} at ${smallest.document.chars}`);
  console.log(`\n  ${measured.length} of ${CASES.length} cases compile under both bindings; ${rejected} are rejected at compile time.`);

  const both = CASES.filter((c) => Array.isArray(c.expect));
  console.log(`  ${both.length} of ${CASES.length} cases have a binding-independent expected answer.`);
  console.log(`  ${CASES.filter((c) => c.note).length} of ${CASES.length} cases needed a note to justify the expected answer.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

if (values.sql) {
  const testCase = CASES.find((c) => c.id === values.sql);
  if (!testCase) {
    console.error(`no case "${values.sql}"`);
    process.exit(2);
  }
  console.log(`${testCase.id}  ${testCase.title}`);
  console.log(`filter   ${JSON.stringify(testCase.filter)}`);
  for (const name of Object.keys(BINDINGS)) {
    for (const dialect of ["sqlite", "postgres"]) {
      console.log(`\n--- ${name} / ${dialect}`);
      try {
        const { sql, params, warnings } = compile(testCase.filter, bindingFor(name, dialect));
        console.log(sql);
        console.log(`params  ${JSON.stringify(params)}`);
        for (const w of warnings) console.log(`warning ${w}`);
      } catch (error) {
        if (!(error instanceof QueryProblem)) throw error;
        console.log(JSON.stringify(error.toProblem(), null, 2));
      }
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------

if (positionals.length !== 1) {
  console.error("usage: run.mjs '<filter json>' | --corpus | --metrics | --sql <case-id>");
  process.exit(2);
}

const filter = JSON.parse(positionals[0]);
const malformed = validateFilter(filter);
if (malformed) {
  console.log(JSON.stringify(malformed.toProblem(), null, 2));
  process.exit(1);
}

const binding = bindingFor(values.binding, values.dialect);
let compiled;
try {
  compiled = compile(filter, binding);
} catch (error) {
  if (!(error instanceof QueryProblem)) throw error;
  console.log(JSON.stringify(error.toProblem(), null, 2));
  process.exit(1);
}

console.log(compiled.sql);
console.log(`\nparams  ${JSON.stringify(compiled.params)}`);
for (const w of compiled.warnings) console.log(`warning ${w}`);
for (const r of compiled.requires) console.log(`needs   ${r}`);

if (values.dialect === "sqlite") {
  const db = openDatabase();
  console.log(`\nmatches ${outcome(search(db, filter, binding))}`);
}
