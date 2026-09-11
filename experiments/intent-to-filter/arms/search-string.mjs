/**
 * search-string.mjs — the arm README.md:63 names as the foil.
 *
 *   "A bespoke query string (?q=status:open AND born>2020) has to be taught:
 *    the tool description explains the syntax, the prompt carries examples,
 *    and the model assembles a string nothing can validate until it reaches
 *    your parser."
 *
 * So this arm is that string, and the effort here goes into making it *good*.
 * The syntax is not a strawman: every construct below is lifted from Lucene,
 * Elasticsearch query-string, or GitHub search, because those are what a real
 * team reaches for. It has wildcards, ranges, regex with a case-insensitivity
 * flag, `_exists_`, quoted field names, boolean grouping, and — the one place
 * it is genuinely more ergonomic than the filter grammar — implicit any-element
 * semantics on multi-valued fields, so `tags:indoor` means what a user expects
 * without naming a quantifier.
 *
 * THE PARSER IS DELIBERATELY GENEROUS. It accepts every reasonable variant
 * spelling it can: `>=` and `≥`, `TO` in either case, unquoted values with
 * internal spaces where unambiguous, `NOT x` and `-x`. A stingy parser would
 * manufacture rejections and hand the comparison to the schema arms; that
 * would be the easiest way to fake this entire experiment, so the bias here
 * runs the other way on purpose.
 *
 * What it cannot express is recorded in CEILING, not hidden as a parse error.
 */

import { runFilter, problem } from "./execute.mjs";

/** Multi-valued paths: a bare match against these means "some element". */
const ARRAY_PATHS = new Set(["tags", "vaccinations"]);

/** Every field the syntax accepts, and how it is spelled as a filter path. */
const FIELDS = {
  id: "id", name: "name", species: "species", status: "status", born: "born",
  weightKg: "weightKg", neutered: "neutered", microchip: "microchip",
  tags: "tags", notes: "notes", priceCents: "priceCents", costCents: "costCents",
  "$rate": "$$rate", "size.raw": "size\\.raw",
  "shelter.name": "shelter.name", "shelter.city": "shelter.city",
  "shelter.capacity": "shelter.capacity",
  vaccinations: "vaccinations",
  "vaccinations.vaccine": ["vaccinations", "vaccine"],
  "vaccinations.administeredAt": ["vaccinations", "administeredAt"],
  "vaccinations.boosterDue": ["vaccinations", "boosterDue"],
};

