/**
 * gold.test.mjs — everything that must hold before a single request is paid for.
 *
 * The failure this guards against is the one that would quietly invalidate the
 * whole experiment: an arm losing a case because its own executor could not run
 * the right answer. If the hand-written gold query for a case does not return
 * the gold row set through that arm, then a model producing exactly that query
 * would be marked wrong, and the arm's score would measure the harness rather
 * than the interface.
 *
 * So: every arm, every case, the right answer, executed.
 *
 *   node --test experiments/intent-to-filter/gold.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../filter-to-sql/harness.mjs";
import { CASES } from "../filter-to-sql/cases.mjs";
import { CORPUS, EXCLUDED } from "./corpus.mjs";
import { QUESTIONS, BANNED_TOKENS, LEAK_EXEMPTIONS } from "./questions.mjs";
import { ARMS, PROSE_BUDGET, approxTokens } from "./arms/index.mjs";
import { openDifferential, equivalent, BINDING } from "./differential.mjs";
import { compile } from "../filter-to-sql/compile.mjs";
import { mistakes } from "./grade.mjs";

const db = openDatabase();
const differentialDb = openDifferential();

const normalise = (expect) =>
  Array.isArray(expect) || expect === undefined ? { ids: expect ?? [] } : expect;

const asOutcome = (result) => (result.problem ? { problem: result.problem.type } : { ids: result.ids });

// ---------------------------------------------------------------------------
// The load-bearing test
// ---------------------------------------------------------------------------

for (const arm of ARMS) {
  test(`${arm.name}: every gold query returns the gold answer, or is declared unreachable`, () => {
    let answered = 0;
    let unreachable = 0;
    for (const testCase of CORPUS) {
      const gold = arm.gold(testCase);
      if (gold === null || gold === undefined) {
        unreachable += 1;
        continue;
      }
      const input =
        arm.kind === "schema" ? { filter: gold }
        : arm.kind === "string" ? { q: gold }
        : arm.kind === "json" ? { where: gold }
        : gold;
      const expected = normalise(testCase.expect);
      const want = expected.problem ? { problem: expected.problem } : { ids: expected.ids };
      assert.deepEqual(
        asOutcome(arm.execute(input, db)),
        want,
        `${arm.name}/${testCase.id}: gold query does not produce the gold answer`,
      );
      answered += 1;
    }
    assert.ok(answered > 0, `${arm.name} answered nothing`);
    assert.equal(answered + unreachable, CORPUS.length);
  });
}

test("every arm's declared ceiling is real — the case is unreachable, not merely unwritten", () => {
  for (const arm of ARMS) {
    for (const id of Object.keys(arm.ceiling ?? {})) {
      assert.ok(BY_ID_HAS(id), `${arm.name} declares a ceiling for ${id}, which is not in the corpus`);
      assert.equal(arm.gold({ id }), null, `${arm.name} declares ${id} unreachable but supplies a gold query`);
    }
  }
});

const BY_ID_HAS = (id) => CORPUS.some((c) => c.id === id);

// ---------------------------------------------------------------------------
// The corpus itself
// ---------------------------------------------------------------------------

test("every corpus case is either asked or excluded, with a reason", () => {
  for (const testCase of CASES) {
    const asked = Boolean(QUESTIONS[testCase.id]);
    const excluded = Boolean(EXCLUDED[testCase.id]);
    assert.ok(asked !== excluded, `${testCase.id} must be exactly one of asked or excluded`);
    if (excluded) assert.match(EXCLUDED[testCase.id], /\S/, `${testCase.id} needs a reason`);
  }
});

test("no question leaks an arm's syntax", () => {
  for (const testCase of CORPUS) {
    const exempt = LEAK_EXEMPTIONS[testCase.id] ?? [];
    let text = testCase.ask;
    for (const allowed of exempt) text = text.split(allowed).join("");
    for (const token of BANNED_TOKENS) {
      assert.ok(
        !text.toLowerCase().includes(token.toLowerCase()),
        `${testCase.id} contains the banned token "${token}": ${testCase.ask}`,
      );
    }
  }
});

test("every gold filter is distinguishable from every other on the differential set", () => {
  const seen = new Map();
  // Only the inherited set: an authored probe deliberately restates an
  // inherited case with a phrasing that tempts a mistake (m02 is c12 asked in
  // the way a user would ask it), so the two are meant to coincide.
  for (const testCase of CORPUS.filter((c) => c.origin === "inherited")) {
    if (normalise(testCase.expect).problem) continue;
    let key;
    try {
      const compiled = compile(testCase.goldFilter, BINDING);
      key = differentialDb.prepare(compiled.sql).all(...compiled.params).map((r) => r.id).join(",");
    } catch {
      continue; // does not compile on this binding; graded on the fixture alone
    }
    const clash = seen.get(key);
    assert.equal(
      clash,
      undefined,
      `${testCase.id} and ${clash} return identical rows on all 200 records — the grader cannot tell them apart`,
    );
    seen.set(key, testCase.id);
  }
});

test("the differential check accepts a re-spelling and rejects a near-miss", () => {
  const between = { weightKg: { $between: [1, 5] } };
  const spelledOut = { weightKg: { $gte: 1, $lte: 5 } };
  const offByOne = { weightKg: { $gte: 1, $lt: 5 } };
  assert.ok(equivalent(differentialDb, between, spelledOut), "an equivalent re-spelling must pass");
  assert.ok(!equivalent(differentialDb, between, offByOne), "an exclusive upper bound must fail");
});

// ---------------------------------------------------------------------------
// Fairness
// ---------------------------------------------------------------------------

test("the prose budget binds the arms whose language is carried by prose", () => {
  const { target, tolerance, binds } = PROSE_BUDGET;
  for (const name of binds) {
    const arm = ARMS.find((a) => a.name === name);
    const size = approxTokens(arm.tool.description);
    assert.ok(
      size >= target * (1 - tolerance) && size <= target * (1 + tolerance),
      `${name}'s description is ~${size} tokens, outside ${Math.round(target * (1 - tolerance))}–${Math.round(target * (1 + tolerance))}`,
    );
  }
});

test("the two schema arms are given no prose to make up for the schema", () => {
  for (const name of ["jql-raw", "jql-generated", "jql-published"]) {
    const arm = ARMS.find((a) => a.name === name);
    assert.ok(
      approxTokens(arm.tool.description) < 100,
      `${name} has a ${approxTokens(arm.tool.description)}-token description; the claim is that it needs none`,
    );
    for (const token of ["$unknownAs", "$some", "three-valued", "null"]) {
      assert.ok(
        !arm.tool.description.includes(token),
        `${name}'s description mentions ${token}, which would be coaching`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The mistake detector
// ---------------------------------------------------------------------------

test("the mistake detector finds each catalogued mistake, and nothing in the gold answers", () => {
  assert.deepEqual(mistakes({ status: "Available" }), ["value-outside-domain"]);
  assert.deepEqual(mistakes({ tags: { $in: ["indoor"] } }), ["in-as-membership"]);
  assert.deepEqual(mistakes({ microchip: { $ne: "CHIP-001" } }), ["ne-drops-nulls"]);
  assert.deepEqual(mistakes({ microchip: { $ne: "CHIP-001", $unknownAs: true } }), []);
  assert.deepEqual(mistakes({ tags: { $some: { $in: ["indoor"] } } }), []);
  assert.deepEqual(mistakes({ status: "available" }), []);

  // The gold answers are by definition correct, so none may trip a detector,
  // with four declared exceptions.
  //
  // c05, d08 and d09 all ask, in words, to *exclude* the records we cannot
  // confirm — so dropping the unknowns is the right answer, and the detector
  // firing on them is the detector being right about the shape and wrong about
  // the intent. Intent is not recoverable from the filter alone.
  //
  // c07 is the §4.1 longhand: the detector sees its $ne but not the $isNull arm
  // of the $or that rescues it.
  //
  // Both limits push the same way — they inflate the count — so the per-mistake
  // numbers in the report are an upper bound on ne-drops-nulls, and are labelled
  // as such.
  const expectedTrips = new Set(["c05", "c07", "d08", "d09"]);
  for (const testCase of CORPUS) {
    const found = mistakes(testCase.goldFilter);
    if (expectedTrips.has(testCase.id)) continue;
    assert.deepEqual(found, [], `gold answer for ${testCase.id} trips the detector: ${found.join(", ")}`);
  }
});
