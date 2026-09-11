/**
 * execute.mjs — one evaluator, shared by every arm.
 *
 * The single most important fairness property in this experiment: no arm gets
 * its own semantics. Each arm translates whatever the model produced into a
 * filter, and every filter is then compiled and run by the same compiler from
 * ../../filter-to-sql, against the same ten records. An arm therefore cannot
 * win or lose because its executor happened to treat a null differently.
 *
 * What each arm owns is the translation and the rejection: what its syntax can
 * express, and what it refuses. That is the thing under test.
 */

import { compile, QueryProblem } from "../../filter-to-sql/compile.mjs";
import { HYBRID_BINDING } from "../../filter-to-sql/dataset.mjs";

export { HYBRID_BINDING };

/** A SPEC §8-shaped rejection, in the flat form the runner feeds back to the model. */
export function problem(type, detail, pointer = "/filter") {
  return { type, detail, pointer };
}

/**
 * Compile and run a filter. Returns the matching ids, or the problem the
 * compiler raised — the arm-neutral half of every arm's `execute`.
 */
export function runFilter(db, filter, binding = HYBRID_BINDING) {
  let compiled;
  try {
    compiled = compile(filter, binding);
  } catch (error) {
    if (error instanceof QueryProblem) {
      const p = error.toProblem();
      return { problem: problem(p.type.split("/").pop(), p.detail, p.pointer) };
    }
    throw error;
  }
  // A filter can pass validation and still compile to SQL the database will
  // not accept. That is a defect in the compiler, not in the model's answer,
  // so it is recorded as its own condition rather than crashing the grader or
  // being scored against the arm.
  try {
    const ids = db.prepare(compiled.sql).all(...compiled.params).map((r) => r.id);
    return { ids };
  } catch (error) {
    return { problem: problem("compiler-defect", `${error.message} — SQL: ${compiled.sql.slice(0, 200)}`, "/filter"), compilerDefect: true };
  }
}

/** The queryable paths, single source of truth for the arms that enumerate them. */
export const PATHS = [
  "id", "name", "species", "status", "born", "weightKg", "neutered",
  "microchip", "tags", "notes", "priceCents", "costCents", "$$rate", "size\\.raw",
  "shelter.name", "shelter.city", "shelter.capacity", "vaccinations",
];

/** Closed domains, for the arms whose documentation states them. */
export const DOMAINS = {
  status: ["available", "pending", "sold"],
  species: ["cat", "dog", "rabbit", "bird"],
  "vaccinations[].vaccine": ["rabies", "distemper", "parvo"],
};
