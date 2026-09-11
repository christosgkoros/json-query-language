/**
 * differential.mjs — a second, larger collection, used only to tell filters apart.
 *
 * THE PROBLEM IT SOLVES. Across the 62 corpus cases with a row-set answer there
 * are only 44 distinct row sets, over ten records: a01, a17 and a20 all return
 * the same six ids. So "returned the right rows" is a weak claim that a model
 * wrote the right filter — a wrong filter can land on the right rows by luck,
 * and with ten records the luck is not even long odds.
 *
 * THE FIX. Grade a candidate correct only if it (1) returns the gold row set on
 * the ten authoritative records, and (2) returns the same rows as the *gold
 * filter* on two hundred generated ones. The ten records keep their authority:
 * they are hand-derived from SPEC.md and they decide whether the gold filter is
 * right. These two hundred decide only whether the candidate agrees with it, so
 * nothing here needs to be hand-checked and nothing here can make a gold answer
 * wrong.
 *
 * It works: the 62 gold filters produce 44 distinct row sets over the ten
 * records and 58 over these two hundred, leaving no pair indistinguishable.
 *
 * The collection is generated from a fixed seed and deliberately dense where
 * filters are easy to confuse: present-nulls beside absent keys, empty arrays,
 * values sitting exactly on the range boundaries the corpus uses, and a `notes`
 * path that holds a different JSON type on every few records. It is not
 * schema-conformant everywhere — tags carry the occasional null element — for
 * the same reason: its job is to separate filters, not to model the resource.
 */

import { DatabaseSync } from "node:sqlite";
import { compile, QueryProblem } from "../filter-to-sql/compile.mjs";
import { HYBRID_BINDING } from "../filter-to-sql/dataset.mjs";

/** mulberry32 — small, seeded, and stable across Node versions. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "Ada", "bruno", "Cleo", "Dash", "Echo", "Fig 50% off", "Gus", "Hera", "Iris", "Juno",
  "Bo", "boris", "Cass", "delta", "Ochre", "Oso", "Pips", "Quill", "Rufus", "Sol",
  "Ames", "Cosmo", "50% Off Milo", "Nox", "Opal", "Bess", "Coco", "Doss", "Enzo", "Flo",
];
const TAG_POOL = ["indoor", "outdoor", "calm", "loud", "quiet", "small", "trained", "senior"];
const CITIES = ["Athens", "Patras", "Volos", "Larissa"];
const VACCINES = ["rabies", "distemper", "parvo"];

/** One value per record for the deliberately heterogeneous `notes` path. */
const NOTES = ["quiet", "loud", 3, 3.0, 3.5, 2, 0, true, false, null, ["a", "b"], [], { k: 1 }, "a", "zed"];

export const SEED = 20260909;

