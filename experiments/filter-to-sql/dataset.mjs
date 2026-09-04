/**
 * dataset.mjs — the fixture collection the experiment compiles against, plus
 * the two field bindings it compiles under.
 *
 * One source of truth: `RECORDS` is the JSON the API would return. The table
 * promotes a handful of paths to real columns and keeps the whole record in a
 * `doc` JSON column, which is what a real service that grew a search endpoint
 * on top of an existing table looks like. That shape is deliberate — it lets
 * the same filter compile two ways and the results be compared:
 *
 *   HYBRID_BINDING    promoted columns where they exist, `doc` for the rest
 *   DOCUMENT_BINDING  every path resolved out of `doc`
 *
 * Records are engineered around the states SPEC.md §4.2 keeps apart: a present
 * null (`p02.microchip`), an absent key (`p03.microchip`), an empty array
 * (`p03.tags`), a heterogeneous path (`notes`, one JSON type per record), a
 * key whose literal name contains a dot (`size.raw`) and one whose literal
 * name starts with `$` (`$rate`).
 */

export const RECORDS = [
  {
    id: "p01", name: "Ada", species: "cat", status: "available",
    born: "2020-03-01", weightKg: 4.2, neutered: true,
    microchip: "CHIP-001", tags: ["calm", "indoor"], notes: "quiet",
    shelter: { name: "North Shelter", city: "Athens", capacity: 40 },
    vaccinations: [
      { vaccine: "rabies", administeredAt: "2024-01-10T09:00:00Z", boosterDue: "2025-01-10" },
    ],
    priceCents: 12000, costCents: 8000,
  },
  {
    id: "p02", name: "bruno", species: "dog", status: "available",
    born: "2018-07-15", weightKg: 22.5, neutered: false,
    microchip: null, tags: ["loud", "outdoor", "trained"], notes: 3,
    shelter: { name: "South Shelter", city: "Patras", capacity: 12 },
    vaccinations: [
      { vaccine: "distemper", administeredAt: "2023-05-02T12:00:00Z" },
      { vaccine: "rabies", administeredAt: "2024-06-01T08:30:00Z", boosterDue: "2025-06-01" },
    ],
    priceCents: 9000, costCents: 9500,
  },
  {
    // microchip is absent, not null. tags and vaccinations are empty arrays.
    id: "p03", name: "Cleo", species: "cat", status: "pending",
    born: "2022-11-05", weightKg: 3.1, neutered: true,
    tags: [], notes: null,
    shelter: { name: "North Shelter", city: "Athens", capacity: 40 },
    vaccinations: [],
    priceCents: 15000, costCents: 15000,
  },
  {
    // rabies and an early booster live on *different* elements: the record
    // that separates $elemMatch from a wildcard path (SPEC §5.9).
    id: "p04", name: "Dash", species: "dog", status: "sold",
    born: "2019-01-20", weightKg: 31.0, neutered: true,
    microchip: "CHIP-004", tags: ["trained"],
    shelter: { name: "East Shelter", city: "Volos" },
    vaccinations: [
      { vaccine: "parvo", administeredAt: "2022-02-02T10:00:00Z", boosterDue: "2023-02-02" },
      { vaccine: "rabies", administeredAt: "2024-03-03T10:00:00Z" },
    ],
    priceCents: 20000, costCents: 11000,
  },
  {
    // species is absent.
    id: "p05", name: "Echo", status: "available",
    born: "2021-06-30", weightKg: 1.2, neutered: false,
    microchip: "CHIP-005", tags: ["small", "indoor", "calm", "quiet"],
    notes: ["a", "b"],
    shelter: { name: "West Shelter", city: "Athens", capacity: 5 },
    vaccinations: [
      { vaccine: "rabies", administeredAt: "2025-02-01T00:00:00Z", boosterDue: "2026-02-01" },
    ],
    priceCents: 5000, costCents: 2000,
  },
  {
    id: "p06", name: "Fig 50% off", species: "rabbit", status: "available",
    born: "2023-04-12", weightKg: 2.0, neutered: false,
    microchip: null, tags: ["indoor"], notes: { k: 1 },
    shelter: { name: "North Shelter", city: "Athens", capacity: 40 },
    vaccinations: [],
    priceCents: 3000, costCents: 3500,
    $rate: 7, "size.raw": "XS",
  },
  {
    id: "p07", name: "Gus", species: "bird", status: "pending",
    born: "2024-02-29", weightKg: 0.4, neutered: false,
    microchip: "CHIP-007", tags: ["loud"], notes: true,
    shelter: { name: "South Shelter", city: "Patras", capacity: 12 },
    vaccinations: [
      { vaccine: "distemper", administeredAt: "2025-03-03T15:00:00Z", boosterDue: "2026-03-03" },
    ],
    priceCents: 2500, costCents: 1000,
  },
  {
    id: "p08", name: "Hera", species: "dog", status: "sold",
    born: "2017-09-09", weightKg: 18.0, neutered: true,
    microchip: "CHIP-008", tags: ["trained", "outdoor"], notes: 3.0,
    shelter: { name: "East Shelter", city: "Volos", capacity: 0 },
    vaccinations: [
      { vaccine: "rabies", administeredAt: "2021-01-01T00:00:00Z", boosterDue: "2022-01-01" },
      { vaccine: "parvo", administeredAt: "2021-01-01T00:00:00Z" },
    ],
    priceCents: 7000, costCents: 7000,
  },
  {
    id: "p09", name: "Iris", species: "cat", status: "available",
    born: "2016-12-25", weightKg: 5.5, neutered: true,
    microchip: "CHIP-009", tags: ["calm"], notes: 3.5,
    shelter: { name: "North Shelter", city: "Athens", capacity: 40 },
    vaccinations: [
      { vaccine: "rabies", administeredAt: "2019-01-01T00:00:00Z", boosterDue: "2020-01-01" },
    ],
    priceCents: 6000, costCents: 6500,
  },
  {
    // born is absent.
    id: "p10", name: "Juno", species: "rabbit", status: "available",
    weightKg: 1.9, neutered: true,
    microchip: "CHIP-010", tags: ["indoor", "small"],
    shelter: { name: "West Shelter", city: "Athens", capacity: 5 },
    vaccinations: [],
    priceCents: 4000, costCents: 1500,
  },
];

