# JSON Query Language — Specification

**Version 0.4.0** · Dialect: JSON Schema draft 2020-12 · Schema: [`query-language-schema.json`](./query-language-schema.json)

This document defines the semantics of the language. The schema defines only its *shape* — a validator can tell you that `{"age": {"$gt": 18}}` is well-formed, but not what it means when `age` is `null`, absent, or a string. Everything a server and a client must agree on beyond well-formedness is specified here.

For a guided introduction, see [README.md](./README.md).

---

## 1. Scope

The language expresses a **predicate over a record**: a function that, given one record, answers whether it matches. The answer is three-valued — TRUE, FALSE or UNKNOWN — and only TRUE matches (§4.1). It is deliberately *not* a full query language. It has no projection, ordering, pagination, grouping or joins — those belong to the enclosing request body, where each API is free to define them. Confining this schema to the predicate is what makes it reusable across endpoints whose result shapes have nothing else in common.

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
| `core` | `$and` `$or` `$nor` `$not` `$eq` `$ne` `$in` `$nin` `$gt` `$gte` `$lt` `$lte` `$exists` `$isNull` `$unknownAs` |
| `strings` | `$like` `$nlike` `$ilike` `$nilike` `$startsWith` `$endsWith` `$contains` |
| `regex` | `$regex` `$flags` |
| `ranges` | `$between` `$nbetween` |
| `types` | `$type` |
| `collections` | `$some` `$every` `$hasAll` `$size` |
| `refs` | `$field` `$literal` |
| `text` | `$search` |

A conforming implementation MUST implement `core` in full. Every other profile is OPTIONAL, and MUST be implemented in full or not at all — partial profiles defeat the purpose of advertising them.

An implementation MUST reject an operator it does not support with an `unsupported-operator` error (§8). It MUST NOT silently ignore the clause: dropping a predicate from a filter widens the result set, which is the most dangerous possible failure mode for an authorization-adjacent filter.

### 2.2 Capability discovery

An implementation SHOULD publish which profiles and fields it accepts. This specification does not mandate a location; a `capabilities` member on the collection resource, or a separate endpoint linked by a `describedby` relation, both work. The RECOMMENDED shape:

```json
{
  "queryLanguage": "https://christosgkoros.com/json/query-language/v0.4.0/query-language-schema.json",
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
index          = "[" 1*DIGIT "]"
```

- `address.city` — a member of a nested object.
- `items[0].sku` — the first element of an array.
- `a\.b` — a single key whose literal name contains a dot.
- `$$price` — a single key whose literal name is `$price`.

A path addresses **one** position. To say something about the elements of an array without naming an index, quantify explicitly with `$some` or `$every` (§5.8). There is deliberately no wildcard segment: a path shape is the wrong place to carry a quantifier, because it cannot be declined by profile (§2.1) and it leaves the quantifier's scope implicit.

### 3.3 The `$` prefix is reserved

Within a `Filter` object, a member name beginning with `$` is an operator. A record field whose real name begins with `$` MUST be escaped by doubling the prefix: `$$price` addresses the field `$price`. A name beginning with a single `$` that is not a defined operator MUST be rejected as `malformed-query` (§8) rather than treated as a field. This is what turns a typo like `$eqq` into an error instead of a filter that matches everything.

### 3.4 Resolution

Resolving a path against a record yields **zero values or exactly one**:

- Zero, when the path does not exist — including when traversing *into* a non-object or non-array.
- One, otherwise. That one value may itself be `null`, an array or an object.

The distinction between "yields zero values" and "yields one value that is `null`" is load-bearing; see §4.2.

Inside `$some` and `$every` (§5.8) the paths of the nested condition resolve against the **element** rather than against the record, by the same rule.

### 3.5 Which paths are queryable

The schema's default path rule is permissive by design: the set of queryable fields is a property of the resource, not of the language. An implementation MUST reject a path it does not expose with an `unknown-field` error (§8), and SHOULD publish the accepted set through §2.2. Endpoints that want the field set enforced by schema validation can narrow `$defs/FieldPath` in a bundled copy — see README §*Restricting the queryable field set*.

