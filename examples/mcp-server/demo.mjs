#!/usr/bin/env node
/**
 * demo.mjs — drives the server over stdio the way an MCP client would, so the
 * example can be seen working without wiring it into one.
 *
 * The calls are the ones worth seeing: two that succeed, and the three
 * mistakes an agent makes when it is guessing rather than reading the schema.
 *
 *   node examples/mcp-server/demo.mjs
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const CALLS = [
  ["available cats and dogs born since 2019",
    { $and: [{ status: "available" }, { species: { $in: ["cat", "dog"] } }, { born: { $gte: "2019-01-01" } }] }],
  ["a senior pet in Piraeus, under 15kg",
    { "shelter.city": "Piraeus", tags: { $some: { $in: ["senior"] } }, weightKg: { $lt: 15 } }],
  ["not chipped with CHIP-0001 — three-valued logic drops the nulls",
    { microchip: { $ne: "CHIP-0001" } }],
  ["the same question, meant inclusively",
    { microchip: { $ne: "CHIP-0001", $unknownAs: true } }],
  ["a value outside the field's domain",
    { status: "Available" }],
  ["$in read as array membership",
    { tags: { $in: ["senior"] } }],
  ["a field that is not exposed",
    { internalNotes: { $contains: "bonded" } }],
];

const server = spawn(process.execPath, [join(here, "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: server.stdout });
const pending = new Map();
lines.on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});

let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo", version: "0" } });

const { result: listed } = await rpc("tools/list");
const tool = listed.tools[0];
console.log(`tools/list → ${tool.name}, inputSchema ${JSON.stringify(tool.inputSchema).length} bytes`);
console.log(`  queryable paths: ${Object.keys(tool.inputSchema.properties.filter.properties).filter((k) => !k.startsWith("$")).join(", ")}\n`);

for (const [intent, filter] of CALLS) {
  const { result } = await rpc("tools/call", { name: tool.name, arguments: { filter } });
  const out = result.structuredContent;
  console.log(`— ${intent}`);
  console.log(`  ${JSON.stringify(filter)}`);
  if (out.problem) console.log(`  ✗ ${out.problem.type} at ${out.problem.pointer}\n    ${out.problem.detail}\n`);
  else console.log(`  ✓ ${out.total} match${out.total === 1 ? "" : "es"}: ${out.pets.map((p) => p.name).join(", ") || "—"}\n`);
}

server.kill();