function generate(count = 200) {
  const random = rng(SEED);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const chance = (p) => random() < p;
  const records = [];

  for (let i = 0; i < count; i += 1) {
    const record = { id: `d${String(i).padStart(3, "0")}`, name: pick(NAMES) };

    // A rogue value outside the documented domain, on purpose: without one,
    // `status is available`, `status is neither sold nor pending` and `status
    // starts with a` are indistinguishable on any conformant data, and three
    // corpus cases collapse into one. Real collections have values like this;
    // this set is not shown to a model, only used to tell filters apart.
    if (chance(0.94)) record.status = pick(["available", "pending", "sold", "available", "pending", "sold", "archived", "withdrawn"]);
    if (chance(0.88)) record.species = pick(["cat", "dog", "rabbit", "bird"]);

    // Dates clustered on the 2020-01-01 boundary the corpus keeps testing.
    if (chance(0.9)) {
      const year = pick([2016, 2017, 2018, 2019, 2019, 2020, 2020, 2021, 2022, 2023, 2024]);
      const month = 1 + Math.floor(random() * 12);
      const day = 1 + Math.floor(random() * 28);
      record.born = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }

    // Weights that land exactly on 1 and 5, the inclusive bounds of a04/c11.
    if (chance(0.95)) {
      record.weightKg = pick([0.4, 0.9, 1, 1, 1.2, 2, 3.1, 4.2, 5, 5, 5.5, 12, 18, 22.5, 31, 40]);
    }
    if (chance(0.9)) record.neutered = chance(0.5);

    // The three states §4.2 keeps apart, in roughly equal thirds.
    const chipState = random();
    if (chipState < 0.5) record.microchip = pick(["CHIP-001", "CHIP-002", "CHIP-004", "CHIP-010"]);
    else if (chipState < 0.8) record.microchip = null;
    // else: absent

    if (chance(0.92)) {
      const size = Math.floor(random() * 4); // 0..3, so empty lists are common
      record.tags = Array.from({ length: size }, () => (chance(0.05) ? null : pick(TAG_POOL)));
    }

    if (chance(0.85)) record.notes = NOTES[Math.floor(random() * NOTES.length)];

    record.priceCents = pick([2500, 3000, 5000, 6000, 7000, 9000, 12000, 15000, 20000]);
    record.costCents = pick([1000, 2000, 3500, 6500, 7000, 8000, 9500, 11000, 15000]);

    if (chance(0.25)) record.$rate = pick([3, 5, 5, 7, 9]);
    if (chance(0.3)) record["size.raw"] = pick(["XS", "S", "M", "L"]);

    if (chance(0.96)) {
      record.shelter = { name: `${pick(["North", "South", "East", "West"])} Shelter` };
      if (chance(0.9)) record.shelter.city = pick(CITIES);
      if (chance(0.85)) record.shelter.capacity = pick([0, 5, 12, 12, 22, 40, 60]);
    }

    if (chance(0.9)) {
      const shots = Math.floor(random() * 3); // 0..2, so empty histories are common
      record.vaccinations = Array.from({ length: shots }, () => {
        const shot = {
          vaccine: pick(VACCINES),
          administeredAt: `${pick([2021, 2022, 2023, 2024, 2025])}-0${1 + Math.floor(random() * 9)}-15T10:00:00Z`,
        };
        if (chance(0.6)) {
          shot.boosterDue = `${pick([2022, 2023, 2024, 2024, 2025, 2026])}-0${1 + Math.floor(random() * 9)}-15`;
        }
        return shot;
      });
    }

    records.push(record);
  }
  return records;
}

export const RECORDS = generate();

const DDL = `
CREATE TABLE pets (
  id           TEXT PRIMARY KEY,
  status       TEXT,
  species      TEXT,
  born         TEXT,
  weight_kg    REAL,
  price_cents  INTEGER,
  cost_cents   INTEGER,
  doc          TEXT NOT NULL
);`;

/**
 * The same binding the graded run uses, pointed at this table. It has to be the
 * same: a promoted column and a JSON path answer $exists differently (§4.2), so
 * a differential test under a different binding would disagree with the real
 * one for reasons that have nothing to do with the candidate filter.
 */
export const BINDING = { ...HYBRID_BINDING, table: "pets" };

export function openDifferential() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA case_sensitive_like = ON");
  db.function("jql_regex", { deterministic: true }, (value, pattern, flags) => {
    if (value === null || value === undefined) return null;
    try {
      return new RegExp(pattern, flags || undefined).test(String(value)) ? 1 : 0;
    } catch {
      return null;
    }
  });
  db.exec(DDL);
  const insert = db.prepare(
    "INSERT INTO pets (id, status, species, born, weight_kg, price_cents, cost_cents, doc) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const r of RECORDS) {
    insert.run(
      r.id, r.status ?? null, r.species ?? null, r.born ?? null,
      r.weightKg ?? null, r.priceCents ?? null, r.costCents ?? null, JSON.stringify(r),
    );
  }
  return db;
}

function idsFor(db, filter) {
  try {
    const compiled = compile(filter, BINDING);
    return { ids: db.prepare(compiled.sql).all(...compiled.params).map((r) => r.id) };
  } catch (error) {
    if (error instanceof QueryProblem) return { problem: error.type.split("/").pop() };
    throw error;
  }
}

/**
 * Do two filters mean the same thing? Answered by running both, not by
 * comparing their shapes — a great many spellings of the same predicate are
 * correct, and grading on structure would fail them all.
 */
export function equivalent(db, goldFilter, candidateFilter) {
  const gold = idsFor(db, goldFilter);
  const candidate = idsFor(db, candidateFilter);
  if (gold.problem || candidate.problem) return gold.problem === candidate.problem;
  if (gold.ids.length !== candidate.ids.length) return false;
  const set = new Set(gold.ids);
  return candidate.ids.every((id) => set.has(id));
}

/** How many of the 200 a filter matches — reported so a vacuous filter is visible. */
export function selectivity(db, filter) {
  const result = idsFor(db, filter);
  return result.problem ? null : result.ids.length;
}
