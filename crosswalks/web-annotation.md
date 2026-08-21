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
| `line_range` `{start,end}` | `FragmentSelector` (RFC 5147 `#line=`) | **partial** | UPC is 1-based inclusive, RFC 5147 is 0-based half-open — see "Fragment syntax" |
| `bbox` `[x,y,w,h]` | `FragmentSelector` (Media Fragments `#xywh=pixel:`) / `SvgSelector` for irregular shapes | partial | image region; resolution-dependent, so `upc:reference` travels with it |
| `timestamp_range` `{start,end}` sec | `FragmentSelector` (`#t=start,end`) | partial | audio/video, NPT seconds |
| `page` | `FragmentSelector` (`#page=N`, PDF open parameters) | partial | coarse, non-gating |
| `heading` / `section` | `RangeSelector` (approx) | partial | not emitted: no unambiguous fragment syntax |
| `secondary_locators[]` | an additional `target`, or extra selectors on the same target | partial | advisory, excluded from UPC identity — see "Cross-representation targets" |
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

## Fragment syntax, and the unit traps in each

Presentation locators project to four external fragment syntaxes. Every one is
emitted inside a `FragmentSelector`, flagged `upc:interopOnly: true`, and tagged
with `upc:conformsTo` and `upc:unit`. **None of them is ever verified**, and none
may carry `upc:gateAuthoritative`.

| UPC locator | Fragment emitted | `upc:conformsTo` | Standard |
|---|---|---|---|
| `line_range` | `#line=<start-1>,<end>` | `rfc5147` | [RFC 5147](https://www.rfc-editor.org/rfc/rfc5147) |
| `page` | `#page=<n>` | `pdf-open-params` | PDF open parameters (RFC 8118 / ISO 32000-2) |
| `bbox` | `#xywh=pixel:x,y,w,h` | `media-frags` | [W3C Media Fragments](https://www.w3.org/TR/media-frags/) |
| `timestamp_range` | `#t=<start>,<end>` | `media-frags` | Media Fragments, NPT seconds |

Each trap, stated plainly rather than silently reconciled:

- **RFC 5147 is 0-based and half-open; UPC `line_range` is 1-based and
  inclusive.** UPC lines 3–5 export as `#line=2,5`. RFC 5147 also counts line
  *terminators* as part of the line and is therefore CRLF-sensitive, while UPC
  numbers lines by `\n` alone. The shift is applied only at this boundary; §03
  governs inside UPC.
- **PDF user space is bottom-left with Y increasing upward; image space is
  top-left with Y increasing downward.** A `bbox` is defined in *image* pixels
  (§05). Anything derived from a PDF's own coordinates must be flipped before it
  becomes a UPC `bbox`; UPC does not do this for you and cannot detect a
  mis-flipped box.
- **`#xywh=pixel:` is resolution-dependent.** The same region on a 240×120 render
  and a 2400×1200 render has different pixel numbers. This is why a `bbox`
  carries `reference: {width, height}`, exported as `upc:reference`. Without it a
  pixel fragment is not portable. `#xywh=percent:` avoids the problem and is
  emitted when `unit` is `percent`.
- **`timestamp_range` is seconds, half-open**, relative to media start.

## Cross-representation targets

A secondary locator may address a **different representation of the same source**
than the primary one does — that is how a quotation verified against an `ocr` text
records where on the *image* that text sits (§05).

An OA `selector` is only meaningful against its own `target.source`, so such a
locator MUST NOT be appended to the text target's selector array. The projection
emits an **additional target** instead, and `target` becomes an array:

```json
{ "@type": "Annotation", "@id": "#ext-e32197281015-anno", "upc:interopOnly": true,
  "target": [
    { "source": {"@id": "…/ocr/figure.txt"},
      "selector": [
        {"@type": "TextPositionSelector", "start": 0, "end": 28, "upc:unit": "codepoint"},
        {"@type": "TextQuoteSelector", "exact": "Downtime: staging-first = 0s"} ] },
    { "source": {"@id": "…/images/figure.svg"},
      "selector": [
        {"@type": "FragmentSelector", "value": "#xywh=pixel:12,52,200,18",
         "upc:conformsTo": "media-frags", "upc:unit": "pixel",
         "upc:reference": {"width": 240, "height": 120}},
        {"@type": "TextQuoteSelector", "exact": "Downtime: staging-first = 0s"} ] } ],
  "body": { "@type": "TextualBody", "value": "Downtime: staging-first = 0s" } }
```

A secondary locator on the *same* representation adds its selectors to the
existing target rather than creating a second one, and an annotation with a single
target keeps the bare-object form.

**`refinedBy` is deliberately not used for this.** `refinedBy` narrows a selection
*within one resource*; using it across resources would assert that the image
region is a refinement of the text span, which is exactly the inference UPC
refuses to make. The two targets are co-equal and differently trusted: the text
one is gated, the image one is recorded.

**IIIF.** For images served through a [IIIF](https://iiif.io/) Image API endpoint,
the same region is addressable as a IIIF region parameter and the annotation
target may be a IIIF canvas. UPC does not emit IIIF: it has no way to know an
image's IIIF service. The `bbox` plus `reference` carries everything a IIIF-aware
consumer needs to construct one.

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

Export only (inside the RO-Crate projection, and via `upc locate --format
web-annotation` for a single extraction). No OA importer; OA selectors never
become gate-bearing UPC locators.

Since 1.5.0 the projection also covers presentation and cross-representation
locators, as `FragmentSelector`s on their own targets. This widened what UPC
*describes*; it did not widen what UPC *verifies*, which remains exactly the
primary `char_range`.
