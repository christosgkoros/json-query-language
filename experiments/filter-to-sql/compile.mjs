/**
 * compile.mjs — compile a JSON Query Language filter into a SQL statement.
 *
 * EXPERIMENT. Not part of the published artifact; see ./README.md for what
 * this was built to measure and what it found.
 *
 * The compiler's one job is to produce a SQL boolean expression whose
 * three-valued result matches SPEC.md §4 clause for clause, so that SQL's
 * "WHERE keeps only TRUE" rule and the language's "a record matches iff the
 * filter is TRUE" rule coincide. Everything else follows from that: NULL is
 * UNKNOWN, and any place where a SQL operator would return TRUE or FALSE where
 * the spec says UNKNOWN needs an explicit guard.
 *
 * Two assumptions, both load-bearing:
 *
 *   1. The input is already valid against query-language-schema.json. The
 *      compiler does no structural validation and has no recovery path — a
 *      malformed filter is a caller bug, not a branch here. (run.mjs validates
 *      with ajv first, which is how a server would do it.)
 *   2. Field paths are resolved through a *binding* (see dataset.mjs), which
 *      says where each queryable path lives — a column, or a path inside a
 *      JSON column — and, for columns, what type it holds. A path with no
 *      binding is `unknown-field` per SPEC §3.5.
 *
 * Every user-derived string, field paths included, leaves here as a bound
 * parameter. The only text this file interpolates into SQL is its own
 * keywords, its own generated aliases, and the column names in the binding.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** The profile map is published in the grammar; read it rather than restate it. */
const GRAMMAR = JSON.parse(
  readFileSync(join(here, "..", "..", "query-language-schema.json"), "utf8"),
);
const OPERATOR_PROFILE = new Map();
for (const [profile, operators] of Object.entries(GRAMMAR["x-profiles"])) {
  for (const op of operators) OPERATOR_PROFILE.set(op, profile);
}

export const PROBLEM_BASE = "https://christosgkoros.com/json/query-language/problems/";

const PROBLEM_TITLES = {
  "malformed-query": "Malformed query",
  "unknown-field": "Unknown field",
  "unsupported-operator": "Unsupported operator",
  "invalid-operand": "Invalid operand",
  "query-too-complex": "Query too complex",
};

/** An RFC 9457 problem in flight, per SPEC §8. */
export class QueryProblem extends Error {
  constructor(type, detail, pointer, extra = {}) {
    super(detail);
    this.name = "QueryProblem";
    this.type = type;
    this.pointer = pointer;
    this.extra = extra;
  }

  toProblem() {
    return {
      type: PROBLEM_BASE + this.type,
      title: PROBLEM_TITLES[this.type],
      status: 400,
      detail: this.message,
      pointer: this.pointer,
      ...this.extra,
    };
  }
}

const ptrJoin = (pointer, token) =>
  `${pointer}/${String(token).replace(/~/g, "~0").replace(/\//g, "~1")}`;

// ---------------------------------------------------------------------------
// Field paths (SPEC §3.2)
// ---------------------------------------------------------------------------

/**
 * Parses a field path into segments: {key}, {index} or {wildcard}. The escape
 * rules are the reason this exists at all — `a\.b` is one key, `$$price`
 * addresses the field `$price`, and neither survives a naive `split(".")`.
 */
export function parsePath(raw, pointer) {
  const bad = (detail) => new QueryProblem("malformed-query", detail, pointer);
  if (typeof raw !== "string" || raw === "") throw bad("empty field path");

  const segments = [];
  let i = 0;
  let head = true;

  while (i < raw.length) {
    let key = "";
    if (head) {
      if (raw.startsWith("$$")) {
        key = "$";
        i = 2;
      } else if (raw[0] === "$") {
        throw bad(`"${raw}" starts with a single '$', which is reserved for operators`);
      }
    }
    while (i < raw.length) {
      const c = raw[i];
      if (c === "\\") {
        const next = raw[i + 1];
        if (next === undefined || !".[]\\".includes(next)) {
          throw bad(`invalid escape sequence "\\${next ?? ""}" in "${raw}"`);
        }
        key += next;
        i += 2;
        continue;
      }
      if (c === "." || c === "[") break;
      key += c;
      i += 1;
    }
    if (key === "") throw bad(`empty key in "${raw}"`);
    segments.push({ key });

    while (raw[i] === "[") {
      const close = raw.indexOf("]", i);
      if (close < 0) throw bad(`unterminated index in "${raw}"`);
      const body = raw.slice(i + 1, close);
      if (body === "*") segments.push({ wildcard: true });
      else if (/^\d+$/.test(body)) segments.push({ index: Number(body) });
      else throw bad(`invalid index "[${body}]" in "${raw}"`);
      i = close + 1;
    }

    if (i < raw.length) {
      if (raw[i] !== ".") throw bad(`unexpected "${raw[i]}" in "${raw}"`);
      i += 1;
      if (i >= raw.length) throw bad(`trailing '.' in "${raw}"`);
    }
    head = false;
  }
  return segments;
}

/** The JSON type class of an operand, in the vocabulary of SPEC §5.10. */
function classOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

