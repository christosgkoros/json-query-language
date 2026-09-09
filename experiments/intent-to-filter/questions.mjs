/**
 * questions.mjs — the natural-language side of the corpus.
 *
 * `../filter-to-sql/cases.mjs` supplies the answer key: a gold filter and the
 * row set SPEC.md says it returns, hand-derived from the fixture records. What
 * it does not supply is an information need. Its `title` names the mechanism
 * under test — "The §4.1 surprise: $not over a nullable field" — which, handed
 * to a model as a prompt, is the answer.
 *
 * So each case gets a question here, and `cases.mjs` is not touched.
 *
 * THE AUTHORING RULE, enforced by gold.test.mjs:
 *
 *   A question may name fields and values. It may not contain an operator, a
 *   syntax token, or a structural concept belonging to any arm.
 *
 *     yes — "Which pets are available cats?"
 *     no  — "pets where tags has some element in [indoor]"
 *
 * The rule is what keeps the corpus neutral between five arms that are given
 * the same questions. Where a case cannot be phrased without breaking it, the
 * case is excluded and the reason is recorded in EXCLUDED — published rather
 * than quietly dropped, because the exclusion set is itself a finding about
 * which parts of the language have no user-facing intent behind them.
 *
 * Two of the questions below carry a clarifying second sentence about missing
 * or blank data ("include the ones we can't confirm"). That is not leakage:
 * it is the distinction a user actually draws, and whether an interface can
 * express it is the thing under test. Without it the question would be
 * ambiguous and any grading of it dishonest.
 *
 * `probe` classes:
 *   retrieval    a row set is expected
 *   edge         a row set is expected, but the case turns on null, absence,
 *                or type semantics — reported separately from ordinary traffic
 *   unanswerable the field is not exposed, or the operator is outside the
 *                advertised profiles. Correct behaviour is to say so.
 *                Fabricating an answer is the failure.
 */

