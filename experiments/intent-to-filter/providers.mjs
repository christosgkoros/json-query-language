/**
 * providers.mjs — the same tool definition, put to three model families.
 *
 * The experiment was designed for one provider and had to move to three when
 * no Anthropic key was available. That turned out to be the better design:
 * `README.md:3` claims a property of "a model", not of one vendor's models, so
 * evidence from three independent families answers an objection that two
 * models from one family never could.
 *
 * IT ALSO SURFACED THE LARGEST FINDING IN THIS DIRECTORY, before any question
 * was asked. Gemini cannot host the recommended setup at all. Its function
 * declaration schema is a restricted subset with no `$ref`, and the filter
 * grammar is recursive — `{"$and": {"items": {"$ref": "#"}}}` — so it cannot be
 * flattened into a finite tree either. Not degraded: impossible. Both schema
 * arms are therefore unavailable on that provider, and on Gemini the string
 * syntax wins by default. README §"Exposing search to an agent" tells the
 * reader to inline the schema and does not mention that a major provider will
 * reject it.
 *
 * That is recorded as `provider-incompatible`, not as a failure of the arm, and
 * it is reported as its own row.
 */

import { flattenTool } from "./deref.mjs";

const OPENAI = "https://api.openai.com/v1/chat/completions";
const GROQ = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export const PROVIDERS = {
  "gpt-5.5": { family: "openai", model: "gpt-5.5", url: OPENAI, keyVar: "OPENAI_API_KEY", label: "GPT-5.5 (OpenAI)" },
  "gpt-5.4-mini": { family: "openai", model: "gpt-5.4-mini", url: OPENAI, keyVar: "OPENAI_API_KEY", label: "GPT-5.4-mini (OpenAI)" },
  "gpt-oss-120b": { family: "openai", model: "openai/gpt-oss-120b", url: GROQ, keyVar: "GROQ_API_KEY", label: "gpt-oss-120b (Groq, open weight)" },
  "gemini-3.8-flash": { family: "gemini", model: "gemini-3.8-flash", url: GEMINI("gemini-3.8-flash"), keyVar: "GEMINI_API_KEY", label: "Gemini 3.8 Flash" },
};

/**
 * The same system prompt everywhere. The last sentence exists so that declining
 * is a permitted move — two of the questions cannot be answered by the tool,
 * and without it those would be a trick rather than a probe.
 */
export const SYSTEM = [
  "You are an assistant with access to a pet-store search tool.",
  "Answer the user's question by calling the tool with the arguments that express it.",
  "If the question cannot be expressed with the tool as described, say so plainly instead of approximating it.",
].join(" ");

// ---------------------------------------------------------------------------
// Gemini's schema subset
// ---------------------------------------------------------------------------

/** Keywords Gemini's function-declaration parser rejects outright. */
const GEMINI_STRIPS = ["$schema", "$id", "$comment", "title", "default", "additionalProperties", "examples"];

function hasRef(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasRef);
  if ("$ref" in node || "$defs" in node) return true;
  return Object.values(node).some(hasRef);
}

function sanitiseForGemini(schema) {
  const clone = structuredClone(schema);
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const key of GEMINI_STRIPS) delete node[key];
    Object.values(node).forEach(walk);
  };
  walk(clone);
  return clone;
}

/**
 * Can this provider carry this arm's tool definition at all?
 * Returns null when it can, or the reason it cannot.
 */
/**
 * Keywords Gemini's function-declaration schema has no field for. Each one is
 * load-bearing in the filter grammar, so dropping them to force the request
 * through would ship a different language than the one under test.
 */
const GEMINI_UNSUPPORTED = ["$ref", "$defs", "dependentRequired", "dependentSchemas", "propertyNames", "patternProperties", "not", "if", "then"];

function usesAny(node, keywords) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const member of node) { const hit = usesAny(member, keywords); if (hit) return hit; }
    return null;
  }
  for (const key of Object.keys(node)) if (keywords.includes(key)) return key;
  for (const value of Object.values(node)) { const hit = usesAny(value, keywords); if (hit) return hit; }
  return null;
}

/**
 * Can this provider carry this arm's tool definition at all?
 *
 * For Gemini the answer for both schema arms is no, and it took two rounds to
 * establish. First `$ref`, which cannot be flattened away because the grammar
 * is recursive. Then, once flattened anyway, `dependentRequired` — the keyword
 * that makes `$flags` require `$regex` — and `dependentSchemas`, the one that
 * stops `$unknownAs` standing alone. Both are semantics, not decoration; a
 * request that omits them describes a different language.
 */
