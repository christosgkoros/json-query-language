# JSON Query Language

A JSON-encoded, SQL-flavoured **predicate language**, described by a single JSON Schema — `$ref` it from an OpenAPI document, or drop it into an MCP tool's `inputSchema`.

Write the filter grammar once. Use it for every `POST /…/search` and `QUERY /…` operation in your API, and for every search tool you expose to an agent. Clients learn one language instead of one ad-hoc query syntax per endpoint — and so do models.

```json
{
  "$and": [
    { "status": "available" },
    { "$or": [
        { "species": { "$in": ["cat", "dog"] } },
        { "tags":    { "$hasAny": ["rescue", "senior"] } }
    ]},
    { "born": { "$gte": "2020-01-01" } }
  ]
}
```

- **Schema** — [`query-language-schema.json`](./query-language-schema.json) (JSON Schema draft 2020-12)
- **Semantics** — [`SPEC.md`](./SPEC.md) — nulls, paths, coercion, errors, limits
- **Integration examples** — [`examples/`](./examples) — working OpenAPI 3.1 and 3.2 documents
- **Version** — `0.2.0`. See [`CHANGELOG.md`](./CHANGELOG.md) for the v0.1.0 migration.

---

## Why

Search endpoints attract bespoke query syntaxes. Each one arrives as an opaque string parameter (`?q=status:open AND born>2020`) that no schema can validate, no generator can type, and no client can build safely. Structuring the query as JSON changes that: it can be described by a JSON Schema, and a JSON Schema is the interchange format both of today's API description layers already speak. From OpenAPI it validates in CI, appears in generated docs, and produces real types in generated clients. As an MCP tool's `inputSchema` it becomes the contract an LLM agent writes filters against — with the operator `description`s carried along as the instructions, instead of prose telling a model to assemble a string it can never be checked against.

Confining the schema to the *predicate* — no projection, ordering or pagination — is what makes it reusable. Those parts differ per API; the filter does not.

## Quickstart

The schema is a single self-contained file. Install it, vendor it, or `$ref` it by URL.

```bash
npm install --save-dev json-query-language
# or:  curl -O https://raw.githubusercontent.com/christosgkoros/json-query-language/main/query-language-schema.json
```

