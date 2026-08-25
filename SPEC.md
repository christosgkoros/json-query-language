# JSON Query Language — Specification

**Version 0.2.0** · Dialect: JSON Schema draft 2020-12 · Schema: [`query-language-schema.json`](./query-language-schema.json)

This document defines the semantics of the language. The schema defines only its *shape* — a validator can tell you that `{"age": {"$gt": 18}}` is well-formed, but not what it means when `age` is `null`, absent, or a string. Everything a server and a client must agree on beyond well-formedness is specified here.

For a guided introduction, see [README.md](./README.md).

---

## 1. Scope

The language expresses a **predicate over a record**: a boolean function that, given one record, answers whether it matches. It is deliberately *not* a full query language. It has no projection, ordering, pagination, grouping or joins — those belong to the enclosing request body, where each API is free to define them. Confining this schema to the predicate is what makes it reusable across endpoints whose result shapes have nothing else in common.

A conforming request body embeds a filter as a member, conventionally named `filter`:

```json
{ "filter": { "status": "open" }, "limit": 50 }
```

The schema validates the value of `filter`, not the envelope.

## 2. Conformance

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

### 2.1 Profiles

Operators are grouped into profiles so that a server can implement a subset honestly rather than silently mistranslating. The grouping is published in the schema itself, under the `x-profiles` extension keyword.

| Profile | Operators |
| --- | --- |
| `core` | `$and` `$or` `$nor` `$not` `$eq` `$ne` `$in` `$nin` `$gt` `$gte` `$lt` `$lte` `$exists` `$isNull` |
| `strings` | `$like` `$nlike` `$ilike` `$nilike` `$startsWith` `$endsWith` `$contains` |
| `regex` | `$regex` `$flags` |
| `ranges` | `$between` `$nbetween` |
| `types` | `$type` |
| `collections` | `$hasAny` `$hasAll` `$hasNone` `$size` `$elemMatch` |
| `refs` | `$field` `$literal` |
| `text` | `$search` |

A conforming implementation MUST implement `core` in full. Every other profile is OPTIONAL, and MUST be implemented in full or not at all — partial profiles defeat the purpose of advertising them.

An implementation MUST reject an operator it does not support with an `unsupported-operator` problem (§8). It MUST NOT silently ignore the clause: dropping a predicate from a filter widens the result set, which is the most dangerous possible failure mode for an authorization-adjacent filter.

### 2.2 Capability discovery

An implementation SHOULD publish which profiles and fields it accepts. This specification does not mandate a location; a `capabilities` member on the collection resource, or a separate endpoint linked by a `describedby` relation, both work. The RECOMMENDED shape:

```json
{
  "queryLanguage": "https://christosgkoros.com/json/query-language/v0.2.0/query-language-schema.json",
  "profiles": ["core", "strings", "ranges"],
  "fields": {
    "status": {
      "operators": ["$eq", "$ne", "$in"],
      "type": "string",
      "values": ["available", "pending", "sold"],
      "description": "Listing state."
    },
    "createdAt": {
      "operators": ["$gt", "$gte", "$lt", "$lte", "$between"],
      "type": "string",
      "format": "date-time"
    },
    "title": {
      "operators": ["$eq", "$like", "$ilike"],
      "type": "string"
    }
  },
  "limits": { "maxDepth": 10, "maxClauses": 100, "maxSetLength": 1000 }
}
```

Each member of `fields` describes one queryable path:

| Member | Required | Meaning |
| --- | --- | --- |
| `operators` | yes | The operators accepted on this path. A subset of those implied by `profiles`. |
| `type` | SHOULD | The JSON type of the field's value, drawn from the `$type` vocabulary of §5.10. |
| `format` | — | A format name constraining a `type: "string"` value: `date`, `date-time`, `uuid`, and so on. |
| `values` | SHOULD, where the domain is closed | The complete set of accepted values. |
| `description` | — | Prose stating what the field holds. |

