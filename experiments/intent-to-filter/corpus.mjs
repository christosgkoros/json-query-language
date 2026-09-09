/**
 * corpus.mjs — the graded set, assembled in one place.
 *
 * Sixty questions inherited from ../filter-to-sql/cases.mjs, whose answer key
 * was hand-derived from SPEC.md months before this experiment existed, plus
 * three written here to tempt the three mistakes README catalogues. The two
 * groups are tagged `inherited` and `authored` and never averaged together:
 * the inherited ones cannot have been chosen to flatter the language, and the
 * authored ones plainly were chosen with a hypothesis in mind.
 */

import { CASES } from "../filter-to-sql/cases.mjs";
import { QUESTIONS, MISTAKE_PROBES, EXCLUDED } from "./questions.mjs";

/** Which corpus group a case's expected answer came from. */
const inherited = CASES.filter((c) => QUESTIONS[c.id]).map((c) => ({
  id: c.id,
  origin: "inherited",
  group: c.group,
  probe: QUESTIONS[c.id].probe,
  ask: QUESTIONS[c.id].ask,
  expect: c.expect,
  goldFilter: c.filter,
  title: c.title,
}));

const authored = Object.entries(MISTAKE_PROBES).map(([id, p]) => ({
  id,
  origin: "authored",
  group: "M. Mistake probes",
  probe: p.probe,
  ask: p.ask,
  expect: p.expect,
  goldFilter: p.gold,
  tempts: p.tempts,
  title: `tempts ${p.tempts}`,
}));

export const CORPUS = [...inherited, ...authored];
export const BY_ID = Object.fromEntries(CORPUS.map((c) => [c.id, c]));
export { EXCLUDED };

/** A. and B. are what a search UI sends; the rest probe the semantic edges. */
export const isOrdinaryTraffic = (c) => c.group.startsWith("A.") || c.group.startsWith("B.");
