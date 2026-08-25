# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the pre-1.0 caveat that a
minor release may break compatibility, in which case the break is spelled out below.

## [0.3.0] — 2026-08-25

Guidance for adopters exposing a search endpoint to an LLM agent. No grammar change: filters
valid under v0.2.0 remain valid, and the only schema edit is to two `description` annotations.

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

[0.3.0]: https://github.com/christosgkoros/json-query-language/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/christosgkoros/json-query-language/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/christosgkoros/json-query-language/releases/tag/v0.1.0
