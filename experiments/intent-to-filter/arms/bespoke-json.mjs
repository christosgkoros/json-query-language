/**
 * bespoke-json.mjs — the control that isolates the actual variable.
 *
 * COMPARISON.md:29-30 says an agent "is handed an `inputSchema` and left to
 * infer a query syntax from prose". This arm is that: a JSON query language of
 * the kind a team invents for one API, with `where: {type: "object"}` as its
 * entire schema and a prose paragraph as its entire documentation.
 *
 * Two design decisions make it a control rather than a strawman.
 *
 * **It is near-isomorphic to the filter grammar.** Every operator has a
 * counterpart, resolution of unknowns included. The claim under test is that
 * *describing a language with JSON Schema* beats *describing it with prose* —
 * so the language has to be held roughly constant, or the experiment measures
 * expressivity instead. Its CEILING is empty, and that is deliberate.
 *
 * **It is not Mongo-shaped.** Models carry a large MongoDB prior, and the
 * filter grammar is deliberately Mongo-adjacent (COMPARISON.md:174). A bespoke
 * arm spelled with `$eq` and `$in` would be measuring familiarity. So this one
 * uses `{op, value}` pairs and word operators — the other common house style,
 * and one no model has memorised.
 */

import { runFilter, problem } from "./execute.mjs";

const OPS = {
  is: "$eq", isnot: "$ne",
  gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte",
  between: "$between", notbetween: "$nbetween",
  anyof: "$in", noneof: "$nin",
  exists: "$exists", isblank: "$isNull",
  prefix: "$startsWith", suffix: "$endsWith", substring: "$contains",
  like: "$like", ilike: "$ilike", matches: "$regex",
  type: "$type", hasall: "$hasAll",
};

/** Operators whose operand is itself a condition rather than a value. */
const NESTED = { some: "$some", every: "$every", count: "$size" };

const FIELDS = {
  id: "id", name: "name", species: "species", status: "status", born: "born",
  weightKg: "weightKg", neutered: "neutered", microchip: "microchip",
  tags: "tags", notes: "notes", priceCents: "priceCents", costCents: "costCents",
  rate: "$$rate", sizeRaw: "size\\.raw",
  "shelter.name": "shelter.name", "shelter.city": "shelter.city",
  "shelter.capacity": "shelter.capacity",
  vaccinations: "vaccinations",
  vaccine: "vaccine", administeredAt: "administeredAt", boosterDue: "boosterDue",
};

