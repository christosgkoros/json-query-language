# 0001 — Array quantifiers, and an escape hatch for UNKNOWN

| | |
| --- | --- |
| **Status** | **Accepted and implemented** in 0.4.0 |
| **Date** | 2026-09-07 |
| **Release** | `0.4.0`, breaking — see [CHANGELOG](../CHANGELOG.md#040--2026-09-07) |
| **Authority for breaking** | [SPEC.md §9](../SPEC.md#9-versioning): "Before `1.0.0` a minor release MAY break compatibility; each such break is recorded in CHANGELOG.md with a migration note." |
| **Scope** | The three operator overlaps flagged independently by an external review and by `experiments/filter-to-sql`. Nothing else. |

## Context

Two independent reviews have now flagged the same three constructs.

An external survey of query languages for the HTTP `QUERY` body ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)) scored this project 3.0 on a 10-criterion rubric, and its Simplicity (3) and Orthogonality (3) deductions cite exactly three things. The repository's own `experiments/filter-to-sql` — an exercise that built a filter-to-SQL compiler specifically to judge the design by implementing it — independently flagged the same three. They are:

1. `$in` (whole-value comparison) against `$hasAny` (element membership).
2. `$elemMatch` against wildcard field paths (`items[*].sku`).
3. Three-valued `$not` and `$ne` silently excluding nulls.

Two independent sources converging on one set is the strongest signal available before there are any users. All three must be settled before `1.0.0`, because after adoption they are permanent.

This record resolves all three. It concludes that they are **not three problems**. Two are one problem — the language grew two unrelated mechanisms for looking inside an array — and the third is largely a documentation defect wearing a semantics defect's clothing.

### What this record does not do

