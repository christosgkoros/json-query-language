# Experiment: compiling a filter to SQL

**This is an exercise, not a deliverable.** Nothing here is published, nothing
here is versioned, and nothing in `../../query-language-schema.json`,
`../../SPEC.md` or `../../tools/` depends on it. It exists to answer one
question that a specification cannot answer about itself:

> Does this design make an implementation simpler or harder than it had to be?

The method is to build the implementation and count. A compiler from a filter
to a SQL statement, a corpus of the filters a real search endpoint receives,
and a database to run them against — then measure where the code went, which
clauses cost more than they look like they should, and which parts of the
specification turned out to be unimplementable as written.

The short answer, up front: **substantially simpler, with five localised costs
and six places where the specification does not say enough to implement it
without guessing.** Both halves are detailed below.

---

## What is here

| File | |
| --- | --- |
| `compile.mjs` | the compiler: filter + binding → `{ sql, params, warnings }`, dialects `sqlite` and `postgres` |
| `dataset.mjs` | 10 fixture records, and the two bindings the corpus is compiled under |
| `cases.mjs` | 65 use cases, each with the row set SPEC.md says it should return |
| `harness.mjs` | an in-memory SQLite database, plus the ajv validation a server does first |
| `compile.test.mjs` | the corpus, executed: 136 assertions |
| `run.mjs` | command line — compile a filter, print the SQL, run the corpus, print the measurements |

```bash
npm run test:experiment                # the corpus, executed: 136 assertions
npm run experiment -- --corpus         # every case, both bindings, side by side
npm run experiment -- --metrics        # the numbers quoted below
npm run experiment -- --sql b02        # one case, both bindings, both dialects
npm run experiment -- '{"status":"available","weightKg":{"$lt":5}}'
```

## What it compiles to

The compiler resolves each field path through a **binding**, which says where
that path lives: a promoted column, or a path inside a JSON column. The corpus
is compiled twice, under two bindings over the same table — `hybrid`, where
`status`, `species`, `born`, `weightKg`, `priceCents` and `costCents` are real
columns, and `document`, where every path is resolved out of the JSON. Same
records, same expected answers, two completely different code paths through the
compiler.

`{"status": "available"}`, promoted column:

```sql
SELECT id FROM pets WHERE status = ?1 ORDER BY id            -- ["available"]
```

The same filter, JSON column (line breaks added; the compiler emits one line):

```sql
SELECT id FROM pets WHERE CASE
    WHEN coalesce(json_type(doc, ?1), 'null') = 'null' THEN NULL
    WHEN json_type(doc, ?1) = 'text' THEN json_extract(doc, ?1) = ?2
    ELSE FALSE END
  ORDER BY id                                    -- ["$.status", "available"]
```

Those two are the whole story in miniature. The three branches are not
defensive coding: they are SPEC §4.2 (a path that resolved to nothing, or to
null, is UNKNOWN), SPEC §5.1 (a value of another type is unequal, not unknown)
and the comparison itself. The column version needs none of them, because the
column's declared type answers the type question at compile time and SQL's own
NULL propagation answers the other.

## Method

**The corpus is written from the specification, not from the compiler.** Each
case in `cases.mjs` carries the ids that SPEC.md says should match, derived by
hand from the ten fixture records, plus a note giving the reasoning in section
references. That is what the assertions compare against. (Full disclosure: the
compiler was developed against about a sixth of these filters before the corpus
was written down, so the corpus is not a blind test end to end. The other
five-sixths, and every expected row set, were fixed before the first full run,
and none had to be revised after it.)

**Two bindings, cross-checked.** Beyond asserting each result, the suite
asserts that the two bindings return *the same* answer for every case, and
enumerates the exceptions. Two independent lowerings of the same semantics
agreeing on all 56 filters that compile under both is much stronger evidence
than either one matching a hand-written expectation. Exactly one case is allowed to disagree, for the
reason SPEC §4.2 predicts, and one more is rejected under one binding only.

**Executed, not snapshotted.** SQL that looks right is not evidence. Every
case-binding pair runs against a real SQLite database — `node:sqlite`, no
dependencies — and is asserted against returned rows.

