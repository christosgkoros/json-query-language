# Experiment: from intent to filter

**This is an exercise, not a deliverable.** Nothing here is published, nothing
here is versioned, and nothing in `../../query-language-schema.json`,
`../../SPEC.md` or `../../tools/` depends on it. It exists to answer one
question the repository has been asserting the answer to:

> Given the same information need and the same documentation budget, does a
> model produce a *correct* query more often against a JSON-Schema-described
> predicate language than against a documented search string, a prose-documented
> bespoke JSON query language, or fixed scalar parameters — and, separately,
> does it *know* when it has failed?

`README.md:3` says the model "needs nothing else to use it". `:37` says "no
prompt teaching the syntax, no few-shot examples, no steering". `:210` says a
rejection is "enough for an agent to repair its own request in one round trip",
and that every other approach fails as "an empty result set, which an agent
cannot distinguish from 'no such records'". `COMPARISON.md:107-110` says the
same to GraphQL and cites the README, which cites nothing. None of it has been
measured; nothing in this repository had ever called a model before this
directory existed.

**The predictions are committed before the run.** The seven hypotheses below,
and the conditions that would refute each, are in this file's first commit; the
results go in a second one, reported against each numbered prediction including
the ones that miss. Two of the seven predict *against* the repository's
interest. They are the reason the other five are worth believing.

**Status: run, and the headline prediction is refuted.** On GPT-5.5, across
1,890 calls, the two prose-documented arms beat both schema arms on accuracy
*and* on the silent-failure rate that this repository argues is the thing that
matters. Details under Results, reported against each numbered prediction.

**The plan changed once, under duress.** It was designed for Claude Opus 5 and
Haiku 4.5. No working Anthropic key was available, and the three keys that did
work — OpenAI, Google, Groq — turned out to make a better experiment: the claim
under test is about "a model", not about one vendor's models, so three
independent families answer an objection two models from one family could not.

---

## What is here

| File | |
| --- | --- |
| `questions.mjs` | one natural-language question per case, the authoring rule, and the excluded set with reasons |
| `corpus.mjs` | the 63 graded questions, assembled |
| `arms/` | five interfaces: tool definition, validation, translation |
| `arms/docs/` | the two prose-documented arms' tool descriptions, verbatim |
| `differential.mjs` | 200 generated records, used only to tell two filters apart |
| `grade.mjs` | outcome classification and the mistake detector |
| `runner.mjs` | batch submission and collection |
| `report.mjs` | every number that appears below |
| `gold.test.mjs` | the thirteen checks that must pass before anything is paid for |

```bash
node --test experiments/intent-to-filter/gold.test.mjs   # 13 pre-flight checks
node experiments/intent-to-filter/report.mjs             # the corpus, before any run
node experiments/intent-to-filter/runner.mjs --dry-run   # cost estimate, sends nothing
node experiments/intent-to-filter/runner.mjs --pilot     # 15 cases, one model, ~$1
node experiments/intent-to-filter/runner.mjs --run       # the full run
```

## Method

### The answer key was written before the question

`../filter-to-sql/cases.mjs` holds 72 cases, each with a gold filter and the row
set SPEC.md says it returns — *"derived by hand from the fixture records rather
than from any implementation"*, and cross-validated by compiling every case two
different ways. It was written months ago to measure compiler complexity. That
it long predates this experiment is the single best property here: the answer
key cannot have been chosen to flatter the language.

What it lacks is an information need. Its `title` names the mechanism under test
— "The §4.1 surprise: `$not` over a nullable field" — which, handed to a model,
is the answer. So `questions.mjs` adds one question per case under a rule that
`gold.test.mjs` enforces:

> A question may name fields and values. It may not contain an operator, a
> syntax token, or a structural concept belonging to any arm.

Twelve cases cannot be phrased under that rule and are excluded, each with a
published reason. Two kinds recur, and they say different things: *no user
intent* (nobody asks for "a weight greater than the word heavy" — but a
specification still has to pin the behaviour down) and *not separable* (c06 has
a real intent, identical in both words and rows to c05; grading both would
double-count one question). Sixty survive, and three more are written here to
tempt the three mistakes the README catalogues. Those three are tagged
`authored` and never averaged into the inherited numbers.

