import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

// ajv and ajv-formats ship CommonJS; interop hands us either the namespace or the default.
const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const fixtures = join(here, "fixtures");

const schema = JSON.parse(
  readFileSync(join(repo, "query-language-schema.json"), "utf8"),
);

/**
 * strict: true is the regression guard for the whole class of defects this
 * rewrite fixed — unknown keywords ("regex" instead of "pattern", "id" instead
 * of "$id", OpenAPI's "components"/"example"), mistyped "examples", and
 * unresolvable $refs all fail compilation here rather than silently annotating.
 */
function makeAjv() {
  // allowUnionTypes: union "type" arrays are valid JSON Schema; ajv's strict
  // mode flags them only as a style preference.
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  // Documented OpenAPI-style extension keyword; see x-profiles in the schema.
  ajv.addVocabulary(["x-profiles"]);
  return ajv;
}

const validate = makeAjv().compile(schema);

function loadFixtures(kind) {
  const dir = join(fixtures, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}

test("schema is a valid draft 2020-12 schema", () => {
  const ajv = makeAjv();
  const ok = ajv.validateSchema(schema);
  assert.ok(ok, ajv.errorsText(ajv.errors, { separator: "\n" }));
});

test("schema declares the 2020-12 dialect and a versioned $id", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.match(schema.$id, /\/v\d+\.\d+\.\d+\//);
  assert.equal(schema.id, undefined, "draft-04 'id' must not be present");
  assert.equal(schema.components, undefined, "OpenAPI 'components' must not be present");
});

test("root asserts — the schema constrains input rather than accepting anything", () => {
  // The v0.1.0 file had no assertion keywords at its root and accepted every instance.
  assert.equal(validate("not an object"), false);
  assert.equal(validate([]), false);
  assert.equal(validate(42), false);
});

test("every JSON Schema 'examples' member is an array of instances", () => {
  const offenders = [];
  (function walk(node, path) {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}/${i}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "example") offenders.push(`${path}/example (OpenAPI 3.0 spelling)`);
      if (k === "examples" && !Array.isArray(v)) offenders.push(`${path}/examples (not an array)`);
      walk(v, `${path}/${k}`);
    }
  })(schema, "#");
  assert.deepEqual(offenders, []);
});

test("every inline example in the schema validates against the schema", () => {
  const ajv = makeAjv();
  ajv.addSchema(schema, "root");
  for (const [name, def] of Object.entries(schema.$defs)) {
    if (!Array.isArray(def.examples)) continue;
    const check = ajv.getSchema(`root#/$defs/${name}`);
    def.examples.forEach((ex, i) => {
      assert.ok(
        check(ex),
        `$defs/${name}/examples/${i}: ${ajv.errorsText(check.errors)}`,
      );
    });
  }
});

test("x-profiles covers exactly the operators the grammar defines", () => {
  const declared = new Set(Object.values(schema["x-profiles"]).flat());
  const defined = new Set([
    ...Object.keys(schema.$defs.Filter.properties),
    ...Object.keys(schema.$defs.ConstraintObject.properties),
    ...Object.keys(schema.$defs.ValueRef.properties),
    ...Object.keys(schema.$defs.LiteralWrapper.properties),
  ]);
  assert.deepEqual(
    [...defined].filter((op) => !declared.has(op)).sort(),
    [],
    "operators missing from x-profiles",
  );
  assert.deepEqual(
    [...declared].filter((op) => !defined.has(op)).sort(),
    [],
    "x-profiles lists operators the grammar does not define",
  );
});

test("every operator is exercised by at least one valid fixture", () => {
  // Keeps the README's operator table honest — it claims the table and the
  // fixture set are the same list.
  const corpus = loadFixtures("valid").map((f) => JSON.stringify(f.query)).join("\n");
  const uncovered = Object.values(schema["x-profiles"])
    .flat()
    .filter((op) => !corpus.includes(`"${op}":`))
    .sort();
  assert.deepEqual(uncovered, []);
});

test("fixture directories are non-empty", () => {
  assert.ok(loadFixtures("valid").length >= 20);
  assert.ok(loadFixtures("invalid").length >= 15);
});

for (const fx of loadFixtures("valid")) {
  test(`valid: ${fx.file} — ${fx.description}`, () => {
    const ok = validate(fx.query);
    assert.ok(ok, makeAjv().errorsText(validate.errors, { separator: "\n" }));
  });
}

for (const fx of loadFixtures("invalid")) {
  test(`invalid: ${fx.file} — ${fx.description}`, () => {
    assert.equal(validate(fx.query), false, "expected the query to be rejected");
    // Assert *why* it failed, so a fixture cannot pass for an unrelated reason.
    const keywords = validate.errors.map((e) => e.keyword);
    assert.ok(
      keywords.includes(fx.expectKeyword),
      `expected a '${fx.expectKeyword}' error, got: ${[...new Set(keywords)].join(", ")}`,
    );
  });
}

test("narrowing $defs/FieldPath in a bundled copy restricts fields at every depth", () => {
  // The documented way to lock an endpoint to a fixed field set: bundle the
  // schema locally and replace one definition. Because Filter reaches field
  // names through propertyNames -> $ref #/$defs/FieldPath, the narrowing
  // propagates through every level of recursion.
  const bundled = structuredClone(schema);
  bundled.$id = "https://example.com/pets/query.json";
  bundled.$defs.FieldPath = {
    type: "string",
    enum: ["id", "name", "status"],
  };

  const ajv = makeAjv();
  const restricted = ajv.compile(bundled);

  assert.ok(restricted({ name: "Fido" }), ajv.errorsText(restricted.errors));
  assert.ok(
    restricted({ $and: [{ status: "available" }, { $not: { id: { $eq: 3 } } }] }),
    ajv.errorsText(restricted.errors),
  );
  assert.equal(restricted({ nickname: "Fido" }), false, "unknown top-level field");
  assert.equal(
    restricted({ $or: [{ name: "Fido" }, { nickname: "Rex" }] }),
    false,
    "unknown field nested inside $or — the narrowing must survive recursion",
  );
  assert.equal(
    restricted({ name: { $eq: { $field: "nickname" } } }),
    false,
    "the narrowing also governs $field references",
  );
  // The published schema is unaffected.
  assert.ok(validate({ nickname: "Fido" }));
});
