/**
 * fuzz.mjs — a seeded sampler of candidate filters for a generated filter
 * schema.
 *
 * The narrowing property ("every filter the generated schema accepts is also
 * valid against the published grammar") is universally quantified over filters,
 * so a list of examples cannot establish it: it can only re-check the cases
 * someone already thought of. This walks a generated schema and builds filters
 * out of its own vocabulary instead, which puts enough of them inside the
 * accepted set for the property to be worth testing.
 *
 * Sampling is *mostly* conformant — a uniformly random JSON value is rejected
 * by both schemas and tells us nothing. Where a keyword bounds the shape of a
 * value rather than its type (minProperties, minItems/maxItems, uniqueItems,
 * and the dependency keywords, which are ignored outright) the sampler steps
 * over the line on purpose: those are the keywords a generator drops silently,
 * and a dropped one only shows up as a filter this schema accepts and the
 * grammar does not.
 *
 * Deterministic: same seed, same filters, so a failure reproduces.
 */

/** mulberry32 — small, seeded, and stable across Node versions. */
export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Values by format, so a format-constrained operand is usually satisfiable. */
const BY_FORMAT = {
  date: ["2020-01-01", "2024-06-15", "1999-12-31", "not-a-date"],
  "date-time": ["2024-01-01T00:00:00Z", "2020-06-15T12:30:00Z", "nope"],
  time: ["12:00:00", "23:59:59"],
  uuid: ["6f9619ff-8b86-d011-b42d-00c04fc964ff", "00000000-0000-0000-0000-000000000000", "abc"],
  email: ["vet@example.com"],
  uri: ["https://example.com/a"],
  duration: ["P1Y"],
};

const STRINGS = [
  "Fido", "rabies", "cat", "available", "adopt-", "%amsterdam%", "^Fi", "x", "",
  // Short alphabetic values so a pattern-constrained operand ($flags is
  // "^[ims]{0,3}$") has something in the pool that matches it.
  "i", "m", "s", "im", "ims",
];

const FOREIGN = ["Available", "unicorn", 42, true, null];

/** Keys whose value recurses into another filter or constraint object. */
const RECURSIVE = new Set(["$and", "$or", "$nor", "$not", "$some", "$every"]);

/**
 * Builds a sampler over one generated schema. `maxDepth` bounds the nesting the
 * logical operators would otherwise pursue forever, since $not and $some point
 * back at the definition that offers them.
 */
export function sampler(schema, seed, { maxDepth = 4 } = {}) {
  const rand = rngFrom(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chance = (p) => rand() < p;

  const deref = (node) => {
    let cur = node;
    for (let hops = 0; cur && typeof cur === "object" && typeof cur.$ref === "string"; hops++) {
      if (hops > 8) return null;
      cur = cur.$ref === "#" ? schema : schema.$defs?.[cur.$ref.replace("#/$defs/", "")];
    }
    return cur;
  };

  function sample(node, depth) {
    const s = deref(node);
    if (!s || typeof s !== "object") return pick(FOREIGN);
    if ("const" in s) return s.const;
    if (Array.isArray(s.enum)) return chance(0.9) ? pick(s.enum) : pick(FOREIGN);
    if (Array.isArray(s.anyOf)) {
      const { anyOf, ...rest } = s;
      return sample({ ...rest, ...deref(pick(anyOf)) }, depth);
    }

    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : ["object"];
    const type = pick(types);
    switch (type) {
      case "null":
        return null;
      case "boolean":
        return chance(0.5);
      case "integer":
      case "number": {
        const lo = s.minimum ?? s.exclusiveMinimum ?? 0;
        const hi = s.maximum ?? s.exclusiveMaximum ?? lo + 100;
        const v = pick([lo, hi, (lo + hi) / 2, lo - 1, hi + 1, 3.5]);
        return type === "integer" ? Math.round(v) : v;
      }
      case "string": {
        let pool = s.format ? BY_FORMAT[s.format] ?? STRINGS : STRINGS;
        if (s.pattern) {
          const rx = new RegExp(s.pattern);
          const matching = pool.filter((v) => rx.test(v));
          if (matching.length > 0) pool = matching;
        }
        return pick(pool);
      }
      case "array": {
        const min = s.minItems ?? 0;
        const max = Math.max(s.maxItems ?? min + 2, min);
        let n = min + Math.floor(rand() * (max - min + 1));
        // Step outside the declared cardinality now and then: if the generator
        // dropped minItems or maxItems, this is what finds it.
        if (chance(0.08)) n = Math.max(0, n + (chance(0.5) ? 1 : -1));
        const items = Array.from({ length: n }, () => sample(s.items ?? {}, depth + 1));
        // Same for uniqueItems, which $in and $hasAll both carry.
        if (items.length > 1 && chance(0.15)) items[1] = items[0];
        return items;
      }
      default: {
        const names = Object.keys(s.properties ?? {});
        if (names.length === 0) return chance(0.5) ? {} : { vaccine: "rabies" };
        const usable = depth >= maxDepth ? names.filter((k) => !RECURSIVE.has(k)) : names;
        const from = usable.length > 0 ? usable : names.filter((k) => k === "$not");
        if (from.length === 0) return {};
        // Deliberately blind to minProperties, dependentRequired and
        // dependentSchemas: an operator subset is chosen freely, so a lone
        // $unknownAs or a lone $flags is a filter this sampler will produce.
        let k = 1 + Math.floor(rand() * Math.min(3, from.length));
        if (chance(0.05)) k = 0;
        const shuffled = [...from];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const out = {};
        for (const key of shuffled.slice(0, k)) out[key] = sample(s.properties[key], depth + 1);
        return out;
      }
    }
  }

  return () => sample(schema, 0);
}

/** Every operator named anywhere in a generated schema's constraint objects. */
export function operatorsIn(schema) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node.properties ?? {})) {
      if (key.startsWith("$") && !key.startsWith("$$")) found.add(key);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(schema);
  return found;
}

/** Every operator used by a filter, so a sample run can report its coverage. */
export function operatorsUsed(filter, into = new Set()) {
  if (Array.isArray(filter)) {
    for (const item of filter) operatorsUsed(item, into);
    return into;
  }
  if (!filter || typeof filter !== "object") return into;
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("$") && !key.startsWith("$$")) into.add(key);
    operatorsUsed(value, into);
  }
  return into;
}
