import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

import { generateFilterSchema } from "../tools/generate-filter-schema.mjs";

const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const grammar = JSON.parse(readFileSync(join(repo, "query-language-schema.json"), "utf8"));
const pet = JSON.parse(readFileSync(join(repo, "examples", "pet.schema.json"), "utf8"));

function makeAjv() {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  ajv.addVocabulary(["x-profiles", "x-jql"]);
  return ajv;
}

const { schema: generated, capabilities, warnings } = generateFilterSchema(pet, {
  id: "https://api.example.com/schemas/pet.filter.json",
});

const validate = makeAjv().compile(generated);
const validateGrammar = makeAjv().compile(grammar);

const errs = (v) => makeAjv().errorsText(v.errors, { separator: "; " });

test("the generated schema compiles under ajv strict mode", () => {
  const ajv = makeAjv();
  assert.ok(ajv.validateSchema(generated), ajv.errorsText(ajv.errors, { separator: "\n" }));
});

test("generation is deterministic", () => {
  const again = generateFilterSchema(pet, { id: "https://api.example.com/schemas/pet.filter.json" });
  assert.equal(JSON.stringify(again.schema), JSON.stringify(generated));
});

test("the committed example outputs are up to date", () => {
  // These are the artefacts README points readers at; a drifted copy is worse
  // than none, because it is the one people will read instead of running the tool.
  const onDisk = JSON.parse(readFileSync(join(repo, "examples", "pet.filter.json"), "utf8"));
  const capsOnDisk = JSON.parse(readFileSync(join(repo, "examples", "pet.capabilities.json"), "utf8"));
  assert.deepEqual(onDisk, generated, "run: npm run generate:example");
  assert.deepEqual(capsOnDisk, capabilities, "run: npm run generate:example");
});

test("no warnings for a well-typed resource schema", () => {
  assert.deepEqual(warnings, []);
});

const ACCEPTED = [
  ["scalar shorthand on a closed domain", { status: "available" }],
  ["explicit equality", { status: { $eq: "sold" } }],
  ["set membership over the domain", { species: { $in: ["cat", "dog"] } }],
  ["date ordering", { born: { $gte: "2020-01-01" } }],
  ["inclusive range on a number", { weightKg: { $between: [2, 8] } }],
  ["array membership", { tags: { $hasAny: ["rescue", "senior"] } }],
  ["array length", { tags: { $size: { $gte: 1 } } }],
  ["element condition over an array of scalars", { tags: { $elemMatch: { $startsWith: "adopt-" } } }],
  ["element condition over an array of objects", {
    vaccinations: { $elemMatch: { vaccine: "rabies", administeredAt: { $gt: "2024-01-01T00:00:00Z" } } },
  }],
  ["nested object path", { "shelter.city": { $ilike: "%amsterdam%" } }],
  ["null handling spelled out", { $or: [{ microchip: { $ne: "X" } }, { microchip: { $isNull: true } }] }],
  ["presence of an optional object", { shelter: { $exists: true } }],
  ["nested logic", {
    $and: [
      { status: "available" },
      { $or: [{ species: { $in: ["cat", "dog"] } }, { tags: { $hasAny: ["rescue"] } }] },
      { $not: { neutered: false } },
    ],
  }],
];

for (const [name, filter] of ACCEPTED) {
  test(`accepts: ${name}`, () => {
    assert.ok(validate(filter), errs(validate));
  });
}

test("everything the generated schema accepts, the published grammar also accepts", () => {
  // The soundness property that makes generation safe: narrowing only. A filter
  // written against a generated schema is always a legal JQL filter, so a
  // server implementing the published semantics can evaluate it unchanged.
  for (const [name, filter] of ACCEPTED) {
    assert.ok(validateGrammar(filter), `${name}: ${errs(validateGrammar)}`);
  }
});