It does not change `$in`'s whole-value semantics, [§4.1](../SPEC.md#41-three-valued-logic)'s three-valued logic, the profile mechanism of [§2.1](../SPEC.md#21-profiles), or the single `$defs/FieldPath` override point. Three of those are load-bearing differentiators and one is the extensibility story. A reader who finishes this document believing three-valued logic was weakened has misread it.

### What was implemented

All three decisions, in 0.4.0. The schema, [`SPEC.md`](../SPEC.md), the generator, the fixtures, the OpenAPI examples and the SQL experiment all move together; [`CHANGELOG.md`](../CHANGELOG.md) carries the migration table. Measured outcomes are recorded in [Results](#results) at the end of this document, including the two predictions that were tested rather than argued.

One thing changed between proposal and implementation: **`$none` was dropped from the family.** Working the semantics through showed it is exactly `$not` over `$some` — see [the redundancy argument](#why-every-is-included-and-none-is-not) — while `$every` is not expressible at all. That inverts which operator is the open question and keeps the count flat.

---

## Decision 1 — one element-quantifier family replaces the two array mechanisms

**Add** `$some` and `$every` to the `collections` profile. Each takes a `Filter` (paths inside are element-relative) or a `ConstraintObject` (for scalar elements) — the operand shape `$elemMatch` already has.

**Remove** `$elemMatch`, `$hasAny`, `$hasNone`, and the `[*]` production from the [§3.2](../SPEC.md#32-path-grammar) path grammar.

**Keep** `$hasAll` and `$size` unchanged.

### Migration

| Removed | Rewrite | Exact? |
| --- | --- | --- |
| `{"items": {"$elemMatch": {…}}}` | `{"items": {"$some": {…}}}` | Yes — pure rename |
| `{"tags": {"$hasAny": ["a", "b"]}}` | `{"tags": {"$some": {"$in": ["a", "b"]}}}` | Yes |
| `{"tags": {"$hasNone": ["a", "b"]}}` | `{"tags": {"$not": {"$some": {"$in": ["a", "b"]}}}}` | Yes |
| `{"items[*].qty": {"$gt": 2}}` | `{"items": {"$some": {"qty": {"$gt": 2}}}}` | Yes, except for an empty array — see [The one non-mechanical consequence](#the-one-non-mechanical-consequence) |
| `{"items[*].qty": {"$gt": 2}, "items[*].sku": {"$startsWith": "A"}}` | `{"$and": [{"items": {"$some": {"qty": {"$gt": 2}}}}, {"items": {"$some": {"sku": {"$startsWith": "A"}}}}]}` | As above |

`items[0].sku` is **not** affected. Indexed paths stay.

### Why `$hasAll` survives when `$hasAny` and `$hasNone` do not

This asymmetry is the first thing a reviewer will challenge, so it is stated up front. The three `$has*` operators are not three variants of one idea. They quantify over different things:

- `$some`, `$every` quantify the **field's elements**: ∃e∈value, ∀e∈value.
- `$hasAll` quantifies the **operand's members**: ∀o∈operand ∃e∈value, e = o.

`$hasAny` and `$hasNone` are compositions — ∃o∃e collapses to `$some` over `$in`, and ∄o∃e to its negation — so they are redundant surface. `$hasAll`'s doubled quantifier is not a composition of the element-side family, and it earns its place three times over:

- Its rewrite would be an `$and` of N `$some: {$eq: …}` clauses, growing with operand length. [§7](../SPEC.md#7-safety-limits) caps a filter at 100 total clauses while capping set length at 1000, so a `$hasAll` with more than 100 members would become unwritable — a real loss of expressiveness, not a verbosity tax.
- It has a direct index-backed lowering: Postgres `@>`.
- It is the only one of the three whose set semantics need stating at all ([§5.8](../SPEC.md#58-collections--some-every-hasall-size) already documents that multiplicity is ignored).

### Why the wildcard path production goes

This is the load-bearing half of the decision, and it contradicts a claim currently made in this repository, so the evidence is given in full.

**Wildcards add zero expressiveness over `$some`.** [§5.9](../SPEC.md#59-quantifier-scope) distinguishes the two by quantifier scope: a wildcard constraint is existential *per constraint*, so two wildcard clauses may be satisfied by different elements, while `$elemMatch` requires one element to satisfy all of its inner constraints. That difference is real — `b01` and `b02` in the experiment corpus return different row sets (`p08 p09` versus `p04 p08 p09`). But the per-constraint reading is exactly what an `$and` of *separate* `$some` clauses means, because the per-element scope boundary **is** the `$some` boundary. Both readings remain available; only one mechanism is needed to express them.

`experiments/filter-to-sql/README.md:204-208` currently argues the opposite:

> **`$elemMatch` and `[*]` are different operators** (§5.9). `b01` and `b02` are the same two conditions written both ways, and they return different row sets (`p08 p09` versus `p04 p08 p09`). A language with only one of the two would have to pick, and would be wrong half the time.

The premise is right and the conclusion does not follow. A language with only `$some` picks nothing: it writes one `$some` for the single-element reading and two for the per-constraint reading. That bullet must be **corrected** when this decision is implemented, not merely updated — it is the one piece of in-repo evidence against Decision 1, and leaving it standing would be the most misleading thing in the repository.

**Wildcards are ungateable.** `$elemMatch` sits in the `collections` profile, so a server that cannot walk arrays declines it and reports `unsupported-operator` per [§2.1](../SPEC.md#21-profiles). Wildcards live in the path grammar, so they are present in **every** profile including `core`, and no capability document can decline them. The language's single most expensive construct is the one construct a server has no way to refuse. That is the strongest argument in the repository for consolidating, and it is a `core`-profile problem, not a `collections` one.

**Wildcards are the most expensive construct in the language.** From `experiments/filter-to-sql/README.md:257-275`: §5.9's three outcomes require two correlated subqueries wrapped in a three-branch `CASE` *per clause*, plus one table-valued join per `[*]`. `b02`, a two-clause filter, is 1135 characters of `WHERE`; the equivalent `$elemMatch` in `b01` is 652 — 1.74×. In the compiler, wildcards cost ~38 lines in the core path builder and touch five further sites (`parsePath`, `resolveField`, `constraintToSql`, `readOperand`, and an internal invariant throw), and they force `resolveField` to return two different accessor shapes. `$elemMatch` is ~23 lines, one `EXISTS`, and reuses the `arrayGuarded` wrapper (`compile.mjs:824`) that `$hasAny`, `$hasAll` and `$size` already share — it adds no new control flow at all.

**Wildcards create a specification contradiction.** [§4.2](../SPEC.md#42-missing-versus-null) grants `$exists` totality: it "is total", never UNKNOWN for the reason of absence. §5.9 revokes that for any wildcard path, because a path that resolves to nothing makes the whole constraint UNKNOWN. The `b09`/`b10` pair asks `$exists: true` and `$exists: false` on the same wildcard path and three records appear in **neither** result set. Nothing in SPEC.md acknowledges this.

**Wildcards are dead surface in operand position.** [§5.11](../SPEC.md#511-field-references--field-literal) already says a `$field` operand resolving to more than one value is UNKNOWN. The grammar permits writing one; it can never be useful.

**The repository already chose `$elemMatch`.** `tools/generate-filter-schema.mjs:199-203` says arrays "are addressed through $elemMatch instead, which is the operator with the semantics people usually mean (SPEC §5.9)". Generated schemas emit `properties` with `additionalProperties: false`, so every generated filter schema **already rejects every wildcard path**, and `examples/pet.filter.json` contains no `[*]` property key. The documented default path for exposing a resource has been wildcard-free since v0.3.0. This decision aligns the language with the tool the language already ships.

**Test exposure is one clause.** `tests/fixtures/valid/26-paths.json` is the only fixture containing `[*]`, in one of its three clauses. There is no invalid fixture for a malformed wildcard path, because the schema cannot reject one (see [Schema mechanics](#schema-mechanics)).

**What removal does not buy.** `items[0]` shares the same `index` production in §3.2, so the character-level path parser stays — all 59 lines of it, the single largest cost centre in the compiler after the operators themselves. Only the existential builder goes. Any claim that this decision deletes the path parser would be false.

### Why `$every` is included and `$none` is not

`$every` is the only genuinely additive operator in this record, and it is not redundant. The candidate rewrites both fail:

- `$every` is not `$not` over `$some`. `$not {$some {c}}` is "no element satisfies c", not "every element satisfies c".
- `$every` is not `$none` over the negated constraint either. "No element satisfies NOT c" admits elements where c is UNKNOWN; `$every` requires all of them TRUE. They diverge on exactly the records this design is trying to stop surprising people.

Universal quantification over array elements is therefore **currently inexpressible in the language**, and completing the lattice is what makes the family defensible as a family.

`$none`, by contrast, *is* exactly `$not` over `$some` — both are two-valued over elements (see [Semantics](#semantics-of-some-and-every)), so the equivalence is total, including for non-array values where both are UNKNOWN. Including it would re-introduce precisely the kind of redundant surface this record removes. It is left out, and the trade is recorded as an [open question](#open-question) rather than settled silently, because it is the one omission with a real ergonomic cost.

The net effect on the operator count is that there isn't one: −`$hasAny` −`$hasNone` −`$elemMatch` +`$some` +`$every` +`$unknownAs` leaves the language at **34 operators**, with one fewer grammar production, one fewer array-traversal mechanism, one fewer operand-set dialect, and no construct definable in terms of another.

---

## Decision 2 — keep whole-value `$in`; make the quantifier visible; unify the operand sets

**`$in` semantics do not change.** The MongoDB divergence is correct and is defended in four places already (`SPEC.md:232`, `README.md:170`, `COMPARISON.md:174`, `experiments/filter-to-sql/README.md:197-202`). The reason is that overloading makes an operator's meaning depend on data a validator cannot see, and the experiment confirmed the payoff empirically: because the split keeps the compiler total, a declared type in the binding turns `{"tags": {"$in": ["indoor"]}}` into a `400` with an `invalid-operand` problem (case `f08`) rather than an empty result set.

The defect was never the semantics. It was that the language offered **no visible quantifier**, so `$in` and `$hasAny` read as two spellings of one operator and a reader had to consult prose to learn which was which. After Decision 1 there is exactly one way to express membership and it visibly contains the quantifier:

```json
{ "tags": { "$some": { "$in": ["urgent", "p1"] } } }
```

Nothing about that form invites confusion with `{"tags": {"$in": […]}}`: one has a quantifier and one does not, and the quantifier is the thing being chosen. The `$in`-versus-membership trap survives only as an agent writing `{"tags": {"$in": ["urgent"]}}` and getting an empty set — which the generator already turns into a `400`, because a generated per-field schema gives an array-typed field the element operators and not `$in`.

Two orthogonality bugs are fixed in the same release.

**`ScalarSet` versus `OperandSet`.** `$in` and `$nin` take `ScalarSet` (`query-language-schema.json:346-354`): scalars and `null` only. `$hasAny`/`$hasAll`/`$hasNone` take `OperandSet` (`:356-363`): any JSON value, plus `$field` references and `$literal` escapes. So `{"tags": {"$hasAny": [{"$field": "x"}]}}` validates today and `{"tags": {"$in": [{"$field": "x"}]}}` does not. The divergence is undocumented, no fixture covers it, and nothing in §5.4 or §5.8 hints at it.

Resolution: **unify on `OperandSet`** and delete `ScalarSet`. `$in` becomes "the value is `$eq` to at least one member", with members drawn from the same operand grammar as every other operator — which is what §5.4 already says it means, since `$eq` accepts any JSON value including arrays and objects. Widening `$in` is backward-compatible for filters and closes the asymmetry from the permissive side, so no existing valid filter becomes invalid. `$hasAll` keeps the operand set it already had. Note the consequence to record in §7: the set-length limit row loses `$hasAny`/`$hasNone` and keeps `$in`, `$nin`, `$hasAll`.

**The `core`-has-no-membership hole is resolved by design, not left open.** `$in`/`$nin` are `core`; the quantifiers are optional `collections`. So a `core`-only server can compare whole values but cannot express element membership at all. This is correct rather than a gap, and the record should say so: `compile.mjs:420-446` shows a promoted scalar column sets `canWalk: false` and `columnAccessor` refuses to be constructed for an array-typed binding at all. A server backed by typed scalar columns has no arrays to look inside, so there is nothing for it to decline. Element quantification must stay optional for exactly the reason `collections` exists.

---

## Decision 3 — keep three-valued logic; add one orthogonal escape hatch; fix the prose

**[§4.1](../SPEC.md#41-three-valued-logic) does not change.** The case against changing it is decisive:

- **It costs almost nothing to implement.** `experiments/filter-to-sql/README.md:139` measures three-valued logic at **23 of 769 code lines — 3%** — because SQL's `AND`, `OR` and `NOT` already *are* that truth table and UNKNOWN is just SQL `NULL`. `$nor` is `NOT (a OR b)`, `$ne` is `NOT (eq)`, `$nin` is `NOT (in)`. Nothing needed rewriting into positive normal form and there is no separate UNKNOWN value to thread anywhere. The part of the specification that reads as most intimidating is the cheapest part of the compiler.
- **It is a differentiator.** `COMPARISON.md:101` sells specified null semantics against GraphQL, whose "null propagation is its most notorious sharp edge, and its filter semantics are per-vendor folklore."
- **Two-valued logic would be worse on the criterion the change is meant to serve.** Making `$ne` and `$not` null-inclusive by default means every backend emits `IS NULL OR …` guards, and it silently *widens* result sets under negation — the failure mode §2.1 already identifies as the most dangerous possible one for an authorization-adjacent filter.
- **The experiment's own single recommendation is explicitly not to change any semantics.**

The cost of three-valued logic is not in the backend. It is in the user's head, and in three-quarters of the operator descriptions. So this decision adds one escape hatch and then fixes the prose.

### (a) `$unknownAs: true | false`

A boolean modifier on a `ConstraintObject`, in the `core` profile. It resolves UNKNOWN to the stated value for that constraint. The four-line workaround §4.1 currently prescribes:

```json
{ "$or": [ { "status": { "$ne": "archived" } }, { "status": { "$isNull": true } } ] }
```

becomes:

```json
{ "status": { "$ne": "archived", "$unknownAs": true } }
```

Why a modifier and not `$neOrNull`-style sugar:

- **It is a modifier on an axis, not a new operator**, so it composes with every operator at once instead of needing one variant per negative operator (`$neOrNull`, `$ninOrNull`, `$nlikeOrNull`, …). Adding one keyword that works everywhere raises orthogonality; adding six fused operators lowers it.
- **The grammar already has this shape.** `$flags` is a modifier sibling of `$regex`, wired with `dependentRequired`. `$unknownAs` is idiomatic here in a way a new operator family would not be.
- **It lowers to one expression**: `coalesce(<pred>, TRUE|FALSE)`. Available on every backend, including the promoted-column path where the type guards otherwise collapse to nothing.
- **It cannot silently widen a result set**, because it is explicit and opt-in. A clause either says `$unknownAs` or it does not.
- **It does not collide with an existing documented equivalence.** `query-language-schema.json:213` already documents `$isNull: false` as equivalent to `$ne: null`; a null-inclusive `$ne` variant would contradict that, and a modifier does not.

Two scope rules are normative.

**It applies to the conjunction of its sibling operators, evaluated last** — outermost within the constraint object, after a field-level `$not`. For `AND` this is unambiguous, because coalescing distributes over three-valued conjunction. Writing `c` for the coalesce that maps UNKNOWN to `v` and fixes TRUE and FALSE, all nine cases agree:

| `a` | `b` | `a AND b` | `c(a AND b)` | `c(a) AND c(b)` |
| --- | --- | --- | --- | --- |
| T | T | T | T | T |
| T | F | F | F | F |
| T | U | U | `v` | `T AND v` = `v` |
| F | T | F | F | F |
| F | F | F | F | F |
| F | U | F | F | `F AND v` = F |
| U | T | U | `v` | `v AND T` = `v` |
| U | F | F | F | `v AND F` = F |
| U | U | U | `v` | `v AND v` = `v` |

So an implementation may coalesce per operator or once over the conjunction and get the same answer. It does **not** distribute over negation, which is why the ordering has to be stated rather than left to the implementer:

```json
{ "age": { "$not": { "$gt": 5 }, "$unknownAs": true } }   // coalesce(NOT x, TRUE)
{ "age": { "$not": { "$gt": 5, "$unknownAs": true } } }   // NOT coalesce(x, TRUE)
```

For an absent `age` the first is TRUE and the second is FALSE. Both are writable, and the difference is visible in the nesting.

**It is a no-op where §4.2 already grants totality** — on `$exists`, and on `$isNull` for a present value. Implementations MUST accept it there rather than rejecting it, so that a generated schema need not special-case it, but it changes nothing.

### (b) Six schema descriptions that contradict §4.1

These strings are vendored verbatim into MCP tool definitions and generated filter schemas, which makes them a first-order cause of the flagged confusion rather than a cosmetic issue. Fixing them is zero-breakage and could ship as a patch release ahead of everything else in this record.

| Location | Current description | Defect |
| --- | --- | --- |
| `$nor` (`:44`) | "None of the listed filters may evaluate TRUE." | **Wrong.** That is the two-valued reading. Under §4.1, `$nor` over a nullable field is UNKNOWN, so the record is excluded even though no listed filter evaluated TRUE. |
| `$ne` (`:109`) | "Field does not equal the operand." | The precise two-valued reading §4.1 then denies. The most misleading string in the schema, on the operator most likely to be reached for. |
| `$nin` (`:152`) | "Field equals no member of the list." | Reads as total. |
| `$nbetween` (`:141`) | "Field falls outside [lower, upper]." | Reads as total. |
| `$nlike` (`:164`), `$nilike` (`:174`) | "Negated $like." / "Negated $ilike." | §5.5 never states that these are negations *under three-valued logic*, though §5.3 and §5.4 do state it for `$nbetween` and `$nin`. |
| `$hasNone` (`:235`) | "The array-valued field contains no member of this list." | Reads as total. Removed by Decision 1, so this one resolves itself. |

Only `$not`, in both its spellings, currently states the trap correctly. Every negative operator's description must state what it does with UNKNOWN, and `$nor`'s must be rewritten rather than adjusted.

### (c) Three specification defects in the same area

All three are observable only under negation, which is why they have survived this long.

**§4.3 versus §5.1 — is a type-mismatched `$eq` FALSE or UNKNOWN?** [§4.3](../SPEC.md#43-types-and-coercion) says comparing values of different JSON types yields UNKNOWN. [§5.1](../SPEC.md#51-equality--eq-ne) defines `$eq` as structural equality, under which a string and a number are simply unequal — FALSE. The two readings are indistinguishable under `$eq` and differ under `$ne`: with FALSE, `{"notes": {"$ne": 3}}` returns the string-valued records; with UNKNOWN it does not.

Resolution: **structural equality wins — FALSE.** §5.2 restates the UNKNOWN rule for ordering specifically, which is evidence that §4.3 was written about ordering and coercion rather than about equality. The compiler already chose this reading (`compareConst`'s `mismatch` parameter, `compile.mjs:617-624`). It is a one-sentence fix to §4.3 and it changes result sets, so it must be recorded in the CHANGELOG as a behavioural break even though no filter changes shape.

**`$nor` has no truth-table row.** §4.1 gives AND, OR and NOT but defines `$nor` only by the rewrite `NOT (a OR b OR …)`, leaving the reader to derive that `FALSE NOR UNKNOWN` is UNKNOWN. That derivation *is* the trap — `cases.mjs:165` notes a corpus case is "safe here only because status is never null: $nor over a nullable field would exclude the nulls too." Add the row. While there, note that the AND/OR table has six rows rather than nine and relies on the reader knowing both are commutative; say so, or add the rows.

**§1 calls the filter "a boolean function"** (`SPEC.md:13`) while §4.1 makes it three-valued. One word, and it sets the wrong expectation in the first paragraph anyone reads.

---

## Semantics of `$some` and `$every`

The quantifiers are **two-valued over elements**: an element-level UNKNOWN is absorbed at the quantifier boundary rather than propagated out of it. This is a deliberate boundary and it must be stated, because it is a fourth place where UNKNOWN is absorbed and the specification does not currently have such a place.

- `$some(A, c)` is TRUE if some element of `A` satisfies `c`; otherwise FALSE.
- `$every(A, c)` is TRUE if every element of `A` satisfies `c`; otherwise FALSE.

"Satisfies" means the inner condition evaluates to TRUE for that element, per §4.1's rule that only TRUE matches. An element for which `c` is UNKNOWN does not satisfy it and does not block the others. This is exactly SQL's `EXISTS` over a three-valued predicate, which is why it costs one subquery, and it is what `compile.mjs` already emits for `$elemMatch`.

UNKNOWN can still arise, but only from the **field**, never from an element:

| Value of the field | `$some` | `$every` | Why |
| --- | --- | --- | --- |
| Array, some elements satisfy | TRUE | FALSE | |
| Array, all elements satisfy | TRUE | TRUE | |
| Array, no element satisfies | FALSE | FALSE | Includes the case where every element is UNKNOWN |
| **Empty array** `[]` | **FALSE** | **TRUE** | Vacuous truth. `$every` over nothing is TRUE; `$some` over nothing is FALSE |
| `null` | UNKNOWN | UNKNOWN | §5.8: the value must be an array |
| **Absent path** | UNKNOWN | UNKNOWN | §5 preamble. `$every` over a missing field is **not** vacuously TRUE |
| Non-array (string, number, object) | UNKNOWN | UNKNOWN | §5.8, and §4.3's no-coercion rule |

`$unknownAs` composes with this in the obvious way: inside the quantifier it applies per element, so `{"tags": {"$some": {"$gt": 5, "$unknownAs": true}}}` is TRUE for any non-empty `tags`; outside it, `{"tags": {"$some": {…}, "$unknownAs": false}}` turns "not an array" into FALSE.

### The one non-mechanical consequence

For an **empty array**, a wildcard clause was UNKNOWN (§5.9: "UNKNOWN if the path resolved to nothing") and the `$some` rewrite is FALSE. Under negation those differ, so `{"$not": {"tags[*]": {"$ne": "indoor"}}}` and `{"$not": {"tags": {"$some": {"$ne": "indoor"}}}}` disagree on a record whose `tags` is `[]`. The experiment corpus has such a record (`p03`) and such a case (`b07`).

This is an improvement — an empty array is a resolved value and FALSE is the honest answer about it — but it is the one place a codemod cannot claim to preserve behaviour, and it must be called out in the migration note rather than buried.

### What this does and does not do for `$exists`

Removing the wildcard production ends the §4.2-versus-§5.9 **contradiction**: there is no longer a rule that revokes `$exists`'s totality for a class of paths. `$exists` on a single-valued path is total, always, with no exceptions anywhere in the specification.

It does not make every array question total, and the record should not overclaim. `{"vaccinations": {"$some": {"type": {"$exists": true}}}}` is still UNKNOWN when `vaccinations` is absent — but that UNKNOWN is now attributable to one stated rule (a non-array value is UNKNOWN, §5.8) instead of an unstated interaction between the path grammar and §4.2. And the question `b09`/`b10` were actually trying to ask now has a total answer that wildcards could not express at all: `{"vaccinations": {"$exists": true}}`.

---

## Four of the experiment's six underspecifications close as a side effect

This is the strongest evidence that the three flagged items are one design rather than three patches. From `experiments/filter-to-sql/README.md:306-342`, "Six places where the compiler had to choose, and the choice is observable":

| Gap | Resolution |
| --- | --- |
| **#1** Is a type-mismatched `$eq` FALSE or UNKNOWN? | Decided: FALSE. See [Decision 3(c)](#c-three-specification-defects-in-the-same-area). |
| **#2** `$elemMatch`'s `anyOf: [Filter, ConstraintObject]` overlap on `$not` | Normative rule: recurse through `$not`/`$and`/`$or`/`$nor` bodies to the first key that is unambiguous — a field path, `$and`, `$or` or `$nor` makes it a `Filter`; an operator key makes it a `ConstraintObject`. Decidable, terminating, and it is the rule the compiler already invented (`compile.mjs:870-873`). |
| **#3** What does `$field` resolve against inside `$elemMatch`? | Normative: **element-relative**, consistent with the surrounding paths and with the compiler's choice. §5.11's "the same record" must be qualified. |
| **#4** Is `[*]` on a bound path the same field for authorization? | Disappears with the wildcard production. The compiler got this wrong on its first attempt, which is the sort of thing a specification should pre-empt. |
| **#6** Does `$exists` survive a wildcard path? | Disappears. See [above](#what-this-does-and-does-not-do-for-exists). |

Gap **#5** — `$size`'s nested constraint is a fourth constraint dialect, neither `Filter` nor `ConstraintObject` nor scalar — is **out of scope**. It is a real wart and it is unrelated to these three overlaps; folding it in would widen a breaking release past what the evidence supports. Recorded as a follow-up.

---

## Schema mechanics

**The path pattern cannot currently reject a wildcard.** `$defs/FieldPath` (`:78-85`) constrains only the first character — `^(?:[^$]|\$\$)`, meaning "does not begin with a single `$`". It does not encode the §3.2 grammar at all, so `[*]`, `[0]`, `.` and `\.` are entirely unvalidated.

Recommendation: add a targeted exclusion beside the existing pattern rather than encoding the whole grammar as one regex:

```json
"FieldPath": {
  "type": "string",
  "minLength": 1,
  "pattern": "^(?:[^$]|\\$\\$)",
  "not": { "pattern": "\\[\\*\\]" }
}
```

Cheap, portable across validators, and it gives the suite the invalid-path fixture it has never had. Encoding the full §3.2 grammar as a single regex is a larger change with worse validator-compatibility odds and no additional benefit here.

**The pattern literal is duplicated.** `^(?:[^$]|\$\$)` appears in `Filter.patternProperties` (`:56`) and again via `FieldPath` (`:83`), with a `$comment` at `:59` explaining that the overlap is deliberate — `patternProperties` enforces the default grammar while `propertyNames → FieldPath` is the single named override point. Any path change touches both, and the `not` above belongs on `FieldPath` only, so that a narrowed bundled copy inherits it.

**`$unknownAs` needs no `dependentRequired`.** Unlike `$flags`, it is meaningful alongside any operator, and `ConstraintObject`'s `minProperties: 1` should be raised to require at least one actual operator beside it — a constraint of `{"$unknownAs": true}` alone is not a predicate. This is expressible as a `not` over the single-property case, or by listing `$unknownAs` outside the operator set and requiring one of the others.

---

## Rubric impact

The acceptance test for this record: it must raise Simplicity and Orthogonality without regressing anything else.

| Criterion | Now | After | Why |
| --- | --- | --- | --- |
| Expressiveness | 4 | 4+ | Every removed construct has an exact rewrite. `$every` adds universal quantification over array elements, which is currently **inexpressible**. `$in` widens to the full operand grammar. |
| **Simplicity** | 3 | **↑** | Operator count is **flat at 34**. What falls: one grammar production, one of two array-traversal mechanisms, one of two operand-set dialects, four specification ambiguities, and the four-line null workaround. No operator is definable in terms of another. |
| Flexibility | 4 | 4 | Quantifiers stay optional in `collections`, so scalar-column backends are unaffected and correctly decline them. `$unknownAs` is one `coalesce`, available everywhere. |
| Community | 1 | 1 | Unaffected — and the rewrites are mechanical, so migration is a codemod rather than an adoption barrier. |
| Extensibility | 4 | 4 | The `$` namespace reservation, the profile mechanism and the single `FieldPath` override point are untouched. Removing `[*]` *simplifies* a narrowed `FieldPath` enum, which no longer needs wildcard variants of every array path. |
| Transport | 3 | 3 | No new media type, body-only, `QUERY` safety and idempotency unaffected. |
| Standardization | 1 | 1↑ | A path grammar without `[*]` sits closer to RFC 9535's non-wildcard subset — a divergence `COMPARISON.md:176` already flags as "worth revisiting before 1.0". Resolving four gaps makes the spec more implementable, which is what a standards venue asks for first. |
| Security | 4 | 4+ | Wildcards were an ungateable join-per-clause path shape that §7 had no way to bound; the quantifiers are gateable by profile. `$unknownAs` is explicit and opt-in, so no clause is ever silently widened. |
| Performance | 3 | **↑** | Removes the 1.74× wildcard SQL and the join-per-clause shape. The rewrites keep index acceleration: a compiler can pattern-match `$some: {$in: […]}` to Postgres `&&` and `$hasAll` to `@>`, which is what `$hasAny`/`$hasAll` lowered to anyway. |
| **Orthogonality** | 3 | **↑** | One quantifier axis × one predicate axis, replacing four fused constructs. Operand sets unified. `$field`-over-wildcard dead surface gone. `$unknownAs` is a modifier on an axis rather than six fused negative variants. |

---

## Costs and risks

- **`experiments/filter-to-sql/README.md:204-208` must be corrected**, not updated. Its "wrong half the time" conclusion does not follow from its premise, and it is the only in-repo argument against Decision 1.
- **Empty arrays change from UNKNOWN to FALSE** under the wildcard rewrite. The one non-mechanical migration step.
- **A type-mismatched `$ne` changes result sets** (§4.3 versus §5.1 resolved to FALSE). No filter changes shape, so this break is invisible to a codemod and must be prominent in the CHANGELOG.
- **`$unknownAs` lands in `core`**, so every implementation must support it. Justified: the failure mode it addresses is a `core` failure mode (`$ne`, `$nin`, `$not`, `$nor`), and the implementation is one `coalesce`.
- **Fixtures to rewrite:** `valid/19-collections.json`, `valid/21-elemmatch-object.json`, `valid/22-elemmatch-scalar.json`, `valid/26-paths.json`. New fixtures needed for: a rejected `[*]` path, `$some`/`$every` over an empty array, `$unknownAs` scoping against a field-level `$not`, `$unknownAs` alone in a constraint object (invalid), and the `OperandSet` `minItems`/`uniqueItems` rejections that no fixture currently covers.
- **Experiment corpus:** the whole `b` group (`b01`, `b02`, `b04`–`b07`, `b09`, `b10`) plus `a09`, `a10`, `f09`. `b09`/`b10` become a different question, not a rewritten one.
- **Documentation surface:** README's operator tables, its "Three things that will bite you" section (two of the three change), the five-point agent guidance, and the generator's `SILENT_RULES` (`:608-613`), which restates both flagged rules to models.

## Open question

**Should `$none` be included after all?** It is definitionally redundant — exactly `$not` over `$some`, including for non-array values — and this record leaves it out on that basis. The cost of leaving it out is borne by the single most common negative array predicate, which becomes a nested `$not`:

```json
{ "labels": { "$not": { "$some": { "$in": ["spam"] } } } }
```

That routes the most frequent case through `$not`, which is the operator this record spends Decision 3 trying to make less dangerous. Including `$none` costs one operator (35, not 34) and buys a spelling with no `$not` in it.

**Settled: left out.** The stance that governs this record is that a construct definable in terms of another does not earn a name, and `$none` is definable. Reconsider if the generator's output or early agent testing shows the nested form being written wrongly — that would be evidence about ergonomics that no amount of reasoning here can substitute for. It remains the one place where the two criteria this record targets pull against each other.

## Follow-ups, explicitly out of scope

- Gap #5: `$size`'s nested constraint as a fourth constraint dialect.
- Making capability-document `type` `SHOULD`-bordering-on-`MUST`, and promoting per-resource schema generation from appendix to documented default path. This is the experiment's own single strongest recommendation, it addresses the same "valid and wrong, returns empty" failure mode from the other end, and it is a larger docs change than this record should carry.
- Executing the Postgres dialect against a real Postgres. Every Postgres claim in the experiment — including the `&&`/`@>` lowerings this record leans on for its Performance argument — is currently reasoned rather than tested.

---

## Results

Measured after implementation, against the corpus in `experiments/filter-to-sql` (72 cases, 150 assertions, both bindings, executed against SQLite).

**Operator count is flat at 34.** −`$hasAny` −`$hasNone` −`$elemMatch`, +`$some` +`$every` +`$unknownAs`. One fewer grammar production, one fewer array-traversal mechanism, one fewer operand-set dialect (`ScalarSet` is gone), and no operator definable in terms of another.

**The redundancy claim held.** `b02` — the case that used to be written with two wildcard paths — returns `p04 p08 p09` when rewritten as two `$some` clauses, which is exactly what the wildcard spelling returned. That was the load-bearing prediction of Decision 1 and it is now executable rather than argued.

**The cost claim held, by more than predicted.** `b02` fell from 1135 characters of `WHERE` to **799**. Across the corpus, per-clause `WHERE` size fell from 124 to 98 characters on the hybrid binding and from 154 to 122 on the document binding, because a quantifier has two outcomes over any array where a wildcard clause had three — one `EXISTS` instead of two correlated subqueries in a three-branch `CASE`. In the compiler, *Field resolution* fell from 85 code lines to 54; the path parser did **not** shrink, exactly as predicted, because `[0]` shares the `index` production.

**Three-valued logic did not move: still 23 of 743 code lines.** The section that implements §4.1 was untouched by a release that rewrote the constructs around it, which is the strongest available evidence that keeping it was right. `$unknownAs` added one `coalesce` at the end of the constraint dispatch.

**Two behavioural changes are now demonstrated, not just documented.**

- `b13` (`{"$not": {"tags": {"$some": {"$ne": "indoor"}}}}`) returns `p03 p06`. Under the v0.3.x wildcard spelling it returned `p06` alone, because `p03`'s empty array made the clause UNKNOWN. This is the empty-array divergence, made observable.
- `c13`/`c14` differ by exactly one row (`p10`, the record with no `born`), which is the non-distribution of `$unknownAs` over negation in two filters.

**One thing the design under-specified and the implementation surfaced.** `$unknownAs: true` is *more* inclusive than the §4.1 longhand it replaces: `{"$or": [{"m": {"$ne": "X"}}, {"m": {"$isNull": true}}]}` recovers a `null` but not an absent field, because `$isNull` on absence is itself UNKNOWN, whereas `$unknownAs` resolves every UNKNOWN including absence. `c12` pins this. It is the better default for what people mean, but it is not a drop-in equivalence and the CHANGELOG says so.

**Five of the experiment's six specification gaps closed** — #1 (type-mismatched `$eq`), #2 (operand disambiguation), #3 (`$field` scope), #4 (index-suffix authorization), #6 (`$exists` under a wildcard). Gap #5, `$size`'s constraint dialect, was deliberately left open.
