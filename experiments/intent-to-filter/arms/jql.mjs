/**
 * jql.mjs — the two arms that hand the model a JSON Schema and nothing else.
 *
 *   jql-generated  pet.filter.json, generated from pet.resource.json. Per-field
 *                  operators and per-field operand domains. What README
 *                  §"Exposing search to an agent" actually recommends.
 *   jql-published  query-language-schema.json with $defs/FieldPath narrowed to
 *                  the queryable paths. One Constraint shared by every field,
 *                  so no domains. The cheap setup, and the control that says
 *                  how much of any win belongs to the generator rather than to
 *                  the language.
 *
 * Neither arm gets a prose tool description beyond one sentence naming the
 * resource. That is the claim being tested — that the schema is sufficient —
 * and writing a paragraph of guidance here would test something else.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

import { runFilter, problem, PATHS } from "./execute.mjs";

const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;
const here = dirname(fileURLToPath(import.meta.url));

const GENERATED = JSON.parse(readFileSync(join(here, "..", "pet.filter.json"), "utf8"));

/**
 * The published grammar with one definition replaced — the override point
 * README §"Restricting the queryable field set" documents, applied here rather
 * than described.
 */
function narrowedGrammar() {
  const grammar = JSON.parse(
    readFileSync(join(here, "..", "..", "..", "query-language-schema.json"), "utf8"),
  );
  grammar.$id = "https://example.invalid/intent-to-filter/pet.published.json";
  grammar.$defs.FieldPath = {
    type: "string",
    description: "A queryable path on a pet record.",
    // The narrowing applies at every nesting level, quantifiers included, so
    // the paths that are relative to a vaccination *element* have to appear in
    // the same list as the paths relative to the record. One namespace for two
    // scopes is a real wart of the single-override-point design, and it is the
    // reason this arm's field list reads oddly.
    enum: [
      ...PATHS,
      "vaccinations[0].vaccine", "tags[0]",
      "vaccine", "administeredAt", "boosterDue",
    ],
  };
  return grammar;
}

const PUBLISHED = narrowedGrammar();

function compileValidator(schema) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addVocabulary(["x-profiles"]);
  return ajv.compile(schema);
}

const validators = {
  // jql-raw and jql-generated differ only in how the schema is delivered to the
  // model; the server validates identically, which is the whole point of the pair.
  "jql-raw": compileValidator(GENERATED),
  "jql-generated": compileValidator(GENERATED),
  "jql-published": compileValidator(PUBLISHED),
};

/** JSON Pointer escaping, for the token that names the offending member. */
const esc = (token) => token.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * ajv says where a filter stopped matching; SPEC.md §8 asks which of five
 * things went wrong. The mapping is the same one examples/mcp-server uses,
 * because that is the server this arm is standing in for.
 */
function problemFromAjv(errors) {
  // Two ways a member can be refused, depending on which arm rejected it: a
  // generated schema closes `additionalProperties`, a narrowed grammar closes
  // `propertyNames`. Same condition, different keyword.
  const refused =
    errors.find((e) => e.keyword === "additionalProperties") ??
    errors.find((e) => e.keyword === "propertyNames");
  if (refused) {
    const name = refused.params.additionalProperty ?? refused.params.propertyName;
    const pointer = `/filter${refused.instancePath}/${esc(name)}`;
    return name.startsWith("$")
      ? problem("unsupported-operator", `${name} is not available here. The operators this field accepts are listed under it in the schema.`, pointer)
      : problem("unknown-field", `"${name}" is not a queryable path on this resource.`, pointer);
  }
  const deepest = errors.reduce((a, b) => (b.instancePath.length > a.instancePath.length ? b : a));
  const at = deepest.instancePath;
  const local = errors.filter((e) => e.instancePath === at);
  const allowed = [
    ...new Set(local.flatMap((e) =>
      e.keyword === "const" ? [e.params.allowedValue]
      : e.keyword === "enum" ? e.params.allowedValues
      : [])),
  ];
  const detail = allowed.length
    ? `${at || "the filter"} must be one of: ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`
    : `${at || "the filter"} ${(local.find((e) => e.keyword !== "anyOf") ?? deepest).message}.`;
  return problem("invalid-operand", detail, `/filter${at}`);
}

/**
 * Cases the generated schema provably cannot express. Each one is a property
 * of the generator, not of the language — jql-published expresses all four —
 * and each is a finding the README does not currently mention:
 *
 *   a19  $field cross-field comparison. The generator narrows $gt's operand to
 *        the field's own type, leaving no room for a reference operand, so the
 *        refs profile is unreachable from a generated schema.
 *   a20  $regex against status. By design: pattern matching is withheld from
 *        enumerated domains. Correct, and it still costs the case.
 *   b04  vaccinations[0].vaccine — the generator emits no indexed paths.
 *   b08  tags[0] — as b04.
 */
const GENERATED_CEILING = {
  a19: "the generator narrows $gt to the field's own type, so a $field reference operand cannot validate",
  a20: "pattern matching is deliberately withheld from enumerated domains",
  b04: "the generator emits no indexed paths",
  b08: "the generator emits no indexed paths",
};

function makeArm(id, schema, blurb, ceiling) {
  return {
    name: id,
    kind: "schema",
    ceiling,
    tool: {
      name: "search_pets",
      description: blurb,
      input_schema: {
        type: "object",
        properties: {
          filter: schema,
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Maximum number of records to return." },
        },
        required: ["filter"],
        additionalProperties: false,
      },
    },
    /** The query as the model expressed it, for logging and mistake analysis. */
    extract: (input) => input?.filter,
    validate(input) {
      if (input?.filter === undefined) return problem("malformed-query", "the filter argument is required.", "/filter");
      const validate = validators[id];
      return validate(input.filter) ? null : problemFromAjv(validate.errors);
    },
    execute(input, db) {
      const rejected = this.validate(input);
      if (rejected) return { problem: rejected };
      return runFilter(db, input.filter);
    },
    /** The gold query for a case is the gold filter itself — no translation. */
    gold: (testCase) => (ceiling[testCase.id] ? null : testCase.goldFilter ?? testCase.filter ?? null),
  };
}

const RAW_BLURB = "Search the pet collection. The `filter` argument is a predicate over a pet record; its schema describes the operators and the queryable fields, including which values each field accepts. Returns the matching records.";

export const jqlGenerated = makeArm(
  "jql-generated",
  GENERATED,
  "Search the pet collection. The `filter` argument is a predicate over a pet record; its schema describes the operators and the queryable fields, including which values each field accepts. Returns the matching records.",
  GENERATED_CEILING,
);

/**
 * The generated schema shipped exactly as README §"Exposing search to an agent"
 * says to ship it: inlined, `$ref`s and all. It is kept as its own arm because
 * the pilot found that this does not deliver the grammar to any model tested —
 * Gemini rejects it, OpenAI silently drops the 94% of the file that lives in
 * `$defs` — and the size of that gap is worth a row rather than a footnote.
 */
export const jqlRaw = { ...makeArm("jql-raw", GENERATED, RAW_BLURB, GENERATED_CEILING), rawRefs: true };

export const jqlPublished = makeArm(
  "jql-published",
  PUBLISHED,
  "Search the pet collection. The `filter` argument is a predicate over a pet record; its schema describes the operators and the queryable fields. Returns the matching records.",
  {},
);