### Every arm is evaluated by the same evaluator

Each arm translates whatever the model produced into a filter, and every filter
is then compiled and run by the same compiler from `../filter-to-sql`, against
the same ten records. No arm has its own semantics, so none can win or lose
because its executor treated a null differently. What an arm owns is its
translation and its rejections — which is the thing under test.

### Right rows is not the same as right filter

Across the 62 corpus cases with a row-set answer there are only **44 distinct
row sets** over ten records: `a01`, `a17` and `a20` all return the same six ids.
Grading on rows alone would pass a wrong filter that lands on the right rows,
and with ten records that is not long odds.

So `differential.mjs` generates two hundred more records from a fixed seed,
dense where filters are easy to confuse — present-nulls beside absent keys,
empty arrays, values exactly on the range boundaries the corpus uses, the
occasional status outside the documented domain. A candidate counts as correct
only if it returns the gold rows on the ten authoritative records *and* agrees
with the gold filter on the two hundred. The ten keep their authority; the two
hundred only compare candidate to gold, so nothing here needs hand-checking.

It works: the gold filters produce 44 distinct row sets over ten records and
**58 of 58** over two hundred, leaving no pair the grader cannot separate.

### The arms

| Arm | What the model sees | Tool tokens | Ceiling |
| --- | --- | --- | --- |
| `jql-generated` | a schema generated from the resource, per-field operators and domains | 15,407 | 4 |
| `jql-published` | the published grammar, `FieldPath` narrowed. No domains | 3,656 | 0 |
| `search-string` | `{q: string}` and 647 tokens of syntax | 741 | 10 |
| `bespoke-json` | `{where: object}` and 747 tokens of prose | 873 | 0 |
| `fixed-params` | ten typed scalar parameters | 311 | 54 |

**`search-string` is not a strawman.** Every construct is lifted from Lucene,
Elasticsearch query-string or GitHub search: wildcards, `[lo TO hi]` ranges,
`/regex/i`, `_exists_`, `_missing_`, quoted field names, boolean grouping,
`count()` and `first()`. Its parser is deliberately generous, accepting every
variant spelling it can — a stingy parser would manufacture rejections and hand
the comparison to the schema arms, which is the easiest way to fake this whole
experiment. On one axis the string syntax is frankly *better* than the filter
grammar: `tags:indoor` means any-element without naming a quantifier, which is
exactly the mistake `$in` invites.

**`bespoke-json` is the real control.** It is near-isomorphic to the filter
grammar, resolution of unknowns included, so its ceiling is empty by design. The
claim under test is that describing a language *with a schema* beats describing
it *with prose*; holding the language constant is the only way to isolate that.
It is deliberately not Mongo-shaped — the filter grammar is Mongo-adjacent
(`COMPARISON.md:174`), and a `$eq`/`$in` competitor would measure familiarity.

**The documentation budget binds the two prose arms only**, at 700 tokens ±10%.
It does not bind the schema arms, whose whole claim is that they need no prose,
and `gold.test.mjs` asserts their descriptions stay under 100 tokens and never
mention `$unknownAs`, `$some`, three-valued logic or nulls. The budget was set
*after* both prose documents were drafted, at the length the longer needed, and
the shorter was left as written rather than padded — fixing the number first and
cutting to hit it would mean deciding how good a competitor's documentation is
allowed to be.

### A ceiling is not a failure

Every arm has a hand-written gold query for every case, and `gold.test.mjs`
executes all of them: 63 cases × 5 arms, each asserted to return the gold answer
through that arm's own executor. Where an interface provably cannot put a
question, the case is counted as that arm's **expressivity ceiling** and dropped
from its accuracy denominator, not marked wrong. Without this, `fixed-params`
would score near zero for reasons that have nothing to do with how well a model
uses it.