class ParseError extends Error {
  constructor(detail, type = "malformed-query") {
    super(detail);
    this.detail = detail;
    this.type = type;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const PUNCT = new Set(["(", ")"]);

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (PUNCT.has(ch)) { tokens.push({ kind: ch }); i += 1; continue; }
    if (ch === "-" && (tokens.length === 0 || tokens.at(-1).kind !== "term")) {
      tokens.push({ kind: "NOT" }); i += 1; continue;
    }
    // A term runs to whitespace or an unnested paren, but quoted runs,
    // bracketed ranges and /regex/ bodies swallow whatever is inside them.
    let start = i;
    let depth = 0;
    let text = "";
    while (i < source.length) {
      const c = source[i];
      if (c === '"' || c === "'") {
        const close = source.indexOf(c, i + 1);
        if (close === -1) throw new ParseError(`unterminated quote at position ${i}`);
        text += source.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      if (c === "/" && text.includes(":")) {
        const close = source.indexOf("/", i + 1);
        if (close === -1) throw new ParseError(`unterminated regular expression at position ${i}`);
        let end = close + 1;
        while (end < source.length && /[a-z]/.test(source[end])) end += 1;
        text += source.slice(i, end);
        i = end;
        continue;
      }
      if (c === "[") { depth += 1; text += c; i += 1; continue; }
      if (c === "]") { depth -= 1; text += c; i += 1; continue; }
      if (c === "(" && (text.includes(":") || /^(count|first)$/.test(text))) {
        depth += 1; text += c; i += 1; continue;
      }
      if (c === ")" && depth > 0) { depth -= 1; text += c; i += 1; continue; }
      if (depth === 0 && (/\s/.test(c) || PUNCT.has(c))) break;
      text += c;
      i += 1;
    }
    if (!text) throw new ParseError(`cannot read the query at position ${start}`);
    const upper = text.toUpperCase();
    if (upper === "AND" || upper === "OR") tokens.push({ kind: upper });
    else if (upper === "NOT") tokens.push({ kind: "NOT" });
    else tokens.push({ kind: "term", text });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — precedence: NOT binds tightest, then AND, then OR
// ---------------------------------------------------------------------------

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (kind) => (peek()?.kind === kind ? (pos += 1, true) : false);

  function primary() {
    if (eat("NOT")) return { $not: primary() };
    if (eat("(")) {
      const inner = orExpr();
      if (!eat(")")) throw new ParseError("unbalanced parentheses");
      return inner;
    }
    const token = peek();
    if (!token || token.kind !== "term") throw new ParseError("expected a search clause");
    pos += 1;
    return clause(token.text);
  }

  function andExpr() {
    const parts = [primary()];
    for (;;) {
      if (eat("AND")) { parts.push(primary()); continue; }
      // Adjacency is AND, as in every search box that has ever shipped.
      const next = peek();
      if (next && (next.kind === "term" || next.kind === "(" || next.kind === "NOT")) {
        parts.push(primary());
        continue;
      }
      break;
    }
    return parts.length === 1 ? parts[0] : { $and: parts };
  }

  function orExpr() {
    const parts = [andExpr()];
    while (eat("OR")) parts.push(andExpr());
    return parts.length === 1 ? parts[0] : { $or: parts };
  }

  const filter = orExpr();
  if (pos !== tokens.length) throw new ParseError("trailing input after the query");
  return filter;
}

// ---------------------------------------------------------------------------
// One clause -> one filter
// ---------------------------------------------------------------------------

const unquote = (raw) =>
  (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
    ? raw.slice(1, -1)
    : raw;

/** Untyped syntax, so scalars are inferred — the coercion a string arm cannot avoid. */
function scalar(raw) {
  const text = unquote(raw);
  if (raw !== text) return text; // it was quoted: it is a string, whatever it looks like
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

const LIKE_ESCAPE = (text) => text.replace(/([%_\\])/g, "\\$1");

function resolveField(name) {
  const key = unquote(name);
  const path = FIELDS[key];
  if (path === undefined) {
    throw new ParseError(
      `"${key}" is not a searchable field. The searchable fields are: ${Object.keys(FIELDS).join(", ")}.`,
      "unknown-field",
    );
  }
  return path;
}

/** Wrap a constraint so it applies to elements where the path is multi-valued. */
function place(path, constraint) {
  if (Array.isArray(path)) {
    const [array, member] = path;
    return { [array]: { $some: { [member]: constraint } } };
  }
  if (ARRAY_PATHS.has(path)) return { [path]: { $some: constraint } };
  return { [path]: constraint };
}

function clause(text) {
  // A bare term with no field is free text.
  const split = text.indexOf(":");
  if (split === -1) return { name: { $search: unquote(text) } };

  let field = text.slice(0, split);
  const rest = text.slice(split + 1);

  // count(tags):>=3 and first(tags):indoor
  const wrapped = /^(count|first)\((.+)\)$/.exec(field);
  if (wrapped) {
    const [, fn, inner] = wrapped;
    const path = resolveField(inner);
    if (fn === "count") {
      if (Array.isArray(path) || !ARRAY_PATHS.has(path)) {
        throw new ParseError(`count() applies to a multi-valued field; ${unquote(inner)} is not one.`, "invalid-operand");
      }
      const cmp = comparison(rest);
      return { [path]: { $size: cmp === null ? scalar(rest) : cmp } };
    }
    const indexed = Array.isArray(path) ? `${path[0]}[0].${path[1]}` : `${path}[0]`;
    return { [indexed]: { $eq: scalar(rest) } };
  }

  if (field === "_exists_" || field === "_missing_") {
    const present = field === "_exists_";
    return place(resolveField(rest), { $exists: present });
  }

  const path = resolveField(field);

  // field:null — present, but blank
  if (rest === "null") return place(path, { $isNull: true });

  // field:/pattern/flags
  const re = /^\/(.+)\/([a-z]*)$/.exec(rest);
  if (re) {
    const [, pattern, flags] = re;
    const constraint = { $regex: pattern };
    if (flags) constraint.$flags = flags;
    return place(path, constraint);
  }

  // field:[lo TO hi]
  const range = /^\[(.+?)\s+TO\s+(.+?)\]$/i.exec(rest);
  if (range) return place(path, { $between: [scalar(range[1]), scalar(range[2])] });

  // field:(a OR b OR c)
  const group = /^\((.+)\)$/.exec(rest);
  if (group) {
    const members = group[1].split(/\s+OR\s+/i).map((m) => scalar(m.trim()));
    return place(path, { $in: members });
  }

  // field:>x field:>=x field:<x field:<=x
  const cmp = comparison(rest);
  if (cmp !== null) return place(path, cmp);

  // wildcards
  const raw = unquote(rest);
  if (raw !== rest || !raw.includes("*")) {
    return place(path, { $eq: scalar(rest) });
  }
  const inner = raw.slice(raw.startsWith("*") ? 1 : 0, raw.endsWith("*") ? -1 : undefined);
  if (raw.startsWith("*") && raw.endsWith("*")) return place(path, { $contains: inner });
  if (raw.endsWith("*") && !inner.includes("*")) return place(path, { $startsWith: inner });
  if (raw.startsWith("*") && !inner.includes("*")) return place(path, { $endsWith: inner });
  return place(path, { $like: raw.split("*").map(LIKE_ESCAPE).join("%") });
}

/** `>x` `>=x` `<x` `<=x`, accepting the unicode spellings too. */
function comparison(rest) {
  const m = /^(>=|<=|≥|≤|>|<)\s*(.+)$/.exec(rest);
  if (!m) return null;
  const op = { ">": "$gt", ">=": "$gte", "≥": "$gte", "<": "$lt", "<=": "$lte", "≤": "$lte" }[m[1]];
  return { [op]: scalar(m[2]) };
}

// ---------------------------------------------------------------------------
// The arm
// ---------------------------------------------------------------------------

/**
 * What this syntax cannot say. Every entry is a real limitation of the
 * string-query family, not of this parser — which is the point of recording
 * them rather than letting them surface as parse failures.
 */
const CEILING = {
  a19: "no cross-field comparison: a value position cannot name another field",
  b01: "no correlated element match — the two conditions cannot be pinned to the same vaccination",
  b07: "`some element is not indoor` is not expressible; `-tags:indoor` means `no element is indoor`",
  b11: "no universal quantifier over elements",
  b12: "no universal quantifier over elements",
  b13: "no universal quantifier over elements",
  d01: "no type predicate",
  d02: "no type predicate",
  d03: "no type predicate",
  d04: "no type predicate",
};

/** The gold query per case: what a fluent user of this syntax would write. */
const GOLD = {
  a01: "status:available",
  a02: "status:available AND species:cat",
  a03: "status:(available OR pending)",
  a04: "weightKg:[1 TO 5]",
  a05: "born:>=2020-01-01",
  a06: "name:b*",
  a07: "name:/o/i",
  a08: "name:*50%*",
  a09: "tags:(indoor OR small)",
  a10: "tags:trained AND tags:outdoor",
  a11: "count(tags):>=3",
  a12: "count(tags):0",
  a13: "shelter.city:Athens",
  a14: "shelter.capacity:<=12",
  a15: "(species:cat AND status:available) OR (species:dog AND weightKg:<20)",
  a16: "status:available AND (shelter.city:Patras OR tags:trained)",
  a17: "-status:sold AND -status:pending",
  a18: "neutered:true",
  a20: "status:a*",
  b02: "vaccinations.vaccine:rabies AND vaccinations.boosterDue:<2025-01-01",
  b03: "vaccinations.administeredAt:>=2025-01-01T00:00:00Z",
  b04: "first(vaccinations.vaccine):parvo",
  b05: "vaccinations.vaccine:parvo",
  b06: "-tags:indoor",
  b08: "first(tags):indoor",
  b09: "_exists_:vaccinations.boosterDue",
  b10: "_missing_:vaccinations.boosterDue",
  c01: "microchip:null",
  c02: "-_exists_:microchip",
  c03: "_exists_:notes",
  c04: "-_exists_:shelter.capacity",
  c05: "-microchip:CHIP-001",
  c07: "-microchip:CHIP-001 OR microchip:null",
  c08: "-status:sold",
  c11: "-weightKg:[1 TO 5]",
  c12: "-microchip:CHIP-001 OR microchip:null OR -_exists_:microchip",
  c13: "-born:>=2020-01-01 OR born:null",
  d05: "notes:3",
  d06: "notes:>2",
  d07: "notes:>a",
  d08: "-notes:3",
  d09: "-notes:>2",
  e01: "$rate:>5",
  e02: '"size.raw":XS',
  e03: "name:C*o",
  e04: "name:/^[A-C]/",
  e05: "name:/^[a-c]/i",
  e06: "name:*s",
  f01: "internalNotes:anything",
  f02: "ada",
  m01: "tags:indoor",
  m02: "-microchip:CHIP-001 OR microchip:null OR -_exists_:microchip",
  m03: "status:available",
};

export const searchString = {
  name: "search-string",
  kind: "string",
  ceiling: CEILING,
  tool: {
    name: "search_pets",
    description: null, // filled from arms/docs/search-string.md by index.mjs
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "The search query. See the tool description for the syntax." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Maximum number of records to return." },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  extract: (input) => input?.q,
  /** Translate, or explain why not. Translation failure IS this arm's validation. */
  translate(input) {
    if (typeof input?.q !== "string" || !input.q.trim()) {
      throw new ParseError("the q argument is required and must be a non-empty query string.");
    }
    return parse(tokenize(input.q));
  },
  validate(input) {
    try {
      this.translate(input);
      return null;
    } catch (error) {
      if (error instanceof ParseError) return problem(error.type, error.detail, "/q");
      throw error;
    }
  },
  execute(input, db) {
    let filter;
    try {
      filter = this.translate(input);
    } catch (error) {
      if (error instanceof ParseError) return { problem: problem(error.type, error.detail, "/q") };
      throw error;
    }
    return runFilter(db, filter);
  },
  gold: (testCase) => (CEILING[testCase.id] ? null : GOLD[testCase.id] ?? null),
};

export const __test = { tokenize, parse, clause };