The same artifact is also published to GitHub Packages as `@christosgkoros/json-query-language` — GitHub Packages accepts only scoped names. It needs a token even for public packages, so npmjs is the easier path unless you are already authenticated there; see [RELEASING.md](./RELEASING.md#installing-from-github-packages).

Validate a filter with any draft 2020-12 validator:

```js
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import schema from 'json-query-language/query-language-schema.json' with { type: 'json' }

const ajv = new Ajv2020({ allowUnionTypes: true })
addFormats(ajv)
ajv.addVocabulary(['x-profiles'])          // the schema's one extension keyword

const validate = ajv.compile(schema)
validate({ status: 'open', age: { $gte: 18 } })   // true
validate({ status: { $eqq: 'open' } })            // false — typos are caught
```

Then run the repo's own suite to see the grammar exercised end to end:

```bash
npm install && npm test
```

## The two rules worth learning first

**Sibling members AND together.** At every level.

```json
{ "department": "sales", "age": { "$gte": 18 } }
```
is `department = 'sales' AND age >= 18`. That holds for operators on one field too — `{"age": {"$gt": 18, "$ne": 30}}` is a single valid constraint.

**A bare scalar means equality.** `{"status": "open"}` is shorthand for `{"status": {"$eq": "open"}}`. The shorthand covers strings, numbers, booleans and `null` only; arrays and objects must use an explicit operator, so `{"tags": ["a"]}` can never be misread as either `$eq` or `$in`.

## Operator reference

Every operator below has a matching fixture in [`tests/fixtures/valid/`](./tests/fixtures/valid) — the table and the test suite are the same list. Full semantics in [SPEC.md §5](./SPEC.md#5-operator-semantics).

### Logical — profile `core`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$and` | `{"$and": [{"a": 1}, {"b": 2}]}` | All must be TRUE |
| `$or` | `{"$or": [{"a": 1}, {"b": 2}]}` | At least one TRUE |
| `$nor` | `{"$nor": [{"a": 1}]}` | None TRUE |
| `$not` | `{"$not": {"a": 1}}` | Negation |

### Comparison — profile `core`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$eq` | `{"name": {"$eq": "Alice"}}` | Equal. Accepts any JSON value, including `null`, arrays and objects |
| `$ne` | `{"name": {"$ne": "Alice"}}` | Not equal |
| `$gt` `$gte` | `{"price": {"$gt": 50}}` | Greater than / or equal |
| `$lt` `$lte` | `{"born": {"$lte": "2023-12-31"}}` | Less than / or equal |
| `$in` | `{"color": {"$in": ["red", "green"]}}` | Value is one of |
| `$nin` | `{"color": {"$nin": ["red"]}}` | Value is none of |
| `$exists` | `{"archivedAt": {"$exists": false}}` | Key present on the record |
| `$isNull` | `{"middleName": {"$isNull": true}}` | Value is `null` |

### Ranges — profile `ranges`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$between` | `{"score": {"$between": [10, 20]}}` | Within `[lo, hi]`, **inclusive** |
| `$nbetween` | `{"score": {"$nbetween": [10, 20]}}` | Outside `[lo, hi]` |

### Strings — profile `strings`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$like` | `{"description": {"$like": "%urgent%"}}` | SQL pattern: `%` any run, `_` one char, `\` escapes |
| `$nlike` | `{"code": {"$nlike": "TMP-%"}}` | Negated `$like` |
| `$ilike` `$nilike` | `{"title": {"$ilike": "%k8s%"}}` | Case-insensitive `$like` |
| `$startsWith` | `{"sku": {"$startsWith": "INV-"}}` | Literal prefix — wildcards not interpreted |
| `$endsWith` | `{"file": {"$endsWith": ".pdf"}}` | Literal suffix |
| `$contains` | `{"body": {"$contains": "100%"}}` | Literal substring. **String-only** — for arrays use `$hasAny` |

### Regular expressions — profile `regex`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$regex` | `{"ref": {"$regex": "^inv-[0-9]{4}$"}}` | ECMA-262, matched unanchored |
| `$flags` | `{"ref": {"$regex": "^inv-", "$flags": "i"}}` | `i`, `m`, `s`. Only valid alongside `$regex` |

### Types — profile `types`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$type` | `{"quantity": {"$type": "integer"}}` | One of `string` `number` `integer` `boolean` `object` `array` `null` |

### Collections — profile `collections`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$hasAny` | `{"tags": {"$hasAny": ["p1", "urgent"]}}` | Array shares an element with the list |
| `$hasAll` | `{"tags": {"$hasAll": ["a", "b"]}}` | Array contains all of them |
| `$hasNone` | `{"tags": {"$hasNone": ["spam"]}}` | Array contains none of them |
| `$size` | `{"tags": {"$size": {"$gte": 1}}}` | Array length — exact, or a comparison |
| `$elemMatch` | `{"items": {"$elemMatch": {"qty": {"$gt": 2}}}}` | One element satisfies all of it |

### Field references — profile `refs`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$field` | `{"price": {"$gt": {"$field": "cost"}}}` | Compare two fields — SQL's `WHERE price > cost` |
| `$literal` | `{"p": {"$eq": {"$literal": {"$field": "x"}}}}` | Force an object operand to be read as data |

### Free text — profile `text`

| Operator | Example | Meaning |
| --- | --- | --- |
| `$search` | `{"title": {"$search": "kubernetes ingress"}}` | Server-defined text match |

## Three things that will bite you

**`$not` does not include nulls.** Evaluation is three-valued, like SQL. `{"$not": {"status": {"$eq": "archived"}}}` excludes records whose `status` is `null`, because `NOT UNKNOWN` is UNKNOWN and only TRUE matches. Write it out:

```json
{ "$or": [ { "status": { "$ne": "archived" } }, { "status": { "$isNull": true } } ] }
```

**Missing is not null.** `{"a": null}` and `{}` are different records. `$exists` tests the key, `$isNull` tests the value. [SPEC.md §4.2](./SPEC.md#42-missing-versus-null) has the full table.

**`$in` does not search inside arrays.** It compares the value as a whole, so `{"tags": {"$in": ["a"]}}` asks whether `tags` *equals* `"a"`. Element membership is `$hasAny`. This differs from MongoDB on purpose — overloading `$in` makes the meaning depend on data a validator cannot see.

## Field paths

A member name is a path into the record:

| Path | Addresses |
| --- | --- |
| `name` | a top-level field |
| `address.city` | a nested field |
| `items[0].sku` | an array element by index |
| `items[*].sku` | every element of an array |
| `a\.b` | a single key whose literal name contains a dot |
| `$$price` | a single key whose literal name is `$price` |

`$` is reserved for operators, which is why a real `$price` field is escaped by doubling. A name starting with a single `$` that is not a known operator is rejected — that is what turns `$eqq` into an error rather than a filter that matches everything.

Note that `items[*]` and `$elemMatch` differ: two wildcard constraints may be satisfied by *different* elements, while `$elemMatch` requires a single element to satisfy all of them. [SPEC.md §5.9](./SPEC.md#59-elemmatch-versus-wildcard-paths).

## Using it from OpenAPI

One of the two integration paths this repo exists for; [Exposing search to an agent](#exposing-search-to-an-agent) covers the other. Complete, CI-linted documents live in [`examples/`](./examples).

### OpenAPI 3.1 — `POST /…/search`

The 3.1 Path Item Object has a **fixed** set of method fields (`get`, `put`, `post`, `delete`, `options`, `head`, `patch`, `trace`). `QUERY` is not among them, so on 3.1 a search with a body is a `POST` to a sub-resource:

```yaml
paths:
  /pets/search:
    post:
      operationId: searchPets
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PetSearchRequest'
      responses:
        '200': { $ref: '#/components/responses/PetPage' }
        '400': { $ref: '#/components/responses/InvalidQuery' }

components:
  schemas:
    Filter:
      $ref: 'https://christosgkoros.com/json/query-language/v0.2.0/query-language-schema.json'
    PetSearchRequest:
      type: object
      required: [filter]
      properties:
        filter: { $ref: '#/components/schemas/Filter' }
```

→ [`examples/openapi-3.1-post-search.yaml`](./examples/openapi-3.1-post-search.yaml)

### OpenAPI 3.2 — the `QUERY` method

3.2 added `additionalOperations`, which is how methods outside the fixed set are described:

```yaml
paths:
  /pets:
    additionalOperations:
      QUERY:
        operationId: queryPets
        requestBody:
          required: true
          content:
            application/json:
              schema: { $ref: '#/components/schemas/PetSearchRequest' }
        responses:
          '200':
            description: Matching pets
            headers:
              Content-Location:
                schema: { type: string, format: uri-reference }
```

→ [`examples/openapi-3.2-query-method.yaml`](./examples/openapi-3.2-query-method.yaml)

`QUERY` ([draft-ietf-httpbis-safe-method-w-body](https://datatracker.ietf.org/doc/draft-ietf-httpbis-safe-method-w-body/)) is **safe and idempotent** and carries a request body — it says "this is a read" in a way `POST` cannot, so intermediaries may cache it and clients may retry it. Return `Content-Location` when the same representation is also reachable by `GET`.

It is still an IETF draft. Ship `POST /search` alongside it and let clients pick.

### Referencing by URL or by copy

Both work, and they trade off differently:

| | Absolute `$id` URL | Bundled copy |
| --- | --- | --- |
| `$ref` | `https://…/v0.2.0/query-language-schema.json` | `./schemas/query-language-schema.json` |
| Upgrades | change one URL | re-vendor the file |
| Tooling | needs a resolver that fetches remote refs | works everywhere |
| MCP `inputSchema` | no — nothing on that path resolves remote refs | yes, and it is the only option |
| Field restriction | not possible | see below |

If you bundle, keep the `$id` intact so consumers can tell which version they are looking at.

The MCP row is not a preference. A server ships `inputSchema` inline in its `tools/list` response, so an absolute-URL `$ref` reaches the model as an opaque string and no grammar — see [Exposing search to an agent](#exposing-search-to-an-agent).

### Restricting the queryable field set

The default grammar accepts any field name, because the set of queryable paths belongs to your resource, not to the language. Servers MUST reject unknown fields at runtime ([SPEC.md §3.5](./SPEC.md#35-which-paths-are-queryable)) — but you can also have it enforced by schema validation.

Bundle the schema and replace **one** definition, `$defs/FieldPath`:

```json
{
  "$id": "https://api.example.com/schemas/pet-filter.json",
  "$ref": "#/$defs/Filter",
  "$defs": {
    "FieldPath": { "type": "string", "enum": ["id", "name", "status", "born"] },
    "…": "everything else copied verbatim from query-language-schema.json"
  }
}
```

The narrowing applies at **every nesting level** — inside `$and`, inside `$not`, inside `$elemMatch`, and to `$field` references — because `Filter` reaches field names through `propertyNames → $ref '#/$defs/FieldPath'`. There is one override point, and this is it. (`tests/validate.test.mjs` exercises exactly this.)

> An earlier design used draft 2020-12 `$dynamicRef`/`$dynamicAnchor` so the override could be applied *without* copying the file. It was dropped: ajv 8.20 does not resolve it correctly even for the canonical recursive case, and OpenAPI tooling support is worse. A plain `$ref` works in every validator.

## Conformance profiles

Not every backend can implement every operator, and silently ignoring a clause you cannot execute widens the result set — the worst possible failure for a filter. So operators are grouped into profiles, published in the schema under `x-profiles`:

`core` · `strings` · `regex` · `ranges` · `types` · `collections` · `refs` · `text`

Implement `core` in full; take the rest whole or not at all. Reject unsupported operators with an `unsupported-operator` problem, and publish what you accept through a capability document. [SPEC.md §2](./SPEC.md#2-conformance).

## Errors

Rejected filters are reported as [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details with a `pointer` locating the offending clause:

```json
{
  "type": "https://christosgkoros.com/json/query-language/problems/unsupported-operator",
  "title": "Unsupported operator",
  "status": 400,
  "detail": "$regex is not in this endpoint's advertised profiles (core, strings).",
  "pointer": "/filter/$and/1/name/$regex"
}
```

Types: `malformed-query` · `unknown-field` · `unsupported-operator` · `invalid-operand` · `query-too-complex`. [SPEC.md §8](./SPEC.md#8-errors).

## Exposing search to an agent

An LLM agent calling your search endpoint — directly, or through an MCP server wrapping it — sees only the tool definition you hand it. It does not fetch this schema and it does not read [SPEC.md](./SPEC.md). Whatever a correct filter requires has to be present in that definition or in your capability document.

The language does the syntactic work for you. A malformed filter, an unknown field and an unsupported operator all come back as a `400` with a `pointer` at the offending clause ([SPEC.md §8](./SPEC.md#8-errors)) — enough for an agent to repair its own request in one round trip. What the language cannot catch is a filter that is *valid and wrong*. Those fail as an empty result set, which an agent cannot distinguish from "no such records", so it reports a confident false negative. Three cases account for most of them:

| Mistake | Why the agent makes it |
| --- | --- |
| `{"status": "Available"}` | Nothing told it the accepted values. |
| `{"status": {"$ne": "archived"}}`, meaning "not archived" | Three-valued logic drops the `null`s — [SPEC.md §4.1](./SPEC.md#41-three-valued-logic). |
| `{"tags": {"$in": ["urgent"]}}`, meaning array membership | `$in` compares the whole value. The element operator is `$hasAny`. |

Five things close them:

1. **Bundle the schema into the tool definition.** An MCP server ships `inputSchema` inline in its `tools/list` response, and nothing on that path resolves a remote `$ref` — an absolute-URL reference reaches the model as an opaque string and no grammar. Vendor the file; see [Referencing by URL or by copy](#referencing-by-url-or-by-copy).
2. **Narrow `$defs/FieldPath` to the fields you expose.** Otherwise the tool definition says nothing about what is queryable and the agent learns your field names one `unknown-field` at a time. Prefer `anyOf` of `const` + `description` over a bare `enum` if you want per-field prose to survive — an `enum` has nowhere to document its members.
3. **Publish the value domains.** The grammar cannot express them: every path shares one `Constraint`, so per-field operand types are not representable. Put `type`, `format` and `values` in your capability document ([SPEC.md §2.2](./SPEC.md#22-capability-discovery)) and restate any closed domain in the tool description.
4. **Trim the operators to your profiles.** If you implement `core` and `strings`, delete the rest from the bundled copy so `$regex` is unavailable rather than rejected at runtime. `x-profiles` maps each profile to its operators; dropping `regex` means dropping `$flags` and its `dependentRequired` entry with it.
5. **State the two silent rules explicitly** in the tool description: `$ne` and `$not` exclude nulls, and `$in` is not array membership. An agent that has not been told will not infer either.

One MCP-specific note: define one tool per resource (`search_pets`, `search_orders`) rather than a single `search(resource, filter)`. `tools/list` is static, so a generic tool cannot vary its field list by argument — and that field list is most of what makes the tool usable.

## Safety

A filter is user input that becomes a query plan. [SPEC.md §7](./SPEC.md#7-safety-limits) sets recommended bounds on nesting depth, clause count, set length and body size, and requires rejection rather than truncation when they are exceeded.

`$regex` is the largest exposure. Use a linear-time engine (RE2, Rust `regex`, Go `regexp`); if you only have a backtracking one, leave `regex` out of your advertised profiles and point clients at `$like`.

## Migrating from v0.1.0

v0.2.0 restructures the file. The old one had no assertion keywords at its root, so it accepted every instance — anything validating against it was passing vacuously.

| v0.1.0 | v0.2.0 |
| --- | --- |
| `"id": "…/v0.1.0"` | `"$id": "…/v0.2.0/query-language-schema.json"` |
| `#/components/schemas/Query` | `#/$defs/Filter`, or just `$ref` the file |
| `#/components/schemas/Condition` | folded into `#/$defs/Filter` |
| `#/components/schemas/equalCondition` &c. | folded into `#/$defs/ConstraintObject` |
| `$isnull` | `$isNull` |
| one operator family per field | any operators may be combined on a field |

Filters themselves are unaffected apart from `$isnull` → `$isNull`; the v0.1.0 examples are kept as fixtures to prove it. Full detail in [`CHANGELOG.md`](./CHANGELOG.md).

## Repository layout

```
query-language-schema.json     the schema — the only file you need to consume
SPEC.md                        normative semantics
RELEASING.md                   how a release reaches both registries
examples/                      working OpenAPI 3.1 and 3.2 documents
tests/validate.test.mjs        meta-validation + fixture runner
tests/fixtures/valid/          one per operator; also the docs' example set
tests/fixtures/invalid/        every defect this version fixes, pinned
.github/workflows/ci.yml       tests on Node 20/22/24 + OpenAPI lint
.github/workflows/release.yml  publishes on GitHub Release
```

`npm test` meta-validates the schema under ajv's strict mode, checks that `x-profiles` covers exactly the operators the grammar defines, validates every inline example against its own subschema, and runs all fixtures — invalid ones asserting *which* keyword rejected them, so a fixture cannot pass for the wrong reason.

## Status

Pre-1.0. The grammar may still change; each break is recorded in the changelog with a migration note. Pin the versioned `$id`.

## License

[MIT](./LICENSE)