Four of `jql-generated`'s ceiling entries are findings in themselves, and the
README does not currently mention any of them. A generated schema cannot express
a `$field` cross-field comparison (the generator narrows `$gt`'s operand to the
field's own type, leaving no room for a reference operand, so the whole `refs`
profile is unreachable); it withholds pattern matching from enumerated domains,
which is correct and still costs the case; and it emits no indexed paths.
`jql-published` expresses all four. The recommended setup is *less* expressive
than the cheap one, and that trade-off is currently undocumented.

### Outcomes

| Class | |
| --- | --- |
| `correct` | gold rows on the ten, and equivalent to the gold filter on the two hundred |
| `loud-failure` | rejected by validation or parse — **the agent is told** |
| `silent-failure` | accepted, executed, wrong rows — **the agent is not told** |
| `fabrication` | an unanswerable question answered with an invented field |
| `correct-abstention` | an unanswerable question reported as unaskable |
| `no-call` / `refusal` | no tool call, or the model declined |

**The headline is the silent-failure rate and the loud:silent ratio, not raw
accuracy.** For an agent, an interface that is wrong often but always says so
beats one that is wrong half as often and never does. That is the repository's
actual argument, and it is the one worth testing.

Five trials per cell, with Wilson intervals: sampling parameters are rejected on
Opus 5, so runs are non-deterministic and a single-shot number would be
dishonest. Repair is measured as `acc@2 − acc@1` over turn-1 loud failures, with
the rejection fed back as a tool result flagged `is_error`, exactly as
`examples/mcp-server` returns it.

## Predictions, committed before the run

| # | Prediction | Refuted if |
| --- | --- | --- |
| H1 | `jql-generated` has the lowest silent-failure rate: ≤10%, against ≥25% for `search-string` | the gap is under 10 points — the central README claim is then unsupported and has to be softened |
| H2 | `jql-generated` has **more** turn-1 loud failures than `search-string` — a bigger surface to get wrong — but they convert | it has fewer of both, which is a stronger result than predicted and should be said so |
| H3 | Repair yield ≥15 points for the schema arms, ≤5 for `search-string` | the schema arms yield ≤5 — "one round trip" is rhetoric, and five places in the repository need rewriting |
| H4 | `jql-published`'s silent rate is 2–3× `jql-generated`'s: same syntax, no domains | they are equal — then the generator is not earning its 4.2× token cost |
| H5 | The `$ne`-drops-nulls mistake is **not** reduced by the generated schema, because it is prose-only; the ablation shows `SILENT_RULES` is what moves it | the generated schema reduces it anyway — then the validation/prose split is wrong |
| H6 | `fixed-params` cannot express ≥40% of the corpus, but is the **most accurate** arm on what it can | it is not most accurate on its answerable subset — the ceiling argument is weaker than assumed |
| H7 | `jql-generated` costs ~20× `search-string`'s input tokens; at low volume the string arm wins on accuracy-per-dollar | the schema arm is cost-competitive per correct answer — a stronger claim than the repository currently makes |

H6's ceiling is already known, before any model is called: `fixed-params` can
put **9 of 63** questions, an 86% ceiling against the 40% predicted. The
prediction is recorded as written and scored as a miss.

### What each outcome would change

- **H1, H3, H4 holding** does not license "agents are better at this language".
  It licenses a narrower and more defensible claim — *fails loudly instead of
  silently, and recovers* — with a number attached. `README.md:37` and `:210`
  get rewritten to that, and `COMPARISON.md:107-110` gets a citation instead of
  a cross-reference to itself.
- **H5 holding** is actionable: add `$ne` and `$nbetween` to the generator's
  `SURPRISING` set (`tools/generate-filter-schema.mjs:65-70`). `$not` keeps its
  prose under the default `brief`; `$ne`, where the canonical mistake actually
  lives, does not.
- **H6 and H7** give the boundary — when *not* to reach for this. A repository
  that publishes its own boundary is why the rest of it is believable.

## Findings that did not need the run

Three, all about the path README §"Exposing search to an agent" tells the reader
to take. Each is reproducible from this directory.

### 1. Gemini cannot host the recommended setup at all