const REJECTED = [
  // The three valid-but-wrong filters from README §"Exposing search to an agent".
  // Each is well-formed JQL — the published grammar accepts all three — and each
  // fails as an empty result set rather than an error. Typing them per field is
  // what turns them into a 400.
  ["value outside a closed domain", { status: "Available" }, "anyOf"],
  ["$in used as array membership", { tags: { $in: ["urgent"] } }, "additionalProperties"],
  ["wrong operand type for an ordered field", { born: { $gte: 2020 } }, "anyOf"],
  // Field-set and operator-set narrowing.
  ["unknown field", { birthDate: "2020-01-01" }, "additionalProperties"],
  ["unknown field nested in $or", { $or: [{ status: "sold" }, { nickname: "Rex" }] }, "additionalProperties"],
  ["field excluded by x-jql", { internalNotes: { $contains: "vet" } }, "additionalProperties"],
  ["operator outside the advertised profiles", { name: { $regex: "^Fi" } }, "additionalProperties"],
  ["ordering on an unordered string", { name: { $gt: "M" } }, "additionalProperties"],
  ["pattern matching on a closed domain", { species: { $like: "ca%" } }, "additionalProperties"],
  ["$exists on an always-present field", { status: { $exists: true } }, "additionalProperties"],
  ["$isNull on a non-nullable field", { name: { $isNull: true } }, "additionalProperties"],
  ["numeric bound outside the field's range", { weightKg: 500 }, "anyOf"],
  ["unknown path inside $elemMatch", { vaccinations: { $elemMatch: { brand: "x" } } }, "additionalProperties"],
];

for (const [name, filter, keyword] of REJECTED) {
  test(`rejects: ${name}`, () => {
    assert.equal(validate(filter), false, "expected rejection");
    const keywords = validate.errors.map((e) => e.keyword);
    assert.ok(
      keywords.includes(keyword),
      `expected a '${keyword}' error, got: ${[...new Set(keywords)].join(", ")}`,
    );
  });
}

test("the rejected filters are rejected by narrowing, not by the base grammar", () => {
  // If the published grammar already caught these, per-field typing would be
  // buying nothing. Everything here is legal JQL that means the wrong thing.
  const alsoIllegalUnderTheGrammar = REJECTED
    .filter(([, filter]) => !validateGrammar(filter))
    .map(([name]) => name);
  assert.deepEqual(alsoIllegalUnderTheGrammar, []);
});

test("profiles trim the operator set", () => {
  const { schema } = generateFilterSchema(pet, { profiles: ["core"] });
  const json = JSON.stringify(schema);
  for (const op of ["$like", "$ilike", "$contains", "$between", "$hasAny", "$size", "$elemMatch", "$regex"]) {
    assert.ok(!json.includes(`"${op}"`), `${op} should not survive a core-only generation`);
  }
  for (const op of ["$eq", "$in", "$gte", "$and"]) {
    assert.ok(json.includes(`"${op}"`), `${op} is core and must survive`);
  }
});

test("an unknown profile is refused rather than silently dropped", () => {
  assert.throws(() => generateFilterSchema(pet, { profiles: ["core", "geo"] }), /unknown profile "geo"/);
  assert.throws(() => generateFilterSchema(pet, { profiles: ["strings"] }), /"core" profile is mandatory/);
});

test("--descriptions trades tokens for prose", () => {
  const brief = JSON.stringify(generateFilterSchema(pet, {}).schema);
  const all = JSON.stringify(generateFilterSchema(pet, { descriptions: "all" }).schema);
  const none = JSON.stringify(generateFilterSchema(pet, { descriptions: "none" }).schema);
  assert.ok(none.length < brief.length && brief.length < all.length);
  // The rules an agent gets wrong survive the default mode.
  assert.ok(brief.includes("it does NOT test membership inside an array-valued field"));
});