An index suffix addresses the elements of a path rather than a member beneath it, so `items[0]` is the field `items` for this purpose: exposing `items` exposes `items[0]`. A **named** member beneath it (`items[0].sku`) is a separate path and MUST be exposed on its own.

## 4. Evaluation

### 4.1 Three-valued logic

Every clause evaluates to **TRUE**, **FALSE** or **UNKNOWN**. UNKNOWN arises when a comparison is not meaningful — the path resolved to nothing, or to `null`, or to a value of a type the operator cannot order.

| `a` | `b` | `a AND b` | `a OR b` | `a NOR b` |
| --- | --- | --- | --- | --- |
| T | T | T | T | F |
| T | F | F | T | F |
| T | U | U | T | F |
| F | F | F | F | T |
| F | U | F | U | U |
| U | U | U | U | U |

All three are commutative, so the six rows cover all nine combinations.

| `a` | `NOT a` |
| --- | --- |
| T | F |
| F | T |
| U | **U** |

`$nor [a, b, …]` is `NOT (a OR b OR …)`, which is TRUE only when **every** member is FALSE. One UNKNOWN member makes the whole thing UNKNOWN, so a `$nor` over a nullable field excludes the records whose field is null or absent — the same surprise as `$not`, one level up.

**A record is included in the result if and only if the filter evaluates to TRUE.** UNKNOWN excludes, exactly as SQL's `WHERE` does.

The consequence that surprises people: `{"$not": {"status": {"$eq": "archived"}}}` does **not** match records whose `status` is `null` or absent, because `$eq` returned UNKNOWN and `NOT UNKNOWN` is UNKNOWN. To include them, say so with `$unknownAs` (§4.6):

```json
{ "status": { "$ne": "archived", "$unknownAs": true } }
```

which is equivalent to the longhand this specification prescribed before v0.4.0:

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

There is **no implicit coercion**. Comparing values of different JSON types is never an error and never a coerced comparison. `{"age": {"$gt": "18"}}` against `{"age": 21}` is UNKNOWN, not TRUE.

A type mismatch resolves differently for equality than for ordering, and the difference is observable under negation:

| Operator family | Type mismatch | Why |
| --- | --- | --- |
| `$eq`, `$ne`, `$in`, `$nin`, `$hasAll` | **FALSE** (unequal) | Equality is structural (§5.1). A string and a number are not equal; nothing is unknown about it. So `{"notes": {"$ne": 3}}` **does** match a record whose `notes` is `"hello"`. |
| `$gt`, `$gte`, `$lt`, `$lte`, `$between`, `$nbetween` | **UNKNOWN** | No ordering is defined across types (§5.2). |
| `$like` and friends, `$regex`, `$search`, `$startsWith`, `$endsWith`, `$contains` | **UNKNOWN** | The operator is defined on strings only (§5.5, §5.6). |
| `$some`, `$every`, `$hasAll`, `$size` | **UNKNOWN** | The operator is defined on arrays only (§5.8). |

`$exists`, `$isNull` and `$type` are total over types by construction and never UNKNOWN for this reason.

This is a deliberate departure from SQL, where `'18' > 17` may or may not succeed depending on the engine. Servers that need coercion (a date column queried with a string, for instance) SHOULD perform it at the *boundary* — mapping the operand into the field's declared type once, before evaluation — and MUST reject an operand that cannot be mapped with an `invalid-operand` error (§8) rather than evaluating it as UNKNOWN.

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

### 4.6 Resolving UNKNOWN — `$unknownAs`

`$unknownAs` is a modifier on a constraint object, not a predicate. It resolves that constraint's UNKNOWN to the value given:

```json
{ "status": { "$ne": "archived", "$unknownAs": true } }
```

"`status` is not `archived`, and count the records where `status` is null or absent." It is the one-clause form of the §4.1 longhand, and it is the answer to the language's most common mistake: a negative predicate that silently drops the rows a client meant to include.

