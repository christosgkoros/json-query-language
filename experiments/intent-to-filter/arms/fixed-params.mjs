/**
 * fixed-params.mjs — the arm that measures the ceiling rather than the accuracy.
 *
 * README.md:61: "Give it `list_pets(status, species)` and it can ask three
 * questions". This arm is that tool, built as well as the shape allows: ten
 * typed parameters, enums where the domain is closed, ranges split into a pair
 * of bounds. It is the interface most search tools actually ship.
 *
 * The interesting number here is not how often the model gets it right. It is
 * how often the question cannot be asked at all — and, on the questions that
 * *can* be asked, whether typed enum parameters catch the closed-domain
 * mistake that the filter grammar needs a generated schema to catch.
 *
 * Its CEILING is by far the largest of the five, and that is the finding.
 */

import { runFilter, problem, DOMAINS } from "./execute.mjs";

const PARAMS = {
  status: { type: "string", enum: DOMAINS.status, description: "Listing state." },
  species: { type: "string", enum: DOMAINS.species, description: "Taxon." },
  bornFrom: { type: "string", format: "date", description: "Earliest date of birth, inclusive." },
  bornTo: { type: "string", format: "date", description: "Latest date of birth, inclusive." },
  minWeightKg: { type: "number", minimum: 0, description: "Lowest weight, inclusive." },
  maxWeightKg: { type: "number", minimum: 0, description: "Highest weight, inclusive." },
  tag: { type: "string", description: "A single label the pet must carry." },
  shelterCity: { type: "string", description: "City the shelter is in." },
  neutered: { type: "boolean", description: "Whether the pet has been neutered." },
  nameContains: { type: "string", description: "Case-insensitive substring of the pet's name." },
};

/** Parameter -> the clause it contributes. Order is irrelevant: all AND together. */
const CLAUSE = {
  status: (v) => ({ status: { $eq: v } }),
  species: (v) => ({ species: { $eq: v } }),
  bornFrom: (v) => ({ born: { $gte: v } }),
  bornTo: (v) => ({ born: { $lte: v } }),
  minWeightKg: (v) => ({ weightKg: { $gte: v } }),
  maxWeightKg: (v) => ({ weightKg: { $lte: v } }),
  tag: (v) => ({ tags: { $some: { $eq: v } } }),
  shelterCity: (v) => ({ "shelter.city": { $eq: v } }),
  neutered: (v) => ({ neutered: { $eq: v } }),
  nameContains: (v) => ({ name: { $ilike: `%${v}%` } }),
};

/**
 * The nine questions this shape can answer, out of sixty-three. Everything
 * absent from GOLD is beyond the ceiling — there is no point enumerating the
 * fifty-four reasons individually, since they are all the same reason.
 */
const GOLD = {
  a01: { status: "available" },
  a02: { status: "available", species: "cat" },
  a04: { minWeightKg: 1, maxWeightKg: 5 },
  a05: { bornFrom: "2020-01-01" },
  a07: { nameContains: "o" },
  a13: { shelterCity: "Athens" },
  a18: { neutered: true },
  m01: { tag: "indoor" },
  m03: { status: "available" },
};

function validateInput(input) {
  const given = Object.entries(input ?? {}).filter(([k]) => k !== "limit");
  if (given.length === 0) {
    return problem("malformed-query", "at least one search parameter is required.", "/");
  }
  for (const [key, value] of given) {
    const spec = PARAMS[key];
    if (!spec) {
      return problem("unknown-field", `"${key}" is not a parameter of this tool. The parameters are: ${Object.keys(PARAMS).join(", ")}.`, `/${key}`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      return problem("invalid-operand", `${key} must be one of: ${spec.enum.map((v) => JSON.stringify(v)).join(", ")}.`, `/${key}`);
    }
    const actual = typeof value;
    const wanted = spec.type === "number" ? "number" : spec.type === "boolean" ? "boolean" : "string";
    if (actual !== wanted) {
      return problem("invalid-operand", `${key} must be a ${wanted}.`, `/${key}`);
    }
  }
  return null;
}

export const fixedParams = {
  name: "fixed-params",
  kind: "params",
  /** Everything not in GOLD; computed by index.mjs against the question set. */
  ceiling: {},
  ceilingReason: "the question needs a predicate this parameter list cannot form",
  tool: {
    name: "search_pets",
    description:
      "Search the pet collection. Every parameter you supply narrows the result further; omit the ones you do not need. Returns the matching records.",
    input_schema: {
      type: "object",
      properties: {
        ...PARAMS,
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Maximum number of records to return." },
      },
      additionalProperties: false,
    },
  },
  extract: (input) => input,
  validate: validateInput,
  /** The parameters as a filter — the form the differential grader compares. */
  translate(input) {
    const rejected = validateInput(input);
    if (rejected) throw Object.assign(new Error(rejected.detail), { problem: rejected });
    const clauses = Object.entries(input)
      .filter(([k]) => k !== "limit" && CLAUSE[k])
      .map(([k, v]) => CLAUSE[k](v));
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  },
  execute(input, db) {
    const rejected = validateInput(input);
    if (rejected) return { problem: rejected };
    return runFilter(db, this.translate(input));
  },
  gold: (testCase) => GOLD[testCase.id] ?? null,
  expressible: (id) => Object.hasOwn(GOLD, id),
};