test("exclude and max-depth bound the surface", () => {
  const { schema } = generateFilterSchema(pet, { exclude: ["shelter*", "id"] });
  assert.ok(!("id" in schema.properties));
  assert.ok(!("shelter.city" in schema.properties));
  assert.ok("name" in schema.properties);

  const shallow = generateFilterSchema(pet, { maxDepth: 0 });
  assert.ok(!("shelter.city" in shallow.schema.properties));
  assert.ok(shallow.warnings.some((w) => w.includes("max-depth")));
});

test("a recursive resource schema terminates", () => {
  const recursive = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.com/node.json",
    title: "Node",
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      parent: { $ref: "#" },
      children: { type: "array", items: { $ref: "#" } },
    },
  };
  const { schema } = generateFilterSchema(recursive, { maxDepth: 2 });
  assert.ok(makeAjv().validateSchema(schema));
  assert.ok("parent.id" in schema.properties, Object.keys(schema.properties).join(", "));
});

test("allOf composition still yields fields", () => {
  const composed = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Composed",
    $defs: { Timestamps: { type: "object", properties: { createdAt: { type: "string", format: "date-time" } } } },
    allOf: [{ $ref: "#/$defs/Timestamps" }],
    type: "object",
    properties: { name: { type: "string" } },
  };
  const { schema } = generateFilterSchema(composed, {});
  assert.deepEqual(Object.keys(schema.properties).filter((k) => !k.startsWith("$")).sort(), ["createdAt", "name"]);
});

test("an untyped property is skipped with a warning rather than guessed at", () => {
  const loose = {
    title: "Loose",
    type: "object",
    properties: { known: { type: "string" }, anything: { description: "no type here" } },
  };
  const { schema, warnings: w } = generateFilterSchema(loose, {});
  assert.ok(!("anything" in schema.properties));
  assert.ok(w.some((m) => m.includes("anything")));
});

test("the capability document describes exactly the generated field set", () => {
  const fromSchema = Object.keys(generated.properties).filter((k) => !k.startsWith("$"));
  assert.deepEqual(Object.keys(capabilities.fields).sort(), fromSchema.sort());
  assert.equal(capabilities.queryLanguage, grammar.$id);
  assert.deepEqual(capabilities.fields.status.values, ["available", "pending", "sold"]);
  assert.equal(capabilities.fields.microchip.nullable, true);
  assert.ok(!("$regex" in capabilities.fields.name.operators));
  // §2.2 requires every advertised operator to be one the profiles imply.
  const enabled = new Set(capabilities.profiles.flatMap((p) => grammar["x-profiles"][p]));
  for (const [path, field] of Object.entries(capabilities.fields)) {
    for (const op of field.operators) {
      assert.ok(enabled.has(op), `${path} advertises ${op}, which no advertised profile provides`);
    }
  }
});

test("the generated schema's operators and the capability document agree", () => {
  for (const [path, field] of Object.entries(capabilities.fields)) {
    const node = generated.properties[path];
    const constraintRef = node.$ref ?? node.anyOf.at(-1).$ref;
    const constraint = generated.$defs[constraintRef.replace("#/$defs/", "")];
    assert.deepEqual(Object.keys(constraint.properties), field.operators, `mismatch on ${path}`);
  }
});

test("--include keeps exactly the named paths, nested ones included", () => {
  const { schema, capabilities: caps, warnings: w } = generateFilterSchema(pet, {
    include: ["status", "shelter.city", "notAField"],
  });
  const paths = Object.keys(schema.properties).filter((k) => !k.startsWith("$"));
  assert.deepEqual(paths.sort(), ["shelter.city", "status"]);
  assert.deepEqual(Object.keys(caps.fields).sort(), ["shelter.city", "status"]);
  assert.ok(w.some((m) => m.includes("notAField")));
  // The defs of pruned fields are unreachable but harmless; what matters is
  // that the schema still compiles and still rejects what it dropped.
  const check = makeAjv().compile(schema);
  assert.ok(check({ status: "sold" }), errs(check));
  assert.equal(check({ name: "Fido" }), false);
});