Its function-declaration schema is a restricted subset with **no `$ref` field**.
Inlining `pet.filter.json` into a tool declaration returns HTTP 400. The schema
cannot be flattened into a finite tree either, because the grammar is recursive
(`$and`, `$or`, `$nor` and `$not` all take `{"$ref": "#"}`), so there is no
version of the recommended setup that Gemini will accept. Both schema arms are
unavailable there, and on that provider the string syntax wins by walkover.

### 2. OpenAI accepts the schema and silently discards 94% of it

The generated schema is 61,354 characters, of which the `$defs` block is 57,756
— every operator description and every per-field value domain. OpenAI's function
parameters do not carry `$defs`. The request succeeds, with no warning:

| tool as sent | input tokens billed |
| --- | --- |
| `pet.filter.json` inlined, as the README describes | **704** |
| the same schema with every `$ref` resolved first | **14,089** |

At 704 tokens the model is receiving a list of field names and a set of dangling
references. The grammar never arrives. `examples/mcp-server` ships the schema
this way, and `README.md:232` prices it at "about 42 KB… paid once per session".

Flattening is the fix, and it is not free: it has to cut the recursion at a fixed
depth, so the model is told nesting stops sooner than the server will accept.
`deref.mjs` measures the trade — depth 1 is 65,775 characters, depth 2 is
245,904, depth 3 is 280,526. The experiment runs `jql-raw` and `jql-generated`
side by side so the gap between the documented setup and a working one is a row
in the results rather than a claim in this paragraph.

### 3. The generated schema is not a narrowing, and the soundness test cannot see it

Found by gpt-5.4-mini during the pilot, not by hand. Answering c05 it emitted:

```json
{"microchip": {"$unknownAs": false}}
```

The published grammar **rejects** this. `$defs/ConstraintObject` carries

```json
"dependentSchemas": { "$unknownAs": { "minProperties": 2 } }
```

because `$unknownAs` is a modifier and needs an operator to modify — pinned by
`tests/fixtures/invalid/24-unknownas-alone.json`. The generator does not emit
that rule, so every generated per-field constraint object accepts a lone
`$unknownAs`. The committed `examples/pet.filter.json` accepts it too.

Downstream, `../filter-to-sql` compiles it to `coalesce((), FALSE)` and SQLite
rejects the statement. A server built exactly as the README recommends answers
500 to a filter its own published schema called valid.

This contradicts `README.md`:

> **Narrowing only.** Every filter the generated schema accepts is also valid
> against the published grammar… `tests/generator.test.mjs` asserts this.

It does not assert it. It iterates a hand-written list of fifteen filters
somebody thought of. The property is universally quantified and the test is an
enumeration, so it can only ever find the counterexamples already known. A model
found a new one on its first pass.

Recorded here and deliberately left unfixed: the repair belongs in its own
change, against `tools/generate-filter-schema.mjs`, and it should replace the
enumeration with a property check that fuzzes generated schemas against the
published grammar.

## Results

**GPT-5.5, 63 questions x 6 arms x 5 trials, 1,890 calls, no failures.** This is
the substantive result. The other two providers could not complete: Groq
rate-limited and Gemini exhausted its free-tier daily quota, so their accuracy
columns are too thin to read and are reported only for the infrastructure
findings above.

```
  arm                 n   correct    loud   silent  loud:silent
  jql-raw           295   66% ± 5     24%       4%          6.0
  jql-generated     295   79% ± 5      9%       9%          1.0
  jql-published     315   44% ± 5     39%       6%          6.2
  search-string     265   89% ± 4      2%       5%          0.4
  bespoke-json      315   86% ± 4      0%       7%          0.0
  fixed-params       45  100% ± 4      0%       0%            —
```

A documented search string beat a generated JSON Schema by ten points, and a
prose-documented bespoke JSON language beat it by seven — at a fifteenth of the
token cost. The schema arms were not close.

### Against the predictions