It MUST be accompanied by at least one operator; the schema enforces this. Two rules fix its meaning.

**It applies last.** The modifier resolves the result of the whole constraint object — after every sibling operator has been evaluated and ANDed together, and after a field-level `$not` (§5.13). For the conjunction this is unambiguous either way, because resolving UNKNOWN distributes over three-valued AND: writing `c` for the resolution, `c(a AND b)` equals `c(a) AND c(b)` in all nine cases. An implementation MAY therefore resolve per operator or once over the conjunction.

It does **not** distribute over negation, which is why the ordering is normative rather than left to the implementer:

```json
{ "age": { "$not": { "$gt": 5 }, "$unknownAs": true } }
{ "age": { "$not": { "$gt": 5, "$unknownAs": true } } }
```

For a record with no `age`, the first is TRUE — the negation yields UNKNOWN, which is then resolved to TRUE — and the second is FALSE, because the inner UNKNOWN is resolved to TRUE first and then negated. Both are legal; the nesting says which is meant.

**It is scoped to its own constraint object.** It does not reach into a nested `$some` or `$every` condition, and it does not affect sibling fields. Inside a quantifier it applies per element:

```json
{ "tags": { "$some": { "$gt": 5, "$unknownAs": true } } }
```

`$unknownAs` is a no-op wherever UNKNOWN is unreachable — on `$exists`, which is total (§4.2). Implementations MUST accept it there rather than rejecting it, so that a generated schema need not special-case the field; it simply changes nothing. A generator MAY omit it from a field that can be neither absent nor null, for the same reason it omits `$exists` and `$isNull` there.

## 5. Operator semantics

Throughout, *the value* means the value the field path resolved to (§3.4). Unless stated otherwise, an operator applied to a path that resolved to nothing yields UNKNOWN.

### 5.1 Equality — `$eq`, `$ne`

Structural equality over JSON values. Objects compare irrespective of member order; arrays compare element-wise and are order-**sensitive**. Numbers compare by mathematical value, so `1`, `1.0` and `1e0` are equal.

A value of a **different JSON type is unequal, not unknown**: `$eq` is FALSE and `$ne` is TRUE (§4.3). Only absence and `null` produce UNKNOWN here.

`$eq: null` is TRUE when the value is `null` — it is the one comparison for which `null` is an operand rather than a cause of UNKNOWN. `$ne` is the negation of `$eq` under three-valued logic, so `{"a": {"$ne": 1}}` is UNKNOWN when `a` is absent. Add `$unknownAs: true` (§4.6) to match those records.

The scalar shorthand `{"status": "open"}` is exactly `{"status": {"$eq": "open"}}`. It is available for strings, numbers, booleans and `null`. Arrays and objects are excluded so that `{"tags": ["a", "b"]}` cannot be read as either `$eq` or `$in`; write the operator you mean.

### 5.2 Ordering — `$gt`, `$gte`, `$lt`, `$lte`

Defined for two numbers or two strings. Numbers compare numerically. Strings compare by Unicode code point, which for RFC 3339 `date`, `date-time` and `time` strings coincides with chronological order — provided the operands use the same offset. Comparing a `Z`-suffixed timestamp against a `+02:00` one lexicographically gives the wrong answer; servers that store timestamps as strings SHOULD normalise to UTC before comparing, and servers that store them as instants SHOULD parse the operand.

Any other operand type, or a type mismatch between operand and value, yields UNKNOWN.

### 5.3 Ranges — `$between`, `$nbetween`

`{"$between": [lo, hi]}` is `value >= lo AND value <= hi` — **inclusive at both ends**. `$nbetween` is its negation under three-valued logic.

Both bounds SHOULD be of the same type; if they are not, the result is UNKNOWN. If `lo > hi` the range is empty and the result is FALSE, not an error.

### 5.4 Sets — `$in`, `$nin`

`$in` is TRUE when the value is `$eq` to at least one member of the list. `$nin` is its negation.

