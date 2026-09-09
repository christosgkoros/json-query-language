#!/usr/bin/env node
/**
 * server.mjs — an MCP server whose search tool takes a JSON Query Language
 * filter as its input schema.
 *
 * The point of the example is one line of the tool definition:
 *
 *     inputSchema.properties.filter = <the filter schema, inlined>
 *
 * Everything the model needs in order to write a correct filter is in that
 * subschema: the operators, their semantics, the queryable paths, and each
 * path's value domain. Nothing in the prompt has to teach the query language
 * and nothing in the tool description has to hint at it. The grammar is the
 * contract, and the model reads it the same way it reads any other argument.
 *
 * The rest of this file is an ordinary server: validate, compile, execute.
 *
 *   tool definition   pet.filter.json, generated from pet.schema.json
 *   validation        ajv, against that same file
 *   execution         the SQL compiler from experiments/filter-to-sql
 *   data              pets.mjs, an in-memory SQLite table
 *
 * Transport is stdio JSON-RPC, written out by hand so the example has no
 * dependencies beyond what the repository already installs for its tests. A
 * real server would use an MCP SDK; the tool definition would be identical.
 *
 * Requires Node 22.5+ (node:sqlite).  Run: node examples/mcp-server/server.mjs
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

import { compile, QueryProblem } from "../../experiments/filter-to-sql/compile.mjs";
import { BINDING, DDL, INSERT, rows } from "./pets.mjs";

const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;
const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The tool definition
// ---------------------------------------------------------------------------

/**
 * The filter schema is read from disk and inlined. It has to be inlined: a
 * server ships `inputSchema` inside its tools/list response, and nothing on
 * that path fetches a remote $ref — an absolute URL would reach the model as
 * a string it cannot dereference.
 *
 * Its `$id` is kept. The schema refers to itself (`{"$ref": "#"}` for nested
 * filters, `#/$defs/...` for each field's operand domain) and those fragments
 * resolve against the nearest `$id`. Strip it and they would resolve against
 * the tool schema's root instead, which is a different document.
 */
const FILTER_SCHEMA = JSON.parse(
  readFileSync(join(here, "..", "pet.filter.json"), "utf8"),
);

const SEARCH_PETS = {
  name: "search_pets",
  title: "Search pets",
  description:
    "Search the pet collection. The `filter` argument is a predicate over a " +
    "pet record; its schema describes every operator and every queryable " +
    "field, including which values each field accepts. Returns the matching " +
    "records. An invalid filter comes back as an error naming the offending " +
    "clause, which is enough to correct it and retry.",
  inputSchema: {
    type: "object",
    properties: {
      filter: FILTER_SCHEMA,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 20,
        description: "Maximum number of records to return.",
      },
    },
    required: ["filter"],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Validate, compile, execute
// ---------------------------------------------------------------------------

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateFilter = ajv.compile(FILTER_SCHEMA);

/**
 * ajv reports where a filter stopped matching; SPEC.md §8 asks which of five
 * things went wrong. The mapping is coarse on purpose — what an agent needs is
 * a distinguishable condition and a pointer at the clause, not a taxonomy.
 */
function pointerEscape(token) {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function problemFromAjv(errors) {
  // A property the schema does not allow is either a path that is not
  // queryable or an operator this endpoint does not implement. The leading
  // "$" is what tells them apart.
  const rejected = errors.find((e) => e.keyword === "additionalProperties");
  if (rejected) {
    const name = rejected.params.additionalProperty;
    const pointer = `/filter${rejected.instancePath}/${pointerEscape(name)}`;
    return name.startsWith("$")
      ? {
          type: "unsupported-operator",
          title: "Unsupported operator",
          detail: `${name} is not available here. The operators this field accepts are listed under it in the filter schema.`,
          pointer,
        }
      : {
          type: "unknown-field",
          title: "Unknown field",
          detail: `"${name}" is not a queryable path on this resource. The queryable paths are the properties of the filter schema.`,
          pointer,
        };
  }

  // Everything else is an operand the field's domain does not admit. The outer
  // anyOf/type errors only restate a failure that happened further in, so the
  // deepest location is the one worth reporting — and where the domain is
  // closed, ajv has already listed the values it would have accepted.
  const deepest = errors.reduce((a, b) => (b.instancePath.length > a.instancePath.length ? b : a));
  const at = deepest.instancePath;
  const here_ = errors.filter((e) => e.instancePath === at);
  const allowed = [
    ...new Set(
      here_.flatMap((e) =>
        e.keyword === "const" ? [e.params.allowedValue]
        : e.keyword === "enum" ? e.params.allowedValues
        : [],
      ),
    ),
  ];
  const detail = allowed.length
    ? `${at || "the filter"} must be one of: ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`
    : `${at || "the filter"} ${(here_.find((e) => e.keyword !== "anyOf") ?? deepest).message}.`;
  return { type: "invalid-operand", title: "Invalid operand", detail, pointer: `/filter${at}` };
}

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA case_sensitive_like = ON");
db.exec(DDL);
{
  const insert = db.prepare(INSERT);
  for (const row of rows()) insert.run(...row);
}

function searchPets({ filter, limit = 20 }) {
  if (!validateFilter(filter)) {
    return { problem: problemFromAjv(validateFilter.errors) };
  }
  let compiled;
  try {
    compiled = compile(filter, BINDING);
  } catch (error) {
    if (error instanceof QueryProblem) {
      const p = error.toProblem();
      return { problem: { type: p.type?.split("/").pop() ?? "malformed-query", title: p.title, detail: p.detail, pointer: p.pointer } };
    }
    throw error;
  }
  const found = db
    .prepare(compiled.sql)
    .all(...compiled.params)
    .map((row) => JSON.parse(row.doc))
    // `internalNotes` is not queryable and is not returned either.
    .map(({ internalNotes, ...pet }) => pet);
  return { total: found.length, pets: found.slice(0, limit), sql: compiled.sql };
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(request) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pet-store-search", version: "0.4.0" },
      };

    case "ping":
      return {};

    case "tools/list":
      return { tools: [SEARCH_PETS] };

    case "tools/call": {
      if (request.params?.name !== SEARCH_PETS.name) {
        throw Object.assign(new Error(`unknown tool: ${request.params?.name}`), { code: -32602 });
      }
      const result = searchPets(request.params.arguments ?? {});
      // A rejected filter is a tool error, not a protocol error: the model
      // should see it, and it carries everything needed to fix the clause.
      return {
        content: [{ type: "text", text: JSON.stringify(result.problem ?? result, null, 2) }],
        structuredContent: result,
        isError: Boolean(result.problem),
      };
    }

    default:
      throw Object.assign(new Error(`unknown method: ${request.method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  // Notifications carry no id and take no response.
  if (request.id === undefined) return;
  try {
    send({ jsonrpc: "2.0", id: request.id, result: handle(request) });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: error.code ?? -32603, message: error.message },
    });
  }
});
