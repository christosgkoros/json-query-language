/**
 * deref.mjs — inline every `$ref`, because two of three providers will not.
 *
 * THE PROBLEM THIS EXISTS FOR, which the pilot found and which is the largest
 * finding in this directory.
 *
 * README §"Exposing search to an agent" says to inline the filter schema into
 * the tool definition, and `examples/mcp-server` does exactly that. Neither
 * mentions that the schema is built almost entirely out of `$ref`. For the
 * generated pet schema, the `$defs` block is 57,756 of 61,354 characters —
 * 94% of the file. Every operator description and every per-field value domain
 * lives in there and is reached by reference.
 *
 * Handed to a provider as a function's parameter schema:
 *
 *   Gemini   rejects the request outright. Its function-declaration schema has
 *            no `$ref` field at all: HTTP 400.
 *   OpenAI   accepts the request and silently discards `$defs`. Measured: the
 *            full tool bills 634 prompt tokens, which is the 3,598 characters
 *            that are *not* `$defs`. The model receives a list of field names
 *            and a set of dangling references.
 *
 * So the recommended setup does not deliver the grammar to the model on either.
 * The schema has to be flattened first, which is what this file does, and the
 * flattening is not free: it multiplies size, and the recursion has to be cut
 * at a fixed depth because a recursive schema has no finite tree form.
 *
 * `$and`, `$or`, `$nor` and `$not` take `{"$ref": "#"}`, so nested filters are
 * unbounded by construction. Cutting at MAX_DEPTH means a filter nested deeper
 * than that is describable but not *described* — the model is told the nesting
 * stops sooner than the server will actually accept.
 */

/**
 * Depth 1. Measured on the generated pet schema: depth 1 is 65,775 characters,
 * depth 2 is 245,904, depth 3 is 280,526. Depth 1 buys every field's operand
 * domain — the part that prevents the valid-but-wrong failures — and spends
 * nothing on re-describing the nesting, which the stub describes in a sentence.
 */
const MAX_DEPTH = 1;

const resolvePointer = (root, ref) => {
  if (ref === "#") return root;
  return ref
    .replace(/^#\//, "")
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((node, token) => node?.[token], root);
};

/** Keywords no provider's function-parameter parser wants to see. */
const DROP = ["$schema", "$id", "$comment", "$defs", "$anchor"];

/**
 * Inline every reference, cutting recursion at `maxDepth`.
 *
 * At the cut, a recursive position becomes a bare `{"type": "object"}` rather
 * than being deleted: deleting it would tell the model that nesting is
 * impossible, which is a different and worse lie than telling it the nesting
 * is shallower than it is.
 */
export function dereference(schema, { maxDepth = MAX_DEPTH } = {}) {
  const root = schema;

  const walk = (node, depth, seen) => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((member) => walk(member, depth, seen));

    if (typeof node.$ref === "string") {
      const { $ref, ...siblings } = node;
      if (depth >= maxDepth) {
        return { type: "object", description: "A nested filter, same shape as the parent." };
      }
      if (seen.has($ref)) {
        return { type: "object", description: "A nested filter, same shape as the parent." };
      }
      const target = resolvePointer(root, $ref);
      if (target === undefined) return { type: "object" };
      const inlined = walk(target, depth + 1, new Set([...seen, $ref]));
      return { ...inlined, ...walk(siblings, depth, seen) };
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (DROP.includes(key)) continue;
      out[key] = walk(value, depth, seen);
    }
    return out;
  };

  return walk(root, 0, new Set());
}

/** Gemini additionally rejects these, even with no reference left in the tree. */
const GEMINI_DROP = ["title", "default", "additionalProperties", "examples", "minProperties", "uniqueItems", "const"];

/**
 * Gemini's subset is narrower still: it has no `const`, so a `oneOf` of consts
 * — which is how the generator expresses a documented enum with per-value
 * prose — has to be rewritten as a plain `enum`, losing the per-value
 * descriptions. Another cost the README does not mention.
 */
export function forGemini(schema) {
  const flat = dereference(schema);

  const walk = (node) => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);

    // oneOf/anyOf of consts -> enum
    for (const combinator of ["oneOf", "anyOf"]) {
      const members = node[combinator];
      if (Array.isArray(members) && members.length > 0 && members.every((m) => m && "const" in m)) {
        const { [combinator]: _drop, ...rest } = node;
        return walk({ ...rest, type: rest.type ?? "string", enum: members.map((m) => m.const) });
      }
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (GEMINI_DROP.includes(key)) continue;
      out[key] = walk(value);
    }
    return out;
  };

  return walk(flat);
}

/**
 * Flatten an arm's whole tool definition.
 *
 * The embedded filter schema keeps its own `$id`, so its `#` and `#/$defs/...`
 * fragments resolve against *it*, not against the tool schema that contains it
 * — which is exactly the hazard README §"Referencing by URL or by copy" warns
 * about, met here from the other side. Dereferencing the wrapper as one
 * document silently resolves every fragment to nothing.
 */
export function flattenTool(tool, { dialect = "openai" } = {}) {
  const flatten = dialect === "gemini" ? forGemini : dereference;
  const schema = structuredClone(tool.input_schema);
  if (schema.properties?.filter) {
    schema.properties.filter = flatten(schema.properties.filter);
  }
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const key of DROP) delete node[key];
    if (dialect === "gemini") for (const key of GEMINI_DROP) delete node[key];
    Object.values(node).forEach(walk);
  };
  walk(schema);
  return { ...tool, input_schema: schema };
}
