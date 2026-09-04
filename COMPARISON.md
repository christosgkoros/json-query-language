# JSON Query Language and GraphQL

The question arrives in two forms. *Why not just use GraphQL?* — asked by someone choosing
between them. And *could this become a JSON-Schema-native alternative to GraphQL?* — asked by
someone who has noticed that the two overlap somewhere. This document answers both, starting from
the observation that makes both answerable: they overlap much less than the question assumes.

---

## 1. GraphQL is four things; this is a fifth

GraphQL bundles:

1. **A type system with mandatory introspection.** SDL, plus a query every server must answer that
   returns its own schema.
2. **Client-specified projection.** The response contains the fields the client asked for and
   nothing else. This is the feature GraphQL is adopted for.
3. **Traversal.** Nested selections are joins, executed by resolvers.
4. **A transport and execution contract.** One endpoint, variables, operations, an `errors` array
   alongside partial `data`, subscriptions.

**Filtering is not on that list.** The GraphQL specification says nothing about `where`. Every
server invents its own input objects — Hasura's `_eq`/`_in`, Prisma's `equals`/`contains`,
Postgraphile, Dgraph — with no shared vocabulary, no shared null semantics, and no portability
between them. A client that knows GraphQL does not thereby know how to filter.

That is the gap this specification occupies. [JSON:API](https://jsonapi.org/format/#fetching-filtering)
has the same hole and says so explicitly: it reserves the `filter` query parameter and declines to
define its contents. MCP tool definitions have it too — an agent is handed an `inputSchema` and
left to infer a query syntax from prose.

So the first answer is that **this is not GraphQL's competitor; it is the piece GraphQL left
out.** A GraphQL server could adopt the grammar as the body of its `where` argument tomorrow and
lose nothing.

---

## 2. Side by side

The same request, filtering pets and taking three fields.

**GraphQL** — projection is the point; the filter vocabulary is the server's invention:

```graphql
query {
  pets(where: { _and: [
    { status: { _eq: "available" } },
    { born:   { _gte: "2020-01-01" } }
  ]}, limit: 50) {
    id
    name
    shelter { city }
  }
}
```

**JSON Query Language** — the filter is standard and schema-validated; projection, ordering and
paging belong to the enclosing body, where each API defines them:

```http
QUERY /pets HTTP/1.1
Content-Type: application/json
```
```json
{
  "filter": {
    "status": "available",
    "born": { "$gte": "2020-01-01" }
  },
  "fields": ["id", "name", "shelter.city"],
  "limit": 50
}
```

The differences that matter are not the syntax. In the GraphQL version the response type is known
statically from the selection set, and the filter is unportable. In the second the filter is
portable and machine-checkable, and `fields` is whatever that API decided it should be.

---

## 3. What GraphQL does that this does not

Stated plainly, because these are the reasons to choose GraphQL and they are good ones.

| | |
| --- | --- |
| **Response shape follows the request** | The single hardest thing to reproduce. See §5. |
| **One round trip across many resources** | A GraphQL document fetches pets, their shelters and their vaccinations together. Per-resource search endpoints do not. |
| **One mandatory introspection format** | Every GraphQL server answers the same introspection query, which is why GraphiQL, codegen and federation work everywhere. [SPEC.md §2.2](./SPEC.md#22-capability-discovery)'s capability document is RECOMMENDED, not required, and lives at an unspecified URL. |
| **Federation** | Composing one graph from many services is a solved, productised problem there and an unsolved one here. |
| **Subscriptions** | Out of scope entirely. |
| **Mutations** | Out of scope entirely; this is a predicate language. |

---

## 4. What this does that GraphQL does not

| | |
| --- | --- |
| **HTTP survives** | Cache-Control and ETags apply, `QUERY` and `GET` stay safe and cacheable, status codes mean what they say, errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problems with an RFC 6901 pointer at the offending clause ([SPEC.md §8](./SPEC.md#8-errors)). GraphQL's single POST endpoint forfeits intermediary caching; `application/graphql-response+json` recovers status codes but not cache keys. |
| **Null semantics are specified** | [SPEC.md §4.1](./SPEC.md#41-three-valued-logic) and [§4.2](./SPEC.md#42-missing-versus-null) pin down three-valued logic and the missing-versus-null distinction. GraphQL's null propagation is its most notorious sharp edge, and its filter semantics are per-vendor folklore. |
| **Complexity limits are normative** | [SPEC.md §7](./SPEC.md#7-safety-limits) bounds depth, clause count, set length and regex execution, and requires rejection rather than truncation. GraphQL query cost is left to each shop to solve. |
| **Honest partial implementations** | Profiles ([SPEC.md §2.1](./SPEC.md#21-profiles)) let a server advertise the subset it implements and reject the rest, instead of mistranslating it. |
| **Incremental adoption** | One endpoint can adopt the filter grammar without the rest of the API changing. GraphQL is a parallel stack. |
| **It is already in the toolchains** | JSON Schema is what OpenAPI 3.1 speaks and what an MCP `inputSchema` is. No new parser, client or IDE plugin. |

That last row is worth more in 2026 than it was in 2016. An LLM agent gains little from
client-specified projection — it did not want the other fields anyway — and a great deal from a
grammar it can be handed, validated against, and corrected by in one round trip. See
[README §*Exposing search to an agent*](./README.md#exposing-search-to-an-agent).

---

## 5. What a JSON-Schema-native alternative would actually require

Taking the ambition seriously, layer by layer. Each of these is independently useful, which is the
point: the reason to build this way rather than adopt GraphQL is that adopters can take one layer
and leave the rest.

| Layer | Status | The hard part |
| --- | --- | --- |
| **filter** | this specification | done |
| **capabilities** | [SPEC.md §2.2](./SPEC.md#22-capability-discovery), RECOMMENDED | making it mandatory and locating it, so tooling can rely on it |
| **select** | not started | deriving the *response* schema from a runtime selection set |
| **expand / link** | not started | JSON Schema has no relationship vocabulary; [JSON Hyper-Schema](https://json-schema.org/draft/2019-09/json-hyper-schema) tried and stalled after draft-07 |
| **order / page** | not started | little novelty; cursor opacity is the only real decision |
| **envelope + errors** | [SPEC.md §8](./SPEC.md#8-errors) | done for filters; would need extending per layer |

**The load-bearing difficulty is projection typing.** GraphQL's trick is that the client's query
document is itself the input to type derivation — that is what Relay and graphql-codegen consume.
JSON Schema cannot express "the response shape is a function of this request's selection set".
There are two workable answers and they are not exclusive:

- *Normatively:* the response schema is the resource schema with every non-selected property
  optional. A selection then guarantees presence, not typing — the same bargain OData and
  JSON:API's sparse fieldsets strike.
- *In tooling:* derive the exact response schema client-side from `resource schema ∩ selection`.
  This is codegen, and it is what GraphQL users are actually running anyway.

**A relationship vocabulary is the second obstacle**, and the precedent is discouraging. JSON
Hyper-Schema was the attempt and it did not reach 2019-09. Anything here would have to be new
work, and cross-resource traversal is the point at which the N+1 problem, authorisation per hop
and query cost all arrive at once — everything GraphQL servers spend their complexity budget on.

---

## 6. Where the generator fits

The gap that most weakens the comparison today is that the published grammar shares one
`Constraint` across every field, so it can validate that `{"status": "Available"}` is well-formed
but not that `"Available"` is outside `status`'s domain. GraphQL does not have this problem: it
*generates* `StringFilter`, `StatusEnumFilter` and so on per field, so the equivalent mistake is a
compile-time error.

[`tools/generate-filter-schema.mjs`](./tools/generate-filter-schema.mjs) closes it the same way,
from the resource's own JSON Schema — see
[README §*Generating a per-resource filter schema*](./README.md#generating-a-per-resource-filter-schema).
`data schema → filter schema` is the same pipeline as GraphQL's `SDL → input types`, with JSON
Schema as the source of truth instead of SDL. Extending that generator to emit a `select` schema
and a response schema from the same input is what would turn the phrase "JSON-Schema-native
alternative to GraphQL" into an architecture rather than a slogan.

---

## 7. Prior art

Anyone building this should know what has already been tried.

| | |
| --- | --- |
| [**OData**](https://www.odata.org/) | The dream, already attempted and standardised (OASIS, ISO/IEC 20802). `$filter`, `$select`, `$expand`, `$orderby`, `$top`/`$skip`, `$metadata`. Worth studying for why it did not displace GraphQL: a string-encoded `$filter` no schema can validate — precisely the defect this grammar fixes — an enormous surface, and CSDL metadata few enjoyed. |
| [**JSON:API**](https://jsonapi.org/) | Sparse fieldsets and `include` are a working design for the `select` and `expand` layers. Its `filter` is deliberately unspecified. |
| [**OGC CQL2**](https://docs.ogc.org/is/21-065r2/21-065r2.html) | Direct prior art for the predicate itself, including a JSON encoding. |
| **MongoDB query language** | The obvious syntactic ancestor of `$eq`/`$in`/`$elemMatch`. The divergences here are deliberate: no implicit coercion, specified three-valued logic, and `$in` documented as whole-value comparison. |
| [**SCIM filters**](https://www.rfc-editor.org/rfc/rfc7644#section-3.4.2.2), [**AIP-160**](https://google.aip.dev/160) | String-encoded filter grammars, with the same unvalidatable-parameter problem as OData. |
| [**JSONPath (RFC 9535)**](https://www.rfc-editor.org/rfc/rfc9535) | A standardised path grammar. [SPEC.md §3.2](./SPEC.md#32-path-grammar) uses a deliberately smaller one; the divergence is worth revisiting before 1.0. |
| **JSON Hyper-Schema** | The cautionary tale for the `expand` layer. |
| **Hasura / Prisma / Postgraphile `where`** | The de facto GraphQL filter dialects. Between them they are the closest thing to an existing standard, and none of them is one. |

---

## 8. Choosing between them

- **Choose GraphQL** if clients need to shape their own responses, if one round trip across many
  resources is a requirement, or if you need federation or subscriptions.
- **Choose this** if you have HTTP endpoints that already work and want their filters to be
  consistent, validated in CI, typed in generated clients, and usable by an agent — without
  adopting a parallel stack.
- **Choose both** if you run GraphQL: nothing stops the grammar being the body of your `where`
  argument, and it would make your filter vocabulary portable to the REST endpoints beside it.

The honest framing of the ambition: what is published here is one layer, and the most valuable one
to standardise because it is the one everybody re-invents. Whether the layers above it get built
is a separate question from whether this layer is worth adopting, and the answer to the second
does not depend on the first.
