/**
 * grade.mjs — turning one model response into one outcome.
 *
 * The distinction the whole experiment turns on is between a failure the agent
 * is told about and one it is not. README.md:210 claims that is the real
 * difference between a schema-described language and a string:
 *
 *   "What the language cannot catch is a filter that is *valid and wrong*.
 *    Those fail as an empty result set, which an agent cannot distinguish from
 *    'no such records', so it reports a confident false negative."
 *
 * So `loud` and `silent` are separate outcomes, and the headline number is the
 * ratio between them rather than raw accuracy. An arm that is wrong often but
 * always says so is, for an agent, a better arm than one that is wrong half as
 * often and never says so.
 */

import { expectationFor } from "../filter-to-sql/cases.mjs";
import { equivalent } from "./differential.mjs";

export const OUTCOMES = [
  "correct",
  "loud-failure",
  "silent-failure",
  "fabrication",
  "correct-abstention",
  "no-call",
  "refusal",
  "compiler-defect",
];

/** Paths that can be null or absent, so a bare negation over them drops rows. */
const NULLABLE = new Set([
  "microchip", "notes", "born", "species", "weightKg", "neutered",
  "shelter.capacity", "shelter.city", "$$rate", "size\\.raw", "boosterDue",
]);

/** Paths holding a list, where $in compares the list rather than its elements. */
const ARRAY_PATHS = new Set(["tags", "vaccinations"]);

const DOMAINS = {
  status: ["available", "pending", "sold"],
  species: ["cat", "dog", "rabbit", "bird"],
  vaccine: ["rabies", "distemper", "parvo"],
};

/**
 * The three mistakes README §"Exposing search to an agent" catalogues, detected
 * on the translated filter so that one detector serves all five arms.
 *
 * They are not symmetrical, and the asymmetry is the point of H5: a generated
 * schema turns 1 and 3 into validation errors, but 2 stays valid and wrong
 * against every arm, mitigated only by prose. Counting them separately is how
 * we find out whether the prose works.
 */
export function mistakes(filter) {
  const found = new Set();
  if (filter === null || typeof filter !== "object") return [];

  const walk = (node, path = null, negated = false) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((m) => walk(m, path, negated));

    for (const [key, value] of Object.entries(node)) {
      if (key === "$and" || key === "$or") { walk(value, path, negated); continue; }
      // A negation only drops the unknowns if nothing alongside it resolves
      // them: {"born": {"$not": {...}, "$unknownAs": true}} is the correct
      // spelling of c13, not a mistake.
      const resolvedHere = node.$unknownAs !== undefined;
      if (key === "$nor") { walk(value, path, !resolvedHere); continue; }
      if (key === "$not") { walk(value, path, !resolvedHere); continue; }

      if (key === "$in" || key === "$nin") {
        if (path && ARRAY_PATHS.has(path)) found.add("in-as-membership");
        continue;
      }
      if (key === "$ne") {
        if (path && NULLABLE.has(path) && node.$unknownAs === undefined) found.add("ne-drops-nulls");
        continue;
      }
      if (key === "$eq" || key === undefined) {
        // fall through to the domain check below
      }
      if (key.startsWith("$")) {
        if ((key === "$some" || key === "$every") && value && typeof value === "object") {
          walk(value, null, negated);
        }
        continue;
      }

      // A member name: either a field path, or an element member inside a quantifier.
      const leaf = key.includes(".") ? key : key;
      const domain = DOMAINS[leaf.split(".").pop()];
      const operand = value !== null && typeof value === "object" ? value.$eq : value;
      if (domain && typeof operand === "string" && !domain.includes(operand)) {
        found.add("value-outside-domain");
      }
      if (domain && value !== null && typeof value === "object" && Array.isArray(value.$in)) {
        if (value.$in.some((v) => typeof v === "string" && !domain.includes(v))) {
          found.add("value-outside-domain");
        }
      }
      walk(value, leaf, negated);
    }

    // A bare field-level $not over a nullable path drops the unknowns too.
    if (negated && path && NULLABLE.has(path) && node.$unknownAs === undefined) {
      found.add("ne-drops-nulls");
    }
  };

  walk(filter);
  return [...found];
}

