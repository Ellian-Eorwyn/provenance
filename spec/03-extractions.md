# UPC 03 — Extractions & the Quotation Gate

An **extraction** is structured evidence selected from a *specific
representation* at an *exact location*. This is the object most exchanged between
tools, so its schema is the central interoperability contract. The governing
principle: **an extraction must never become an orphaned quotation.** It is always
traceable to its source, the representation it came from, the exact locus within
that representation, and the process that selected it — and, when it carries a
`direct_quote`, that quote is verifiable byte-for-byte against the representation.

Schema: [`extraction.schema.json`](../schemas/extraction.schema.json).

## Two kinds of extracted text, one of them verified

An extraction may carry `direct_quote`, `text`, or both. They are held to
completely different standards, and this difference is the foundation of the
whole gate:

- **`direct_quote`** — an **exact, verbatim** span of the representation. It MUST
  be identical, codepoint-for-codepoint, to the representation's text at the
  extraction's locator (the hop-B gate, below). No normalization is applied when
  checking it. If you cannot produce a span that matches exactly, you do not have
  a `direct_quote` — you have a paraphrase, which goes in `text`.
- **`text`** — a **faithful statement** of what the evidence says. It MAY be
  lightly normalized, de-hyphenated, or paraphrased for readability. It is
  **never verified** against the representation and MUST NOT be presented as a
  quotation (no quotation marks, no blockquote styling — §09 enforces this in the
  browser).

At least one of `direct_quote` or `text` MUST be present. The two must not be
conflated: a consumer that wants a guaranteed-real quotation uses `direct_quote`;
a consumer that wants a readable gloss uses `text`.

## Shape

```json
{
  "extraction_id": "ext-10aaf6c96053",
  "source_id": "src-a1b2c3d4e5f6",
  "representation_ref": "rep-3333bbbb4444",
  "type": "evidence",
  "status": "active",
  "text": "Staging-first migration avoids downtime by cutting over DNS only after validation.",
  "direct_quote": "cut over DNS only after the staging copy is fully validated",
  "locator": { "type": "char_range", "representation_ref": "rep-3333bbbb4444", "value": { "start": 4120, "end": 4179 } },
  "secondary_locators": [
    { "type": "section", "representation_ref": "rep-3333bbbb4444", "value": "Cutover" }
  ],
  "query": "How do you migrate a WordPress site without downtime?",
  "interpretation": "explicit",
  "confidence": "high",
  "confidence_score": 0.9,
  "rationale": "Directly answers the cutover-timing part of the question.",
  "provenance": {
    "produced_by": { "tool": "pi-forge", "tool_version": "0.1.0", "model": "local-llm", "method": "model", "prompt_version": "web-research/evidence@3" },
    "created_at": "2026-07-09T19:05:00Z",
    "derived_from": { "source_ids": ["src-a1b2c3d4e5f6"], "representation_refs": ["rep-3333bbbb4444"] },
    "input_digest": "sha256:77aa…"
  }
}
```

`context_before` / `context_after` MAY still be recorded as convenience strings,
but they are **advisory** and never gate-bearing; the authoritative context is the
representation itself, read at the locator (which is exactly what the browser
shows, §09). They are not part of identity.

## The locator is `(representation_ref, typed position)`

A char offset, a heading, or a page number is meaningless without knowing *which
rendering* it indexes — the raw HTML, the cleaned Markdown, or the PDF all have
different offsets for the same sentence.

- `extraction.representation_ref` names the representation.
- `locator.representation_ref` MUST equal it (validator rule `locator_rep_mismatch`).
- `locator.type` (closed vocab) selects the position shape:

| `locator.type` | `value` shape | Gate-bearing? | Typical representation |
|---|---|---|---|
| `char_range` | `{ "start": int, "end": int }` | **yes** | markdown / text |
| `line_range` | `{ "start": int, "end": int }` | no (advisory) | markdown / text |
| `page` | integer ≥ 1 | no | pdf |
| `heading` / `section` | string | no | markdown / html |
| `css_selector` / `xpath` | string | no | html |
| `url` | string | no | any (the whole source) |
| `timestamp_range` | `{ "start": sec, "end": sec }` | no | audio / video |
| `bbox` | `[x, y, w, h]` | no | image |