**`$in` compares the value as a whole.** If the field is array-valued, `{"tags": {"$in": ["a"]}}` asks whether the array *equals* `"a"` — which it does not. Element membership is a quantifier over the elements:

```json
{ "tags": { "$some": { "$in": ["a"] } } }
```

This differs from MongoDB, which overloads `$in`; the split is intentional, because overloading makes the meaning depend on data the validator cannot see. What v0.4.0 changed is that the element form now names its quantifier, so the two spellings can no longer be mistaken for variants of one operator.

The list is a set: duplicate members are rejected by the schema, and order is not significant. Members are drawn from the same operand grammar as every other operator, so a `$field` reference or a `$literal` may appear among them.

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

`$contains` is string-only. For arrays, quantify over the elements: `{"tags": {"$some": {"$contains": "x"}}}` (§5.8).

### 5.7 Regular expressions — `$regex`, `$flags`

The operand is an ECMA-262 regular expression, matched **unanchored**: the clause is TRUE if the pattern matches anywhere in the value. Anchor with `^` and `$` for a whole-value match.

`$flags` accepts `i` (case-insensitive), `m` (`^`/`$` match at line breaks) and `s` (`.` matches line terminators), in any order. It is only valid alongside `$regex`; the schema enforces this. Flags that affect capture or iteration (`g`, `y`, `u`, `d`) are excluded because the language only asks whether a match exists.

A pattern that does not compile MUST be rejected as `invalid-operand`. See §7 on execution limits — this operator is the language's largest denial-of-service surface.

### 5.8 Collections — `$some`, `$every`, `$hasAll`, `$size`

All four require the value to be an array; any other type — including `null`, and including a path that resolved to nothing — yields UNKNOWN.

**`$some` and `$every` quantify over the field's elements.** Each takes a `Filter` when the elements are objects, in which case the paths inside resolve against the element (§3.4), or a constraint object when the elements are scalars:

```json
{ "items": { "$some":  { "qty": { "$gt": 2 } } } }
{ "tags":  { "$every": { "$startsWith": "adopt-" } } }
```

- `$some` — TRUE when at least one element satisfies the condition.
- `$every` — TRUE when every element satisfies it.

**The quantifiers are two-valued over elements.** An element for which the condition is UNKNOWN does not satisfy it, and does not make the quantifier UNKNOWN. So over any array both operators return TRUE or FALSE, and UNKNOWN can only come from the field itself:

| Value of the field | `$some` | `$every` |
| --- | --- | --- |
| Array, at least one element satisfies | TRUE | FALSE unless all do |
| Array, every element satisfies | TRUE | TRUE |
| Array, no element satisfies | FALSE | FALSE |
| Array, every element UNKNOWN | FALSE | FALSE |
| Empty array `[]` | **FALSE** | **TRUE** (vacuously) |
| `null` | UNKNOWN | UNKNOWN |
| Path resolved to nothing | UNKNOWN | UNKNOWN |
| Present but not an array | UNKNOWN | UNKNOWN |

The two vacuous-case answers are the ones worth reading twice. `$every` over an empty array is TRUE because there is no element that fails; `$every` over a **missing** array is UNKNOWN, not vacuously TRUE, because there is no array at all.

Note that `$every` is not expressible as a negation. `{"$not": {"items": {"$some": c}}}` is "no element satisfies `c`", and `$some` over the negation of `c` admits elements for which `c` is UNKNOWN. Neither is `$every`.

**Operand shape.** `$some` and `$every` accept either a `Filter` or a constraint object, and the two overlap on a leading `$not`. An implementation MUST disambiguate by scanning for the first member that can only be one of the two — a field path, `$and`, `$or` or `$nor` makes it a `Filter`; any other operator makes it a constraint object — recursing through the bodies of `$not`, `$and`, `$or` and `$nor` when the outer member is itself ambiguous. If no such member exists, it is a constraint object.