`operators` tells a client what it may write; `type`, `format` and `values` tell it *what to write*. The grammar cannot carry that second half: field names are constrained through `propertyNames`, but every path shares one `Constraint` definition, so per-field operand domains are not expressible in the schema (§6). A filter naming a real field with a value outside that field's domain is therefore well-formed, and matches nothing — the failure surfaces as an empty result set rather than an error (§8). The capability document is the only place the domain can be stated, which is why `values` is RECOMMENDED wherever the domain is closed.

## 3. Data model and field paths

### 3.1 Records

A **record** is any JSON value, in practice an object. Field paths address positions within it. The language makes no assumption that records share a shape.

### 3.2 Path grammar

```abnf
field-path     = head-key *( "." key )
head-key       = ( head-char / "$$" ) *key-char *index
key            = 1*key-char *index
head-char      = key-char        ; excluding "$"
key-char       = unescaped / escape-seq
unescaped      = %x20-2D / %x2F-5A / %x5E-10FFFF
                                 ; any character except "." "[" "\" "]"
escape-seq     = "\" ( "." / "[" / "]" / "\" )
index          = "[" ( 1*DIGIT / "*" ) "]"
```

- `address.city` — a member of a nested object.
- `items[0].sku` — the first element of an array.
- `items[*].sku` — every element of an array (see §5.9).
- `a\.b` — a single key whose literal name contains a dot.
- `$$price` — a single key whose literal name is `$price`.

### 3.3 The `$` prefix is reserved

Within a `Filter` object, a member name beginning with `$` is an operator. A record field whose real name begins with `$` MUST be escaped by doubling the prefix: `$$price` addresses the field `$price`. A name beginning with a single `$` that is not a defined operator MUST be rejected as `malformed-query` (§8) rather than treated as a field. This is what turns a typo like `$eqq` into an error instead of a filter that matches everything.

### 3.4 Resolution

Resolving a path against a record yields a **sequence** of zero or more values:

- A path with no wildcard yields zero values (the path does not exist) or exactly one.
- A path containing `[*]` yields one value per matching element, in document order.
- Traversing *into* a non-object or non-array yields zero values.

The distinction between "yields zero values" and "yields one value that is `null`" is load-bearing; see §4.2.

### 3.5 Which paths are queryable

The schema's default path rule is permissive by design: the set of queryable fields is a property of the resource, not of the language. An implementation MUST reject a path it does not expose with an `unknown-field` problem (§8), and SHOULD publish the accepted set through §2.2. Endpoints that want the field set enforced by schema validation can narrow `$defs/FieldPath` in a bundled copy — see README §*Restricting the queryable field set*.

## 4. Evaluation

### 4.1 Three-valued logic

Every clause evaluates to **TRUE**, **FALSE** or **UNKNOWN**. UNKNOWN arises when a comparison is not meaningful — the path resolved to nothing, or to `null`, or to a value of a type the operator cannot order.

| `a` | `b` | `a AND b` | `a OR b` |
| --- | --- | --- | --- |
| T | T | T | T |
| T | F | F | T |
| T | U | U | T |
| F | F | F | F |
| F | U | F | U |
| U | U | U | U |

| `a` | `NOT a` |
| --- | --- |
| T | F |
| F | T |
| U | **U** |

`$nor [a, b, …]` is `NOT (a OR b OR …)`.

**A record is included in the result if and only if the filter evaluates to TRUE.** UNKNOWN excludes, exactly as SQL's `WHERE` does.

The consequence that surprises people: `{"$not": {"status": {"$eq": "archived"}}}` does **not** match records whose `status` is `null` or absent, because `$eq` returned UNKNOWN and `NOT UNKNOWN` is UNKNOWN. To include them, say so:

```json
{ "$or": [ { "status": { "$ne": "archived" } }, { "status": { "$isNull": true } } ] }
```

