/**
 * harness.mjs — an in-process SQLite database holding the fixture collection,
 * plus the schema validation a real endpoint would do before compiling.
 *
 * The point of executing rather than snapshotting: a SQL string that looks
 * right is not evidence. Every case in cases.mjs is asserted against the rows
 * the database actually returns.
 */

import { DatabaseSync } from "node:sqlite";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DDL, INSERT, rows } from "./dataset.mjs";
import { compile, QueryProblem } from "./compile.mjs";

const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;

const here = dirname(fileURLToPath(import.meta.url));
const grammar = JSON.parse(readFileSync(join(here, "..", "..", "query-language-schema.json"), "utf8"));

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
ajv.addVocabulary(["x-profiles"]);
const validateAgainstGrammar = ajv.compile(grammar);

/**
 * What a server does first: reject anything the published grammar rejects.
 * Everything downstream of this line may assume a well-formed filter, which is
 * the single largest simplification the design buys an implementer.
 */
export function validateFilter(filter) {
  if (validateAgainstGrammar(filter)) return null;
  const first = validateAgainstGrammar.errors[0];
  return new QueryProblem(
    "malformed-query",
    `${first.instancePath || "/"} ${first.message}`,
    `/filter${first.instancePath}`,
  );
}

export function openDatabase() {
  const db = new DatabaseSync(":memory:");
  // SPEC §5.5 wants $like case-sensitive; SQLite's LIKE folds ASCII case
  // unless told otherwise. Emitted SQL is not self-contained without this.
  db.exec("PRAGMA case_sensitive_like = ON");
  // SQLite has no REGEXP implementation of its own. A JS RegExp is an
  // ECMA-262 engine, which is exactly what SPEC §5.7 asks for — and exactly
  // what §7 warns about, since it backtracks.
  db.function("jql_regex", { deterministic: true }, (value, pattern, flags) => {
    if (value === null || value === undefined) return null;
    return new RegExp(pattern, flags || undefined).test(String(value)) ? 1 : 0;
  });
  db.exec(DDL);
  const insert = db.prepare(INSERT);
  for (const row of rows()) insert.run(...row);
  return db;
}

/**
 * Compiles and runs one filter. Returns the matching ids, or the RFC 9457
 * problem the compiler raised.
 */
export function search(db, filter, binding) {
  const malformed = validateFilter(filter);
  if (malformed) return { problem: malformed.toProblem() };
  let compiled;
  try {
    compiled = compile(filter, binding);
  } catch (error) {
    if (error instanceof QueryProblem) return { problem: error.toProblem() };
    throw error;
  }
  const ids = db.prepare(compiled.sql).all(...compiled.params).map((r) => r.id);
  return { ids, ...compiled };
}