**Two invariants, checked over the whole corpus in both dialects.** That no
user-supplied string — field paths included — reaches the SQL text rather than
the parameter list, and that no statement carries a parameter it never
mentions. The second one found a real defect that SQLite tolerates silently and
Postgres would reject outright: the SQLite `$regex` lowering binds `$flags` as
a parameter, the Postgres one encodes it into the choice of operator, and the
shared code path was interning the parameter either way.

**Postgres output is generated but not executed.** No Postgres was available in
this environment, so the second dialect is verified only in that it compiles,
that its shape was reviewed by hand, and that it refuses what it cannot do.
Treat every Postgres claim below as reasoned, not tested.

## Results

```
130/130 case-binding pairs match the hand-derived expectation.
136 assertions pass (65 cases × 2 bindings + 6 structural tests).
```

| | |
| --- | --- |
| Operator names in `x-profiles` | 34 |
| Compiled | 33 — every one except `$search` |
| Faithful on both dialects | 31 — `$regex`/`$flags` are faithful on SQLite only |
| Cases that compile | 56 of 65 |
| Cases rejected at compile time, with the right §8 problem type | 8, plus `c09` in the column binding only |
| Cases whose answer is legitimately binding-dependent | 1 (`c10`) |

## Where the cost went

`compile.mjs` is 1026 lines, 769 of them code. By section:

| Section | Code lines | What it does |
| --- | --- | --- |
| Operators | 209 | one function per operator family |
| Dialects | 106 | the SQLite and Postgres primitives |
| Constraints and filters | 88 | the dispatch: 34 `case` labels and the AND/OR/NOT plumbing |
| Field resolution | 85 | path → binding → accessor, including wildcard expansion |
| Compilation context | 64 | parameter interning, §7 limits, §2.1 profile gating |
| Field paths | 59 | the §3.2 path grammar |
| Accessors | 48 | the interface that hides "column or JSON" from the operators |
| Operands | 27 | `$field` / `$literal` |
| Comparison shapes | 23 | **all of the three-valued logic** |
| Entry points | 20 | |

And the emitted SQL, over the 56 filters that compile under both bindings:

| | promoted columns | JSON column |
| --- | --- | --- |
| Characters of `WHERE` per clause | 124 | 154 |
| Filters needing at least one `CASE` guard | 39 of 56 | 50 of 56 |
| `CASE` guards emitted in total | 76 | 95 |
| Filters needing no guard at all | 17 | 6 |
| Largest single filter | | 1135 chars (`b02`, two wildcard clauses) |
| Smallest | 10 chars (`born >= ?1`) | 27 chars (`json_type(doc, ?1) = 'null'`) |

Two numbers are worth staring at.

**Three-valued logic cost 23 lines.** The part of the specification that reads
as the most intimidating — a truth table, UNKNOWN propagation, the `$not`
surprise, `$ne` over nulls — is the cheapest part of the compiler, because
`AND`, `OR` and `NOT` in SQL already are that truth table. `$nor` is
`NOT (a OR b)`. `$ne` is `NOT (eq)`. `$nin` is `NOT (in)`. `$hasNone` is
`NOT (hasAny)`. Nothing needed rewriting into a positive normal form, and there
is no separate UNKNOWN value to thread anywhere: it is SQL NULL.

**The field path grammar cost 59 lines — two and a half times more.** The
feature that looks free in the specification (`a.b.c`, and by the way `\.` and
`$$` and `[0]` and `[*]`) needs a real character-level parser before anything
can be compiled, because `split(".")` is wrong for `a\.b` and `"$eqq"` has to
be distinguished from a field named `$eqq`. It is the one place in this
exercise where the specification's cost estimate and the implementation's are
inverted.

## What the design made easier

**1. There is no parser, and no error recovery.** The filter arrives as JSON,
and the published schema decides whether it is well-formed. `harness.mjs`
spends a dozen lines on ajv, and `compile.mjs` contains not one line of structural
validation, no lookahead, no "expected token" messages, no partial parse tree.
Every error path that remains is *semantic* — unknown field, unsupported
operator, invalid operand, too complex — and every one of them maps to a
SPEC §8 problem type. `f05` (`{"name": {"$eqq": "Ada"}}`) is rejected before
the compiler is even called, by `additionalProperties: false` on the constraint
object. A text DSL — OData `$filter`, a SQL-ish `WHERE` string — would have put
a lexer, a precedence-climbing parser and a diagnostics layer in front of
everything above, and none of that code would have been about querying.

