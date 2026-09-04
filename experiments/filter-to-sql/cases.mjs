/**
 * cases.mjs — the use-case corpus.
 *
 * Two kinds of case, deliberately mixed:
 *
 *   - what a search UI or an agent actually sends (groups A and B). If a
 *     predicate language cannot express these cheaply, nothing else matters.
 *   - what SPEC.md says happens at the edges (groups C to F). These are where
 *     an implementation either matches the specification or quietly does not.
 *
 * `expect` is the set of ids that SPEC.md says should match, derived by hand
 * from the fixture records rather than from any implementation. Where the two
 * bindings are specified to answer differently — which happens exactly once,
 * and for the reason SPEC §4.2 predicts — `expect` is keyed by binding.
 *
 * `note` is the reasoning. It is the part worth reading: the ratio of cases
 * whose expected answer needed a paragraph to cases that needed none is one of
 * the things this experiment set out to measure.
 */

/** Nested `$not`s, one deeper than SPEC §7's recommended limit of 10. */
function tooDeep(levels) {
  let filter = { status: "available" };
  for (let i = 0; i < levels; i += 1) filter = { $not: filter };
  return filter;
}

export const CASES = [
  // -------------------------------------------------------------------------
  {
    group: "A. What a search UI sends",
    id: "a01",
    title: "One field, scalar shorthand",
    filter: { status: "available" },
    expect: ["p01", "p02", "p05", "p06", "p09", "p10"],
  },
  {
    group: "A. What a search UI sends",
    id: "a02",
    title: "Two facets, implicit AND",
    filter: { status: "available", species: "cat" },
    expect: ["p01", "p09"],
  },
  {
    group: "A. What a search UI sends",
    id: "a03",
    title: "A multi-select facet",
    filter: { status: { $in: ["available", "pending"] } },
    expect: ["p01", "p02", "p03", "p05", "p06", "p07", "p09", "p10"],
  },
  {
    group: "A. What a search UI sends",
    id: "a04",
    title: "A numeric slider",
    filter: { weightKg: { $between: [1, 5] } },
    expect: ["p01", "p03", "p05", "p06", "p10"],
    note: "$between is inclusive at both ends (§5.3); 5.5 kg is out, 1.2 kg is in.",
  },
  {
    group: "A. What a search UI sends",
    id: "a05",
    title: "A date lower bound",
    filter: { born: { $gte: "2020-01-01" } },
    expect: ["p01", "p03", "p05", "p06", "p07"],
    note: "p10 has no born date: the comparison is UNKNOWN, and UNKNOWN excludes (§4.1).",
  },
  {
    group: "A. What a search UI sends",
    id: "a06",
    title: "A type-ahead prefix, case-sensitive",
    filter: { name: { $startsWith: "b" } },
    expect: ["p02"],
    note: "$startsWith is literal and case-sensitive (§5.6): 'bruno' matches, 'Bruno' would not.",
  },
  {
    group: "A. What a search UI sends",
    id: "a07",
    title: "A case-insensitive substring search",
    filter: { name: { $ilike: "%o%" } },
    expect: ["p02", "p03", "p05", "p06", "p10"],
  },
  {
    group: "A. What a search UI sends",
    id: "a08",
    title: "A substring that contains a wildcard character",
    filter: { name: { $contains: "50%" } },
    expect: ["p06"],
    note: "% is literal in $contains (§5.6). The compiler has to escape it before handing the pattern to SQL LIKE.",
  },
  {
    group: "A. What a search UI sends",
    id: "a09",
    title: "Tag chips, any of",
    filter: { tags: { $hasAny: ["indoor", "small"] } },
    expect: ["p01", "p05", "p06", "p10"],
  },
  {
    group: "A. What a search UI sends",
    id: "a10",
    title: "Tag chips, all of",
    filter: { tags: { $hasAll: ["trained", "outdoor"] } },
    expect: ["p02", "p08"],
    note: "p04 has 'trained' but not 'outdoor'.",
  },
  {
    group: "A. What a search UI sends",
    id: "a11",
    title: "At least three tags",
    filter: { tags: { $size: { $gte: 3 } } },
    expect: ["p02", "p05"],
  },
  {
    group: "A. What a search UI sends",
    id: "a12",
    title: "No tags at all",
    filter: { tags: { $size: 0 } },
    expect: ["p03"],
    note: "An empty array has size 0 (§5.8). Records with no tags member at all are UNKNOWN, not 0.",
  },
  {
    group: "A. What a search UI sends",
    id: "a13",
    title: "A nested object member",
    filter: { "shelter.city": "Athens" },
    expect: ["p01", "p03", "p05", "p06", "p09", "p10"],
  },
  {
    group: "A. What a search UI sends",
    id: "a14",
    title: "A range over a nested member",
    filter: { "shelter.capacity": { $lte: 12 } },
    expect: ["p02", "p05", "p07", "p08", "p10"],
    note: "p08's capacity is 0, which is in range; p04 has no capacity member, which is UNKNOWN.",
  },
  {
    group: "A. What a search UI sends",
    id: "a15",
    title: "Combined facets under OR",
    filter: {
      $or: [
        { species: "cat", status: "available" },
        { species: "dog", weightKg: { $lt: 20 } },
      ],
    },
    expect: ["p01", "p08", "p09"],
  },
  {
    group: "A. What a search UI sends",
    id: "a16",
    title: "AND of an OR of two different operator families",
    filter: {
      $and: [
        { status: "available" },
        { $or: [{ "shelter.city": "Patras" }, { tags: { $hasAny: ["trained"] } }] },
      ],
    },
    expect: ["p02"],
  },
  {
    group: "A. What a search UI sends",
    id: "a17",
    title: "Exclude two statuses with $nor",
    filter: { $nor: [{ status: "sold" }, { status: "pending" }] },
    expect: ["p01", "p02", "p05", "p06", "p09", "p10"],
    note: "Safe here only because status is never null: $nor over a nullable field would exclude the nulls too.",
  },
  {
    group: "A. What a search UI sends",
    id: "a18",
    title: "A boolean flag",
    filter: { neutered: true },
    expect: ["p01", "p03", "p04", "p08", "p09", "p10"],
  },
  {
    group: "A. What a search UI sends",
    id: "a19",
    title: "Cross-field comparison",
    filter: { priceCents: { $gt: { $field: "costCents" } } },
    expect: ["p01", "p04", "p05", "p07", "p10"],
    note: "SQL's WHERE price > cost, via $field (§5.11).",
  },
  {
    group: "A. What a search UI sends",
    id: "a20",
    title: "Regex on a promoted column",
    filter: { status: { $regex: "^a" } },
    expect: ["p01", "p02", "p05", "p06", "p09", "p10"],
  },

  // -------------------------------------------------------------------------
  {
    group: "B. Collections and nesting",
    id: "b01",
    title: "One element satisfying two conditions ($elemMatch)",
    filter: { vaccinations: { $elemMatch: { vaccine: "rabies", boosterDue: { $lt: "2025-01-01" } } } },
    expect: ["p08", "p09"],
    note: "p04 has a rabies shot and an overdue booster, but on two different elements (§5.9).",
  },
  {
    group: "B. Collections and nesting",
    id: "b02",
    title: "The same two conditions over a wildcard path",
    filter: {
      "vaccinations[*].vaccine": "rabies",
      "vaccinations[*].boosterDue": { $lt: "2025-01-01" },
    },
    expect: ["p04", "p08", "p09"],
    note: "Existential per clause, so p04 now matches. The pair b01/b02 is the whole of §5.9 in two filters.",
  },
  {
    group: "B. Collections and nesting",
    id: "b03",
    title: "A range inside $elemMatch",
    filter: { vaccinations: { $elemMatch: { administeredAt: { $gte: "2025-01-01T00:00:00Z" } } } },
    expect: ["p05", "p07"],
  },
  {
    group: "B. Collections and nesting",
    id: "b04",
    title: "An indexed path",
    filter: { "vaccinations[0].vaccine": "parvo" },
    expect: ["p04"],
    note: "p08 has parvo, but as its second element.",
  },
  {
    group: "B. Collections and nesting",
    id: "b05",
    title: "$in over a wildcard path",
    filter: { "vaccinations[*].vaccine": { $in: ["parvo"] } },
    expect: ["p04", "p08"],
  },
  {
    group: "B. Collections and nesting",
    id: "b06",
    title: "Contains none of",
    filter: { tags: { $hasNone: ["indoor"] } },
    expect: ["p02", "p03", "p04", "p07", "p08", "p09"],
    note: "p03's empty array contains nothing, so it satisfies $hasNone.",
  },

  {
    group: "B. Collections and nesting",
    id: "b07",
    title: "A constraint on the elements of an array, via [*]",
    filter: { "tags[*]": { $ne: "indoor" } },
    expect: ["p01", "p02", "p04", "p05", "p07", "p08", "p09", "p10"],
    note: "Existential (§5.9): TRUE where some tag is not 'indoor'. p06's only tag is 'indoor', so FALSE; p03's empty array resolves to nothing, so UNKNOWN.",
  },
  {
    group: "B. Collections and nesting",
    id: "b08",
    title: "A single element by index",
    filter: { "tags[0]": "indoor" },
    expect: ["p06", "p10"],
  },
  {
    group: "B. Collections and nesting",
    id: "b09",
    title: "$exists: true over a wildcard path",
    filter: { "vaccinations[*].boosterDue": { $exists: true } },
    expect: ["p01", "p02", "p04", "p05", "p07", "p08", "p09"],
  },
  {
    group: "B. Collections and nesting",
    id: "b10",
    title: "$exists: false over the same wildcard path",
    filter: { "vaccinations[*].boosterDue": { $exists: false } },
    expect: ["p02", "p04", "p08"],
    note: "The records with no vaccinations at all (p03, p06, p10) appear in neither b09 nor b10: §5.9 makes a wildcard constraint UNKNOWN when the path resolves to nothing, which costs $exists the totality §4.2 gives it everywhere else.",
  },

  // -------------------------------------------------------------------------
  {
    group: "C. Null, missing and negation",
    id: "c01",
    title: "Present and null",
    filter: { microchip: { $isNull: true } },
    expect: ["p02", "p06"],
    note: "p03 has no microchip member: $isNull is UNKNOWN there, not TRUE (§4.2).",
  },
  {
    group: "C. Null, missing and negation",
    id: "c02",
    title: "Absent",
    filter: { microchip: { $exists: false } },
    expect: ["p03"],
  },
  {
    group: "C. Null, missing and negation",
    id: "c03",
    title: "Present, whatever the value",
    filter: { notes: { $exists: true } },
    expect: ["p01", "p02", "p03", "p05", "p06", "p07", "p08", "p09"],
    note: "Includes p03, whose notes is null. $exists is the only total operator (§4.2).",
  },
  {
    group: "C. Null, missing and negation",
    id: "c04",
    title: "Absent nested member",
    filter: { "shelter.capacity": { $exists: false } },
    expect: ["p04"],
  },
  {
    group: "C. Null, missing and negation",
    id: "c05",
    title: "$ne over a nullable field",
    filter: { microchip: { $ne: "CHIP-001" } },
    expect: ["p04", "p05", "p07", "p08", "p09", "p10"],
    note: "The nulls (p02, p06) and the absent one (p03) are UNKNOWN, so they are excluded.",
  },
  {
    group: "C. Null, missing and negation",
    id: "c06",
    title: "The §4.1 surprise: $not over a nullable field",
    filter: { $not: { microchip: { $eq: "CHIP-001" } } },
    expect: ["p04", "p05", "p07", "p08", "p09", "p10"],
    note: "NOT UNKNOWN is UNKNOWN, so negation does not pull the nulls back in. Identical result to c05.",
  },
  {
    group: "C. Null, missing and negation",
    id: "c07",
    title: "What the spec tells you to write instead",
    filter: { $or: [{ microchip: { $ne: "CHIP-001" } }, { microchip: { $isNull: true } }] },
    expect: ["p02", "p04", "p05", "p06", "p07", "p08", "p09", "p10"],
    note: "The nulls come back; the absent member still does not, which is the distinction §4.2 exists to keep.",
  },
  {
    group: "C. Null, missing and negation",
    id: "c08",
    title: "$not over a non-nullable field is unremarkable",
    filter: { $not: { status: { $eq: "sold" } } },
    expect: ["p01", "p02", "p03", "p05", "p06", "p07", "p09", "p10"],
  },
  {
    group: "C. Null, missing and negation",
    id: "c09",
    title: "$exists against a promoted column",
    filter: { species: { $exists: false } },
    expect: {
      document: ["p05"],
      hybrid: { problem: "unsupported-operator" },
    },
    note: "§4.2 tells a store that cannot separate absent from null to reject $exists. The column binding cannot, and does.",
  },
  {
    group: "C. Null, missing and negation",
    id: "c10",
    title: "$isNull answers differently under the two bindings",
    filter: { species: { $isNull: true } },
    expect: {
      document: [],
      hybrid: ["p05"],
    },
    note: "p05 has no species member. In the document binding that is UNKNOWN; in a NULL column it is indistinguishable from a null value, and §4.2 permits reporting it as one so long as the endpoint says so. The one case where conformance is binding-dependent.",
  },
  {
    group: "C. Null, missing and negation",
    id: "c11",
    title: "Outside a range, over a complete field",
    filter: { weightKg: { $nbetween: [1, 5] } },
    expect: ["p02", "p04", "p07", "p08", "p09"],
  },

  // -------------------------------------------------------------------------
  {
    group: "D. Types and coercion",
    id: "d01",
    title: "$type on a heterogeneous path",
    filter: { notes: { $type: "number" } },
    expect: ["p02", "p08", "p09"],
  },
  {
    group: "D. Types and coercion",
    id: "d02",
    title: "$type: integer includes 3.0",
    filter: { notes: { $type: "integer" } },
    expect: ["p02", "p08"],
    note: "§5.10: integer means a number with no fractional part, so 3.0 qualifies and 3.5 does not.",
  },
  {
    group: "D. Types and coercion",
    id: "d03",
    title: "$type: array",
    filter: { notes: { $type: "array" } },
    expect: ["p05"],
  },
  {
    group: "D. Types and coercion",
    id: "d04",
    title: "$type: null distinguishes null from absent",
    filter: { notes: { $type: "null" } },
    expect: ["p03"],
  },
  {
    group: "D. Types and coercion",
    id: "d05",
    title: "Numbers compare by value, not representation",
    filter: { notes: { $eq: 3 } },
    expect: ["p02", "p08"],
    note: "§5.1: 1, 1.0 and 1e0 are equal. p02 holds 3 and p08 holds 3.0.",
  },
  {
    group: "D. Types and coercion",
    id: "d06",
    title: "Ordering skips values of the wrong type",
    filter: { notes: { $gt: 2 } },
    expect: ["p02", "p08", "p09"],
    note: "The string, array, object and boolean values are UNKNOWN, not FALSE — which only becomes observable under negation (see d07).",
  },
  {
    group: "D. Types and coercion",
    id: "d07",
    title: "String ordering on the same path",
    filter: { notes: { $gt: "a" } },
    expect: ["p01"],
    note: "Only p01's notes is a string. Same clause shape as d06, disjoint answer: no coercion (§4.3).",
  },
  {
    group: "D. Types and coercion",
    id: "d08",
    title: "$nin is the negation of $in, UNKNOWN included",
    filter: { notes: { $nin: [3] } },
    expect: ["p01", "p05", "p06", "p07", "p09"],
    note: "p03 (null) and p04/p10 (absent) are UNKNOWN and stay out. Values of other types are FALSE for $in, so TRUE here.",
  },

  {
    group: "D. Types and coercion",
    id: "d09",
    title: "Field-level $not over a heterogeneous path",
    filter: { notes: { $not: { $gt: 2 } } },
    expect: [],
    note: "Nothing matches: the numbers are all greater than 2 (FALSE), and every non-number is UNKNOWN, which negation leaves UNKNOWN (§5.13).",
  },

  // -------------------------------------------------------------------------
  {
    group: "E. Paths and patterns",
    id: "e01",
    title: "A key whose name starts with $",
    filter: { $$rate: { $gt: 5 } },
    expect: ["p06"],
    note: "§3.3: $$rate addresses the member literally named $rate.",
  },
  {
    group: "E. Paths and patterns",
    id: "e02",
    title: "A key whose name contains a dot",
    filter: { "size\\.raw": "XS" },
    expect: ["p06"],
    note: "§3.2: the escape makes this one key, not a two-segment path.",
  },
  {
    group: "E. Paths and patterns",
    id: "e03",
    title: "$like with both wildcards",
    filter: { name: { $like: "C%o" } },
    expect: ["p03"],
    note: "The pattern matches the whole value (§5.5), so 'Cleo' matches and 'Echo' does not.",
  },
  {
    group: "E. Paths and patterns",
    id: "e04",
    title: "$regex, unanchored, case-sensitive",
    filter: { name: { $regex: "^[A-C]" } },
    expect: ["p01", "p03"],
  },
  {
    group: "E. Paths and patterns",
    id: "e05",
    title: "$regex with the i flag",
    filter: { name: { $regex: "^[a-c]", $flags: "i" } },
    expect: ["p01", "p02", "p03"],
  },
  {
    group: "E. Paths and patterns",
    id: "e06",
    title: "$endsWith",
    filter: { name: { $endsWith: "s" } },
    expect: ["p07", "p09"],
  },

  // -------------------------------------------------------------------------
  {
    group: "F. What has to be rejected",
    id: "f01",
    title: "A path the endpoint does not expose",
    filter: { internalNotes: "anything" },
    expect: { problem: "unknown-field" },
    note: "§3.5. The problem carries queryableFields so a client converges in one round trip (§8).",
  },
  {
    group: "F. What has to be rejected",
    id: "f02",
    title: "An operator outside the advertised profiles",
    filter: { name: { $search: "ada" } },
    expect: { problem: "unsupported-operator" },
    note: "The `text` profile is not advertised. §2.1 forbids ignoring the clause, because dropping a predicate widens the result set.",
  },
  {
    group: "F. What has to be rejected",
    id: "f03",
    title: "A malformed $like escape",
    filter: { name: { $like: "a\\b" } },
    expect: { problem: "invalid-operand" },
    note: "§5.5 requires rejection: \\ may only escape %, _ or itself.",
  },
  {
    group: "F. What has to be rejected",
    id: "f04",
    title: "An operand the field's declared type cannot hold",
    filter: { weightKg: { $gt: "heavy" } },
    expect: { problem: "invalid-operand" },
    note: "§4.3: map at the boundary or reject. Without the declared type this would be a silent UNKNOWN.",
  },
  {
    group: "F. What has to be rejected",
    id: "f05",
    title: "A misspelled operator",
    filter: { name: { $eqq: "Ada" } },
    expect: { problem: "malformed-query" },
    note: "Caught by the schema, not the compiler: additionalProperties: false on the constraint object. §3.3 is what makes this an error rather than a field named $eqq.",
  },
  {
    group: "F. What has to be rejected",
    id: "f06",
    title: "Nesting past the depth limit",
    filter: tooDeep(12),
    expect: { problem: "query-too-complex" },
    note: "§7's recommended default is 10.",
  },
  {
    group: "F. What has to be rejected",
    id: "f07",
    title: "Structural equality against an object operand",
    filter: { "shelter.name": { $eq: { $literal: { k: 1 } } } },
    expect: { problem: "unsupported-operator" },
    note: "SQLite has no order-insensitive JSON comparison, so this backend refuses. Postgres jsonb `=` would do it correctly. §8 has no code for 'this operator, but not with that operand shape'.",
  },
  {
    group: "F. What has to be rejected",
    id: "f08",
    title: "The $in-on-an-array trap, caught by the declared type",
    filter: { tags: { $in: ["indoor"] } },
    expect: { problem: "invalid-operand" },
    note: "§5.4's documented trap: $in compares the whole value, so this asks whether tags equals 'indoor'. Because the binding declares tags as an array, the compiler can reject the string operand instead of returning nothing.",
  },
  {
    group: "F. What has to be rejected",
    id: "f09",
    title: "The same trap where no type is declared",
    filter: { vaccinations: { $in: ["rabies"] } },
    expect: [],
    note: "vaccinations is bound as a subtree with no declared type, so there is nothing to check the operand against and the trap stays silent: a well-formed filter that matches nothing (§2.2).",
  },
];

/** The expected outcome for one case under one binding. */
export function expectationFor(testCase, bindingName) {
  const expect = testCase.expect;
  if (Array.isArray(expect)) return { ids: expect };
  if (expect.problem) return { problem: expect.problem };
  const perBinding = expect[bindingName];
  return Array.isArray(perBinding) ? { ids: perBinding } : { problem: perBinding.problem };
}

/** True when the two bindings are expected to answer differently. */
export function bindingsDiverge(testCase) {
  const expect = testCase.expect;
  return !Array.isArray(expect) && !expect.problem;
}
