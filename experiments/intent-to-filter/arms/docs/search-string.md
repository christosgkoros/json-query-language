Search the pet collection. `q` is a query string. Returns the matching records.

**Syntax.** `field:value` matches a field. Combine clauses with `AND`, `OR`, `NOT` and parentheses; adjacent clauses are ANDed. Prefix a clause with `-` to negate it. Quote a value with `"` when it contains spaces, or to stop `*` being read as a wildcard. Quote a *field* name with `"` when the name itself contains a dot.

**Comparison.** `field:>x`, `field:>=x`, `field:<x`, `field:<=x`. Inclusive range: `field:[lo TO hi]`. Any-of: `field:(a OR b OR c)`.

**Text.** `field:pre*` prefix, `field:*suf` suffix, `field:*sub*` substring, `field:a*b` a general pattern. Matching is case-sensitive. For case-insensitive or more complex matching use a regular expression: `field:/^[a-c]/` , with a trailing flag for case-insensitivity — `field:/^[a-c]/i`.

**Presence.** `_exists_:field` matches records where the field is present. `_missing_:field` matches records where it is absent. `field:null` matches records where the field is present but blank. These are three different states and a record is in exactly one of them.

**Negation and blanks.** A negated clause matches only records where the field is present and does not match. It does **not** pull in records where the field is blank or absent — those are unknown, not false. To include them, spell it out: `-microchip:X OR microchip:null OR -_exists_:microchip`.

**Multi-valued fields.** `tags` and `vaccinations` hold lists. A clause against one of them matches if *any* element matches, so `tags:indoor` finds pets carrying that label. `count(field):>=3` matches on list length; `first(field):value` matches the first element only. Two separate clauses against the same list may be satisfied by two different elements.

**Fields.** `id`, `name`, `species`, `status`, `born`, `weightKg`, `neutered`, `microchip`, `tags`, `notes`, `priceCents`, `costCents`, `$rate`, `"size.raw"`, `shelter.name`, `shelter.city`, `shelter.capacity`, `vaccinations.vaccine`, `vaccinations.administeredAt`, `vaccinations.boosterDue`.

`status` is one of `available`, `pending`, `sold`. `species` is one of `cat`, `dog`, `rabbit`, `bird`. `vaccinations.vaccine` is one of `rabies`, `distemper`, `parvo`. `born` and `vaccinations.boosterDue` are dates (`YYYY-MM-DD`); `vaccinations.administeredAt` is a timestamp. `notes` is unstructured and holds a different type on every record.

**Examples.**
`status:available AND species:(cat OR dog)`
`weightKg:[1 TO 5] AND shelter.city:Athens`
`born:>=2020-01-01 AND -tags:indoor`
`count(tags):>=3 OR vaccinations.vaccine:rabies`
