# Crosswalk: UPC ⇄ W3C Web Annotation

The [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) (OA)
defines an interoperable vocabulary for selecting spans of a resource. UPC's
locator model overlaps it strongly, and the RO-Crate projection
([ro-crate.md](ro-crate.md)) emits an OA `Annotation` for every gated extraction so
external annotation tools can consume UPC evidence.

**Critical:** the OA form is an **interoperability projection only**. UPC's
`char_range` remains the single **gate-authoritative** selector (§11); the OA
selectors are advisory and are flagged `upc:interopOnly: true`. UPC MUST NOT weaken
its equality semantics to match OA, and MUST NOT register OA selectors as a UPC
`locator_type` (that would pull them into the `ext-` identity recipe, §06).

Legend: **exact** · **partial** · **incompatible** · **UPC-only**.

## Selector mapping

| UPC locator | Web Annotation | Mapping | Notes |
|---|---|---|---|
| `char_range` `{start,end}` | `TextPositionSelector` `{start,end}` | **partial** | see "Normalization divergence" — the numbers may differ |
| `direct_quote` (the exact span) | `TextQuoteSelector.exact` | **exact** | verbatim string equality on both sides |
| context (read at the locator) | `TextQuoteSelector.prefix`/`suffix` | exact | UPC reads these from the representation at build time; advisory, for re-anchoring |
| `css_selector` | `CssSelector` | exact | non-gating in both |
| `xpath` | `XPathSelector` | exact | non-gating |
| `bbox` `[x,y,w,h]` | `FragmentSelector` (media frag) / SVG selector | partial | image region |
| `timestamp_range` `{start,end}` sec | `FragmentSelector` (`#t=start,end`) | partial | audio/video |
| `page` / `heading` / `section` | `FragmentSelector` / `RangeSelector` (approx) | partial | coarse, non-gating |
| `secondary_locators[]` | `refinedBy` / multiple selectors | partial | advisory, excluded from UPC identity |
| **hop-B verification** | — | **UPC-only** | OA records a selection; it does not verify a quote |

Companion annotation shape emitted by the projection:

```json
{ "@type": "Annotation", "@id": "#ext-10aaf6c96053-anno", "upc:interopOnly": true,
  "target": { "source": {"@id": "sources/example/clean.md"},
    "selector": [
      { "@type": "TextPositionSelector", "start": 4120, "end": 4179, "upc:unit": "codepoint" },
      { "@type": "TextQuoteSelector", "exact": "cut over DNS only after the staging copy is fully validated",
        "prefix": "…", "suffix": "…" } ] },
  "body": { "@type": "TextualBody", "value": "…" } }
```

The extraction entity *itself* additionally carries `upc:charRange: {start,end}`
and `upc:gateAuthoritative: true`.

## Normalization divergence (why `char_range` → `TextPositionSelector` is only *partial*)

This is the single most important incompatibility, and the crosswalk states it
explicitly:

- **OA normalizes before counting.** The Web Annotation model specifies text
  normalization when recording/counting textual selectors, and `TextPositionSelector`
  positions are commonly implemented in **UTF-16 code units** over rendered text.
- **UPC does not normalize, ever, and counts codepoints.** `char_range` counts
  **Unicode codepoints** over the strict-UTF-8 decoding of the exact stored bytes,
  with no NFC/NFD, whitespace collapse, or case folding (§03).

Consequences the projection flags with `upc:unit: "codepoint"` and
`upc:interopOnly: true`:

- **Astral-plane characters** (emoji, some CJK): one codepoint = two UTF-16 units,
  so UPC offsets and a naive UTF-16 `TextPositionSelector` diverge after the first
  astral character.
- **CR/LF and whitespace:** UPC counts bytes-as-stored; an OA implementation that
  normalizes line endings or collapses whitespace will land on different offsets.
- **Combining characters:** UPC treats NFC and NFD as different text; an OA
  implementation that normalizes to NFC will not.

Therefore: **the `TextPositionSelector` is an interoperability representation; the
UPC `char_range` is gate-authoritative.** A consumer that wants the guaranteed span
resolves `upc:charRange` against the codepoint-decoded representation, not the OA
selector. The `TextQuoteSelector.exact` string, by contrast, *is* exact on both
sides and is the safest cross-system anchor — with `prefix`/`suffix` disambiguating
a quote that occurs more than once (useful for re-anchoring, still non-authoritative
for the gate).

## Direction

Export only in 1.4.0 (inside the RO-Crate projection). No OA importer; OA selectors
never become gate-bearing UPC locators.