### 4.2 Missing versus null

These are different states and the language keeps them apart:

| Record | `{"$exists": true}` | `{"$exists": false}` | `{"$isNull": true}` | `{"$eq": "x"}` |
| --- | --- | --- | --- | --- |
| `{"a": "x"}` | TRUE | FALSE | FALSE | TRUE |
| `{"a": null}` | TRUE | FALSE | TRUE | UNKNOWN |
| `{}` | FALSE | TRUE | UNKNOWN | UNKNOWN |

`$exists` and `$isNull` are the only operators that are never UNKNOWN for the reason of absence — `$exists` is total, and `$isNull` is UNKNOWN only when the path resolves to nothing.

Implementations backed by a store that cannot distinguish the two (many document stores, most SQL columns) MUST document which state they report and SHOULD reject `$exists` rather than approximate it.

### 4.3 Types and coercion

There is **no implicit coercion**. Comparing values of different JSON types yields UNKNOWN, never an error and never a coerced comparison. `{"age": {"$gt": "18"}}` against `{"age": 21}` is UNKNOWN, not TRUE.

This is a deliberate departure from SQL, where `'18' > 17` may or may not succeed depending on the engine. Servers that need coercion (a date column queried with a string, for instance) SHOULD perform it at the *boundary* — mapping the operand into the field's declared type once, before evaluation — and MUST reject an operand that cannot be mapped with an `invalid-operand` problem (§8) rather than evaluating it as UNKNOWN.

### 4.4 Implicit AND

Sibling members of a `Filter` object are combined with AND:

```json
{ "department": "sales", "age": { "$gte": 18 } }
```

is identical to

```json
{ "$and": [ { "department": "sales" }, { "age": { "$gte": 18 } } ] }
```

The same rule applies to sibling operators within one constraint object: `{"age": {"$gt": 18, "$ne": 30}}` is `age > 18 AND age <> 30`. Logical operators and field constraints MAY be siblings; all of them AND together.

Because JSON object members are unordered and duplicate names are not interoperable, a field can appear at most once per object. Two constraints on the same field that cannot be merged into one object go in an explicit `$and`.

### 4.5 Evaluation order

Evaluation order is unobservable: operators are side-effect free and no operator's well-formedness depends on another's result. Implementations are free to reorder, short-circuit and push down clauses however their storage engine prefers.

## 5. Operator semantics

Throughout, *the value* means the value the field path resolved to (§3.4). Unless stated otherwise, an operator applied to a path that resolved to nothing yields UNKNOWN.

### 5.1 Equality — `$eq`, `$ne`

Structural equality over JSON values. Objects compare irrespective of member order; arrays compare element-wise and are order-**sensitive**. Numbers compare by mathematical value, so `1`, `1.0` and `1e0` are equal.

`$eq: null` is TRUE when the value is `null` — it is the one comparison for which `null` is an operand rather than a cause of UNKNOWN. `$ne` is the negation of `$eq` under three-valued logic, so `{"a": {"$ne": 1}}` is UNKNOWN when `a` is absent.

The scalar shorthand `{"status": "open"}` is exactly `{"status": {"$eq": "open"}}`. It is available for strings, numbers, booleans and `null`. Arrays and objects are excluded so that `{"tags": ["a", "b"]}` cannot be read as either `$eq` or `$in`; write the operator you mean.

### 5.2 Ordering — `$gt`, `$gte`, `$lt`, `$lte`

Defined for two numbers or two strings. Numbers compare numerically. Strings compare by Unicode code point, which for RFC 3339 `date`, `date-time` and `time` strings coincides with chronological order — provided the operands use the same offset. Comparing a `Z`-suffixed timestamp against a `+02:00` one lexicographically gives the wrong answer; servers that store timestamps as strings SHOULD normalise to UTC before comparing, and servers that store them as instants SHOULD parse the operand.