export function incompatibility(providerKey, arm) {
  const provider = PROVIDERS[providerKey];
  if (provider.family !== "gemini") return null;
  if (arm.rawRefs && hasRef(arm.tool.input_schema)) {
    return "Gemini function declarations accept no $ref, and the grammar is recursive, so the schema cannot be shipped as the README describes";
  }
  const offender = usesAny(flattenTool(arm.tool, { dialect: "gemini" }).input_schema, GEMINI_UNSUPPORTED);
  if (offender) {
    return `Gemini function declarations have no "${offender}" field; the keyword carries semantics the grammar needs, so omitting it would describe a different language`;
  }
  return null;
}

/**
 * The tool as this provider will actually receive it.
 *
 * Every arm but `jql-raw` is flattened first, because a `$ref` reaches no model
 * intact: Gemini 400s on it and OpenAI silently drops `$defs`. `jql-raw` is
 * deliberately left alone so the gap between "what the README says to ship" and
 * "what a model can actually read" is a measured row rather than a claim.
 */
export function toolFor(providerKey, arm) {
  if (arm.rawRefs) return arm.tool;
  const dialect = PROVIDERS[providerKey].family === "gemini" ? "gemini" : "openai";
  return flattenTool(arm.tool, { dialect });
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

async function postJson(url, headers, body, { attempts = 5 } = {}) {
  let wait = 2000;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true, json: await response.json() };
    const text = await response.text();
    // 429 and 5xx are worth waiting out; a 400 is our bug and never will be.
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= attempts) {
      return { ok: false, status: response.status, error: text.slice(0, 400) };
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, 30_000);
  }
}

function openAiTool(providerKey, arm) {
  const tool = toolFor(providerKey, arm);
  return [{
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }];
}

async function callOpenAi(providerKey, provider, arm, question, priorTurns) {
  const result = await postJson(provider.url, { authorization: `Bearer ${process.env[provider.keyVar]}` }, {
    model: provider.model,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: question }, ...priorTurns],
    tools: openAiTool(providerKey, arm),
  });
  if (!result.ok) return { error: `${result.status}: ${result.error}` };

  const choice = result.json.choices?.[0];
  const call = choice?.message?.tool_calls?.[0];
  let input;
  if (call) {
    // Never string-match a tool call's arguments; parse them.
    try { input = JSON.parse(call.function.arguments); } catch { input = undefined; }
  }
  return {
    input,
    toolCallId: call?.id,
    text: choice?.message?.content ?? "",
    stopReason: choice?.finish_reason,
    usage: { input_tokens: result.json.usage?.prompt_tokens, output_tokens: result.json.usage?.completion_tokens },
    assistantMessage: choice?.message,
  };
}

async function callGemini(providerKey, provider, arm, question, priorTurns) {
  const result = await postJson(`${provider.url}?key=${process.env[provider.keyVar]}`, {}, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: question }] }, ...priorTurns],
    tools: [{
      functionDeclarations: [{
        name: arm.tool.name,
        description: arm.tool.description,
        parameters: toolFor(providerKey, arm).input_schema,
      }],
    }],
  });
  if (!result.ok) return { error: `${result.status}: ${result.error}` };

  const candidate = result.json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const call = parts.find((p) => p.functionCall)?.functionCall;
  return {
    input: call?.args,
    text: parts.filter((p) => p.text).map((p) => p.text).join("\n"),
    stopReason: candidate?.finishReason,
    usage: {
      input_tokens: result.json.usageMetadata?.promptTokenCount,
      output_tokens: result.json.usageMetadata?.candidatesTokenCount,
    },
    assistantMessage: candidate?.content,
  };
}

/** One question, one arm, one provider. */
export async function ask(providerKey, arm, question, priorTurns = []) {
  const provider = PROVIDERS[providerKey];
  const blocked = incompatibility(providerKey, arm);
  if (blocked) return { incompatible: blocked };
  return provider.family === "gemini"
    ? callGemini(providerKey, provider, arm, question, priorTurns)
    : callOpenAi(providerKey, provider, arm, question, priorTurns);
}

/** Run tasks with a bounded number in flight — providers rate-limit on tokens/minute. */
export async function pooled(tasks, limit, onDone) {
  const results = new Array(tasks.length);
  let next = 0;
  let finished = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= tasks.length) return;
        results[index] = await tasks[index]();
        finished += 1;
        onDone?.(finished, tasks.length);
      }
    }),
  );
  return results;
}