Only `char_range` anchors a span precisely enough to verify a quotation. **A
coarse locator (page, section, heading, …) can never carry a gated
`direct_quote`.** Coarse positions are still valuable as *human context*, so an
extraction MAY record any number of them in `secondary_locators[]` (advisory,
excluded from identity, never gated) — for example "this quote is also on page
7, in the Cutover section." An extraction that carries a `direct_quote` MUST have
a `char_range` primary `locator` into a textual representation; otherwise it is a
`text`-only extraction.

### `line_range` is 1-based and inclusive

A `line_range` counts **lines, numbered from 1, with both endpoints included**:
`{ "start": 3, "end": 3 }` is the third line alone. A line break is `\n`; a CRLF
file therefore numbers identically to an LF one, because the `\r` is simply a
codepoint on the preceding line. A trailing newline does not create a final empty
line, so `"a\nb\n"` is two lines.

This differs deliberately from RFC 5147's `#line=`, which is 0-based and
half-open. The difference is reconciled only at the projection boundary
([crosswalks/web-annotation.md](../crosswalks/web-annotation.md)); inside UPC the
1-based inclusive reading is normative. A `line_range` is **advisory** and is
never verified: a line number is a reading aid, and only `char_range` gates.

### Presentation and cross-representation locators

`secondary_locators[]` is the home for two related, always-advisory jobs:

- **Presentation.** A position expressed in whatever unit a reader can act on —
  the line in a text file, the page in a PDF, the region on an image, the moment
  in a recording. These make an extraction *navigable*, not *provable*.
- **Cross-representation anchoring.** A secondary locator MAY address a
  **different representation of the same source** than the primary locator does.
  This is how a quotation verified against an OCR text records *where on the
  image* that text sits (§05). The `locator_rep_mismatch` rule constrains only
  the primary locator, precisely so this remains expressible.

A secondary locator MUST NOT address a representation of a *different source*
(advisory `secondary_locator_cross_source`, §08). Whatever it addresses, it is
never gate-bearing and never enters the `ext-` identity recipe (§06): only the
primary `char_range` does both.

### Advisory locator metadata

A locator MAY carry these optional members **alongside** `type`,
`representation_ref`, and `value`. All four are advisory, and all four are
deliberately siblings of `value` rather than members of it, because `value` is
hashed into the extraction id while these are not (§06):

| Member | Purpose |
|---|---|
| `conforms_to` | The external fragment standard the position projects to — `rfc5147`, `media-frags`, `pdf-open-params`. |
| `unit` | What the numbers count: `codepoint` (the UPC default, and the only gate-bearing unit) or `utf16`; `pixel` or `percent` for a region. |
| `reference` | `{ width, height }` — the resolution frame a pixel `bbox` was captured against. Required in practice for a `bbox` to mean anything, since pixel coordinates are resolution-dependent. |
| `quote_hint` | `{ exact, prefix?, suffix? }` — a content-based re-find hint, mapping to a Web Annotation `TextQuoteSelector`. |

`quote_hint` lets a consumer re-locate a span by **content** when stored offsets
have drifted. It is a recovery aid and a projection input, **never** a
verification path: a `quote_hint` is not checked by any gate, and matching one
does not make a quotation verified. Only hop B does that.

### `char_range`, defined normatively

`char_range` counts **Unicode codepoints** (Unicode scalar values), **0-based**,
**start-inclusive, end-exclusive**, into the representation's text obtained by
**decoding its exact stored bytes as UTF-8**. No normalization (no NFC/NFD, no
whitespace collapse, no case folding) is applied before indexing; newlines and
every other character count as one-or-more codepoints exactly as stored.

The span text is `codepoints(utf8_decode(bytes))[start:end]`. Equivalent
implementations:

- **JavaScript** — `[...string].slice(start, end).join("")` (spreading a string
  iterates by codepoint; plain `.slice()` is UTF-16 and is *wrong* for
  astral-plane characters).
- **Python** — `text[start:end]` (Python 3 strings are codepoint-indexed).
- **Go / Rust** — index the `[]rune` / `char` sequence, not the byte slice.

Constraints (validator rule `locator_range_invalid`): `0 ≤ start ≤ end ≤
codepoint_length(text)`.

### "byte-for-byte" means codepoint-exact over the hash-fixed bytes

