Search the pet collection. `where` is a query object. Returns the matching records.

**Shape.** Each key of `where` is a field name; each value is a condition `{"op": ..., "value": ...}`. Sibling keys are ANDed. Group with `{"all": [...]}`, `{"any": [...]}`, `{"none": [...]}`, or negate with `{"not": {...}}`.

**Operators.** `is`, `isnot`, `gt`, `gte`, `lt`, `lte`, `between` (a two-element list, inclusive), `notbetween`, `anyof` (a list — true if the field equals any member), `noneof`, `prefix`, `suffix`, `substring`, `like` (`%` any run, `_` one character), `ilike` (case-insensitive `like`), `matches` (a regular expression; add `"flags": "i"` for case-insensitivity), `type` (`string`, `number`, `integer`, `boolean`, `object`, `array`, `null`), `exists` (`true` or `false`), `isblank`.

**Negating one field.** Add `"negate": true` to a condition to negate just that field's test.

**Blanks and missing values.** A field can be present with a value, present but blank, or absent. `exists` distinguishes present from absent; `isblank` distinguishes blank from valued. Comparisons against a blank or absent field are *unknown*, and unknown never matches — so `isnot` and `negate` both leave those records out. To include them, add `"orUnknown": true` to the same condition, which resolves that condition's unknowns to true.

**Lists.** `tags` and `vaccinations` hold lists. Reach their elements with `{"op": "some", "value": ...}` (at least one element satisfies it) or `{"op": "every", "value": ...}` (all do; true for an empty list). The value is a condition for a list of scalars, or a nested `where` object for a list of records. `{"op": "count", "value": ...}` tests list length; `{"op": "first", "value": ...}` tests the first element only. Two separate `some` conditions may be satisfied by two different elements — put both tests inside one `some` to require the same element.

**Comparing two fields.** Use `{"op": "gt", "value": {"op": "fieldref", "value": "costCents"}}`.

**Fields.** `id`, `name`, `species`, `status`, `born`, `weightKg`, `neutered`, `microchip`, `tags`, `notes`, `priceCents`, `costCents`, `rate`, `sizeRaw`, `shelter.name`, `shelter.city`, `shelter.capacity`, `vaccinations`; inside a `vaccinations` condition, `vaccine`, `administeredAt`, `boosterDue`.

`status` is one of `available`, `pending`, `sold`. `species` is one of `cat`, `dog`, `rabbit`, `bird`. `vaccine` is one of `rabies`, `distemper`, `parvo`. `born` and `boosterDue` are dates (`YYYY-MM-DD`); `administeredAt` is a timestamp. `notes` is unstructured and holds a different type on every record.

**Examples.**
`{"status": {"op": "is", "value": "available"}, "species": {"op": "anyof", "value": ["cat", "dog"]}}`
`{"weightKg": {"op": "between", "value": [1, 5]}}`
`{"any": [{"shelter.city": {"op": "is", "value": "Athens"}}, {"tags": {"op": "some", "value": {"op": "is", "value": "indoor"}}}]}`
`{"vaccinations": {"op": "some", "value": {"vaccine": {"op": "is", "value": "rabies"}}}}`