| # | Predicted | Measured | |
| --- | --- | --- | --- |
| H1 | `jql-generated` lowest silent rate: ≤10% against ≥25% for `search-string` | 9% against **5%**. `jql-generated` has the *highest* silent rate of the three working arms | **refuted** |
| H2 | more loud failures than `search-string`, but they convert | more loud (9% vs 2%), and they do not convert — 4% repair yield | **half refuted** |
| H3 | repair yield ≥15% for schema arms, ≤5% for `search-string` | `jql-generated` 4%, `jql-published` 2%. The only arm that repairs well is `jql-raw` at 36%, because its errors are trivial ones caused by the model never seeing the schema | **refuted** |
| H4 | `jql-published` silent rate 2–3× `jql-generated`'s | 6% against 9% — the *published* grammar is lower. It fails loudly instead, at 39% | **refuted** |
| H5 | the `$ne`/nulls mistake is not reduced by the generated schema | 5% against 8% published and 6% raw. Within noise; the prose arms are 6% and 10% | **confirmed** |
| H6 | `fixed-params` unanswerable for ≥40%, most accurate on the rest | 86% unanswerable, and 100% correct on the nine it can put | **confirmed** (the 40% was already a recorded miss) |
| H7 | ~10–20× the input tokens of `search-string`; the string wins per-dollar | 14,086 against 938 tokens a call, and **19,044 tokens per correct answer against 1,243** — 15× the cost *and* lower accuracy | **confirmed, and worse than predicted** |

### What did work

Within the JQL family the design decisions pay off in the order the repository
claims, and by large margins: `jql-published` 44% → `jql-raw` 66% → generated
and flattened 79%. Generation is worth 35 points over the bare grammar. So the
generator earns its place — the argument it does not survive is the one against
*other interfaces*.

The clearest single win is the authored probe m03, "Which pets have the status
Available?", where the closed domain is stated in the schema and nowhere else:

```
  m03 — value-outside-domain
      jql-generated   correct  5/5   loud 0   silent 0
      jql-raw         correct  0/5   loud 5   silent 0
      jql-published   correct  0/5   loud 0   silent 5   <- the predicted failure
      search-string   correct  5/5   loud 0   silent 0
      bespoke-json    correct  5/5   loud 0   silent 0
```

`jql-published` fails exactly as README §"Exposing search to an agent" says it
will — five silent empty result sets. The generated schema fixes it. But so do
both prose arms, for a reason the README does not consider: the model simply
normalised the case on its own. The domain in the schema is doing work that the
model was going to do anyway.

The other two catalogued mistakes barely appeared. `$in`-as-membership: zero
occurrences on any arm. `$ne`-drops-nulls was the only common mistake, at 5–10%
everywhere, and no arm's design reduced it much.

### What this costs the repository's claims

`README.md:3` — "the model needs nothing else to use it" — survives in the
narrow sense that no prompt was needed. It does not survive as an argument for
*choosing* this interface: on this corpus, 600 tokens of prose describing a
Lucene-style string outperformed 14,000 tokens of generated schema.

`README.md:210`, that other approaches fail as silent empty result sets while
this one fails loudly, is contradicted. `bespoke-json` had a **0.0** loud:silent
ratio and still beat the schema arms on accuracy; `jql-generated` had the worst
silent rate of the three.

`COMPARISON.md:107-110` — "a great deal from a grammar it can be handed,
validated against, and corrected by in one round trip" — has now been measured
in all three parts. Handed: only one of three providers can receive it.
Validated against: yes, and it rejects 9% of what the model writes. Corrected in
one round trip: 4%.

## Verdict

**The agent-first positioning is not supported by this run and should be withdrawn
or heavily qualified.** The language is fine. The comparative claim made about it
is what fails, and it fails precisely where it is loudest.

**1. The claim is specifically about agents, and agents is where it loses.**
`README.md:3` calls this "a search interface for agents". Six hundred tokens of
prose describing a Lucene-style string produced correct answers 89% of the time;
fourteen thousand tokens of generated JSON Schema produced 79%. Per correct
answer that is 1,243 tokens against 19,044 — fifteen times the cost for ten
points less accuracy. A bespoke JSON language documented only in prose, with no
schema at all, also beat it, at 86%.

