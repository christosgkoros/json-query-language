# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the pre-1.0 caveat that a
minor release may break compatibility, in which case the break is spelled out below.

## [Unreleased]

No change to the grammar or to the semantics of evaluation. The only edit to
`query-language-schema.json` is its root `description`, and its `$id` still names `v0.4.0`.

### Added

- **`examples/mcp-server/`** — a runnable MCP server whose one tool, `search_pets`, takes a
  filter as its `filter` argument and nothing else. The tool's `inputSchema` is
  `examples/pet.filter.json` inlined verbatim; validation is ajv against that same file, and
  execution is the SQL compiler from `experiments/filter-to-sql` over an in-memory SQLite table,
  so the queries are real. `node examples/mcp-server/demo.mjs` drives it over stdio and prints a
  transcript: two filters that answer, one that shows the `$unknownAs` difference (4 matches
  against 7), and the three valid-but-wrong filters from README §*Exposing search to an agent*
  being rejected with a pointer at the clause. `npm run example:mcp` and
  `npm run example:mcp:demo` are the entry points.
- The example is also the first place the `$id`-when-inlining hazard is written down: nested
  under `properties.filter`, a bundled schema's self-references resolve against its own `$id`, so
  removing the `$id` breaks it — ajv fails to compile it at all.

### Changed

- **Positioned as one JSON-Schema-described query language with two integration points**, rather
  than as an agent interface. An earlier revision in this same unreleased window led with the MCP
  tool definition and moved §*Exposing search to an agent* ahead of the OpenAPI and generator
  sections; that ordering is reverted and the "search interface for agents" framing is gone from
  the README, the `package.json` description and the repository description. The agent use case
  keeps its section and its runnable server — it is one of the two things the schema is for, not
  the thing the document opens with.
- **The schema's root `description`** likewise leads with the shared-grammar framing again, and
  mentions inlining as a tool's input schema second. Non-normative prose; no validator behaviour
  changes.