UPC's slogan for the gate is "byte-for-byte," and the normative comparison is
**codepoint equality** (step 6 below). These denote the *same test*: both operands
are compared without any normalization, and both are — directly or transitively —
the strict-UTF-8 decoding of the **same hash-fixed stored bytes** (the
representation's bytes are pinned by hop A, and a `direct_quote` that passes is by
construction a codepoint slice of that same decoded text). Because UTF-8 is a
bijection between a valid byte sequence and its codepoint sequence, codepoint
equality over the decoded text and byte equality over the encoded bytes coincide.
The slogan is the intuition; codepoint-exact equality over a byte-hash-fixed UTF-8
representation is the precise statement (see §11). Offsets count **Unicode
codepoints** — never bytes, UTF-16 code units, or grapheme clusters.

## The hop-B gate (extraction ↔ representation)

This is the first verified hop of the chain `output → extraction → source`. For an
**active** extraction that carries a `direct_quote`, a validator MUST perform,
with no normalization anywhere:

```
1. Resolve rep = representation(extraction.representation_ref).
   Read rep bytes; sha256(bytes) MUST equal rep.sha256   [hop A: rep_hash_mismatch]
2. rep MUST be textual (media_type text/*, application/json, application/xml)
                                                          [quote_rep_not_text]
3. text = utf8_decode_strict(bytes)                       [invalid_utf8 on failure]
4. locator.type MUST be "char_range"                      [quote_locator_missing]
5. 0 ≤ start ≤ end ≤ codepoint_length(text)               [locator_range_invalid]
6. span = codepoints(text)[start:end]
   span MUST equal direct_quote, codepoint-for-codepoint  [quote_gate_failed]
```

Equality is exact. If it fails, the validator reports `quote_gate_failed` and, as
a repair hint, records whether `direct_quote` occurs byte-exactly *elsewhere* in
the representation (a drifted offset) or *nowhere* (a rewritten representation or
a fabricated quote). A failure is **flagged, never absorbed**: the corpus does
not silently "find the quote anyway," and a tool MUST NOT downgrade the
comparison to make it pass.

Extractions whose `status` is not `active` (below) are **not** gated; they are
surfaced as `flagged_extraction` (a warning) so nothing disappears silently.

## Getting a quote right: extract, don't retype

The reliable way to obtain a `direct_quote` is to **copy the exact span from the
representation**, never to retype it from memory. The reference tool does this
mechanically: `upc quote <ext-id>` prints the stored quote with its citation
marker, ready to paste (§ skill). When a producer selects a new quotation, it
should take `codepoints(text)[start:end]` directly and store *that*, so the gate
passes by construction.

If the desired wording spans a hard line break or includes surrounding
punctuation you don't want, the fix is to **choose a cleaner span** or to write a
cleaned representation and anchor into it — not to edit the quote after copying.
Editing the copied bytes is exactly what breaks the gate.

## Normalized re-find at anchoring time

A model asked to copy a span out of PDF-extracted text reliably returns
something a byte-exact search cannot find. It straightens a curly quote, writes
`fi` where the page has an `ﬁ` ligature, puts a space where the page has a line
break, rejoins a word the typesetter hyphenated across lines. The span is
genuinely in the document; the proposal is a faithful reading of it rendered in
ordinary characters.

A producer MAY therefore search with a stated normalization when the byte-exact
search finds nothing. The normalization applies to **both sides** of the search
and to nothing else:

| Class | Treatment |
|---|---|
| `whitespace` | any run of whitespace (including NBSP, en/em spaces, U+202F, U+3000) collapses to one space |
| `quotes` | `‘ ’ ‚ ‛ ′` fold to `'`; `“ ” „ ‟ ″` fold to `"` |
| `dashes` | U+2010–2015 and U+2212 fold to `-` |
| `soft-hyphen` | U+00AD is removed |
| `hyphenation` | a hyphen at a line break followed by a lowercase letter is removed with the break |
| `ligatures` | `ﬀ ﬁ ﬂ ﬃ ﬄ` expand to their letters |
| `ellipsis` | `…` expands to `...` |

Case is **not** folded and Unicode normal forms are **not** applied. Both would
let visibly different text match, and the point of the gate is that what is
stored is what the document says.

The rules that make this safe, all normative:

- A producer **MUST** store the representation's own codepoints at the located
  offsets as `direct_quote`. The proposed string is never stored as the quote.
- A producer **MUST NOT** mint an `active` extraction when the normalized search
  finds zero or more than one occurrence, exactly as for the exact search.