const SQLITE_BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `$.shelter.city`, `$."size.raw"`, `$.items[0]` — SQLite/MySQL JSON path. */
function sqliteJsonPath(segments) {
  let path = "$";
  for (const s of segments) {
    if (s.key !== undefined) {
      path += SQLITE_BARE_KEY.test(s.key) ? `.${s.key}` : `."${s.key.replace(/"/g, '\\"')}"`;
    } else if (s.index !== undefined) {
      path += `[${s.index}]`;
    } else {
      throw new Error("internal: wildcard segments must be split before path building");
    }
  }
  return path;
}

/** `{shelter,city}` — the text[] operand of Postgres' `#>`. */
function postgresPath(segments) {
  return segments.map((s) => (s.key !== undefined ? s.key : String(s.index)));
}

const DIALECTS = {
  sqlite: {
    name: "sqlite",
    placeholder: (n) => `?${n}`,
    // json_type() is the one primitive that separates "absent" from "null":
    // SQL NULL for a path that does not resolve, the text 'null' for a JSON
    // null. SPEC §4.2 is unimplementable without it.
    typeExpr(ctx, node, segments) {
      if (segments.length === 0) return node.typeSql;
      const inner = `json_type(${node.sql}, ${ctx.p(sqliteJsonPath(segments))})`;
      return node.guard ? `CASE WHEN ${node.guard} THEN ${inner} END` : inner;
    },
    valueExpr(ctx, node, segments) {
      if (segments.length === 0) return node.sql;
      const inner = `json_extract(${node.sql}, ${ctx.p(sqliteJsonPath(segments))})`;
      return node.guard ? `CASE WHEN ${node.guard} THEN ${inner} END` : inner;
    },
    lengthExpr(ctx, node, segments) {
      const args = segments.length === 0 ? node.sql : `${node.sql}, ${ctx.p(sqliteJsonPath(segments))}`;
      return `json_array_length(${args})`;
    },
    eachFrom(ctx, node, segments, alias) {
      const args = segments.length === 0 ? node.sql : `${node.sql}, ${ctx.p(sqliteJsonPath(segments))}`;
      return `json_each(${args}) AS ${alias}`;
    },
    // json_each() hands back SQL values, so a text element and a numeric one
    // are indistinguishable without the companion `type` column, and a scalar
    // element is not valid JSON to descend into — hence the guard.
    element: (alias) => ({
      sql: `${alias}.value`,
      typeSql: `${alias}.type`,
      guard: `${alias}.type IN ('object','array')`,
    }),
    // NATIVE type names, not classes: 'integer'/'real' and 'true'/'false' are
    // separate, so every class test is a set test.
    classTest: (typeSql, klass) =>
      ({
        string: `${typeSql} = 'text'`,
        number: `${typeSql} IN ('integer','real')`,
        boolean: `${typeSql} IN ('true','false')`,
        null: `${typeSql} = 'null'`,
        array: `${typeSql} = 'array'`,
        object: `${typeSql} = 'object'`,
      })[klass],
    integerTest: (typeSql, valueSql) =>
      `(${typeSql} = 'integer' OR (${typeSql} = 'real' AND ${valueSql} = CAST(${valueSql} AS INTEGER)))`,
    bind: (value) => (typeof value === "boolean" ? (value ? 1 : 0) : value),
    like: (valueSql, patternPh) => `${valueSql} LIKE ${patternPh} ESCAPE '\\'`,
    // SQLite's LIKE folds ASCII case unless case_sensitive_like is ON; the
    // harness sets it, and $ilike then has to fold explicitly.
    ilike: (valueSql, patternPh) => `lower(${valueSql}) LIKE lower(${patternPh}) ESCAPE '\\'`,
    // No built-in REGEXP: harness.mjs registers jql_regex(), which is a real
    // ECMA-262 engine and therefore the only fully conforming $regex here.
    regex: (valueSql, patternPh, flagsPh) => `jql_regex(${valueSql}, ${patternPh}, ${flagsPh()})`,
    requires: ["PRAGMA case_sensitive_like = ON", "jql_regex(value, pattern, flags) UDF"],
  },

  postgres: {
    name: "postgres",
    placeholder: (n) => `$${n}`,
    typeExpr(ctx, node, segments) {
      if (segments.length === 0) return `jsonb_typeof(${node.sql})`;
      return `jsonb_typeof(${node.sql} #> ${ctx.p(postgresPath(segments))}::text[])`;
    },
    valueExpr(ctx, node, segments, klass) {
      const at =
        segments.length === 0
          ? node.sql
          : `(${node.sql} #> ${ctx.p(postgresPath(segments))}::text[])`;
      if (klass === "string") return `(${at} #>> '{}')`;
      if (klass === "number") return `(${at})::numeric`;
      if (klass === "boolean") return `(${at})::boolean`;
      return at;
    },
    lengthExpr(ctx, node, segments) {
      const at =
        segments.length === 0
          ? node.sql
          : `(${node.sql} #> ${ctx.p(postgresPath(segments))}::text[])`;
      return `jsonb_array_length(${at})`;
    },
    // The array guard has to move *inside* the FROM item: unlike json_each(),
    // jsonb_array_elements() raises on a non-array instead of returning rows,
    // and a guard in WHERE is too late to stop it.
    eachFrom(ctx, node, segments, alias) {
      const at =
        segments.length === 0
          ? node.sql
          : `(${node.sql} #> ${ctx.p(postgresPath(segments))}::text[])`;
      return `jsonb_array_elements(CASE WHEN jsonb_typeof(${at}) = 'array' THEN ${at} ELSE '[]'::jsonb END) AS ${alias}(value)`;
    },
    // Elements are jsonb, so descending into one needs no guard and carries no
    // type ambiguity. This is the single biggest difference between the two.
    element: (alias) => ({ sql: `${alias}.value`, typeSql: `jsonb_typeof(${alias}.value)`, guard: null }),
    // jsonb_typeof()'s vocabulary is the language's $type vocabulary.
    classTest: (typeSql, klass) => `${typeSql} = '${klass}'`,
    integerTest: (typeSql, valueSql) =>
      `(${typeSql} = 'number' AND ${valueSql} = trunc(${valueSql}))`,
    bind: (value) => value,
    like: (valueSql, patternPh) => `${valueSql} LIKE ${patternPh} ESCAPE '\\'`,
    ilike: (valueSql, patternPh) => `${valueSql} ILIKE ${patternPh} ESCAPE '\\'`,
    // `~` is POSIX ARE, not ECMA-262. Close enough to be dangerous, so the
    // caller gets a warning rather than a silent reinterpretation.
    regex: (valueSql, patternPh, flagsPh, flags) => {
      // `m` and `s` have no separable equivalent: Postgres fuses those two
      // behaviours into its own newline-sensitivity options.
      if (/[ms]/.test(flags)) return null;
      return `${valueSql} ${flags.includes("i") ? "~*" : "~"} ${patternPh}`;
    },
    requires: [],
  },
};