class BespokeError extends Error {
  constructor(detail, type = "malformed-query", pointer = "/where") {
    super(detail);
    this.detail = detail;
    this.type = type;
    this.pointer = pointer;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A `{op, value}` condition -> a constraint object. `inElement` relaxes field lookup. */
function condition(node, pointer) {
  if (!isPlainObject(node)) {
    throw new BespokeError(`expected a condition object at ${pointer}.`, "malformed-query", pointer);
  }
  // A nested where-object (used as the body of `some`/`every`) rather than a condition.
  if (!("op" in node)) return where(node, pointer);

  const { op, value, flags, orUnknown, negate } = node;
  const inner = {};

  if (op in NESTED) {
    inner[NESTED[op]] = op === "count" && !isPlainObject(value) ? value : condition(value, `${pointer}/value`);
  } else if (op === "first") {
    throw new BespokeError("`first` may only appear directly under a field.", "malformed-query", pointer);
  } else if (op === "fieldref") {
    throw new BespokeError("`fieldref` may only appear as the value of a comparison.", "malformed-query", pointer);
  } else if (op in OPS) {
    inner[OPS[op]] = isPlainObject(value) && value.op === "fieldref"
      ? { $field: resolve(value.value, pointer) }
      : value;
    if (op === "matches" && flags) inner.$flags = flags;
  } else {
    throw new BespokeError(
      `"${op}" is not an operator. The operators are: ${[...Object.keys(OPS), ...Object.keys(NESTED), "first", "fieldref"].join(", ")}.`,
      "unsupported-operator",
      pointer,
    );
  }

  // `negate: true` negates this field's constraint; `orUnknown` then resolves
  // whatever is left UNKNOWN, which is the outer position of the two.
  const constraint = negate === true ? { $not: inner } : inner;

  if (orUnknown === true) constraint.$unknownAs = true;
  if (orUnknown === false) constraint.$unknownAs = false;
  return constraint;
}

function resolve(name, pointer) {
  const path = FIELDS[name];
  if (path === undefined) {
    throw new BespokeError(
      `"${name}" is not a queryable field. The fields are: ${Object.keys(FIELDS).join(", ")}.`,
      "unknown-field",
      `${pointer}/${name}`,
    );
  }
  return path;
}

const LOGIC = { all: "$and", any: "$or", none: "$nor" };

/** A where-object -> a filter. */
function where(node, pointer = "/where") {
  if (!isPlainObject(node)) {
    throw new BespokeError("the where argument must be an object.", "malformed-query", pointer);
  }
  const entries = Object.entries(node);
  if (entries.length === 0) {
    throw new BespokeError("the where object must carry at least one condition.", "malformed-query", pointer);
  }

  const filter = {};
  for (const [key, value] of entries) {
    const at = `${pointer}/${key}`;
    if (key in LOGIC) {
      if (!Array.isArray(value) || value.length === 0) {
        throw new BespokeError(`"${key}" takes a non-empty list of conditions.`, "malformed-query", at);
      }
      filter[LOGIC[key]] = value.map((member, index) => where(member, `${at}/${index}`));
      continue;
    }
    if (key === "not") { filter.$not = where(value, at); continue; }

    // `first` owns the path, so it is unwrapped here rather than in condition().
    if (isPlainObject(value) && value.op === "first") {
      const path = resolve(key, pointer);
      const body = value.value;
      // `first` on an array of objects addresses a member of element zero;
      // on an array of scalars it addresses element zero itself.
      if (isPlainObject(body) && !("op" in body)) {
        for (const [member, cond] of Object.entries(body)) {
          filter[`${path}[0].${resolve(member, pointer)}`] = condition(cond, `${at}/value/${member}`);
        }
      } else {
        filter[`${path}[0]`] = condition(body, `${at}/value`);
      }
      continue;
    }
    filter[resolve(key, pointer)] = condition(value, at);
  }
  return filter;
}

/**
 * The gold query per case. Isomorphic to the filter grammar by construction,
 * so every case the grammar can express has an entry — which is the point.
 */
const GOLD = {
  a01: { status: { op: "is", value: "available" } },
  a02: { status: { op: "is", value: "available" }, species: { op: "is", value: "cat" } },
  a03: { status: { op: "anyof", value: ["available", "pending"] } },
  a04: { weightKg: { op: "between", value: [1, 5] } },
  a05: { born: { op: "gte", value: "2020-01-01" } },
  a06: { name: { op: "prefix", value: "b" } },
  a07: { name: { op: "ilike", value: "%o%" } },
  a08: { name: { op: "substring", value: "50%" } },
  a09: { tags: { op: "some", value: { op: "anyof", value: ["indoor", "small"] } } },
  a10: { tags: { op: "hasall", value: ["trained", "outdoor"] } },
  a11: { tags: { op: "count", value: { op: "gte", value: 3 } } },
  a12: { tags: { op: "count", value: 0 } },
  a13: { "shelter.city": { op: "is", value: "Athens" } },
  a14: { "shelter.capacity": { op: "lte", value: 12 } },
  a15: { any: [
    { species: { op: "is", value: "cat" }, status: { op: "is", value: "available" } },
    { species: { op: "is", value: "dog" }, weightKg: { op: "lt", value: 20 } },
  ] },
  a16: { all: [
    { status: { op: "is", value: "available" } },
    { any: [
      { "shelter.city": { op: "is", value: "Patras" } },
      { tags: { op: "some", value: { op: "anyof", value: ["trained"] } } },
    ] },
  ] },
  a17: { none: [{ status: { op: "is", value: "sold" } }, { status: { op: "is", value: "pending" } }] },
  a18: { neutered: { op: "is", value: true } },
  a19: { priceCents: { op: "gt", value: { op: "fieldref", value: "costCents" } } },
  a20: { status: { op: "matches", value: "^a" } },
  b01: { vaccinations: { op: "some", value: {
    vaccine: { op: "is", value: "rabies" },
    boosterDue: { op: "lt", value: "2025-01-01" },
  } } },
  b02: { all: [
    { vaccinations: { op: "some", value: { vaccine: { op: "is", value: "rabies" } } } },
    { vaccinations: { op: "some", value: { boosterDue: { op: "lt", value: "2025-01-01" } } } },
  ] },
  b03: { vaccinations: { op: "some", value: { administeredAt: { op: "gte", value: "2025-01-01T00:00:00Z" } } } },
  b04: { vaccinations: { op: "first", value: { vaccine: { op: "is", value: "parvo" } } } },
  b05: { vaccinations: { op: "some", value: { vaccine: { op: "anyof", value: ["parvo"] } } } },
  b06: { tags: { op: "some", value: { op: "anyof", value: ["indoor"] } } }, // negated below
  b07: { tags: { op: "some", value: { op: "isnot", value: "indoor" } } },
  b08: { tags: { op: "first", value: { op: "is", value: "indoor" } } },
  b09: { vaccinations: { op: "some", value: { boosterDue: { op: "exists", value: true } } } },
  b10: { vaccinations: { op: "some", value: { boosterDue: { op: "exists", value: false } } } },
  b11: { vaccinations: { op: "every", value: { vaccine: { op: "is", value: "rabies" } } } },
  b12: { tags: { op: "every", value: { op: "isnot", value: "indoor" } } },
  b13: { not: { tags: { op: "some", value: { op: "isnot", value: "indoor" } } } },
  c01: { microchip: { op: "isblank", value: true } },
  c02: { microchip: { op: "exists", value: false } },
  c03: { notes: { op: "exists", value: true } },
  c04: { "shelter.capacity": { op: "exists", value: false } },
  c05: { microchip: { op: "isnot", value: "CHIP-001" } },
  c07: { any: [
    { microchip: { op: "isnot", value: "CHIP-001" } },
    { microchip: { op: "isblank", value: true } },
  ] },
  c08: { not: { status: { op: "is", value: "sold" } } },
  c11: { weightKg: { op: "notbetween", value: [1, 5] } },
  c12: { microchip: { op: "isnot", value: "CHIP-001", orUnknown: true } },
  c13: { born: { not: true, op: "gte", value: "2020-01-01", orUnknown: true } },
  d01: { notes: { op: "type", value: "number" } },
  d02: { notes: { op: "type", value: "integer" } },
  d03: { notes: { op: "type", value: "array" } },
  d04: { notes: { op: "type", value: "null" } },
  d05: { notes: { op: "is", value: 3 } },
  d06: { notes: { op: "gt", value: 2 } },
  d07: { notes: { op: "gt", value: "a" } },
  d08: { notes: { op: "noneof", value: [3] } },
  d09: { notes: { not: true, op: "gt", value: 2 } },
  e01: { rate: { op: "gt", value: 5 } },
  e02: { sizeRaw: { op: "is", value: "XS" } },
  e03: { name: { op: "like", value: "C%o" } },
  e04: { name: { op: "matches", value: "^[A-C]" } },
  e05: { name: { op: "matches", value: "^[a-c]", flags: "i" } },
  e06: { name: { op: "suffix", value: "s" } },
  f01: { internalNotes: { op: "is", value: "anything" } },
  f02: { name: { op: "fulltext", value: "ada" } },
  m01: { tags: { op: "some", value: { op: "anyof", value: ["indoor"] } } },
  m02: { microchip: { op: "isnot", value: "CHIP-001", orUnknown: true } },
  m03: { status: { op: "is", value: "available" } },
};

// b06 is "no element is indoor" — the negation of its entry above.
GOLD.b06 = { not: GOLD.b06 };
// c13/d09 use a field-level negation, which the surface spells as `not: true`.
GOLD.c13 = { born: { op: "gte", value: "2020-01-01", negate: true, orUnknown: true } };
GOLD.d09 = { notes: { op: "gt", value: 2, negate: true } };

export const bespokeJson = {
  name: "bespoke-json",
  kind: "json",
  ceiling: {},
  tool: {
    name: "search_pets",
    description: null, // filled from arms/docs/bespoke-json.md by index.mjs
    input_schema: {
      type: "object",
      properties: {
        where: { type: "object", description: "The query. See the tool description for the shape." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Maximum number of records to return." },
      },
      required: ["where"],
      additionalProperties: false,
    },
  },
  extract: (input) => input?.where,
  translate(input) {
    if (!isPlainObject(input?.where)) {
      throw new BespokeError("the where argument is required and must be an object.");
    }
    return where(input.where);
  },
  validate(input) {
    try {
      this.translate(input);
      return null;
    } catch (error) {
      if (error instanceof BespokeError) return problem(error.type, error.detail, error.pointer);
      throw error;
    }
  },
  execute(input, db) {
    let filter;
    try {
      filter = this.translate(input);
    } catch (error) {
      if (error instanceof BespokeError) return { problem: problem(error.type, error.detail, error.pointer) };
      throw error;
    }
    return runFilter(db, filter);
  },
  gold: (testCase) => GOLD[testCase.id] ?? null,
};
