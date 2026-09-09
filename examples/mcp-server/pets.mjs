/**
 * pets.mjs — the collection the example server searches, the table it lives
 * in, and the binding that says where each queryable path is stored.
 *
 * The records conform to `../pet.schema.json`, which is the same file
 * `../pet.filter.json` — the tool's inputSchema — was generated from. That is
 * the whole chain: one resource schema produces both the data contract and the
 * query contract, so the tool definition cannot describe a field the server
 * does not have.
 *
 * The collection is deliberately awkward in the places SPEC.md §4.2 keeps
 * apart, because those are the cases an agent gets wrong:
 *
 *   Rex     microchip: null      present, but no value
 *   Juno    microchip absent     the key is not there at all
 *   Pip     tags: []             an empty array, which $every matches
 */

export const RECORDS = [
  {
    id: "3f2a6c18-7b41-4d5e-9a03-5c1f2d8e4b60",
    name: "Ada", species: "cat", status: "available",
    born: "2020-03-01", weightKg: 4.2, neutered: true,
    microchip: "CHIP-0001", tags: ["calm", "indoor", "senior"],
    shelter: { name: "North Shelter", city: "Athens", capacity: 40 },
    vaccinations: [
      { vaccine: "rabies", administeredAt: "2024-01-10T09:00:00Z", boosterDue: "2025-01-10" },
    ],
    internalNotes: "Bonded with Pip; rehome together if possible.",
  },
  {
    id: "8c9d0e11-2f34-4a56-b789-0c1d2e3f4a5b",
    name: "Rex", species: "dog", status: "pending",
    born: "2021-07-14", weightKg: 28.5, neutered: false,
    microchip: null, tags: ["rescue", "large"],
    shelter: { name: "North Shelter", city: "Athens", capacity: 40 },
    vaccinations: [
      { vaccine: "rabies", administeredAt: "2023-11-02T14:30:00Z", boosterDue: "2024-11-02" },
      { vaccine: "parvo", administeredAt: "2023-11-02T14:35:00Z" },
    ],
    internalNotes: "Chip reader failed twice; re-scan before adoption.",
  },
  {
    id: "b1c2d3e4-f5a6-4b78-9c01-d2e3f4a5b6c7",
    name: "Juno", species: "dog", status: "available",
    born: "2019-01-22", weightKg: 12.0, neutered: true,
    tags: ["senior", "quiet"],
    shelter: { name: "Harbour Shelter", city: "Piraeus", capacity: 22 },
    vaccinations: [
      { vaccine: "distemper", administeredAt: "2024-05-18T08:15:00Z", boosterDue: "2025-05-18" },
    ],
    internalNotes: "Never chipped.",
  },
  {
    id: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
    name: "Pip", species: "rabbit", status: "available",
    born: "2023-04-09", weightKg: 1.8, neutered: true,
    microchip: "CHIP-0042", tags: [],
    shelter: { name: "Harbour Shelter", city: "Piraeus", capacity: 22 },
    vaccinations: [],
    internalNotes: "Bonded with Ada.",
  },
  {
    id: "0a1b2c3d-4e5f-4061-8273-84950a6b7c8d",
    name: "Mira", species: "cat", status: "sold",
    born: "2022-09-30", weightKg: 3.6, neutered: true,
    microchip: "CHIP-0107", tags: ["indoor", "kitten"],
    shelter: { name: "West Shelter", city: "Patras", capacity: 60 },
    vaccinations: [
      { vaccine: "rabies", administeredAt: "2024-02-01T11:00:00Z", boosterDue: "2025-02-01" },
      { vaccine: "distemper", administeredAt: "2024-02-01T11:05:00Z", boosterDue: "2025-02-01" },
    ],
    internalNotes: "Adopted 2024-06; record retained.",
  },
  {
    id: "c7d8e9f0-a1b2-4c3d-8e4f-5a6b7c8d9e0f",
    name: "Otto", species: "bird", status: "available",
    born: "2024-02-17", weightKg: 0.4, neutered: false,
    microchip: null, tags: ["loud", "handraised"],
    shelter: { name: "West Shelter", city: "Patras", capacity: 60 },
    vaccinations: [],
    internalNotes: "Very loud before 8am.",
  },
  {
    id: "9f8e7d6c-5b4a-4392-8172-6f5e4d3c2b1a",
    name: "Bruno", species: "dog", status: "sold",
    born: "2018-12-05", weightKg: 34.1, neutered: true,
    microchip: "CHIP-0203", tags: ["senior", "large", "rescue"],
    shelter: { name: "North Shelter", city: "Athens", capacity: 40 },
    vaccinations: [
      { vaccine: "rabies", administeredAt: "2022-03-14T10:00:00Z", boosterDue: "2023-03-14" },
    ],
    internalNotes: "Returned once; second adoption held.",
  },
  {
    id: "2b3c4d5e-6f70-4819-a2b3-c4d5e6f70819",
    name: "Nadia", species: "cat", status: "pending",
    born: "2021-11-11", weightKg: 4.9, neutered: false,
    microchip: "CHIP-0311", tags: ["indoor"],
    shelter: { name: "Harbour Shelter", city: "Piraeus", capacity: 22 },
    vaccinations: [
      { vaccine: "parvo", administeredAt: "2024-08-21T16:45:00Z", boosterDue: "2025-08-21" },
    ],
    internalNotes: "Application under review since August.",
  },
];

export const DDL = `
CREATE TABLE pets (
  id        TEXT PRIMARY KEY,
  status    TEXT NOT NULL,
  species   TEXT,
  born      TEXT,
  weight_kg REAL,
  doc       TEXT NOT NULL
);`;

export const INSERT =
  "INSERT INTO pets (id, status, species, born, weight_kg, doc) VALUES (?, ?, ?, ?, ?, ?)";

export function rows() {
  return RECORDS.map((r) => [
    r.id, r.status, r.species ?? null, r.born ?? null, r.weightKg ?? null, JSON.stringify(r),
  ]);
}

/**
 * Where each queryable path lives. The paths here are exactly the paths
 * `pet.filter.json` names, which is not a coincidence — both sides are
 * derived from `pet.schema.json`. `internalNotes` is in neither: SPEC.md §3.5
 * requires an unexposed path to be rejected, not quietly resolved, and the
 * generator dropped it because the resource schema marks it `"x-jql": false`.
 */
export const BINDING = {
  dialect: "sqlite",
  table: "pets",
  select: "doc",
  orderBy: "json_extract(doc, '$.name')",
  profiles: ["core", "strings", "ranges", "collections"],
  limits: { maxDepth: 10, maxClauses: 100, maxSetLength: 1000 },
  fields: {
    id: { column: "id", type: "string", format: "uuid" },
    status: { column: "status", type: "string", values: ["available", "pending", "sold"] },
    species: { column: "species", type: "string", values: ["cat", "dog", "rabbit", "bird"] },
    born: { column: "born", type: "string", format: "date" },
    weightKg: { column: "weight_kg", type: "number" },
    name: { doc: "doc", type: "string" },
    neutered: { doc: "doc", type: "boolean" },
    microchip: { doc: "doc" },
    tags: { doc: "doc", type: "array" },
    shelter: { doc: "doc", subtree: true },
    vaccinations: { doc: "doc", subtree: true },
  },
};