Any other operand type, or a type mismatch between operand and value, yields UNKNOWN.

### 5.3 Ranges — `$between`, `$nbetween`

`{"$between": [lo, hi]}` is `value >= lo AND value <= hi` — **inclusive at both ends**. `$nbetween` is its negation under three-valued logic.

Both bounds SHOULD be of the same type; if they are not, the result is UNKNOWN. If `lo > hi` the range is empty and the result is FALSE, not an error.

### 5.4 Sets — `$in`, `$nin`

`$in` is TRUE when the value is `$eq` to at least one member of the list. `$nin` is its negation.

**`$in` compares the value as a whole.** If the field is array-valued, `{"tags": {"$in": ["a"]}}` asks whether the array *equals* `"a"` — which it does not. Element membership is `$hasAny`. This differs from MongoDB, which overloads `$in`; the split is intentional, because overloading makes the meaning depend on data the validator cannot see.

The list is a set: duplicate members are rejected by the schema, and order is not significant.

### 5.5 Pattern matching — `$like`, `$nlike`, `$ilike`, `$nilike`

A `$like` pattern is matched against the **whole** value, not a substring of it.

| Sequence | Meaning |
| --- | --- |
| `%` | zero or more characters |
| `_` | exactly one character |
| `\%` | a literal `%` |
| `\_` | a literal `_` |
| `\\` | a literal `\` |

A `\` followed by anything else, or a trailing `\`, is a malformed pattern and MUST be rejected as `invalid-operand` (§8).

`$ilike` is `$like` under case-insensitive comparison. Collation is server-defined; Unicode simple case folding is RECOMMENDED. Servers SHOULD state their collation in their capability document, because case folding for non-ASCII text differs materially between engines.

A non-string value yields UNKNOWN.

### 5.6 Substrings — `$startsWith`, `$endsWith`, `$contains`

Literal, case-sensitive substring tests. `%` and `_` carry **no** special meaning here — `{"body": {"$contains": "100%"}}` looks for the three characters `100%`. An empty operand is TRUE for any string value.

`$contains` is string-only. For array membership use `$hasAny`, `$hasAll` or `$hasNone` (§5.8).

### 5.7 Regular expressions — `$regex`, `$flags`

The operand is an ECMA-262 regular expression, matched **unanchored**: the clause is TRUE if the pattern matches anywhere in the value. Anchor with `^` and `$` for a whole-value match.

`$flags` accepts `i` (case-insensitive), `m` (`^`/`$` match at line breaks) and `s` (`.` matches line terminators), in any order. It is only valid alongside `$regex`; the schema enforces this. Flags that affect capture or iteration (`g`, `y`, `u`, `d`) are excluded because the language only asks whether a match exists.

A pattern that does not compile MUST be rejected as `invalid-operand`. See §7 on execution limits — this operator is the language's largest denial-of-service surface.

### 5.8 Collections — `$hasAny`, `$hasAll`, `$hasNone`, `$size`, `$elemMatch`

These require the value to be an array; any other type yields UNKNOWN.

- `$hasAny` — TRUE when at least one operand is `$eq` to at least one element.
- `$hasAll` — TRUE when every operand is `$eq` to some element. Set semantics: multiplicity is ignored, so `["a"]` satisfies `$hasAll: ["a"]` and `["a","a"]` does not additionally satisfy anything.
- `$hasNone` — TRUE when no operand matches any element. The negation of `$hasAny`.
- `$size` — compares the array's length. `{"$size": 3}` is exact; `{"$size": {"$gte": 1}}` compares. An empty array has size `0`.
- `$elemMatch` — TRUE when at least one element satisfies the nested condition. Supply a `Filter` when elements are objects (paths inside are relative to the element) or a constraint object when they are scalars.

### 5.9 `$elemMatch` versus wildcard paths

They are not the same, and the difference matters:

```json
{ "items[*].qty": { "$gt": 2 }, "items[*].sku": { "$startsWith": "A" } }
```

is TRUE when *some* item has `qty > 2` and *some* item has an `A` SKU — possibly different items.

```json
{ "items": { "$elemMatch": { "qty": { "$gt": 2 }, "sku": { "$startsWith": "A" } } } }
```

is TRUE only when a **single** item satisfies both.

A constraint on a wildcard path is existential: it is TRUE if it holds for at least one resolved value, FALSE if it holds for none and at least one value resolved, and UNKNOWN if the path resolved to nothing.

### 5.10 Presence and type — `$exists`, `$isNull`, `$type`

`$exists` and `$isNull` are specified by the table in §4.2.

`$type` tests the value's JSON type against one of `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`. `integer` matches a number with no fractional part, so `3` and `3.0` are both integers and `3.5` is not; `number` matches any number including integers. `$type: "null"` is TRUE for a present `null` and UNKNOWN for an absent field — use `$exists` to test absence.

### 5.11 Field references — `$field`, `$literal`

`{"$field": "path"}` in operand position resolves `path` against the **same record** and compares the two values, giving the equivalent of SQL's `WHERE price > cost`:

```json
{ "price": { "$gt": { "$field": "cost" } } }
```

If the referenced path resolves to nothing, the comparison is UNKNOWN. A `$field` path is subject to the same queryability rules as any other path (§3.5) — a reference is a read, and MUST be authorized as one. A `$field` operand that resolves to a sequence of more than one value (a wildcard path) is UNKNOWN.

`{"$literal": v}` forces `v` to be treated as data. It is needed only when an object operand would otherwise be read as a reference:

```json
{ "payload": { "$eq": { "$literal": { "$field": "this is data" } } } }
```

### 5.12 Free text — `$search`

`{"title": {"$search": "kubernetes ingress"}}` requests a free-text match. Tokenisation, stemming, stop-words, phrase handling and relevance are entirely server-defined; this specification only reserves the operator name so that implementations do not each invent one. Because relevance ordering is not part of a predicate language, a server that returns ranked results MUST expose the ranking through its own response envelope.

### 5.13 Field-level `$not`

`{"age": {"$not": {"$gt": 5}}}` negates the constraint on that one field. It follows §4.1: UNKNOWN in, UNKNOWN out. It is a convenience — the same thing can always be written with the top-level `$not`.

## 6. Extensibility

The `$` namespace is reserved for this specification. An implementation that adds an operator MUST prefix it distinctly (`$x_`, or a vendor tag such as `$acme_geoWithin`) and MUST document it, because a bare `$geoWithin` may be standardised later with different semantics.

Adding an operator means the endpoint no longer validates against the published schema. Such an endpoint SHOULD publish an extended schema that `allOf`-composes or bundles this one, and MUST NOT advertise the unmodified `$id`.

## 7. Safety limits

A filter is user-supplied input that becomes a query plan. Every implementation MUST bound it. RECOMMENDED defaults, to be published through the capability document (§2.2):

| Limit | Default | Why |
| --- | --- | --- |
| Nesting depth | 10 | Recursive descent over an attacker-supplied tree. |
| Total clauses | 100 | Query planners degrade non-linearly. |
| Set length (`$in`, `$nin`, `$hasAny`, `$hasAll`, `$hasNone`) | 1000 | Each member is a comparison. |
| Request body size | 64 KiB | The cheapest limit to enforce, and the one that subsumes the others. |
| `$regex` execution | 100 ms per record, or a non-backtracking engine | Catastrophic backtracking (ReDoS). |

An implementation MUST reject a filter that exceeds a limit with `query-too-complex` (§8). It MUST NOT truncate the filter to fit — a truncated predicate silently returns records the client did not ask for.

For `$regex`, a linear-time engine (RE2, Rust `regex`, Go `regexp`) is strongly RECOMMENDED over a backtracking one. Where that is not available, `$regex` SHOULD be left out of the advertised profiles entirely, and clients directed to `$like`, whose worst case is bounded.

Fields backed by unindexed storage are their own denial-of-service surface. An implementation SHOULD restrict expensive operators to indexed fields through its capability document rather than accepting them and timing out.

## 8. Errors

A rejected filter MUST be reported with [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details, media type `application/problem+json`, status `400 Bad Request`.

| `type` (relative to `https://christosgkoros.com/json/query-language/problems/`) | Meaning |
| --- | --- |
| `malformed-query` | The body does not conform to the schema: unknown operator, wrong operand type, structural error. |
| `unknown-field` | The path is well-formed but this endpoint does not expose it. |
| `unsupported-operator` | The operator is part of the language but not of this endpoint's profiles. |
| `invalid-operand` | The operator is supported but the operand is not usable: an uncompilable `$regex`, a malformed `$like` escape, a value outside the field's domain. |
| `query-too-complex` | A limit from §7 was exceeded. |