**`$hasAll` quantifies over the operand, not over the elements.** TRUE when every member of the list is `$eq` to some element — possibly different elements. Set semantics: multiplicity is ignored, so `["a"]` satisfies `$hasAll: ["a"]` and `["a","a"]` does not additionally satisfy anything. It is kept as its own operator because that doubled quantifier is not a `$some` or an `$every` over any single condition; the `$some`-per-member rewrite would grow with the operand and run into the §7 clause limit.

**`$size` compares the array's length.** `{"$size": 3}` is exact; `{"$size": {"$gte": 1}}` compares. An empty array has size `0`.

### 5.9 Quantifier scope

A quantifier scopes every condition inside it to **one** element. That is the difference between these two filters, and it is the whole reason `$some` takes a nested condition rather than being spelled across sibling clauses:

```json
{ "items": { "$some": { "qty": { "$gt": 2 }, "sku": { "$startsWith": "A" } } } }
```

is TRUE only when a **single** item has both `qty > 2` and an `A` SKU.

```json
{ "$and": [
  { "items": { "$some": { "qty": { "$gt": 2 } } } },
  { "items": { "$some": { "sku": { "$startsWith": "A" } } } }
] }
```

is TRUE when *some* item has `qty > 2` and *some* item has an `A` SKU — **possibly different items**, because each `$some` chooses its own element.

Both readings are expressible and the nesting says which is meant. Versions before v0.4.0 offered a second mechanism for the second reading — a `[*]` wildcard path segment — which expressed nothing the two-clause form does not, could not be declined by a server through its profiles, and left the quantifier's scope to be inferred from a path shape. It was removed; see [`decisions/0001`](./decisions/0001-array-quantifiers-and-unknown-handling.md).

### 5.10 Presence and type — `$exists`, `$isNull`, `$type`

`$exists` and `$isNull` are specified by the table in §4.2. `$exists` is total: it is TRUE or FALSE for every record and every path, with no exceptions anywhere in this specification.

`$type` tests the value's JSON type against one of `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`. `integer` matches a number with no fractional part, so `3` and `3.0` are both integers and `3.5` is not; `number` matches any number including integers. `$type: "null"` is TRUE for a present `null` and UNKNOWN for an absent field — use `$exists` to test absence.

### 5.11 Field references — `$field`, `$literal`

`{"$field": "path"}` in operand position resolves `path` against the **same record** and compares the two values, giving the equivalent of SQL's `WHERE price > cost`:

```json
{ "price": { "$gt": { "$field": "cost" } } }
```

If the referenced path resolves to nothing, the comparison is UNKNOWN. A `$field` path is subject to the same queryability rules as any other path (§3.5) — a reference is a read, and MUST be authorized as one.

Inside `$some` or `$every`, a `$field` reference resolves against the **element**, consistently with every other path in that nested condition (§3.4). To compare an element against a member of the enclosing record, hoist the comparison out of the quantifier.

`{"$literal": v}` forces `v` to be treated as data. It is needed only when an object operand would otherwise be read as a reference:

```json
{ "payload": { "$eq": { "$literal": { "$field": "this is data" } } } }
```

### 5.12 Free text — `$search`

`{"title": {"$search": "kubernetes ingress"}}` requests a free-text match. Tokenisation, stemming, stop-words, phrase handling and relevance are entirely server-defined; this specification only reserves the operator name so that implementations do not each invent one. Because relevance ordering is not part of a predicate language, a server that returns ranked results MUST expose the ranking through its own response envelope.

### 5.13 Field-level `$not`

`{"age": {"$not": {"$gt": 5}}}` negates the constraint on that one field. It follows §4.1: UNKNOWN in, UNKNOWN out. It is a convenience — the same thing can always be written with the top-level `$not`.

A sibling `$unknownAs` applies *after* the negation; to resolve UNKNOWN before it, put the modifier inside. See §4.6.

## 6. Extensibility

The `$` namespace is reserved for this specification. An implementation that adds an operator MUST prefix it distinctly (`$x_`, or a vendor tag such as `$acme_geoWithin`) and MUST document it, because a bare `$geoWithin` may be standardised later with different semantics.