- A producer **SHOULD** record the search on the extraction as `anchoring`:
  `{ method: "normalized", proposed_quote, rules[] }`, where `rules` lists only
  the classes that actually differed. `anchoring` is advisory, is excluded from
  the `ext-` identity recipe, and describes the *search*, not the quotation.
- **Hop B is unchanged.** Verification remains codepoint equality with no
  normalization. Nothing in this section can make a quotation verify that would
  not have verified anyway; it only changes which spans a producer can find.

`upc anchor --normalize` implements exactly this. Without the flag the search is
byte-exact and nothing else.

## Narrowing: sub-quoting without loosening the gate

To quote *less* than an existing extraction — a phrase inside a verified sentence
— mint a **narrowed extraction** rather than trimming a quote by hand. A narrowed
extraction is a deterministic sub-slice of a verified span:

- its `locator` is a `char_range` fully inside the parent's range;
- its `direct_quote` is `codepoints(text)[start:end]` for the narrower range;
- its `provenance.derived_from.extraction_ids` lists the parent;
- it passes hop B on its own, by construction.

Because narrowing produces a real, independently verifiable extraction with its
own `ext-` id, an output can cite the exact sub-phrase and still be fully gated.
`upc quote <ext-id> --narrow <start> <end>` mints one and prints its marker.

## Extraction lifecycle (`status`, supersession)

Extractions are derived objects and may need correction. Rather than mutate a
content-addressed id in place (which would dangle every citation of it), UPC
tracks a lifecycle:

- `status` ∈ `active` (default), `needs_review`, `superseded`, `retracted`.
  Only `active` extractions are gated and exported; the others are retained and
  surfaced so nothing is lost.
- When a representation is re-rendered (new `rep-` id), its extractions no longer
  verify against it. The `reanchor` workflow (§09) searches the successor
  representation for each quote byte-exactly: a unique hit mints a replacement
  extraction linked by `supersedes` / `superseded_by`; zero or multiple hits set
  the old extraction to `needs_review` with candidate offsets. Nothing is
  re-anchored silently.
- A wrong or unwanted extraction is set to `retracted` (retained, excluded from
  gates and exports) or removed entirely via the journal-logged removal of §10.

## Types

`type` is the closed `extraction_type` vocabulary (plus an `x-` escape hatch):
`quote`, `passage`, `evidence`, `in_text_citation`, `entity`, `claim`, `finding`,
`method`, `limitation`, `definition`, `data_point`, `image_region`,
`timestamp_range`.

### The `in_text_citation` subtype

The core extraction of a citation manager is an in-text citation resolved to a
bibliographic entry. That is an extraction of `type: "in_text_citation"` whose
`resolves_to` carries the bibliographic target:

```json
{
  "extraction_id": "ext-…",
  "source_id": "src-…",
  "representation_ref": "rep-…",
  "type": "in_text_citation",
  "status": "active",
  "text": "[4]",
  "direct_quote": "[4]",
  "locator": { "type": "char_range", "representation_ref": "rep-…", "value": { "start": 2040, "end": 2043 } },
  "resolves_to": { "item_type": "article-journal", "title": "…", "authors": [{ "family": "Smith", "given": "J." }], "issued": { "date_parts": [[2020]] }, "doi": "10.1234/xyz" },
  "confidence_score": 0.87
}
```

The citing sentence's surroundings go in `secondary_locators` or the advisory
`context_*` fields; `resolves_to` is the matched bibliography entry. If a producer
stores the marker as a `direct_quote` (as above), it is gated like any other; if
it stores only the citing sentence as `text`, that is an ungated paraphrase.

## The prompting query

`query` records the question, task, or purpose that caused the extraction to be
selected. This is what makes query-driven literature extraction reproducible: the
same corpus can hold extraction sets for several different questions, each
labelled by its `query`.

## Where extractions live

Two physical arrangements, both valid (declared in the manifests):

- **Per-source** — `sources/<slug>/extractions.jsonl`, one JSON object per line
  (§10 JSONL rules); `source.json.extractions_path` points at it. Best when
  extractions belong to a single source.
- **Extraction sets** — `extractions/<set-id>/{manifest.json, items.jsonl}` for a
  query-driven set spanning many sources; `manifest.json`
  ([`extraction-set.schema.json`](../schemas/extraction-set.schema.json)) records
  the `query` and set metadata. Best for a literature-extraction pass over the
  whole corpus.

Either way, each extraction is a first-class object with a canonical `ext-` id,
and the root `extractions.csv` is a flat projection of all of them.
