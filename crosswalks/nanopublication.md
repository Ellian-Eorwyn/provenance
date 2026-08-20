# Crosswalk: UPC ⇄ Nanopublications (deferred)

[Nanopublications](https://nanopub.net/) represent small publishable knowledge
objects with three named graphs: an **assertion**, its **assertion provenance**,
and **publication information** (often with a Trusty-URI integrity key for
immutability).

**Status: deferred (not in UPC 1.2.0).** UPC's synthesis **claim register**
(`synthesis.claims[]`, §04) overlaps this model and is the natural export surface,
but nanopublication export is a later, optional projection — it needs an RDF
serialization and Trusty-URI machinery that would exceed the zero-dependency
reference implementation. UPC does **not** replace its claims with RDF
nanopublications.

## Sketch of the eventual mapping

| UPC | Nanopublication | Notes |
|---|---|---|
| `synthesis.claims[].text` | assertion | the claim itself |
| claim `evidence_ids` / `source_ids` | assertion provenance | the UPC evidence/source graph |
| synthesis `produced_by` + `created_at` | publication info | who/what/when produced the claim |
| content-addressed `syn-`/`ext-`/`src-` ids | (Trusty-URI-like) immutable references | UPC already has content-addressed identity (§06) |
| the hop-B/C quote gate | — | **UPC-only**; nanopublications do not verify quotations |

Revisit alongside first-class claim entities (a possible UPC 2.0 direction) so a
selected UPC finding can move into scholarly knowledge-graph systems without UPC
itself becoming RDF-native.