- **The error format is no longer mandated.** [SPEC.md §8](./SPEC.md#8-errors) required
  [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details with media type
  `application/problem+json`. It now requires only that a rejected filter be answered with
  `400 Bad Request` and that the response say **which** of the five conditions applies —
  `malformed-query`, `unknown-field`, `unsupported-operator`, `invalid-operand`,
  `query-too-complex` — because that is what a client branches on. The envelope is the API's own:
  an API with an established error format should express these conditions in it rather than carry
  a second format for one endpoint. RFC 9457 remains the RECOMMENDED default where there is none,
  and the `type` URIs, the `pointer` member and the recovery members (`queryableFields`,
  `accepted`) are unchanged as its encoding. This relaxes a requirement, so nothing that
  conformed before stops conforming.
- The prose in [README §Errors](./README.md#errors), [COMPARISON.md §4](./COMPARISON.md), the
  OpenAPI examples and `experiments/filter-to-sql` follows: they now describe Problem Details as
  the recommended shape rather than the required one, and name the failing *condition* where they
  previously said "problem". The examples still model RFC 9457, since it is still the default a
  greenfield API should pick.

## [0.4.0] — 2026-09-07

**Breaking.** The `$id` is now `…/v0.4.0/query-language-schema.json`. This release resolves the
three operator overlaps that an external review and this repository's own
`experiments/filter-to-sql` flagged independently; the design and the evidence are in
[`decisions/0001-array-quantifiers-and-unknown-handling.md`](./decisions/0001-array-quantifiers-and-unknown-handling.md).

The headline is that the language had **two** unrelated mechanisms for looking inside an array —
`$elemMatch` and the `[*]` path segment — and one mechanism now does both jobs while naming its
quantifier. Operator count is unchanged at 34.

### Added

- **`$some` and `$every`** (profile `collections`), the element quantifiers. Each takes a `Filter`
  when the elements are objects — paths inside resolve against the element — or a constraint
  object when they are scalars. `$some` is `$elemMatch` renamed; `$every` is new, because
  universal quantification over elements was **not previously expressible**: `$not` over `$some`
  is "no element matches", which is a different predicate.
- **`$unknownAs`** (profile `core`), a boolean modifier on a constraint object that resolves that
  constraint's UNKNOWN. `{"status": {"$ne": "archived", "$unknownAs": true}}` is the one-clause
  form of the `$or`/`$isNull` longhand this specification prescribed before. It applies last —
  after every sibling operator, including a field-level `$not` — and [SPEC.md
  §4.6](./SPEC.md#46-resolving-unknown--unknownas) gives the scope rules and the nine-case proof
  that resolution distributes over three-valued AND. It requires at least one operator beside it.
- **A truth-table column for `$nor`** in §4.1, and a note that all three connectives are
  commutative so the six rows cover all nine combinations. `$nor`'s three-valued result previously
  had to be derived, and the derivation was the trap.
- **`$every` on generated schemas**, and `$unknownAs` on exactly the fields where UNKNOWN is
  reachable — the same rule the generator already applied to `$exists` and `$isNull`. On a
  property that is required all the way up and cannot hold null, the modifier would be a constant,
  so it is omitted and the trap disappears from the tool definition entirely.

### Removed — breaking

- **`$elemMatch`.** Renamed to `$some`. Mechanical: `{"items": {"$elemMatch": {…}}}` →
  `{"items": {"$some": {…}}}`.
- **`$hasAny` and `$hasNone`.** Both were compositions of a quantifier and `$in`, and their
  presence beside whole-value `$in` was the whole `$in`-versus-membership confusion.
  `{"tags": {"$hasAny": ["a"]}}` → `{"tags": {"$some": {"$in": ["a"]}}}`;
  `{"tags": {"$hasNone": ["a"]}}` → `{"tags": {"$not": {"$some": {"$in": ["a"]}}}}`.
- **The `[*]` wildcard path segment**, from the §3.2 grammar. It expressed nothing the equivalent
  `$some` clauses do not: per-constraint existential scope is exactly what an `$and` of *separate*
  `$some` clauses means. `{"items[*].qty": {"$gt": 2}}` →
  `{"items": {"$some": {"qty": {"$gt": 2}}}}`. Three further reasons it went: living in the path
  grammar made it the only construct present in **every** profile including `core`, so no server
  could decline it; it contradicted §4.2 by revoking `$exists`'s totality; and it cost 1.74× the
  SQL of the equivalent `$elemMatch` plus a table-valued join per clause. The schema now rejects a
  `[*]` path outright, including in `$field` position, so a stale filter is a validation error
  rather than a path read as a literal key name.
- **`$defs/ScalarSet`.** `$in` and `$nin` now take `$defs/OperandSet`, the same set definition the
  collection operators use. The two definitions had silently diverged — `$hasAny` accepted `$field`
  references and object members while `$in` accepted only scalars — with nothing in the
  specification acknowledging it. The unification is toward the permissive side, so no filter that
  was valid becomes invalid.

### Changed — breaking

- **A type-mismatched equality is FALSE, not UNKNOWN.** §4.3 said comparing different JSON types
  yields UNKNOWN; §5.1 defined `$eq` as structural equality, under which a string and a number are
  simply unequal. The two readings are indistinguishable under `$eq` and differ under `$ne`, and
  the specification asserted both. It is now settled as **FALSE for the equality family**
  (`$eq`, `$ne`, `$in`, `$nin`, `$hasAll`) and UNKNOWN for ordering, string and array operators,
  with a table in §4.3. **This changes result sets without changing any filter's shape**, so a
  mechanical rewrite will not surface it: `{"notes": {"$ne": 3}}` now matches a record whose
  `notes` is `"hello"`.
- **An empty array under a former wildcard clause.** `[*]` on `[]` was UNKNOWN, because the path
  resolved to nothing; `$some` on `[]` is FALSE, because an empty array is a resolved value and
  nothing in it satisfies the condition. `$every` on `[]` is TRUE, vacuously. Observable under
  negation only, and it is the one migration step a codemod cannot claim to preserve.
- **§3.4 resolution is single-valued.** With no wildcard segment, a path yields zero values or
  exactly one. The sequence model is gone.
- **Six operator descriptions that contradicted §4.1.** These strings are vendored verbatim into
  generated schemas and MCP tool definitions, so they were a first-order cause of the confusion
  rather than a cosmetic issue. `$nor`'s was outright wrong — "None of the listed filters may
  evaluate TRUE" is the two-valued reading — and `$ne`'s said only "Field does not equal the
  operand". `$nin`, `$nbetween`, `$nlike` and `$nilike` all read as total predicates. Every
  negative operator now states what it does with UNKNOWN.
- **§1 no longer calls the filter "a boolean function"** while §4.1 makes it three-valued.
- **`$exists` is documented as unconditionally total.** It always was, except under a wildcard
  path; with those gone the exception is gone.
- **§3.5 settles whether an index suffix is a separate path.** It is not: `items[0]` is the field
  `items` for queryability, while a named member beneath it (`items[0].sku`) is its own path.
- **§7 addresses quantifier cost.** `$some` and `$every` are the expensive operators on most
  backends, and a server that cannot afford them can decline the `collections` profile — which is
  precisely what the `[*]` segment made impossible.

### Fixed

- **`$some`/`$every`'s operand shape is no longer ambiguous.** `anyOf: [Filter, ConstraintObject]`
  overlaps on a leading `$not`, and nothing said which was meant. §5.8 now gives a decidable rule:
  scan for the first member that can only be one of the two, recursing through `$not`/`$and`/`$or`/
  `$nor` bodies when the outer member is itself ambiguous.
- **`$field` inside a quantifier resolves against the element**, stated in §5.8 and §5.11. §5.11
  said "the same record" while §5.8 said paths were element-relative; both readings were
  defensible.

## [0.3.1] — 2026-09-04

No change to the schema, the grammar or the semantics. `query-language-schema.json` is
byte-identical to 0.3.0 and its `$id` still names `v0.3.0`, because the `$id` version tracks the
grammar and the grammar did not move. Consumers pinning that `$id` have nothing to do.

### Removed

- **Publishing.** The release workflow no longer ships to npmjs.com or GitHub Packages. Neither
  registry ever received a copy, and while the name is a working title neither should: publishing
  under a placeholder claims the name, and npm blocks a name from reuse permanently once it has
  been published and unpublished. `.github/workflows/release.yml` now only verifies a release —
  the test suite, and the tag-against-`package.json` check — and uploads nothing. The
  `NPM_TOKEN` secret and `.github/scripts/version-published.sh` are deleted with it.
  [RELEASING.md](./RELEASING.md#turning-publishing-back-on) keeps what the jobs needed, so they
  can be restored from git history rather than rewritten.

### Changed

- **README no longer offers an install that does not exist.** The Quickstart opened with
  `npm install --save-dev json-query-language`, which the README's own *Status* table already
  contradicted two screens further down. It now vendors the file by `curl`, which is the only
  way to obtain the schema and always was.
- **[RELEASING.md](./RELEASING.md) documents the process that exists** — a tag and a GitHub
  Release, carrying notes and a source snapshot and nothing else.

## [0.3.0] — 2026-09-04

Guidance for adopters exposing a search endpoint to an LLM agent, the tooling that acts on it,
and an honest statement of how finished this is. No grammar change: every filter valid under
v0.2.0 remains valid, and the only edits to `query-language-schema.json` are two `description`
annotations and its version strings.

### Added

- **Per-field domains in the capability document.** [SPEC.md §2.2](./SPEC.md#22-capability-discovery)'s
  RECOMMENDED shape now carries `type`, `format`, `values` and `description` alongside
  `operators`, with a table defining each. The grammar cannot express per-field operand
  domains — every path shares one `Constraint` — so a filter naming a real field with an
  out-of-domain value is well-formed and matches nothing. The capability document is the only
  place that domain can be stated.
- **Recovery members on problem details.** [SPEC.md §8](./SPEC.md#8-errors) now RECOMMENDS that
  `unknown-field` carry `queryableFields` and that `invalid-operand` carry `accepted`, so a
  client that never fetched the capability document can still converge in one round trip
  instead of guessing field names one at a time.
- **README §*Exposing search to an agent*** — what reaches a tool definition, the three
  valid-but-wrong filters that fail as an empty result set, and the five steps that prevent
  them (bundle rather than remote-`$ref`, narrow `FieldPath`, publish value domains, trim to
  advertised profiles, state the null and `$in` semantics in the tool description).

- **`tools/generate-filter-schema.mjs`** — derives a per-resource filter schema from the
  resource's own JSON Schema. The published grammar shares one `Constraint` across every field,
  so it can say `{"status": "Available"}` is well-formed but not that `"Available"` is outside
  `status`'s domain; that is why [SPEC.md §2.2](./SPEC.md#22-capability-discovery) exists. A
  generated schema gives each queryable path its own constraint subschema, carrying only the
  operators that apply to its type and only the operands its domain admits — so the three
  valid-but-wrong filters catalogued in README §*Exposing search to an agent* become validation
  failures instead of empty result sets. The generator emits the §2.2 capability document from
  the same source, and copies operator prose out of the published grammar rather than restating
  it. Generation is narrowing only: every filter a generated schema accepts is valid against the
  published grammar, which `tests/generator.test.mjs` asserts.
- **`COMPARISON.md`** — how this specification relates to GraphQL, and what a JSON-Schema-native
  alternative to GraphQL would still need. The short version: GraphQL never standardised
  filtering, so the two overlap far less than the question assumes. Also covers OData, JSON:API,
  OGC CQL2 and JSON Hyper-Schema as prior art.
- **`examples/pet.schema.json`** with its generated `pet.filter.json` and `pet.capabilities.json`
  committed beside it, and `npm run generate:example` to refresh them. A test fails if they drift.
- **README §*Generating a per-resource filter schema*** — what the generator decides and why, and
  the `x-jql` property annotations that override it.

### Changed

- **README framing.** The schema is presented as feeding two integration paths rather than
  one: `$ref`'d from an OpenAPI document, or bundled into an MCP tool's `inputSchema`. The
  *Referencing by URL or by copy* table gains an `MCP inputSchema` row recording that the
  absolute-URL form does not work there at all, since nothing on that path resolves remote
  refs.
- `$in` and `$nin` descriptions now state that they compare the whole value and do not test
  array membership, naming `$hasAny`/`$hasNone` as the element operators. `$contains` already
  warned about the same crossover; these two did not, and they are the operators a client
  carrying MongoDB habits reaches for first.
- **`$id` is now `…/v0.3.0/query-language-schema.json`.** Consumers pin by `$id`, so the version
  in the path moves with the release. `SPEC.md`, the OpenAPI examples and the generated
  capability document were all still naming v0.2.0; they now agree.
- **README §*Status* states that this is a work in progress, name included.** *JSON Query
  Language* is a working title, and every identifier downstream of it — both package names, the
  `$id`, the URLs in the integration examples — is a placeholder, several of which do not
  resolve. Getting them right is deliberately deferred until the name is settled, because a
  rename moves all of them at once. A notice at the top of the README says the same thing before
  a reader reaches an install command that will not work.
- **`QUERY` now cites [RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)** rather than
  `draft-ietf-httpbis-safe-method-w-body`. The method reached Proposed Standard in June 2026.
  The advice to ship `POST /search` alongside it is unchanged, but the reason is now that
  deployed support trails a fresh RFC, not that the specification is unsettled.

## [0.2.0] — 2026-08-06

A structural rewrite. The v0.1.0 file described a grammar but did not enforce one; this
release makes it a working schema, fixes the grammar's dead ends, and completes the operator
set. Filters written against v0.1.0 still parse apart from the `$isnull` rename.

### Fixed

- **The schema validated nothing.** The root used `"id"` (a draft-04 spelling) rather than
  `"$id"`, and wrapped its definitions in `components.schemas`, which is an OpenAPI container
  and not a JSON Schema keyword. Under draft 2020-12 both were unknown keywords, and the root
  carried no assertion keywords at all — so a validator pointed at the file accepted every
  instance. The root now `$ref`s `#/$defs/Filter`.
- **`"regex"` is not a JSON Schema keyword** (it is `"pattern"`), and the value it carried —
  `"['\"%?.+%?['\"]"` — was a malformed character class that also expected quote characters
  inside the operand. `$like` and `$nlike` are now plain strings; the wildcard and escape
  grammar is specified in prose ([SPEC.md §5.5](./SPEC.md#55-pattern-matching--like-nlike-ilike-nilike))
  where it belongs.
- **`examples` was an object** throughout, in the OpenAPI Example-Object style, where JSON
  Schema requires an array of instance values; two schemas used the OpenAPI 3.0 singular
  `example`. Both spellings are now correct, and a test walks the whole document to keep them
  that way.
- **Operators from different families could not be combined on one field.** The eight-way
  `oneOf` over leaf condition types meant `{"age": {"$gt": 18, "$ne": 30}}` matched no branch
  and was rejected. Sibling operators now AND together.
- **Ambiguous and empty forms were accepted or accidentally rejected.** `{}` matched all eight
  leaf branches at once; `{"$and": […], "$or": […]}` was accepted with no defined semantics;
  `$and: []` and `$in: []` were accepted. Empty forms are now rejected, and implicit AND across
  siblings is specified.
- **`$in`/`$nin` excluded booleans and `null`** while `$eq` allowed them.

### Changed — breaking

| v0.1.0 | v0.2.0 | Note |
| --- | --- | --- |
| `"id": "…/v0.1.0"` | `"$id": "…/v0.2.0/query-language-schema.json"` | Correct keyword, versioned path |
| `#/components/schemas/Query` | `#/$defs/Filter` | Or `$ref` the file itself |
| `#/components/schemas/Condition` | *(removed)* | Folded into `#/$defs/Filter` |
| `#/components/schemas/equalCondition`, `notEqualCondition`, `inArrayCondition`, `notInArrayCondition`, `likeCondition`, `notLikeCondition`, `rangeCondition`, `isNullCondition` | *(removed)* | Folded into `#/$defs/ConstraintObject` |
| `$isnull` | `$isNull` | Renamed for consistency with `$startsWith` &c. |

Any OpenAPI document referencing a `#/components/schemas/…` pointer must be repointed. Filter
*documents* need no change other than `$isnull` → `$isNull`; the v0.1.0 examples are kept as
test fixtures to prove it.

### Added

- **Operators.** `$nor`; `$nbetween`; `$ilike`, `$nilike`, `$startsWith`, `$endsWith`,
  `$contains`; `$regex` with `$flags`; `$exists`; `$type`; `$hasAny`, `$hasAll`, `$hasNone`,
  `$size`, `$elemMatch`; `$search`; a field-level `$not`.
- **Field-to-field comparison** via `{"$field": "path"}` in operand position — SQL's
  `WHERE price > cost` — with `{"$literal": …}` as the escape for object operands that would
  otherwise read as references.
- **Scalar shorthand.** `{"status": "open"}` for `{"status": {"$eq": "open"}}`. Restricted to
  strings, numbers, booleans and `null`, so `{"tags": ["a"]}` can never be read ambiguously.
- **`null`, arrays and objects as `$eq`/`$ne` operands.**
- **A field path grammar** — dotted paths, array indices, `[*]` wildcards, `\.` dot escaping —
  and a rule for field names beginning with `$`: they are escaped by doubling (`$$price`).
  A single `$` prefix that is not a known operator is now rejected, so `$eqq` is an error
  rather than a field name.
- **Conformance profiles**, published in the schema as `x-profiles` and specified in
  [SPEC.md §2.1](./SPEC.md#21-profiles), so a server can advertise the subset it implements.
- **One override point for the queryable field set**, `#/$defs/FieldPath`, reached through
  `propertyNames` so that narrowing it in a bundled copy applies at every nesting level.
- **[SPEC.md](./SPEC.md)** — three-valued logic, missing-versus-null, coercion rules, per-operator
  semantics, safety limits, and an RFC 9457 problem-type registry.
- **[README.md](./README.md)** — operator reference and OpenAPI 3.1 / 3.2 integration guidance.
- **Tests and CI** — ajv under `strict: true`, 30 valid and 22 invalid fixtures, and Redocly
  linting of both OpenAPI examples.

### Notes

`$dynamicRef`/`$dynamicAnchor` was evaluated as a way to let consumers restrict the queryable
field set without copying the file, and rejected: ajv 8.20 does not resolve it correctly even
for the canonical recursive case, and OpenAPI tooling support is worse. The `$ref`-based
override described in the README works in every validator.

## [0.1.0] — 2025-02-05

Initial research draft: `$and`, `$or`, `$not` over eight leaf condition types
(`$eq`, `$ne`, `$in`, `$nin`, `$like`, `$nlike`, `$gt`/`$gte`/`$lt`/`$lte`/`$between`, `$isnull`),
laid out as an OpenAPI `components.schemas` fragment.

[0.4.0]: https://github.com/christosgkoros/json-query-language/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/christosgkoros/json-query-language/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/christosgkoros/json-query-language/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/christosgkoros/json-query-language/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/christosgkoros/json-query-language/releases/tag/v0.1.0
