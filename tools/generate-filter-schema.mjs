#!/usr/bin/env node
/**
 * generate-filter-schema.mjs — derive a per-resource filter schema from a
 * resource's JSON Schema.
 *
 * The published grammar (query-language-schema.json) shares one `Constraint`
 * definition across every field, so it can say that `{"status": "Available"}`
 * is well-formed but not that "Available" is outside `status`'s domain. That
 * gap is why SPEC.md §2.2 exists: the domains have to be published somewhere,
 * and the grammar is not able to carry them.
 *
 * A *generated* schema can. Given the resource's own JSON Schema, every
 * queryable path is known, along with its type, format and value set — so each
 * path gets its own constraint subschema, carrying only the operators that
 * apply to it and only the operands it can meaningfully take. The three
 * valid-but-wrong filters in README §"Exposing search to an agent" all become
 * validation failures instead of empty result sets.
 *
 * Operator titles and descriptions are copied from the published grammar rather
 * than restated here, so the prose an agent reads stays in one place.
 *
 * Usage:
 *   node tools/generate-filter-schema.mjs <resource-schema.json> [options]
 *
 *   --id <uri>              $id for the generated schema (recommended)
 *   --title <text>          title for the generated schema
 *   --profiles <list>       comma-separated; default core,strings,ranges,collections
 *   --pointer <json-ptr>    subschema of the input file to treat as the resource
 *   --max-depth <n>         how far to descend into nested objects (default 3)
 *   --descriptions <mode>   all | brief | none. Default brief: the operators
 *                           whose semantics surprise people keep their prose,
 *                           the self-evident ones keep only a title.
 *   --include <list>        comma-separated paths; omit for "everything found"
 *   --exclude <list>        comma-separated paths or path prefixes ending in *
 *   --out <file>            write the schema here instead of stdout
 *   --capabilities <file>   also write a SPEC.md §2.2 capability document
 *   --grammar <file>        path to query-language-schema.json
 *   --quiet                 suppress warnings on stderr
 *
 * A property may also opt out or override in the resource schema itself:
 *   "x-jql": false                        — not queryable
 *   "x-jql": { "queryable": false }       — same
 *   "x-jql": { "operators": ["$eq"] }     — exactly these operators
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GRAMMAR = join(here, "..", "query-language-schema.json");
const DEFAULT_PROFILES = ["core", "strings", "ranges", "collections"];

/** Formats whose values are opaque tokens: substring matching on them is noise. */
const OPAQUE_FORMATS = new Set(["uuid", "uri", "iri", "email", "ipv4", "ipv6", "duration"]);
/** Formats whose lexicographic order coincides with their natural order (SPEC §5.2). */
const ORDERED_FORMATS = new Set(["date", "date-time", "time"]);
/**
 * Operators whose description earns its place next to every field: each one is
 * a rule a reader would otherwise get wrong. The rest carry their title only,
 * because repeating "Field equals the operand" once per path is pure tokens in
 * an MCP tool definition. `--descriptions all` restores them.
 */
const SURPRISING = new Set([
  "$and", "$or", "$nor", "$not",
  "$in", "$nin", "$exists", "$isNull", "$type",
  "$like", "$ilike", "$contains", "$regex", "$flags", "$search",
  "$between", "$hasAny", "$hasAll", "$hasNone", "$size", "$elemMatch",
]);

/** Value-domain keywords worth carrying onto an equality operand. */
const DOMAIN_KEYWORDS = [
  "enum", "const", "format", "pattern", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
];

// ---------------------------------------------------------------------------
// $ref resolution and allOf flattening
// ---------------------------------------------------------------------------