export const DDL = `
CREATE TABLE pets (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  species      TEXT,
  born         TEXT,
  weight_kg    REAL,
  price_cents  INTEGER,
  cost_cents   INTEGER,
  doc          TEXT NOT NULL
);`;

export const INSERT =
  "INSERT INTO pets (id, status, species, born, weight_kg, price_cents, cost_cents, doc) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

/** One row per record, in the column order of INSERT. */
export function rows() {
  return RECORDS.map((r) => [
    r.id,
    r.status,
    r.species ?? null,
    r.born ?? null,
    r.weightKg ?? null,
    r.priceCents ?? null,
    r.costCents ?? null,
    JSON.stringify(r),
  ]);
}

const PROFILES = ["core", "strings", "regex", "ranges", "types", "collections", "refs"];
const LIMITS = { maxDepth: 10, maxClauses: 100, maxSetLength: 1000 };

/**
 * Promoted columns for the paths a UI filters on constantly; `doc` for the
 * rest. `internalNotes` appears in neither binding: SPEC §3.5 requires an
 * unexposed path to be rejected, not silently resolved.
 */
export const HYBRID_BINDING = {
  dialect: "sqlite",
  table: "pets",
  select: "id",
  orderBy: "id",
  profiles: PROFILES,
  limits: LIMITS,
  fields: {
    id: { column: "id", type: "string", format: "uuid" },
    status: { column: "status", type: "string", values: ["available", "pending", "sold"] },
    species: { column: "species", type: "string", values: ["cat", "dog", "rabbit", "bird"] },
    born: { column: "born", type: "string", format: "date" },
    weightKg: { column: "weight_kg", type: "number" },
    priceCents: { column: "price_cents", type: "integer" },
    costCents: { column: "cost_cents", type: "integer" },
    name: { doc: "doc", type: "string" },
    microchip: { doc: "doc" },
    neutered: { doc: "doc", type: "boolean" },
    notes: { doc: "doc" },
    tags: { doc: "doc", type: "array" },
    shelter: { doc: "doc", subtree: true },
    vaccinations: { doc: "doc", subtree: true },
    $$rate: { doc: "doc" },
    "size\\.raw": { doc: "doc" },
  },
};

/** The same field set, every path resolved out of the JSON column. */
export const DOCUMENT_BINDING = {
  ...HYBRID_BINDING,
  fields: Object.fromEntries(
    Object.entries(HYBRID_BINDING.fields).map(([path, spec]) => [
      path,
      spec.column ? { doc: "doc", type: spec.type, format: spec.format, values: spec.values } : spec,
    ]),
  ),
};
