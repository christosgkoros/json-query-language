/**
 * index.mjs — the five arms, wired up and budget-checked.
 *
 * On the documentation budget: parity is enforced on the *prose* channel only —
 * the tool description — because that is the channel the competing arms have
 * and the schema arms are claiming not to need. The schema itself is the
 * treatment, not part of the budget, which is why jql-generated ends up with
 * the smallest description and by far the largest tool definition. Reporting
 * both numbers side by side is the honest way to present that, and report.mjs
 * does.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { jqlGenerated, jqlPublished, jqlRaw } from "./jql.mjs";
import { searchString } from "./search-string.mjs";
import { bespokeJson } from "./bespoke-json.mjs";
import { fixedParams } from "./fixed-params.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const doc = (name) => readFileSync(join(here, "docs", `${name}.md`), "utf8").trim();

searchString.tool.description = doc("search-string");
bespokeJson.tool.description = doc("bespoke-json");

export const ARMS = [jqlRaw, jqlGenerated, jqlPublished, searchString, bespokeJson, fixedParams];
export const BY_NAME = Object.fromEntries(ARMS.map((a) => [a.name, a]));

/**
 * The prose budget, and who it binds.
 *
 * It binds the two arms whose language is carried entirely by prose —
 * search-string and bespoke-json — because those are the ones an unfair
 * experiment would starve. It does not bind fixed-params, whose parameters
 * carry their own descriptions and which needs no syntax section, nor the two
 * schema arms, whose whole claim is that they need no prose at all.
 *
 * The figure was set *after* both documents were drafted, at the length the
 * longer of the two needed, and the shorter was left as written rather than
 * padded. Fixing a number first and then cutting to hit it would have meant
 * deciding how good a competitor's documentation is allowed to be, which is
 * the one decision this experiment must not make.
 */
export const PROSE_BUDGET = { target: 700, tolerance: 0.1, binds: ["search-string", "bespoke-json"] };

/** Rough token count, for the dry run and for tests that must not need a key. */
export const approxTokens = (text) => Math.ceil(text.length / 4);

/** The whole tool definition, which is what actually reaches the model. */
export function toolTokens(arm) {
  return approxTokens(JSON.stringify(arm.tool));
}