function jsonPointer(root, pointer) {
  if (pointer === "" || pointer === "#") return root;
  const parts = pointer.replace(/^#/, "").split("/").slice(1);
  let node = root;
  for (const raw of parts) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === undefined || node === null) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Follows local $refs to a concrete node. `trail` accumulates the pointers
 * crossed on this branch so a recursive schema (Pet.friends -> Pet) terminates
 * rather than looping: a ref already on the trail resolves to null and the
 * caller drops that branch.
 */
function makeDeref(root) {
  return function deref(node, trail) {
    let cur = node;
    for (let hops = 0; cur && typeof cur === "object" && typeof cur.$ref === "string"; hops++) {
      const ref = cur.$ref;
      if (!ref.startsWith("#")) {
        throw new Error(`only local $ref is supported; found "${ref}". Bundle the schema first.`);
      }
      if (hops > 32) throw new Error(`$ref chain too long at "${ref}"`);
      if (trail?.has(ref)) return null;
      trail?.add(ref);
      const target = jsonPointer(root, ref);
      if (target === undefined) throw new Error(`unresolvable $ref: "${ref}"`);
      cur = target;
    }
    return cur;
  };
}

/** Shallow-merges allOf branches so a composed resource schema still yields fields. */
function flatten(node, deref, trail) {
  const resolved = deref(node, trail);
  if (!resolved || typeof resolved !== "object") return resolved;
  if (!Array.isArray(resolved.allOf)) return resolved;

  const merged = { ...resolved };
  delete merged.allOf;
  for (const branch of resolved.allOf) {
    const b = flatten(branch, deref, new Set(trail));
    if (!b || typeof b !== "object") continue;
    merged.properties = { ...(b.properties ?? {}), ...(merged.properties ?? {}) };
    if (b.required) merged.required = [...new Set([...(b.required ?? []), ...(merged.required ?? [])])];
    for (const k of ["type", "items", "description", "title", ...DOMAIN_KEYWORDS]) {
      if (merged[k] === undefined && b[k] !== undefined) merged[k] = b[k];
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Type inspection
// ---------------------------------------------------------------------------

function typesOf(schema) {
  if (!schema || typeof schema !== "object") return [];
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return [...schema.type];
  // No explicit "type" — infer from whatever else is present.
  const inferred = new Set();
  for (const value of [].concat(schema.const ?? [], schema.enum ?? [])) {
    inferred.add(value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value);
  }
  if (schema.properties || schema.additionalProperties) inferred.add("object");
  if (schema.items || schema.prefixItems) inferred.add("array");
  return [...inferred];
}

/** The consts of a closed domain, whether written as `enum` or as a union of `const`s. */
function domainValues(schema) {
  if (Array.isArray(schema?.enum)) return schema.enum;
  if (schema?.const !== undefined) return [schema.const];
  const union = schema?.oneOf ?? schema?.anyOf;
  if (Array.isArray(union) && union.length && union.every((b) => b && b.const !== undefined)) {
    return union.map((b) => b.const);
  }
  return null;
}

const SCALARS = new Set(["string", "number", "integer", "boolean"]);

function classify(schema) {
  const types = typesOf(schema);
  const nullable = types.includes("null");
  const nonNull = types.filter((t) => t !== "null");
  if (nonNull.length === 0) return { kind: "unknown", nullable, types: nonNull };
  if (nonNull.length === 1 && nonNull[0] === "array") return { kind: "array", nullable, types: nonNull };
  if (nonNull.length === 1 && nonNull[0] === "object") return { kind: "object", nullable, types: nonNull };
  if (nonNull.every((t) => SCALARS.has(t))) return { kind: "scalar", nullable, types: nonNull };
  return { kind: "mixed", nullable, types: nonNull };
}

// ---------------------------------------------------------------------------
// Field paths (SPEC §3.2, §3.3)
// ---------------------------------------------------------------------------

function escapeKey(key) {
  const escaped = key.replace(/([.[\]\\])/g, "\\$1");
  return escaped.startsWith("$") ? `$${escaped}` : escaped;
}

function globToRegExp(glob) {
  const body = glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`);
}

// ---------------------------------------------------------------------------
// Field collection
// ---------------------------------------------------------------------------

/**
 * Walks one object schema and returns the queryable paths beneath it. Nested
 * objects contribute dotted paths within the *same* filter; arrays stop the
 * descent and are addressed through $elemMatch instead, which is the operator
 * with the semantics people usually mean (SPEC §5.9).
 */
function collectFields(node, ctx, state) {
  const out = [];
  walk(node, "", true, state.depth, new Set(state.trail));

  function walk(schemaNode, prefix, alwaysPresent, depth, trail) {
    const schema = flatten(schemaNode, ctx.deref, trail);
    if (!schema || typeof schema !== "object" || !schema.properties) return;
    const required = new Set(schema.required ?? []);

    for (const [name, rawProp] of Object.entries(schema.properties)) {
      const branchTrail = new Set(trail);
      const prop = flatten(rawProp, ctx.deref, branchTrail);
      if (!prop || typeof prop !== "object") continue;

      const ext = rawProp["x-jql"] ?? prop["x-jql"];
      if (ext === false || ext?.queryable === false) continue;

      const path = prefix + escapeKey(name);
      if (ctx.opts.exclude.some((rx) => rx.test(path))) continue;

      const present = alwaysPresent && required.has(name);
      const info = classify(prop);

      if (info.kind === "unknown") {
        ctx.warn(`skipped "${path}": no discoverable type. Add "type", or "x-jql": {"operators": [...]}.`);
        continue;
      }

      if (info.kind === "object") {
        // The object itself is queryable only for presence; its members carry
        // the real predicates.
        if (!present) out.push({ path, schema: prop, info, present, ext, kind: "object" });
        if (depth + 1 <= ctx.opts.maxDepth) {
          walk(prop, `${path}.`, present, depth + 1, branchTrail);
        } else {
          ctx.warn(`stopped at "${path}": --max-depth ${ctx.opts.maxDepth} reached.`);
        }
        continue;
      }

      if (info.kind === "array") {
        const items = flatten(prop.items ?? {}, ctx.deref, branchTrail);
        const itemInfo = items ? classify(items) : { kind: "unknown" };
        out.push({ path, schema: prop, info, present, ext, kind: "array", items, itemInfo, trail: branchTrail, depth });
        continue;
      }

      out.push({ path, schema: prop, info, present, ext, kind: info.kind });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Operator selection
// ---------------------------------------------------------------------------

function operatorsFor(field, ctx) {
  if (Array.isArray(field.ext?.operators)) {
    return field.ext.operators.filter((op) => ctx.enabled.has(op));
  }

  const ops = [];
  const push = (...names) => { for (const n of names) if (ctx.enabled.has(n)) ops.push(n); };
  const { info, schema, kind } = field;
  const format = schema.format;
  const closed = domainValues(schema) !== null;

  if (kind === "object") {
    push("$exists");
    if (info.nullable) push("$isNull");
    return ops;
  }

  if (kind === "array") {
    // An element type we could not resolve — an untyped `items`, or a cycle the
    // walk cut — leaves nothing to type an operand against. Length and presence
    // are all that can be offered honestly.
    if (!field.itemInfo || field.itemInfo.kind === "unknown") {
      ctx.warn(`"${field.path}": element type unresolved; only $size and presence are queryable.`);
      push("$size");
      if (!field.present) push("$exists");
      if (info.nullable) push("$isNull");
      push("$not");
      return ops;
    }
    push("$eq", "$ne");
    if (field.itemInfo.kind === "scalar") push("$hasAny", "$hasAll", "$hasNone");
    push("$size");
    if (field.itemInfo?.kind === "object" || field.itemInfo?.kind === "scalar") push("$elemMatch");
    if (!field.present) push("$exists");
    if (info.nullable) push("$isNull");
    push("$not");
    return ops;
  }

  const isString = info.types.includes("string");
  const isNumeric = info.types.some((t) => t === "number" || t === "integer");
  const isBoolean = info.types.length === 1 && info.types[0] === "boolean";

  push("$eq", "$ne");
  // $in over a two-valued domain says nothing $eq does not.
  if (!isBoolean) push("$in", "$nin");

  const ordered = isNumeric || (isString && ORDERED_FORMATS.has(format));
  if (ordered) {
    push("$gt", "$gte", "$lt", "$lte");
    push("$between", "$nbetween");
  }

  // Pattern matching is meaningful on free text only: not on a closed domain,
  // where the accepted values are already enumerated, and not on an opaque
  // token like a UUID.
  if (isString && !closed && !OPAQUE_FORMATS.has(format) && !ORDERED_FORMATS.has(format)) {
    push("$like", "$nlike", "$ilike", "$nilike", "$startsWith", "$endsWith", "$contains");
    push("$regex", "$flags");
    push("$search");
  }

  // $type only earns its place where the type is genuinely a union.
  if (info.types.length > 1) push("$type");
  if (!field.present) push("$exists");
  if (info.nullable) push("$isNull");
  push("$not");
  return ops;
}

// ---------------------------------------------------------------------------
// Operand schemas
// ---------------------------------------------------------------------------

/**
 * The operand schema for the equality family: the field's own value domain.
 * Carrying `enum`, `pattern` and the numeric bounds is what turns
 * {"status": "Available"} from an empty result set into a 400.
 */
function strictValue(schema, info) {
  const value = {};
  const known = info?.types ?? [];
  const types = info?.nullable ? [...known, "null"] : [...known];
  const consts = domainValues(schema);
  const union = schema.oneOf ?? schema.anyOf;

  if (consts && Array.isArray(union) && union.every((b) => b?.const !== undefined) && union.some((b) => b.description)) {
    // Per-value prose only survives as a union of consts; an enum has nowhere
    // to put it. README §"Exposing search to an agent", step 2.
    if (types.length) value.type = types.length === 1 ? types[0] : types;
    value.anyOf = union.map((b) => ({ const: b.const, ...(b.description ? { description: b.description } : {}) }));
    if (info.nullable) value.anyOf.push({ const: null });
    return value;
  }

  if (types.length) value.type = types.length === 1 ? types[0] : types;
  for (const k of DOMAIN_KEYWORDS) {
    if (schema[k] !== undefined) value[k] = schema[k];
  }
  if (consts && info?.nullable && Array.isArray(value.enum) && !value.enum.includes(null)) {
    value.enum = [...value.enum, null];
  }
  return value;
}

/**
 * The operand schema for the ordering family. Deliberately looser than
 * `strictValue`: `{"$gt": 0}` against a field whose minimum is 1 is a
 * perfectly sensible predicate, so the bounds must not be carried across.
 */
function looseValue(schema, info) {
  const value = { type: info.types.length === 1 ? info.types[0] : info.types };
  if (schema.format && ORDERED_FORMATS.has(schema.format)) value.format = schema.format;
  return value;
}

function setOf(itemsRef) {
  return { type: "array", minItems: 1, uniqueItems: true, items: itemsRef };
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function sanitize(text) {
  return text
    .replace(/\[\*\]/g, "_elem")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "field";
}

function defName(ctx, prefix, hint) {
  const base = `${prefix}${sanitize(hint)}`;
  let name = base;
  for (let n = 2; ctx.defs[name] !== undefined || ctx.reserved.has(name); n++) name = `${base}${n}`;
  ctx.reserved.add(name);
  return name;
}

/**
 * Copies the operator's own title and description out of the published grammar,
 * so the prose an agent reads lives in exactly one place. `from` picks the
 * right definition for the two operators that exist at both levels: $not means
 * something different inside a Filter than inside a constraint object.
 */
function annotate(ctx, op, schema, from = "constraint") {
  const table = from === "filter" ? ctx.grammar.$defs.Filter.properties : ctx.grammar.$defs.ConstraintObject.properties;
  const source = table[op] ?? ctx.grammar.$defs.ConstraintObject.properties[op] ?? ctx.grammar.$defs.Filter.properties[op];
  const { title, description } = source ?? {};
  const keep = ctx.opts.descriptions === "all" || (ctx.opts.descriptions === "brief" && SURPRISING.has(op));
  return {
    ...(title ? { title } : {}),
    ...(keep && description ? { description } : {}),
    ...schema,
  };
}

function emitSizeDef(ctx) {
  if (!ctx.defs.Size) {
    ctx.reserved.add("Size");
    ctx.defs.Size = structuredClone(ctx.grammar.$defs.SizeConstraint);
  }
  return { $ref: "#/$defs/Size" };
}

/** Builds the constraint-object subschema for one field, and registers it. */
function emitConstraint(ctx, field, prefix) {
  const ops = operatorsFor(field, ctx);
  if (ops.length === 0) return null;

  const name = defName(ctx, `${prefix}C_`, field.nameHint ?? field.path);
  const props = {};

  const hint = field.nameHint ?? field.path;
  const valueRef = () => {
    if (!field.valueDef) {
      field.valueDef = defName(ctx, `${prefix}V_`, hint);
      ctx.defs[field.valueDef] = strictValue(field.schema, field.info);
    }
    return { $ref: `#/$defs/${field.valueDef}` };
  };
  const orderedRef = () => {
    if (!field.orderedDef) {
      field.orderedDef = defName(ctx, `${prefix}O_`, hint);
      ctx.defs[field.orderedDef] = looseValue(field.schema, field.info);
    }
    return { $ref: `#/$defs/${field.orderedDef}` };
  };
  const itemRef = () => {
    if (!field.itemDef) {
      field.itemDef = defName(ctx, `${prefix}I_`, hint);
      ctx.defs[field.itemDef] = strictValue(field.items ?? {}, field.itemInfo);
    }
    return { $ref: `#/$defs/${field.itemDef}` };
  };

  for (const op of ops) {
    switch (op) {
      case "$eq": case "$ne":
        props[op] = annotate(ctx, op, field.kind === "array"
          ? { type: "array", items: itemRef() }
          : valueRef());
        break;
      case "$in": case "$nin":
        props[op] = annotate(ctx, op, setOf(valueRef()));
        break;
      case "$gt": case "$gte": case "$lt": case "$lte":
        props[op] = annotate(ctx, op, orderedRef());
        break;
      case "$between": case "$nbetween":
        props[op] = annotate(ctx, op, { type: "array", minItems: 2, maxItems: 2, items: orderedRef() });
        break;
      case "$hasAny": case "$hasAll": case "$hasNone":
        props[op] = annotate(ctx, op, setOf(itemRef()));
        break;
      case "$size":
        props[op] = annotate(ctx, op, emitSizeDef(ctx));
        break;
      case "$elemMatch": {
        const target = emitElemMatch(ctx, field, prefix);
        if (target) props[op] = annotate(ctx, op, target);
        break;
      }
      case "$not":
        props[op] = annotate(ctx, op, { $ref: `#/$defs/${name}` });
        break;
      case "$flags":
        props[op] = annotate(ctx, op, { type: "string", pattern: "^[ims]{0,3}$" });
        break;
      default: {
        // Everything left takes the operand shape the grammar already gives it:
        // $like and friends, $regex, $search, $exists, $isNull, $type.
        const base = ctx.grammar.$defs.ConstraintObject.properties[op];
        const { title, description, $ref, ...shape } = base ?? {};
        props[op] = annotate(ctx, op, shape);
      }
    }
  }

  const constraint = {
    title: field.path,
    ...(field.schema.description ? { description: field.schema.description } : {}),
    type: "object",
    minProperties: 1,
    properties: props,
    additionalProperties: false,
  };
  if (props.$flags) constraint.dependentRequired = { $flags: ["$regex"] };

  ctx.defs[name] = constraint;
  field.constraintDef = name;
  field.operators = ops;

  // Scalars keep the shorthand: {"status": "open"} is {"status": {"$eq": "open"}}.
  if (field.kind === "scalar") {
    return { anyOf: [valueRef(), { $ref: `#/$defs/${name}` }] };
  }
  return { $ref: `#/$defs/${name}` };
}

function emitElemMatch(ctx, field, prefix) {
  if (field.itemInfo?.kind === "object") {
    if (field.depth + 1 > ctx.opts.maxDepth) {
      ctx.warn(`"${field.path}": --max-depth reached, $elemMatch omitted.`);
      return null;
    }
    const name = defName(ctx, `${prefix}F_`, `${field.path}_elem`);
    const filter = emitFilter(ctx, field.items, name, {
      depth: field.depth + 1,
      trail: field.trail ?? new Set(),
      selfRef: `#/$defs/${name}`,
    });
    if (!filter) return null;
    return { $ref: `#/$defs/${name}` };
  }
  if (field.itemInfo?.kind === "scalar") {
    // An array of scalars has no member paths, so the element condition is a
    // constraint object over the element value itself (SPEC §5.8).
    const element = {
      path: `${field.path}[*]`,
      nameHint: `${field.path}_elem`,
      schema: field.items ?? {},
      info: field.itemInfo,
      present: true,
      kind: "scalar",
    };
    const ref = emitConstraint(ctx, element, prefix);
    // $elemMatch takes the object form only; the scalar shorthand is not part
    // of its operand grammar.
    return element.constraintDef ? { $ref: `#/$defs/${element.constraintDef}` } : ref;
  }
  return null;
}

/**
 * Emits a Filter over one object schema: logical operators plus one property
 * per queryable path. `additionalProperties: false` over an explicit property
 * list is what makes an unknown field a validation error rather than a runtime
 * `unknown-field` problem.
 */
function emitFilter(ctx, node, name, state) {
  if (name !== "__root__") ctx.reserved.add(name);
  const selfRef = state.selfRef ?? "#";
  const fields = collectFields(node, ctx, state);
  if (fields.length === 0) {
    ctx.warn(`no queryable fields found${name === "__root__" ? "" : ` for ${name}`}.`);
    return null;
  }

  const prefix = name === "__root__" ? "" : `${sanitize(name)}_`;
  const properties = {};
  for (const op of ["$and", "$or", "$nor"]) {
    if (!ctx.enabled.has(op)) continue;
    properties[op] = annotate(ctx, op, { type: "array", minItems: 1, items: { $ref: selfRef } }, "filter");
  }
  if (ctx.enabled.has("$not")) properties.$not = annotate(ctx, "$not", { $ref: selfRef }, "filter");

  const emitted = [];
  for (const field of fields) {
    const ref = emitConstraint(ctx, field, prefix);
    if (!ref) continue;
    properties[field.path] = ref;
    emitted.push(field);
  }

  const filter = {
    type: "object",
    minProperties: 1,
    properties,
    additionalProperties: false,
  };

  if (name === "__root__") {
    ctx.rootFilter = filter;
    ctx.rootFields = emitted;
  } else {
    ctx.defs[name] = filter;
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SILENT_RULES = [
  "Sibling members are combined with implicit AND, at every level.",
  "A bare scalar is equality: {\"status\": \"open\"} is {\"status\": {\"$eq\": \"open\"}}.",
  "Comparisons use three-valued logic: $ne and $not do NOT match records where the field is null or absent. To include them, add an explicit {\"$isNull\": true} branch under $or.",
  "$in compares the whole field value; it is not array membership. The element operators are $hasAny, $hasAll and $hasNone.",
];

export function generateFilterSchema(resource, options = {}) {
  const ctx = prepare(resource, options);
  emitFilter(ctx, ctx.resource, "__root__", { depth: 0, trail: new Set() });
  if (!ctx.rootFilter) throw new Error("no queryable fields — nothing to generate");
  if (ctx.opts.include) pruneToIncluded(ctx);

  const title = options.title ?? `${ctx.resource.title ?? "Resource"} — filter`;
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(options.id ? { $id: options.id } : {}),
    title,
    description: [
      `A filter over ${ctx.resource.title ?? "this resource"}, in the JSON Query Language.`,
      ...SILENT_RULES,
    ].join(" "),
    $comment:
      `Generated by tools/generate-filter-schema.mjs from ${ctx.resource.$id ?? options.source ?? "a resource schema"} ` +
      `against ${ctx.grammar.$id}. Profiles: ${ctx.opts.profiles.join(", ")}. Do not edit by hand.`,
    ...ctx.rootFilter,
    $defs: ctx.defs,
  };
  return { schema, capabilities: buildCapabilities(ctx, options), warnings: ctx.warnings };
}

export function generateCapabilities(resource, options = {}) {
  return generateFilterSchema(resource, options).capabilities;
}

/**
 * --include is applied after the walk rather than during it, so a nested path
 * like "shelter.city" can be named without also naming its parent.
 */
function pruneToIncluded(ctx) {
  const keep = new Set(ctx.opts.include);
  for (const path of Object.keys(ctx.rootFilter.properties)) {
    if (!path.startsWith("$") && !keep.has(path)) delete ctx.rootFilter.properties[path];
  }
  for (const path of ctx.opts.include) {
    if (!(path in ctx.rootFilter.properties)) ctx.warn(`--include names "${path}", which was not found.`);
  }
  ctx.rootFields = ctx.rootFields.filter((f) => keep.has(f.path));
}

function buildCapabilities(ctx, options) {
  const fields = {};
  for (const field of ctx.rootFields ?? []) {
    const entry = { operators: field.operators };
    const types = field.info.types;
    if (types.length === 1) entry.type = types[0];
    else if (types.length > 1) entry.type = types;
    if (field.schema.format) entry.format = field.schema.format;
    const values = domainValues(field.schema);
    if (values) entry.values = values;
    if (field.kind === "array" && field.items) {
      const itemValues = domainValues(field.items);
      if (itemValues) entry.itemValues = itemValues;
    }
    if (field.schema.description) entry.description = field.schema.description;
    if (field.info.nullable) entry.nullable = true;
    fields[field.path] = entry;
  }
  return {
    queryLanguage: ctx.grammar.$id,
    ...(options.id ? { filterSchema: options.id } : {}),
    profiles: ctx.opts.profiles,
    fields,
    limits: options.limits ?? { maxDepth: 10, maxClauses: 100, maxSetLength: 1000 },
  };
}

function prepare(resource, options) {
  const grammar = options.grammar ?? JSON.parse(readFileSync(options.grammarPath ?? DEFAULT_GRAMMAR, "utf8"));
  const profiles = options.profiles ?? DEFAULT_PROFILES;

  const modes = ["all", "brief", "none"];
  if (options.descriptions && !modes.includes(options.descriptions)) {
    throw new Error(`--descriptions must be one of ${modes.join(", ")}`);
  }

  const known = Object.keys(grammar["x-profiles"]);
  for (const p of profiles) {
    if (!known.includes(p)) throw new Error(`unknown profile "${p}"; the grammar defines ${known.join(", ")}`);
  }
  if (!profiles.includes("core")) throw new Error(`the "core" profile is mandatory (SPEC §2.1)`);

  const enabled = new Set(profiles.flatMap((p) => grammar["x-profiles"][p]));

  const root = resource;
  const deref = makeDeref(root);
  const entry = options.pointer ? jsonPointer(root, options.pointer) : root;
  if (entry === undefined) throw new Error(`--pointer "${options.pointer}" does not resolve`);
  const resolved = flatten(entry, deref, new Set());

  const warnings = [];
  return {
    grammar,
    deref,
    enabled,
    defs: {},
    reserved: new Set(["Size"]),
    warnings,
    warn: (m) => warnings.push(m),
    resource: resolved,
    opts: {
      profiles,
      maxDepth: options.maxDepth ?? 3,
      descriptions: options.descriptions ?? "brief",
      include: options.include ?? null,
      exclude: (options.exclude ?? []).map(globToRegExp),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      id: { type: "string" },
      title: { type: "string" },
      profiles: { type: "string" },
      pointer: { type: "string" },
      "max-depth": { type: "string" },
      include: { type: "string" },
      exclude: { type: "string" },
      capabilities: { type: "string" },
      descriptions: { type: "string" },
      grammar: { type: "string" },
      out: { type: "string" },
      quiet: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length !== 1) {
    // The header comment is the help text; keeping one copy avoids the usual drift.
    const header = readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("*/")[0]
      .replace(/^#!.*\n/, "")
      .replace(/^\/\*\*?\n?/, "")
      .replace(/^ \*\/?/gm, "")
      .replace(/^ /gm, "")
      .trimEnd();
    process.stdout.write(`${header}\n`);
    process.exit(values.help ? 0 : 1);
  }

  const source = positionals[0];
  const resource = JSON.parse(readFileSync(source, "utf8"));
  const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

  const { schema, capabilities, warnings } = generateFilterSchema(resource, {
    id: values.id,
    title: values.title,
    source,
    profiles: list(values.profiles),
    pointer: values.pointer,
    maxDepth: values["max-depth"] ? Number(values["max-depth"]) : undefined,
    descriptions: values.descriptions,
    include: list(values.include),
    exclude: list(values.exclude),
    grammarPath: values.grammar,
  });

  const json = `${JSON.stringify(schema, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, json);
  else process.stdout.write(json);

  if (values.capabilities) {
    writeFileSync(values.capabilities, `${JSON.stringify(capabilities, null, 2)}\n`);
  }
  if (!values.quiet) {
    for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