/** Questions for cases that already exist in ../filter-to-sql/cases.mjs. */
export const QUESTIONS = {
  // -- A. What a search UI sends ---------------------------------------------
  a01: { probe: "retrieval", ask: "Which pets are available for adoption right now?" },
  a02: { probe: "retrieval", ask: "Show me the cats that are available." },
  a03: { probe: "retrieval", ask: "List every pet that is either available or has an application pending." },
  a04: { probe: "retrieval", ask: "Which pets weigh between 1 and 5 kg? Count a pet at exactly 1 kg or exactly 5 kg as inside the range." },
  a05: { probe: "retrieval", ask: "Which pets were born on or after 1 January 2020?" },
  a06: { probe: "retrieval", ask: "Which pets have a name beginning with a lower-case b? A capital B is a different letter and should not match." },
  a07: { probe: "retrieval", ask: "Which pets have the letter o somewhere in their name? Ignore capitalisation." },
  a08: { probe: "retrieval", ask: "Which pets have the text 50% somewhere in their name?" },
  a09: { probe: "retrieval", ask: "Which pets carry at least one of the labels indoor or small?" },
  a10: { probe: "retrieval", ask: "Which pets carry both the trained label and the outdoor label?" },
  a11: { probe: "retrieval", ask: "Which pets have three or more labels?" },
  a12: { probe: "retrieval", ask: "Which pets have no labels at all?" },
  a13: { probe: "retrieval", ask: "Which pets are housed at a shelter in Athens?" },
  a14: { probe: "retrieval", ask: "Which pets are at a shelter with 12 kennels or fewer?" },
  a15: { probe: "retrieval", ask: "Find pets that are either available cats, or dogs weighing under 20 kg." },
  a16: { probe: "retrieval", ask: "Among the available pets, which are either at a shelter in Patras or carry the trained label?" },
  a17: { probe: "retrieval", ask: "Which pets are neither sold nor pending?" },
  a18: { probe: "retrieval", ask: "Which pets have been neutered?" },
  a19: { probe: "retrieval", ask: "Which pets are listed for more than they cost us?" },
  a20: { probe: "retrieval", ask: "Which pets have a status beginning with the letter a?" },

  // -- B. Collections and nesting --------------------------------------------
  b01: {
    probe: "retrieval",
    ask: "Which pets have a rabies shot whose booster fell due before 1 January 2025? The overdue booster has to belong to the rabies shot itself, not to some other shot the pet had.",
  },
  b02: {
    probe: "retrieval",
    ask: "Which pets have had a rabies shot at some point, and also have a shot — any shot at all — whose booster fell due before 1 January 2025? The two do not have to be the same shot.",
  },
  b03: { probe: "retrieval", ask: "Which pets were vaccinated on or after 1 January 2025?" },
  b04: { probe: "retrieval", ask: "Which pets have parvo as the very first entry in their vaccination history?" },
  b05: { probe: "retrieval", ask: "Which pets have had a parvo vaccination?" },
  b06: { probe: "retrieval", ask: "Which pets do not carry the indoor label?" },
  b07: { probe: "retrieval", ask: "Which pets carry at least one label that is something other than indoor?" },
  b08: { probe: "retrieval", ask: "Which pets have indoor as the first label in their list?" },
  b09: { probe: "retrieval", ask: "Which pets have at least one vaccination with a booster date recorded?" },
  b10: { probe: "retrieval", ask: "Which pets have at least one vaccination with no booster date recorded?" },
  b11: {
    probe: "edge",
    ask: "Which pets have never been given anything other than rabies? A pet with no vaccinations on record counts as satisfying this.",
  },
  b12: {
    probe: "edge",
    ask: "Which pets have not a single label that is indoor? A pet with an empty label list counts as satisfying this.",
  },
  b13: { probe: "edge", ask: "Which pets have nothing but indoor labels, or no labels at all?" },

  // -- C. Null, missing and negation -----------------------------------------
  c01: { probe: "edge", ask: "Which pets have a microchip field that is present but blank?" },
  c02: { probe: "edge", ask: "Which pets have no microchip field recorded at all?" },
  c03: { probe: "edge", ask: "Which pets have a notes field present, whatever it happens to contain?" },
  c04: { probe: "edge", ask: "Which pets are at a shelter whose kennel capacity has not been recorded?" },
  c05: {
    probe: "edge",
    ask: "Which pets can we confirm have a microchip other than CHIP-001? Leave out any pet whose chip we cannot confirm either way.",
  },
  c07: {
    probe: "edge",
    ask: "Which pets either have a chip other than CHIP-001, or are on record as having no chip? Pets with no chip field at all should be left out.",
  },
  c08: { probe: "retrieval", ask: "Which pets are not sold?" },
  c11: { probe: "retrieval", ask: "Which pets weigh outside the 1-to-5 kg range?" },
  c12: {
    probe: "edge",
    ask: "Which pets might have a microchip other than CHIP-001? Include every pet we cannot confirm is CHIP-001, whether the chip is blank, missing, or simply different.",
  },
  c13: {
    probe: "edge",
    ask: "Which pets were not born on or after 1 January 2020? Include pets with no birth date on record, since we cannot confirm they were.",
  },

  // -- D. Types and coercion -------------------------------------------------
  d01: { probe: "edge", ask: "Which pets have a notes value that is a number?" },
  d02: { probe: "edge", ask: "Which pets have a notes value that is a whole number? Treat 3.0 as whole." },
  d03: { probe: "edge", ask: "Which pets have a notes value that is a list?" },
  d04: { probe: "edge", ask: "Which pets have a notes value that is explicitly blank, as opposed to missing?" },
  d05: { probe: "edge", ask: "Which pets have a notes value equal to the number 3?" },
  d06: { probe: "edge", ask: "Which pets have a notes value that is a number above 2?" },
  d07: { probe: "edge", ask: "Which pets have a notes value that is text sorting after the letter a?" },
  d08: { probe: "edge", ask: "Which pets can we confirm have a notes value that is not 3?" },
  d09: { probe: "edge", ask: "Which pets can we confirm have a notes value that is not above 2?" },

  // -- E. Paths and patterns -------------------------------------------------
  e01: { probe: "retrieval", ask: "Which pets have a rate above 5? The field is literally named with a leading dollar sign." },
  e02: { probe: "retrieval", ask: "Which pets have a raw size of XS? The field is literally named size.raw, dot included — it is one field name, not a nested path." },
  e03: { probe: "retrieval", ask: "Which pets have a name that starts with C and ends with o?" },
  e04: { probe: "retrieval", ask: "Which pets have a name starting with A, B or C? Capitals only." },
  e05: { probe: "retrieval", ask: "Which pets have a name starting with a, b or c, in either case?" },
  e06: { probe: "retrieval", ask: "Which pets have a name ending in s?" },

  // -- F. What has to be rejected --------------------------------------------
  f01: { probe: "unanswerable", ask: "Which pets have internal staff notes recorded as exactly the word anything?" },
  f02: { probe: "unanswerable", ask: "Run a free-text search across the pet records for ada and tell me which pets come back." },
};