Adding an operator means the endpoint no longer validates against the published schema. Such an endpoint SHOULD publish an extended schema that `allOf`-composes or bundles this one, and MUST NOT advertise the unmodified `$id`.

## 7. Safety limits

A filter is user-supplied input that becomes a query plan. Every implementation MUST bound it. RECOMMENDED defaults, to be published through the capability document (§2.2):

| Limit | Default | Why |
| --- | --- | --- |
| Nesting depth | 10 | Recursive descent over an attacker-supplied tree. |
| Total clauses | 100 | Query planners degrade non-linearly. |
| Set length (`$in`, `$nin`, `$hasAll`) | 1000 | Each member is a comparison. |
| Request body size | 64 KiB | The cheapest limit to enforce, and the one that subsumes the others. |
| `$regex` execution | 100 ms per record, or a non-backtracking engine | Catastrophic backtracking (ReDoS). |

An implementation MUST reject a filter that exceeds a limit with `query-too-complex` (§8). It MUST NOT truncate the filter to fit — a truncated predicate silently returns records the client did not ask for.

For `$regex`, a linear-time engine (RE2, Rust `regex`, Go `regexp`) is strongly RECOMMENDED over a backtracking one. Where that is not available, `$regex` SHOULD be left out of the advertised profiles entirely, and clients directed to `$like`, whose worst case is bounded.

Fields backed by unindexed storage are their own denial-of-service surface. An implementation SHOULD restrict expensive operators to indexed fields through its capability document rather than accepting them and timing out.

`$some` and `$every` are the expensive operators on most backends: each one is a traversal of an array, and a nested quantifier is a traversal per element. They count toward the nesting-depth and clause limits like any other clause, and — unlike the `[*]` path segment they replaced — a server that cannot afford them can decline the whole `collections` profile (§2.1) instead of having to accept them as part of the path grammar. An implementation SHOULD publish a lower `maxDepth` for filters containing quantifiers if its storage makes them disproportionately costly.

## 8. Errors

A rejected filter MUST be answered with status `400 Bad Request`, and the response MUST tell the client which of these conditions applies. Which one it is decides what the client does next, so an error that says only "bad request" is not conforming.

| Condition | Meaning |
| --- | --- |
| `malformed-query` | The body does not conform to the schema: unknown operator, wrong operand type, structural error. |
| `unknown-field` | The path is well-formed but this endpoint does not expose it. |
| `unsupported-operator` | The operator is part of the language but not of this endpoint's profiles. |
| `invalid-operand` | The operator is supported but the operand is not usable: an uncompilable `$regex`, a malformed `$like` escape, a value outside the field's domain. |
| `query-too-complex` | A limit from §7 was exceeded. |

**The wire format is the API's own.** This specification mandates the conditions, not an envelope: an API that already has an error format SHOULD express them in it rather than carry a second format for one endpoint. Where there is no established format, [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details with media type `application/problem+json` is RECOMMENDED, taking each condition as a `type` URI relative to `https://christosgkoros.com/json/query-language/problems/`. The examples below use it.

However it is encoded, the error SHOULD locate the offending clause with a **`pointer`**: an [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON Pointer into the request body. Without it a client faced with a deeply nested filter has no way to know which clause to fix.

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

An error SHOULD carry whatever the client needs to build a correct filter on its next attempt, not only a statement of what was wrong. The member names below are the RECOMMENDED ones; an API expressing these in its own envelope keeps the information and adapts the naming:

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

The schema's `$id` carries the version: `…/v0.4.0/query-language-schema.json`. Each release is published at its own URL and, once published, is immutable. Consumers pin by `$id`.

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
- [RFC 10008](https://www.rfc-editor.org/rfc/rfc10008) — the HTTP QUERY method
- [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) · [OpenAPI 3.2](https://spec.openapis.org/oas/v3.2.0)
- [ECMA-262 §22.2](https://tc39.es/ecma262/#sec-regexp-regular-expression-objects) — regular expressions