/**
 * Did the model say, in words, that the question cannot be answered here? Only
 * consulted for `unanswerable` probes, and only when no tool call was made.
 */
function abstained(text) {
  if (!text) return false;
  return /\b(cannot|can't|unable|not (?:a )?(?:possible|supported|available|searchable|exposed)|no (?:such|way to)|not exposed|isn't (?:searchable|available)|does not support)\b/i
    .test(text);
}

/**
 * Grade one attempt.
 *
 * @param {object} args
 * @param {object} args.testCase   the corpus case, carrying `expect` and `filter`
 * @param {object} args.arm        the arm module
 * @param {object|undefined} args.input  the tool input the model produced
 * @param {string} args.text       any prose the model returned alongside
 * @param {string} args.stopReason
 * @param {object} args.db         the ten-record fixture
 * @param {object} args.differentialDb  the two-hundred-record set
 */
export function grade({ testCase, arm, input, text, stopReason, db, differentialDb }) {
  const probe = testCase.probe;

  if (stopReason === "refusal") return { outcome: "refusal" };

  if (input === undefined) {
    if (probe === "unanswerable" && abstained(text)) return { outcome: "correct-abstention" };
    return { outcome: "no-call", note: abstained(text) ? "declined" : "no tool call" };
  }

  const result = arm.execute(input, db);
  const candidateFilter = arm.translate ? tryTranslate(arm, input) : arm.extract(input);
  const made = candidateFilter ? mistakes(candidateFilter) : [];

  // A compiler defect is not the model's fault and not the arm's; it is ours.
  if (result.compilerDefect) {
    return { outcome: "compiler-defect", problem: result.problem.detail, mistakes: made };
  }

  if (result.problem) {
    // For a question that genuinely cannot be asked, a rejection IS the answer.
    if (probe === "unanswerable") return { outcome: "correct-abstention", problem: result.problem.type, mistakes: made };
    return { outcome: "loud-failure", problem: result.problem.type, mistakes: made };
  }

  if (probe === "unanswerable") {
    return { outcome: "fabrication", ids: result.ids, mistakes: made };
  }

  const expected = testCase.expect !== undefined && !Array.isArray(testCase.expect)
    ? testCase.expect
    : { ids: testCase.expect };
  const wanted = expected.problem ? null : expected.ids;
  if (wanted === null) {
    // The corpus says this should have been rejected and it was not.
    return { outcome: "silent-failure", ids: result.ids, mistakes: made, note: `expected ${expected.problem}` };
  }

  const sameRows = result.ids.length === wanted.length && result.ids.every((id) => wanted.includes(id));
  if (!sameRows) return { outcome: "silent-failure", ids: result.ids, mistakes: made };

  // Right rows on ten records is necessary but not sufficient: check the
  // candidate means the same thing as the gold filter on two hundred more.
  const goldFilter = testCase.goldFilter;
  if (goldFilter && candidateFilter && !equivalent(differentialDb, goldFilter, candidateFilter)) {
    return { outcome: "silent-failure", ids: result.ids, mistakes: made, note: "right rows, different predicate" };
  }

  return { outcome: "correct", ids: result.ids, mistakes: made };
}

function tryTranslate(arm, input) {
  try {
    return arm.translate(input);
  } catch {
    return null;
  }
}

/** Wilson score interval — honest error bars on a proportion from few trials. */
export function wilson(successes, total, z = 1.96) {
  if (total === 0) return { low: 0, high: 0, point: 0 };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { point: p, low: Math.max(0, (centre - spread) / denominator), high: Math.min(1, (centre + spread) / denominator) };
}

/** The expectation for a case, normalised — re-exported so the runner has one import. */
export { expectationFor };
