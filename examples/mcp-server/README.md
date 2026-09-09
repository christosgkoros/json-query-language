# Example: an MCP server whose search tool takes a filter

A working MCP server exposing one tool, `search_pets`, whose `filter` argument
**is** the query language. Run it, and see what an agent sees.

```bash
node examples/mcp-server/demo.mjs      # drives the server over stdio, prints a transcript
node examples/mcp-server/server.mjs    # the server itself, for a real MCP client
```

Requires Node 22.5+ (`node:sqlite`) and `npm ci` (ajv, for validation).

## The one line the example is about

```js
inputSchema: {
  type: "object",
  properties: {
    filter: FILTER_SCHEMA,        //  ← examples/pet.filter.json, inlined
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  },
  required: ["filter"],
}
```

That is the whole integration. There is no prompt that teaches the query
language, no few-shot examples in the tool description, no instructions about
`$unknownAs`. The model is handed a JSON Schema for an argument, which is what
it already knows how to read, and the schema happens to describe a predicate
language: the operators, what each one means, which paths are queryable, and
what values each path takes.

`tools/list` returns 42 KB of `inputSchema` for this resource. That is the
price, and it is paid once per session against a tool the agent may call
dozens of times, each call otherwise a guess.

## What the transcript shows

```
— available cats and dogs born since 2019
  {"$and":[{"status":"available"},{"species":{"$in":["cat","dog"]}},{"born":{"$gte":"2019-01-01"}}]}
  ✓ 2 matches: Ada, Juno

— a value outside the field's domain
  {"status":"Available"}
  ✗ invalid-operand at /filter/status
    /status must be one of: "available", "pending", "sold".

— $in read as array membership
  {"tags":{"$in":["senior"]}}
  ✗ unsupported-operator at /filter/tags/$in
    $in is not available here. The operators this field accepts are listed under it in the filter schema.
```

The two failures are the ones that matter. Against the *published* grammar both
filters are well-formed and would have returned an empty result set — which an
agent cannot tell apart from "there are no such pets", so it answers
confidently and wrongly. Against a schema generated from the resource, they are
rejected before they reach the database, with a pointer at the clause to fix.

The transcript also runs `{"microchip": {"$ne": "CHIP-0001"}}` and the same
filter with `"$unknownAs": true` — 4 matches against 7. Three-valued logic is
the one thing here that a model may not expect, and the difference is visible
rather than explained.

## How it is put together

| | |
| --- | --- |
| `server.mjs` | the server: tool definition, validation, execution. Stdio JSON-RPC by hand, so the example has no dependencies of its own |
| `pets.mjs` | eight records, the SQLite table they live in, and the binding that says where each queryable path is stored |
| `demo.mjs` | an MCP client, just enough of one to print the transcript above |

The pieces it borrows:

- **`../pet.schema.json`** — the resource schema. One file is the source of
  both the data and the query contract.
- **`../pet.filter.json`** — generated from it by
  [`tools/generate-filter-schema.mjs`](../../tools/generate-filter-schema.mjs),
  and used verbatim as the tool's input schema. Regenerate with
  `npm run generate:example`.
- **[`experiments/filter-to-sql`](../../experiments/filter-to-sql)** — the
  compiler that turns a filter into SQL, so the example executes real queries
  instead of pretending to. That directory is an exercise, not a deliverable;
  it is reused here only to avoid writing a second evaluator.

## Three things it does that a real server should copy

**Inline the schema, and keep its `$id`.** A server ships `inputSchema` inside
its `tools/list` response and nothing on that path fetches a remote `$ref`, so
an absolute URL reaches the model as a string it cannot dereference. The
inlined schema refers to itself — `{"$ref": "#"}` for nested filters,
`#/$defs/…` for each field's operand domain — and those fragments resolve
against the nearest `$id`. Delete it and they resolve against the tool schema's
root instead, which is a different document; ajv fails to compile it at all.

**Generate the schema per resource, don't hand-narrow it.** The published
grammar shares one `Constraint` across every field, so it can say
`{"status": "Available"}` is well-formed but not that `"Available"` is outside
the domain. The generated schema carries the domains, which is what turns the
two silent failures above into errors.

**Return the rejection as a tool error, not a protocol error.** `isError: true`
with the problem in the content puts the pointer in front of the model, which
is enough to repair the clause and retry in one round trip. A JSON-RPC error
gets swallowed by the client.

## One tool per resource

`search_pets`, `search_orders`, `search_invoices` — not
`search(resource, filter)`. `tools/list` is static, so a generic tool cannot
vary its field list by argument, and that field list is most of what makes the
tool usable at all.