**2. The mechanism the repository actually argues for did not appear.** The case
in `README.md:210` is not that this is more accurate; it is that other approaches
"fail as an empty result set, which an agent cannot distinguish from 'no such
records'" while this one fails loudly and recovers in one round trip. Measured,
`jql-generated` had the **highest** silent-failure rate of the three working arms
— 9%, against 5% for the search string and 7% for the prose JSON — and a repair
yield of **4%**, not one round trip. `bespoke-json` scored a loud:silent ratio of
0.0, the worst possible on this metric, and still beat both schema arms.

**3. It cannot be delivered to two of the three providers tested.** Gemini's
function declarations have no `$ref`, and the grammar is recursive so it cannot
be flattened; after flattening anyway, `dependentRequired` and `patternProperties`
are missing too. Groq rejects the flattened schema as too large and fails
tool-call validation on the raw one. OpenAI accepts the raw schema and silently
discards the 94% of it that lives in `$defs`, so it only works if you dereference
it yourself first — which the README does not mention and `examples/mcp-server`
does not do. An interface that reaches one of three major providers intact is not
yet a search interface for agents.

**4. The mistakes it prevents are largely mistakes a strong model no longer
makes.** This is the uncomfortable one. `$in`-as-array-membership, one of the
three canonical failures the README is built around, occurred **zero times on
every arm**. On the closed-domain probe the generated schema scored 5/5 — and so
did the search string and the prose JSON, because the model normalised "Available"
to "available" without being told the domain. The domain in the schema was doing
work the model was going to do anyway. Only `$ne`-drops-nulls was common, at 5–10%
across every arm, and no arm's design reduced it meaningfully.

### What survives

Within the family, the design decisions pay off in the claimed order and by large
margins: the bare narrowed grammar 44%, shipped raw 66%, generated and flattened
79%. **Generation is worth 35 points**, so the generator earns its place. And the
one case where the published grammar fails exactly as predicted — five silent
empty result sets on `{"status": "Available"}` — is exactly the case generation
fixes. The internal argument of this repository is sound. The external one is not.

### What would change the verdict

One model completed. Groq and Gemini ran out of rate limit and quota, so the
cross-provider accuracy comparison the design was built for does not exist. Sixty
three questions, one resource, ten records. And the comparison is against a search
syntax and a bespoke JSON dialect *that this experiment wrote*, carefully but
self-interestedly.

Most importantly: nothing here contradicts the narrower claim that one grammar
across every search endpoint in an API, validated in CI and typed in generated
clients, is worth having. That claim was the repository's original one, before
the agent framing was put in front of it. The evidence supports going back to it.

### Recommended changes

- Withdraw "A search interface for agents" as the lead. The measured comparison
  does not support it.
- Replace `README.md:210`'s loud-versus-silent argument with the numbers, or drop
  it. As written it is contradicted.
- Document the deliverability problem in §"Exposing search to an agent": the
  schema must be dereferenced before it reaches any provider, recursion must be
  cut at a depth, and Gemini cannot take it at all.
- Give `COMPARISON.md:107-110` a citation or delete the paragraph.
- Fix the generator bug in issue #8 — separate change.

## What this does not show

- **Two models, one provider.** Nothing here separates a property of this
  language from a property of how these two models were trained.
- **One resource, ten records.** The fixture is engineered for discrimination,
  not for realism. Nothing here predicts behaviour on a fifty-field resource.
- **Single-turn, one tool.** A real agent picks among tools, reads results, and
  asks again. Only the repair turn touches any of that.
- **`strict: true` is off.** Constrained decoding would drive the schema arms to
  100% structural validity by construction — and it is available to them and to
  no other arm, at any price. That is a real advantage this experiment declines
  to bank, because MCP servers do not use it today.
- **The mistake counts are upper bounds.** The detector reads shape, not intent:
  four gold answers trip it, because excluding the unknowns is exactly what
  those questions asked for.
- **The questions are ours.** The answer key is inherited and the leakage rule is
  enforced, but sixty-three questions written by the language's author are still
  sixty-three questions written by the language's author.