**2. SQL-flavoured operators mostly pass through.** `$like` *is* SQL `LIKE`,
including `%`, `_` and `\` escaping, so the pattern is forwarded to the engine
untouched after a validity check; `$ilike` is Postgres `ILIKE`; `$between` is
two comparisons; `$in` is `IN (…)`; `$gt` is `>`. The one place the borrowed
syntax cost something is that `$startsWith`/`$endsWith`/`$contains` are
specified as *literal* (§5.6), so their operands have to be escaped *into* a
LIKE pattern — 1 line, and easy to forget, which is exactly why `a08`
(`{"name": {"$contains": "50%"}}`) is in the corpus.

**3. Structural decisions that a compiler cannot second-guess.** Three of them
paid for themselves repeatedly:

- **`$in` is not overloaded for arrays** (§5.4). In MongoDB, `{"tags": {"$in": ["a"]}}`
  means one thing if `tags` is an array and another if it is a scalar, so a
  compiler either inspects the data it cannot see or emits both branches. Here
  it is one branch, always. The cost of the split is a documented trap for
  users; the benefit is that the compiler is total.
- **Arrays and objects are excluded from the scalar shorthand** (§5.1), so
  `{"tags": ["a"]}` never has to be disambiguated.
- **`$elemMatch` and `[*]` are different operators** (§5.9). `b01` and `b02`
  are the same two conditions written both ways, and they return different row
  sets (`p08 p09` versus `p04 p08 p09`). A language with only one of the two
  would have to pick, and would be wrong half the time.

**4. Profiles and limits are machine-readable.** The compiler reads
`x-profiles` out of the grammar rather than restating it, so operator gating is
a map lookup and a membership test that cannot drift from the published
document. The §7 limits are two counters and a length check — about 25 lines,
most of it the problem objects, for the whole `query-too-complex` story.

**5. The error model falls out of the recursion.** SPEC §8 wants an RFC 9457
problem carrying a JSON Pointer to the offending clause. The compiler is
already recursing with that pointer to look things up, so every `throw` gets it
for free, and `unknown-field` can attach `queryableFields` because the binding
*is* the list. This is the rare specification requirement that costs less to
satisfy than to skip.

## What the design made harder

**1. "No coercion" is the single most expensive rule.** SPEC §4.3 says
comparing different JSON types yields UNKNOWN. Neither SQLite nor Postgres does
that: both define a *total* order across types. `'abc' > 5` is TRUE in SQLite,
and jsonb orders values by type when the types differ
(`Object > Array > Boolean > Number > String > Null`) rather than declining to
compare them. So every ordering comparison against a
JSON-bound path needs an explicit `CASE WHEN <type test> THEN … ELSE NULL END`,
and getting it wrong is invisible until someone writes a `$not`, because
`WHERE FALSE` and `WHERE UNKNOWN` return the same rows and `WHERE NOT FALSE`
and `WHERE NOT UNKNOWN` do not. That is where most of the 154 characters per
clause and 50-of-56 guarded filters come from.

It is also the rule most cheaply *avoided*: a declared type in the binding
removes the guard entirely (124 chars/clause, 17 filters with no guard at all)
and, better, turns a mistyped operand into an `invalid-operand` problem instead
of a silent empty result — which is what §4.3 asks servers to do, and what the
capability document of §2.2 exists to make possible. `f04`
(`{"weightKg": {"$gt": "heavy"}}`) is an error here only because the binding
declares the type.

**2. Missing-versus-null (§4.2) is free on one backend and impossible on
another.** On JSON it hinges on one primitive that is easy to miss:
`json_extract` returns SQL NULL for both an absent path and a JSON null, so the
whole distinction rests on `json_type` (`jsonb_typeof` in Postgres) instead —
NULL for absent, the string `'null'` for a present null. Once you use it,
`$isNull` is one expression — `json_type(doc, ?1) = 'null'`, whose NULL
propagation *is* the specified UNKNOWN, and the shortest predicate this
compiler emits for anything — and `$exists` is `IS NOT NULL`. On a relational column the distinction does not exist at all,
and the compiler rejects `$exists` — which is exactly what §4.2 tells it to do,
and the reason this experiment has a rejection rather than a wrong answer
(`c09`). `c10` is the residue: `{"species": {"$isNull": true}}` returns nothing
under the document binding and one row under the column binding, and both are
conformant, because §4.2 only requires the endpoint to *document* which state
it reports. It is the only case in the corpus whose correct answer depends on
where the data is stored.

**3. Wildcard paths are the most expensive construct in the language.** SPEC
§5.9's existential rule has three outcomes — TRUE if the constraint holds for
some resolved value, FALSE if for none, UNKNOWN if nothing resolved — which
means two correlated subqueries (one asking whether anything resolved, one
asking whether the constraint held) wrapped in a three-branch `CASE`, per
clause, plus one table-valued join per `[*]`. `b02`, a two-clause filter, is
1135 characters of `WHERE`; the equivalent `$elemMatch` in `b01` is 652.
Nothing is wrong with the semantics — they are the only sane reading — but a
server that advertises `collections` on a large table is advertising a
join-per-clause, and the specification's §7 advice about restricting expensive
operators to indexed fields understates the problem: this is not an expensive
*field*, it is an expensive *path shape*.

There is also a spec-level oddity that only shows up here. `b09` and `b10` ask
`$exists: true` and `$exists: false` on the same wildcard path; the three
records with no vaccinations at all appear in *neither*, because §5.9 makes any
wildcard constraint UNKNOWN when the path resolves to nothing — which costs
`$exists` the totality §4.2 grants it everywhere else.

**4. `$regex` is specified in a dialect no SQL engine implements.** §5.7 says
ECMA-262. SQLite has no built-in `REGEXP` implementation, so the harness
registers a `jql_regex()` function backed by a JavaScript `RegExp` — which
makes SQLite the *more* conformant of the two dialects, at the cost of a
backtracking engine inside the query, precisely the ReDoS surface §7 warns
about. Postgres has `~` and `~*`, but they are POSIX ARE, which overlaps
ECMA-262 without matching it: `.` matches a newline by default (in ECMA-262 it
does not, absent `s`), `\d` and `\w` are locale-dependent character classes
rather than ASCII sets, `\p{…}` does not exist, and there is no separable
equivalent of `m` and `s`, because Postgres fuses those two behaviours into its
`(?n)`/`(?p)`/`(?w)` options. So the Postgres dialect refuses `$flags`
containing `m` or `s`, and warns on every pattern it does emit.
own advice — leave `regex` out of the advertised profiles and point clients at
`$like` — is the only fully honest option on a stock SQL engine, and this
exercise is evidence for taking it.

**5. Composite equality, and a gap in the problem taxonomy.** `{"$eq": {…}}` on
an object operand is well-formed, and Postgres jsonb `=` implements it
directly (member order insensitive, numbers compared as numerics). SQLite has no
order-insensitive JSON comparison, so the compiler refuses. There is no §8
problem type for that: `unsupported-operator` overstates it (the operator is
supported; the *operand shape* is not) and `invalid-operand` misplaces the
blame (the operand is perfectly valid). `f07` uses `unsupported-operator` and
says so in the detail, but the taxonomy is operator-granular while backends
fail at operator × operand-shape granularity.

## What the specification does not say

Six places where the compiler had to choose, and the choice is observable:

1. **§4.3 versus §5.1 — is a type-mismatched `$eq` FALSE or UNKNOWN?** §4.3
   says comparing different types yields UNKNOWN; §5.1 defines `$eq` as
   structural equality, under which a string and a number are simply unequal.
   The two readings are indistinguishable under `$eq` and differ under `$ne`:
   with FALSE, `{"notes": {"$ne": 3}}` returns the string-valued records; with
   UNKNOWN it does not. This compiler chose structural equality (FALSE),
   because §5.2 restates the UNKNOWN rule for ordering specifically, which
   suggests §4.3 was written about ordering and coercion. It should be stated
   outright — it is a one-sentence fix and it changes result sets.
2. **`$elemMatch`'s operand shape is ambiguous.** The schema says
   `anyOf: [Filter, ConstraintObject]`, and the two overlap: `{"$not": …}` is
   valid as either, with different meanings for what is inside. The compiler
   guesses — anything that can only be a `Filter` (a field key, `$and`, `$or`,
   `$nor`) makes it a `Filter`, otherwise a constraint object. Two
   implementations could reasonably guess differently.
3. **What does `$field` resolve against inside `$elemMatch`?** §5.11 says "the
   same record"; §5.8 says paths inside `$elemMatch` are relative to the
   element. `{"items": {"$elemMatch": {"qty": {"$gt": {"$field": "limit"}}}}}`
   has two defensible readings. This compiler resolves it against the element,
   for consistency with the surrounding paths.
4. **Is `[*]` on a bound path the same field, for authorization purposes?**
   §3.5 requires rejecting a path the endpoint does not expose. If `tags` is
   exposed, is `tags[*]` exposed? (This compiler says yes for index and
   wildcard suffixes, no for named members unless the subtree is exposed — it
   was a bug the first time round, which is the sort of thing the spec could
   pre-empt in one clause.)
5. **`$size`'s nested constraint is a fourth constraint dialect.** It is
   neither a `Filter` nor a `ConstraintObject` nor a scalar, but its own
   integer-only object in the schema. Nothing is wrong with it; it just means
   the compiler has one more shape to special-case for one operator.
6. **Nothing says whether `$exists` survives a wildcard path** — see the
   `b09`/`b10` pair above.

None of these are structural problems. All six are sentences.

## Verdict

**Simpler, and the difference is not marginal.** The two decisions that
dominate are that a filter is JSON described by a published schema (which
deletes the front end of a conventional query-language implementation, along
with its entire class of diagnostics) and that the evaluation semantics are
SQL's own three-valued logic (which makes the logical operators a transcription
rather than a translation). 769 lines of one dependency-free file cover 33 of
34 operators across two storage layouts and two dialects — one of them
executed against a real database — and the part everyone worries about,
UNKNOWN, is 23 lines of it.

The costs are real but they are localised, and every one of them is a place
where the specification chose fidelity over convenience: no coercion, missing
distinct from null, existential wildcards with three outcomes, ECMA-262
regular expressions. What is interesting is that they do not all fall on the
same side. Missing-distinct-from-null and wildcard paths are cheap on a
JSON-native store and impossible on a table of typed columns; no-coercion is
exactly the other way round — free where a column declares its type, and the
dominant cost in the emitted SQL where the value could be anything. Only the
regex dialect is a problem no binding can fix.

That asymmetry is the finding under the finding. "Conforming implementation"
means something materially different on a jsonb column than on typed columns —
different rejections, and in `c10`'s case a different result set for the same
filter — and §2.2's capability document is the only thing that tells a client
which of the two it is talking to. It is doing much more work than its two
paragraphs suggest.

If one thing were worth changing before 1.0 on the strength of this exercise,
it is not any of the semantics; it is that **`type` in the capability document
should be `SHOULD` bordering on `MUST`, and generating a per-resource filter
schema should be the documented default path** rather than an appendix. The
declared type is what let this compiler reject `{"weightKg": {"$gt": "heavy"}}`
and `{"tags": {"$in": ["indoor"]}}` instead of returning empty result sets, and
it is what collapsed the type guards that otherwise dominate the emitted SQL.
The design's own answer to its worst failure mode — a well-formed filter that
silently matches nothing — is already in the repository as
`tools/generate-filter-schema.mjs`, and it is undersold.

## What this does not show

- **No Postgres was executed.** The dialect compiles and was reviewed, but
  every claim about it is reasoned rather than tested. The jsonb path
  navigation, the `jsonb_array_elements` guard, the `::numeric` casts under
  type guards and the `#>> '{}'` text extraction all need running before they
  should be believed.
- **No performance or index analysis.** Character counts are a proxy for
  complexity, not for cost. Whether these predicates are *plannable* — whether
  `LIKE 'A%'` on a JSON path uses an expression index, what a
  join-per-wildcard-clause does to a million rows — is a separate experiment,
  and the more important one for anyone deploying this.
- **One resource shape, ten records.** The corpus covers the operators and the
  edges of the semantics, not the space of data models. Nothing here exercises
  arrays of arrays, deep recursion, or a resource whose queryable set is large
  enough for `queryableFields` in a problem response to be impractical.
- **`$search` was not attempted.** It cannot be compiled into a predicate at
  all: it needs an index that a compiler cannot synthesise. The specification
  is right to leave it server-defined, and this exercise has nothing to add
  beyond confirming that the operator's cost lives entirely outside the
  compiler.
- **No `$field` authorization check.** §5.11 requires a referenced path to be
  authorized as a read. The compiler resolves it through the same binding, so
  the check happens, but no case here tests an *unauthorized* reference.