// ---------------------------------------------------------------------------
// Compilation context
// ---------------------------------------------------------------------------

class Ctx {
  constructor(binding) {
    this.binding = binding;
    this.dialect = DIALECTS[binding.dialect];
    if (!this.dialect) throw new Error(`unknown dialect "${binding.dialect}"`);
    this.limits = { maxDepth: 10, maxClauses: 100, maxSetLength: 1000, ...(binding.limits ?? {}) };
    this.params = [];
    this.paramIndex = new Map();
    this.warnings = [];
    this.clauses = 0;
    this.aliasSeq = 0;
  }

  /**
   * Interns a bound value and returns its placeholder. Interning is not an
   * optimisation: guarded expressions mention the same JSON path two or three
   * times, and one placeholder per distinct value keeps the emitted SQL and
   * the parameter list from having to be built in lockstep.
   */
  p(value) {
    const bound = this.dialect.bind(value);
    const key = `${typeof bound}:${JSON.stringify(bound)}`;
    let n = this.paramIndex.get(key);
    if (n === undefined) {
      this.params.push(bound);
      n = this.params.length;
      this.paramIndex.set(key, n);
    }
    return this.dialect.placeholder(n);
  }

  alias() {
    return `e${this.aliasSeq++}`;
  }

  warn(message) {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** SPEC §7: a filter is user input that becomes a query plan. Bound it. */
  clause(pointer) {
    if (++this.clauses > this.limits.maxClauses) {
      throw new QueryProblem(
        "query-too-complex",
        `filter exceeds the ${this.limits.maxClauses}-clause limit`,
        pointer,
        { limits: this.limits },
      );
    }
  }

  depth(level, pointer) {
    if (level > this.limits.maxDepth) {
      throw new QueryProblem(
        "query-too-complex",
        `filter exceeds the maximum nesting depth of ${this.limits.maxDepth}`,
        pointer,
        { limits: this.limits },
      );
    }
  }

  /** SPEC §2.1: an operator outside the advertised profiles is an error. */
  profileGate(op, pointer) {
    const profile = OPERATOR_PROFILE.get(op);
    if (profile === undefined) {
      throw new QueryProblem("malformed-query", `"${op}" is not an operator of this language`, pointer);
    }
    if (!this.binding.profiles.includes(profile)) {
      throw new QueryProblem(
        "unsupported-operator",
        `${op} belongs to the "${profile}" profile, which this endpoint does not advertise (${this.binding.profiles.join(", ")})`,
        pointer,
        { profiles: this.binding.profiles },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * An accessor answers, in SQL, the three questions every operator asks of a
 * field: what JSON type is here, what is the comparable value, and is it an
 * array I can walk. Both binding kinds expose the same interface, which is why
 * the operator compilers below have no idea which kind they are looking at.
 */
function docAccessor(ctx, node, segments, label, spec) {
  const d = ctx.dialect;
  return {
    kind: "doc",
    label,
    spec,
    // What the capability document says this path holds, if anything. Used to
    // reject an unusable operand; never used to skip a guard, because JSON in
    // a column can always hold something else.
    declaredClass: DECLARED_CLASS[spec?.type] ?? null,
    certainClass: null,
    canExist: true,
    canWalk: true,
    typeSql: () => d.typeExpr(ctx, node, segments),
    value: (klass) => d.valueExpr(ctx, node, segments, klass),
    isClass: (klass) => d.classTest(d.typeExpr(ctx, node, segments), klass),
    isIntegerValued: () => d.integerTest(d.typeExpr(ctx, node, segments), d.valueExpr(ctx, node, segments, "number")),
    // UNKNOWN-for-this-reason: the path resolved to nothing, or to null. Both
    // collapse here because every operator except $exists/$isNull treats them
    // the same (SPEC §4.2).
    isUnknown: () => `coalesce(${d.typeExpr(ctx, node, segments)}, 'null') = 'null'`,
    exists: () => `${d.typeExpr(ctx, node, segments)} IS NOT NULL`,
    length: () => d.lengthExpr(ctx, node, segments),
    each: (alias) => d.eachFrom(ctx, node, segments, alias),
  };
}

/** SPEC §2.2 declares `type`; §5.10's vocabulary is what operators compare. */
const DECLARED_CLASS = {
  string: "string", number: "number", integer: "number",
  boolean: "boolean", array: "array", object: "object",
};

function columnAccessor(ctx, spec, label) {
  const klass = DECLARED_CLASS[spec.type];
  if (!klass || klass === "array" || klass === "object") {
    throw new Error(`binding for "${label}" must declare a scalar type, got "${spec.type}"`);
  }
  const col = spec.column;
  return {
    kind: "column",
    label,
    spec,
    // A typed column is the whole point of a promoted column: the class is
    // known at compile time, so every type guard below collapses to nothing
    // and SQL's own NULL propagation carries UNKNOWN unaided.
    declaredClass: klass,
    certainClass: klass,
    // A column cannot report absence, and cannot hold an array to walk.
    canExist: false,
    canWalk: false,
    typeSql: () => null,
    value: () => col,
    isClass: (want) => (want === klass ? `${col} IS NOT NULL` : want === "null" ? `${col} IS NULL` : "FALSE"),
    isIntegerValued: () => (klass === "number" ? `${col} = CAST(${col} AS INTEGER)` : "FALSE"),
    isUnknown: () => `${col} IS NULL`,
    exists: () => null, // indistinguishable from null; $exists is rejected
    length: () => null,
    each: () => null,
  };
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a field path against the binding. Returns either a plain accessor
 * or, for a wildcard path, a builder that wraps a predicate in the existential
 * form SPEC §5.9 requires.
 */
function resolveField(ctx, scope, rawPath, pointer) {
  const segments = parsePath(rawPath, pointer);

  if (scope.kind === "element") {
    return buildFromSegments(ctx, scope.node, segments, rawPath);
  }

  const fields = ctx.binding.fields;
  const keys = [];
  for (const s of segments) {
    if (s.key === undefined) break; // an index or wildcard ends the bindable prefix
    keys.push(s.key);
  }

  for (let take = keys.length; take >= 1; take -= 1) {
    const name = keys
      .slice(0, take)
      .map((k) => {
        const escaped = k.replace(/([.[\]\\])/g, "\\$1");
        return escaped.startsWith("$") ? `$${escaped}` : escaped;
      })
      .join(".");
    const spec = fields[name];
    if (!spec) continue;

    const rest = segments.slice(take);
    // An index or a wildcard addresses the elements of a bound path, not a
    // member beneath it: `tags[*]` is still the `tags` field. Only a named key
    // needs the subtree to be exposed.
    const descends = rest.some((s) => s.key !== undefined);
    if (spec.column) {
      if (rest.length) {
        throw new QueryProblem(
          "unknown-field",
          `"${rawPath}" descends into "${name}", which this endpoint exposes as a scalar column`,
          pointer,
          { queryableFields: Object.keys(fields) },
        );
      }
      return { wildcard: false, acc: columnAccessor(ctx, spec, name) };
    }
    if (descends && !spec.subtree) {
      throw new QueryProblem(
        "unknown-field",
        `"${rawPath}" is not a queryable path: "${name}" is exposed but its members are not`,
        pointer,
        { queryableFields: Object.keys(fields) },
      );
    }
    const root = { sql: spec.doc, typeSql: null, guard: null };
    const prefix = parsePath(name, pointer);
    // A declared type describes the bound path itself, not what lies under it.
    return buildFromSegments(ctx, root, [...prefix, ...rest], rawPath, rest.length ? undefined : spec);
  }

  throw new QueryProblem(
    "unknown-field",
    `"${rawPath}" is not a queryable path on this collection`,
    pointer,
    { queryableFields: Object.keys(fields) },
  );
}

/**
 * Splits a path at its wildcards. Without one, the result is a plain accessor.
 * With one, each `[*]` becomes a table-valued join inside a correlated
 * subquery, and the constraint is evaluated against the element.
 */
function buildFromSegments(ctx, root, segments, label, spec) {
  const chunks = [[]];
  for (const s of segments) {
    if (s.wildcard) chunks.push([]);
    else chunks[chunks.length - 1].push(s);
  }
  if (chunks.length === 1) {
    return { wildcard: false, acc: docAccessor(ctx, root, segments, label, spec) };
  }

  // A wildcard path is existential: TRUE if the constraint holds for some
  // resolved value, FALSE if it holds for none, UNKNOWN if nothing resolved.
  // Three outcomes means two subqueries — one to ask whether anything resolved
  // at all, one to ask whether the constraint held.
  const build = (predicate) => {
    const shape = () => {
      const from = [];
      const guards = [];
      let node = root;
      for (let c = 0; c < chunks.length - 1; c += 1) {
        const arrayAcc = docAccessor(ctx, node, chunks[c], label);
        const alias = ctx.alias();
        guards.push(arrayAcc.isClass("array"));
        from.push(arrayAcc.each(alias));
        node = ctx.dialect.element(alias);
      }
      const tail = docAccessor(ctx, node, chunks[chunks.length - 1], label);
      return { from: from.join(", "), guards, tail };
    };

    const resolved = shape();
    const resolvedSql = `EXISTS (SELECT 1 FROM ${resolved.from} WHERE ${[...resolved.guards, resolved.tail.exists()].join(" AND ")})`;
    const held = shape();
    const heldSql = `EXISTS (SELECT 1 FROM ${held.from} WHERE ${held.guards.join(" AND ")} AND (${predicate(held.tail)}))`;
    return `CASE WHEN NOT ${resolvedSql} THEN NULL WHEN ${heldSql} THEN TRUE ELSE FALSE END`;
  };
  return { wildcard: true, build, label };
}

// ---------------------------------------------------------------------------
// Operands
// ---------------------------------------------------------------------------

/** Unwraps `{"$literal": v}` and detects `{"$field": path}` (SPEC §5.11). */
function readOperand(ctx, scope, operand, pointer) {
  if (operand && typeof operand === "object" && !Array.isArray(operand)) {
    if ("$literal" in operand) {
      ctx.profileGate("$literal", ptrJoin(pointer, "$literal"));
      return { kind: "const", value: operand.$literal };
    }
    if ("$field" in operand) {
      ctx.profileGate("$field", ptrJoin(pointer, "$field"));
      const resolved = resolveField(ctx, scope, operand.$field, ptrJoin(pointer, "$field"));
      if (resolved.wildcard) {
        // SPEC §5.11: a reference that resolves to more than one value is
        // UNKNOWN. A wildcard reference always could, so it always is.
        return { kind: "unknown" };
      }
      return { kind: "field", acc: resolved.acc };
    }
  }
  return { kind: "const", value: operand };
}

/**
 * Rejects an operand a typed column could never hold. SPEC §4.3 says a server
 * SHOULD map an operand into the field's declared type at the boundary and
 * MUST reject what it cannot map — an error beats the empty result set that
 * evaluating it as UNKNOWN would produce.
 */
function checkOperandClass(acc, klass, op, pointer) {
  if (acc.declaredClass && acc.declaredClass !== klass) {
    throw new QueryProblem(
      "invalid-operand",
      `${op} on "${acc.label}" needs a ${acc.declaredClass} operand; got ${klass}`,
      pointer,
      { accepted: { type: acc.spec?.type, format: acc.spec?.format, values: acc.spec?.values } },
    );
  }
}

// ---------------------------------------------------------------------------
// Comparison shapes
// ---------------------------------------------------------------------------

/**
 * `value <op> operand` under the class guard the spec requires. `mismatch` is
 * the whole difference between equality and ordering: comparing a string to a
 * number is FALSE for $eq (they are structurally unequal) and UNKNOWN for $gt
 * (no ordering is defined across types).
 */
function compareConst(ctx, acc, klass, op, value, mismatch) {
  const cmp = () => `${acc.value(klass)} ${op} ${ctx.p(value)}`;
  if (acc.certainClass) return acc.certainClass === klass ? cmp() : mismatch;
  if (mismatch === "FALSE") {
    return `CASE WHEN ${acc.isUnknown()} THEN NULL WHEN ${acc.isClass(klass)} THEN ${cmp()} ELSE FALSE END`;
  }
  return `CASE WHEN ${acc.isClass(klass)} THEN ${cmp()} ELSE NULL END`;
}

/** The same, against another field of the same record. */
function compareField(ctx, left, right, op, klasses, mismatch) {
  const branches = [];
  for (const klass of klasses) {
    if (left.certainClass && left.certainClass !== klass) continue;
    if (right.certainClass && right.certainClass !== klass) continue;
    const guards = [];
    if (!left.certainClass) guards.push(left.isClass(klass));
    if (!right.certainClass) guards.push(right.isClass(klass));
    const cmp = `${left.value(klass)} ${op} ${right.value(klass)}`;
    if (guards.length === 0) return cmp; // two typed columns: plain SQL, no guard
    branches.push(`WHEN ${guards.join(" AND ")} THEN ${cmp}`);
  }
  if (branches.length === 0) return mismatch;
  return `CASE ${branches.join(" ")} ELSE ${mismatch} END`;
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

const ORDERED = ["number", "string"];
const SQL_OP = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" };

function equality(ctx, scope, acc, operand, pointer, op) {
  const side = readOperand(ctx, scope, operand, pointer);
  if (side.kind === "unknown") return "NULL";
  if (side.kind === "field") {
    return compareField(ctx, acc, side.acc, "=", ["number", "string", "boolean"], "FALSE");
  }
  const klass = classOf(side.value);
  if (klass === "null") {
    // The one comparison for which null is an operand rather than a cause of
    // UNKNOWN (SPEC §5.1). Identical to $isNull.
    return isNull(ctx, acc, true, pointer);
  }
  if (klass === "array" || klass === "object") {
    // Structural equality against a composite. Postgres jsonb `=` does this
    // correctly; SQLite has no order-insensitive JSON comparison at all, so
    // the honest move is to refuse rather than approximate.
    throw new QueryProblem(
      "unsupported-operator",
      `${op} against ${klass === "array" ? "an array" : "an object"} operand is not supported by the ${ctx.dialect.name} backend`,
      pointer,
    );
  }
  checkOperandClass(acc, klass, op, pointer);
  return compareConst(ctx, acc, klass, "=", side.value, "FALSE");
}

function ordering(ctx, scope, acc, operand, pointer, op) {
  const side = readOperand(ctx, scope, operand, pointer);
  if (side.kind === "unknown") return "NULL";
  if (side.kind === "field") {
    return compareField(ctx, acc, side.acc, SQL_OP[op], ORDERED, "NULL");
  }
  const klass = classOf(side.value);
  if (!ORDERED.includes(klass)) {
    throw new QueryProblem("invalid-operand", `${op} needs a number or a string operand; got ${klass}`, pointer);
  }
  checkOperandClass(acc, klass, op, pointer);
  return compareConst(ctx, acc, klass, SQL_OP[op], side.value, "NULL");
}

function between(ctx, scope, acc, bounds, pointer) {
  const lo = ordering(ctx, scope, acc, bounds[0], ptrJoin(pointer, 0), "$gte");
  const hi = ordering(ctx, scope, acc, bounds[1], ptrJoin(pointer, 1), "$lte");
  return `(${lo} AND ${hi})`;
}

/**
 * `$in` is an OR of `$eq`s (SPEC §5.4), which is also the only way to get the
 * three-valued behaviour right: SQL's own `x IN (NULL, 1)` is UNKNOWN, and a
 * null member of the list is meant to be a null *test*, not a null comparison.
 * Same-class runs still collapse to a real `IN (…)` so an index can be used.
 */
function inSet(ctx, scope, acc, list, pointer) {
  if (list.length > ctx.limits.maxSetLength) {
    throw new QueryProblem(
      "query-too-complex",
      `set of ${list.length} exceeds the limit of ${ctx.limits.maxSetLength}`,
      pointer,
      { limits: ctx.limits },
    );
  }
  const byClass = new Map();
  let hasNull = false;
  for (const value of list) {
    const klass = classOf(value);
    if (klass === "null") hasNull = true;
    else byClass.set(klass, [...(byClass.get(klass) ?? []), value]);
  }

  const terms = [];
  if (hasNull) terms.push(isNull(ctx, acc, true, pointer));
  for (const [klass, values] of byClass) {
    checkOperandClass(acc, klass, "$in", pointer);
    const cmp = () => `${acc.value(klass)} IN (${values.map((v) => ctx.p(v)).join(", ")})`;
    if (acc.certainClass) {
      terms.push(acc.certainClass === klass ? cmp() : "FALSE");
    } else {
      terms.push(
        `CASE WHEN ${acc.isUnknown()} THEN NULL WHEN ${acc.isClass(klass)} THEN ${cmp()} ELSE FALSE END`,
      );
    }
  }
  return terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`;
}

/** SPEC §5.5: `\` may only escape `%`, `_` or itself, and may not trail. */
function checkLikePattern(pattern, pointer) {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== "\\") continue;
    const next = pattern[i + 1];
    if (next === undefined) throw new QueryProblem("invalid-operand", "$like pattern ends with a trailing '\\'", pointer);
    if (!"%_\\".includes(next)) {
      throw new QueryProblem("invalid-operand", `$like pattern contains the invalid escape "\\${next}"`, pointer);
    }
    i += 1;
  }
  return pattern;
}

const escapeLikeLiteral = (s) => s.replace(/([%_\\])/g, "\\$1");

function pattern(ctx, acc, patternText, pointer, { ci = false, op }) {
  checkOperandClass(acc, "string", op, pointer);
  const cmp = () => {
    const ph = ctx.p(patternText);
    return ci ? ctx.dialect.ilike(acc.value("string"), ph) : ctx.dialect.like(acc.value("string"), ph);
  };
  if (acc.certainClass) return acc.certainClass === "string" ? cmp() : "NULL";
  return `CASE WHEN ${acc.isClass("string")} THEN ${cmp()} ELSE NULL END`;
}

function regex(ctx, acc, expression, flags, pointer) {
  try {
    new RegExp(expression, flags);
  } catch (error) {
    throw new QueryProblem("invalid-operand", `$regex does not compile: ${error.message}`, pointer);
  }
  checkOperandClass(acc, "string", "$regex", pointer);
  const cmp = () => {
    // The flags placeholder is a thunk: Postgres encodes the flags into the
    // operator it picks and must not be handed a parameter it never mentions.
    const sql = ctx.dialect.regex(acc.value("string"), ctx.p(expression), () => ctx.p(flags), flags);
    if (sql === null) {
      throw new QueryProblem(
        "unsupported-operator",
        `$flags "${flags}" has no equivalent in the ${ctx.dialect.name} backend's regular expression engine`,
        pointer,
      );
    }
    if (ctx.dialect.name === "postgres") {
      ctx.warn("$regex is emitted as a POSIX operator: '.' matches a newline, \\d and \\w are locale-dependent classes and \\p{…} does not exist, so an ECMA-262 pattern may not mean what SPEC §5.7 says it means");
    }
    return sql;
  };
  if (acc.certainClass) return acc.certainClass === "string" ? cmp() : "NULL";
  return `CASE WHEN ${acc.isClass("string")} THEN ${cmp()} ELSE NULL END`;
}

function exists(ctx, acc, want, pointer) {
  if (!acc.canExist) {
    // SPEC §4.2: a store that cannot tell absent from null SHOULD reject
    // $exists rather than approximate it. This is that rejection.
    throw new QueryProblem(
      "unsupported-operator",
      `$exists is not supported on "${acc.label}": it is stored in a column, where an absent member and a null one are the same state`,
      pointer,
    );
  }
  const sql = acc.exists();
  return want ? sql : `NOT (${sql})`;
}

function isNull(ctx, acc, want, pointer) {
  // On a JSON path this is exactly right: the type test is NULL when the path
  // resolved to nothing, which is the UNKNOWN the spec asks for.
  const sql = acc.isClass("null");
  return want ? sql : `NOT (${sql})`;
}

function typeTest(ctx, acc, wanted, pointer) {
  if (wanted === "integer") {
    if (acc.certainClass) {
      return acc.certainClass === "number" ? acc.isIntegerValued() : "FALSE";
    }
    return `CASE WHEN ${acc.isUnknown()} THEN NULL ELSE ${acc.isIntegerValued()} END`;
  }
  if (wanted === "null") return acc.isClass("null");
  if (acc.certainClass) {
    return acc.certainClass === wanted ? `${acc.value(wanted)} IS NOT NULL` : "FALSE";
  }
  return `CASE WHEN ${acc.isUnknown()} THEN NULL ELSE ${acc.isClass(wanted)} END`;
}

/** Every collection operator is "walk the array, if it is one" (SPEC §5.8). */
function arrayGuarded(ctx, acc, pointer, op, body) {
  if (!acc.canWalk) {
    throw new QueryProblem(
      "unsupported-operator",
      `${op} is not supported on "${acc.label}": it is stored in a scalar column, not as an array`,
      pointer,
    );
  }
  return `CASE WHEN ${acc.isClass("array")} THEN ${body()} ELSE NULL END`;
}

function hasAny(ctx, scope, acc, list, pointer) {
  return arrayGuarded(ctx, acc, pointer, "$hasAny", () => {
    const alias = ctx.alias();
    const from = acc.each(alias);
    const element = docAccessor(ctx, ctx.dialect.element(alias), [], `${acc.label}[*]`);
    const tests = list.map((v, i) => equality(ctx, scope, element, v, ptrJoin(pointer, i), "$hasAny"));
    return `EXISTS (SELECT 1 FROM ${from} WHERE ${acc.isClass("array")} AND (${tests.join(" OR ")}))`;
  });
}

function hasAll(ctx, scope, acc, list, pointer) {
  return arrayGuarded(ctx, acc, pointer, "$hasAll", () => {
    const each = list.map((v, i) => {
      const alias = ctx.alias();
      const from = acc.each(alias);
      const element = docAccessor(ctx, ctx.dialect.element(alias), [], `${acc.label}[*]`);
      const test = equality(ctx, scope, element, v, ptrJoin(pointer, i), "$hasAll");
      return `EXISTS (SELECT 1 FROM ${from} WHERE ${acc.isClass("array")} AND (${test}))`;
    });
    return each.length === 1 ? each[0] : `(${each.join(" AND ")})`;
  });
}

function size(ctx, acc, constraint, pointer) {
  return arrayGuarded(ctx, acc, pointer, "$size", () => {
    if (typeof constraint === "number") return `${acc.length()} = ${ctx.p(constraint)}`;
    const terms = Object.entries(constraint).map(([op, n]) => {
      const sqlOp = op === "$eq" ? "=" : op === "$ne" ? "<>" : SQL_OP[op];
      return `${acc.length()} ${sqlOp} ${ctx.p(n)}`;
    });
    return terms.length === 1 ? terms[0] : `(${terms.join(" AND ")})`;
  });
}

/**
 * `$elemMatch`'s operand is `anyOf: [Filter, ConstraintObject]`, and the two
 * overlap on `$not`. Nothing in the document says which one is meant, so a
 * compiler has to guess: anything that can only be a Filter makes it a Filter.
 */
function elemMatchIsFilter(operand) {
  const keys = Object.keys(operand);
  if (keys.some((k) => ["$and", "$or", "$nor"].includes(k))) return true;
  return keys.some((k) => !k.startsWith("$") || k.startsWith("$$"));
}

function elemMatch(ctx, acc, operand, pointer, level) {
  return arrayGuarded(ctx, acc, pointer, "$elemMatch", () => {
    const alias = ctx.alias();
    const from = acc.each(alias);
    const node = ctx.dialect.element(alias);
    const inner = elemMatchIsFilter(operand)
      ? filterToSql(ctx, operand, { kind: "element", node }, pointer, level + 1)
      : constraintObjectToSql(
          ctx,
          { kind: "element", node },
          docAccessor(ctx, node, [], `${acc.label}[*]`),
          operand,
          pointer,
          level + 1,
        );
    return `EXISTS (SELECT 1 FROM ${from} WHERE ${acc.isClass("array")} AND (${inner}))`;
  });
}

// ---------------------------------------------------------------------------
// Constraints and filters
// ---------------------------------------------------------------------------

function constraintObjectToSql(ctx, scope, acc, constraint, pointer, level) {
  const terms = [];
  const keys = Object.keys(constraint);

  for (const op of keys) {
    if (op === "$flags") continue; // consumed with $regex
    const ptr = ptrJoin(pointer, op);
    const operand = constraint[op];
    ctx.clause(ptr);
    if (op !== "$not") ctx.profileGate(op, ptr);

    switch (op) {
      case "$eq": terms.push(equality(ctx, scope, acc, operand, ptr, op)); break;
      case "$ne": terms.push(`NOT (${equality(ctx, scope, acc, operand, ptr, op)})`); break;
      case "$gt": case "$gte": case "$lt": case "$lte":
        terms.push(ordering(ctx, scope, acc, operand, ptr, op)); break;
      case "$between": terms.push(between(ctx, scope, acc, operand, ptr)); break;
      case "$nbetween": terms.push(`NOT ${between(ctx, scope, acc, operand, ptr)}`); break;
      case "$in": terms.push(inSet(ctx, scope, acc, operand, ptr)); break;
      case "$nin": terms.push(`NOT (${inSet(ctx, scope, acc, operand, ptr)})`); break;
      case "$like": terms.push(pattern(ctx, acc, checkLikePattern(operand, ptr), ptr, { op })); break;
      case "$nlike": terms.push(`NOT (${pattern(ctx, acc, checkLikePattern(operand, ptr), ptr, { op })})`); break;
      case "$ilike": terms.push(pattern(ctx, acc, checkLikePattern(operand, ptr), ptr, { ci: true, op })); break;
      case "$nilike": terms.push(`NOT (${pattern(ctx, acc, checkLikePattern(operand, ptr), ptr, { ci: true, op })})`); break;
      case "$startsWith": terms.push(pattern(ctx, acc, `${escapeLikeLiteral(operand)}%`, ptr, { op })); break;
      case "$endsWith": terms.push(pattern(ctx, acc, `%${escapeLikeLiteral(operand)}`, ptr, { op })); break;
      case "$contains": terms.push(pattern(ctx, acc, `%${escapeLikeLiteral(operand)}%`, ptr, { op })); break;
      case "$regex": terms.push(regex(ctx, acc, operand, constraint.$flags ?? "", ptr)); break;
      case "$exists": terms.push(exists(ctx, acc, operand, ptr)); break;
      case "$isNull": terms.push(isNull(ctx, acc, operand, ptr)); break;
      case "$type": terms.push(typeTest(ctx, acc, operand, ptr)); break;
      case "$hasAny": terms.push(hasAny(ctx, scope, acc, operand, ptr)); break;
      case "$hasAll": terms.push(hasAll(ctx, scope, acc, operand, ptr)); break;
      case "$hasNone": terms.push(`NOT (${hasAny(ctx, scope, acc, operand, ptr)})`); break;
      case "$size": terms.push(size(ctx, acc, operand, ptr)); break;
      case "$elemMatch": terms.push(elemMatch(ctx, acc, operand, ptr, level)); break;
      case "$search":
        throw new QueryProblem(
          "unsupported-operator",
          "$search needs a full-text index this backend does not have; the operator cannot be compiled into a predicate",
          ptr,
        );
      case "$not":
        ctx.depth(level + 1, ptr);
        terms.push(`NOT (${constraintObjectToSql(ctx, scope, acc, operand, ptr, level + 1)})`);
        break;
      default:
        throw new QueryProblem("malformed-query", `"${op}" is not an operator of this language`, ptr);
    }
  }
  return terms.length === 1 ? terms[0] : `(${terms.join(" AND ")})`;
}

function constraintToSql(ctx, scope, rawPath, constraint, pointer, level) {
  const resolved = resolveField(ctx, scope, rawPath, pointer);
  const shorthand = constraint === null || typeof constraint !== "object";
  const asObject = shorthand ? { $eq: constraint } : constraint;

  if (!resolved.wildcard) {
    return constraintObjectToSql(ctx, scope, resolved.acc, asObject, pointer, level);
  }
  return resolved.build((elementAcc) =>
    constraintObjectToSql(ctx, scope, elementAcc, asObject, pointer, level),
  );
}

function filterToSql(ctx, filter, scope, pointer, level) {
  ctx.depth(level, pointer);
  const terms = [];

  for (const key of Object.keys(filter)) {
    const ptr = ptrJoin(pointer, key);
    const value = filter[key];

    if (key === "$and" || key === "$or" || key === "$nor") {
      ctx.clause(ptr);
      ctx.profileGate(key, ptr);
      const parts = value.map((sub, i) => filterToSql(ctx, sub, scope, ptrJoin(ptr, i), level + 1));
      const joined = parts.length === 1 ? parts[0] : `(${parts.join(key === "$and" ? " AND " : " OR ")})`;
      terms.push(key === "$nor" ? `NOT ${parts.length === 1 ? `(${joined})` : joined}` : joined);
      continue;
    }
    if (key === "$not") {
      ctx.clause(ptr);
      ctx.profileGate(key, ptr);
      terms.push(`NOT (${filterToSql(ctx, value, scope, ptr, level + 1)})`);
      continue;
    }
    if (key.startsWith("$") && !key.startsWith("$$")) {
      throw new QueryProblem("malformed-query", `"${key}" is not an operator of this language`, ptr);
    }
    terms.push(constraintToSql(ctx, scope, key, value, ptr, level));
  }

  return terms.length === 1 ? terms[0] : `(${terms.join(" AND ")})`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Compiles a filter to a WHERE-clause expression plus its bound parameters. */
export function compileWhere(filter, binding, { pointer = "/filter" } = {}) {
  const ctx = new Ctx(binding);
  const where = filterToSql(ctx, filter, { kind: "root" }, pointer, 1);
  return {
    where,
    params: ctx.params,
    warnings: ctx.warnings,
    clauses: ctx.clauses,
    requires: ctx.dialect.requires,
  };
}

/** Compiles a filter to a complete statement over the bound table. */
export function compile(filter, binding, options = {}) {
  const compiled = compileWhere(filter, binding, options);
  const select = binding.select ?? "*";
  const order = binding.orderBy ? ` ORDER BY ${binding.orderBy}` : "";
  return {
    ...compiled,
    sql: `SELECT ${select} FROM ${binding.table} WHERE ${compiled.where}${order}`,
  };
}