The problem object SHOULD carry a **`pointer`** extension member: an [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON Pointer into the request body, locating the offending clause. Without it a client faced with a deeply nested filter has no way to know which clause to fix.

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
```
```json
{
  "type": "https://christosgkoros.com/json/query-language/problems/unsupported-operator",
  "title": "Unsupported operator",
  "status": 400,
  "detail": "$regex is not in this endpoint's advertised profiles (core, strings).",
  "pointer": "/filter/$and/1/name/$regex"
}
```

A problem SHOULD carry whatever the client needs to build a correct filter on its next attempt, not only a statement of what was wrong:

- `unknown-field` SHOULD carry a **`queryableFields`** member listing the paths this endpoint does expose. Without it, a client that guessed one field name wrong has no way to converge except by guessing again.
- `unsupported-operator` SHOULD name the endpoint's advertised profiles, as above.
- `invalid-operand` SHOULD carry an **`accepted`** member describing the field's domain — the `values`, `type` or `format` of §2.2 — whenever the operand was rejected for falling outside it.

These members restate part of the capability document (§2.2) deliberately: a client that never fetched it can still recover in one round trip.

```json
{
  "type": "https://christosgkoros.com/json/query-language/problems/unknown-field",
  "title": "Unknown field",
  "status": 400,
  "detail": "'birthDate' is not a queryable path on this collection.",
  "pointer": "/filter/$and/0/birthDate",
  "queryableFields": ["id", "name", "species", "status", "born", "tags"]
}
```

A server MUST report the first error it finds rather than partially evaluating, and SHOULD report all of them when it can — a client fixing one clause at a time across round trips is a poor experience for a filter with a dozen clauses.

## 9. Versioning

The schema's `$id` carries the version: `…/v0.2.0/query-language-schema.json`. Each release is published at its own URL and, once published, is immutable. Consumers pin by `$id`.

- **Patch** — documentation and description text only.
- **Minor** — new optional operators or profiles. A filter valid under `v0.N` stays valid under `v0.N+1`.
- **Major** — anything that can invalidate an existing filter.

Before `1.0.0` a minor release MAY break compatibility; each such break is recorded in [CHANGELOG.md](./CHANGELOG.md) with a migration note.

## 10. References

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) — requirement keywords
- [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) — date and time on the internet
- [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) — JSON Pointer
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) — Problem Details for HTTP APIs
- [JSON Schema draft 2020-12](https://json-schema.org/draft/2020-12/release-notes)
- [draft-ietf-httpbis-safe-method-w-body](https://datatracker.ietf.org/doc/draft-ietf-httpbis-safe-method-w-body/) — the QUERY method
- [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) · [OpenAPI 3.2](https://spec.openapis.org/oas/v3.2.0)
- [ECMA-262 §22.2](https://tc39.es/ecma262/#sec-regexp-regular-expression-objects) — regular expressions