/**
 * Questions written for this experiment rather than inherited, each aimed at
 * one of the three valid-but-wrong mistakes README §"Exposing search to an
 * agent" catalogues. They are the only questions in the corpus authored with a
 * hypothesis in mind, so they are reported as their own block and never folded
 * into the inherited-corpus numbers.
 *
 * `gold` is the filter a correct answer needs; `tempts` names the mistake the
 * phrasing invites, so grade.mjs can report how often each one is actually made.
 */
export const MISTAKE_PROBES = {
  m01: {
    probe: "retrieval",
    tempts: "in-as-membership",
    ask: "Which pets carry the indoor label?",
    gold: { tags: { $some: { $in: ["indoor"] } } },
    expect: ["p01", "p05", "p06", "p10"],
  },
  m02: {
    probe: "edge",
    tempts: "ne-drops-nulls",
    ask: "Which pets do not have microchip CHIP-001? Include the ones whose chip is blank or missing — I want everything that is not confirmed to be CHIP-001.",
    gold: { microchip: { $ne: "CHIP-001", $unknownAs: true } },
    expect: ["p02", "p03", "p04", "p05", "p06", "p07", "p08", "p09", "p10"],
  },
  m03: {
    probe: "retrieval",
    tempts: "value-outside-domain",
    ask: "Which pets have the status Available?",
    gold: { status: "available" },
    expect: ["p01", "p02", "p05", "p06", "p09", "p10"],
  },
};

/**
 * Cases deliberately left out, and why. Two reasons recur, and they say
 * different things about the language:
 *
 *   "no user intent"   — the case probes a rule that no one would ever ask for
 *                        in words. Not a criticism: a specification has to
 *                        pin down behaviour nobody requests.
 *   "not separable"    — the case has a real intent, but one indistinguishable
 *                        by row set from another case already in the corpus.
 *                        Including both would double-count one question.
 */
export const EXCLUDED = {
  b14: "no user intent — probes $every applied to a field that is not an array.",
  c06: "not separable — same intent and same row set as c05; the pair differs only in spelling, which a row-set grader cannot see.",
  c09: "not separable — the expected answer depends on the storage binding, not on the query.",
  c10: "not separable — as c09.",
  c14: "not separable — differs from c13 by one row, and only by where the resolution modifier nests. No English phrasing separates the two without naming the construct.",
  f03: "no user intent — a malformed pattern escape is a defect in a generated query, not an information need.",
  f04: "no user intent — nobody asks for a weight greater than the word 'heavy'.",
  f05: "no user intent — a misspelled operator is a probe of the schema, not of intent.",
  f06: "no user intent — nesting past the depth limit is a denial-of-service probe.",
  f07: "no user intent — structural equality against an object operand.",
  f08: "moved — the intent behind it ('which pets carry the indoor label') is m01, where the mistake it encodes is what gets measured rather than assumed.",
  f09: "moved — as f08.",
};

/** Tokens that would hand a model one arm's syntax. Enforced by gold.test.mjs. */
export const BANNED_TOKENS = [
  "$", "{", "}", "[", "]",
  ">=", "<=", "!=", "==",
  "operator", "regex", "wildcard", "schema", "json", "query language",
  "quantifier", "quantify", "predicate", "clause", "boolean",
];

/** Questions may quote a data value that happens to look like syntax. */
export const LEAK_EXEMPTIONS = {
  a08: ["50%"], // the value under test is literally the string "50%"
  e01: ["dollar sign"], // describes the data, not a syntax
};

/** Every question, inherited and authored, keyed by case id. */
export const ALL = { ...QUESTIONS, ...MISTAKE_PROBES };
