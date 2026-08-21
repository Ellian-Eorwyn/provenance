# UPC 09 — Human Interface, Modification & Projections

The corpus serves three co-equal audiences (§00). This section covers the two
that are not the raw machine surface: the **human browse / modify / export
interface**, and the general rule that **any consumer format is a regenerable
projection**. Browsing, modification, and export are first-class requirements of
the standard, not afterthoughts.

## The projection rule

**Structured objects are the single source of truth. Every human- or
consumer-facing format is a view computed from those objects — never a second
source of truth, and never hand-authored with unsourced content.**

Projections include:

- the CSV mirrors `sources.csv` / `extractions.csv` (§01);
- the static HTML browser `index.html` (below);
- generated Markdown deliverables (`summary.md`, `synthesis.md`, §04);
- bibliographic exports — CSL-JSON, BibTeX, RIS (below);
- an RO-Crate 1.3 metadata graph (`ro-crate-metadata.json`) conforming to the UPC
  RO-Crate profile (`profiles/ro-crate/`; `crosswalks/ro-crate.md`);
- **any format produced on demand by an LLM** — a literature review, a comparison
  table, a slide outline, a prose answer.

Two consequences are normative:

1. A tool MUST be able to regenerate every projection it emits from the objects
   alone (`upc regen`, `upc export`, `upc build-index`).
2. A generated deliverable MUST NOT introduce claims that are not backed by
   extractions/sources in the corpus, and every quotation in it MUST pass the
   hop-C gate (§04). "Ask an LLM for any format" is safe precisely because the
   result is verifiable: run `upc verify-quotes` over it.

## The static HTML browser (`index.html`)

Every corpus can generate a **self-contained, offline** `index.html` that is the
primary human browse-and-find surface, built purely from the manifests and object
files (a projection).

Requirements:

- **Self-contained & offline.** No network dependency; openable directly from the
  filesystem. Asset references are corpus-relative.
- **Findability first.** A source list showing title, author, date, kind, and
  fetch status, with filter/search by title/tag/type/status.
- **Follows the provenance graph both ways.** From a source: its representations
  (open the raw HTML/PDF/images, play audio/video, read transcripts), its
  extractions, its generations, and the syntheses that cite it. From a synthesis:
  back to its claims, their evidence, and the sources.
- **Shows provenance.** For any object, surface where it came from and what
  produced it (the `provenance` stamp).
- **Regenerable.** Rebuilt from the objects at any time; never hand-edited;
  written atomically (§10).

### Verified display (normative)

The browser is a verification surface, not just a viewer, so it must never present
unverified text as verified:

- **Context comes from the representation, not the record.** The in-context
  reader MUST render a quotation by reading the representation's bytes at the
  locator at build time and showing the surrounding text from the file. It MUST
  NOT reconstruct "context" from the extraction's own stored `context_*` strings
  (which nothing verifies) — doing so is self-confirming and can never reveal
  drift.
- **Per-quote badges.** Each quotation shows its gate result: **verified** (hop B
  passed against the representation), **failed** (hop B failed — offset drift or a
  rewritten representation), **verified-to-transcript** (passed against a
  **derived** text — labeled distinctly per §05's trust boundary), or
  **unverifiable** (a `text`-only extraction or a coarse locator).
  A text is *derived* when the bytes it came from were not themselves text: a
  transcript of audio, an OCR of an image, or a text layer extracted from a PDF.
  A conforming surface MUST decide this from the derivation, not from the role
  name — a `role: "text"` representation whose `parent_representation_ref` is a
  PDF is derived text, and badging it plain **verified** would claim the
  quotation was checked against the document when it was checked against a
  rendering of it. A text-to-text conversion (raw HTML → cleaned Markdown) is
  *not* derived in this sense; §11 counts that as exact in the cleaned
  representation.
- **Paraphrases are never styled as quotes.** A `text`-only extraction (no
  `direct_quote`) MUST be labeled a paraphrase and MUST NOT be rendered in
  quotation marks, a blockquote, or `<mark>`. The word "Quote" is reserved for
  gated `direct_quote`s.
- **Failure banner.** If any gate fails in the corpus, the browser surfaces a
  banner with the counts, so a broken corpus never looks clean.
- **Lifecycle chips.** `needs_review`, `superseded`, and `retracted` extractions
  are shown with a status chip, not hidden.
- **Deep links.** URL-hash deep links address views *and individual extractions*
  (`#ex=<ext-id>`), and the active filters/search/sort are encoded in the hash so
  a filtered view is shareable.
- **Presentation locators are shown as navigation, never as evidence.** A
  conforming browser SHOULD surface the advisory positions an extraction carries
  — the derived line number for a `char_range` quote, a `page`, a `bbox` region,
  a `timestamp_range` — so a reader can get from a quotation to its place in the
  source. It MUST render them visibly distinct from the gate result, and MUST NOT
  let any of them change a badge. Resolving a presentation locator is a reading
  aid; only hop B decides whether a quotation is verified.
- **A region drawn on an image MUST be labeled as recorded, not gated.** When a
  surface highlights a `bbox` on an image — including the cross-representation
  case where a quotation verified against an `ocr` text is shown against the
  picture that text was read from — it MUST state that the region is an
  *inference* and not a verified position (§05). Showing the highlight without
  that label would let a gated claim ("this text is exactly what the OCR says")
  silently borrow authority for an ungated one ("and it is exactly there on the
  image"). The two claims MUST stay visibly separate.
- **A source view SHOULD show the representation in place.** Sending a reader to
  a new tab to check a position defeats the purpose of a verification surface. A
  conforming browser SHOULD be able to display the representation alongside the
  evidence, positioned at the locator: the line for a `char_range` or
  `line_range`, the page for a `page`, the region for a `bbox`. Because the
  offline browser cannot read sibling files at view time (`fetch` is unavailable
  from a `file:` origin), a textual representation shown this way MUST be carried
  in the page as the bytes read at build time — the same bytes the gate ran
  against — and MUST NOT be re-fetched at view time, which could silently show
  text that no longer matches what was verified. A representation too large to
  carry MUST be omitted entirely and offered as an external link; a **truncated**
  document MUST NOT be presented as the document.
- **Image representations carry their three pieces.** Where a browser shows an
  image it SHOULD show the `description` (what the image is), the `has_text`
  indication (whether it contains legible text), and a path to the verified
  quotation of that text when one exists (§05). `ocr_text`, if displayed at all,
  MUST be marked advisory and MUST NOT be presented as a quotation.

## Modifying a corpus

A human (or an LLM acting for one) can correct what is wrong. The browser itself
stays **read-only** — editing happens on the structured objects, then projections
are regenerated — so there is exactly one source of truth. The workflow:

```
edit the structured object(s)  →  upc validate  →  upc regen
```

- **Edit** a `source.json`, an extraction record, a claim, or bibliographic
  metadata directly (by hand or via a tool). The edit is stamped as a human
  production (§07): `produced_by` gets `person` and `method: "manual"`,
  `modified_at` is set, and a `modify` event is journaled.
- **Validate** to confirm the edit did not break a gate or a reference. Because
  ids are content-addressed, changing an extraction's quote or locator mints a new
  `ext-` id; the modify workflow supersedes the old extraction (§03) rather than
  leaving a dangling citation.
- **Regenerate** the manifests, CSV mirrors, and browser from the objects.

Because manifests and mirrors are always regenerated, a human never edits them
directly; they edit the objects and let `regen` rebuild the derived surface.

### Re-anchoring after a representation changes

Re-rendering or re-cleaning a source produces a **new** representation (new `rep-`
id), against which the old extractions no longer verify. `upc reanchor` searches
the successor representation for each affected quote **byte-exactly**:

- a **unique** match mints a replacement extraction (new locator + id) linked to
  the old by `supersedes`/`superseded_by`;
- **zero or multiple** matches set the old extraction to `needs_review` with the
  candidate offsets.

Nothing is ever re-anchored silently, and no quotation is repointed to a span it
does not byte-match.

### Re-extraction from the literature (via prompting)

A human can ask for the evidence to be pulled again — e.g. for a new question, or
after a better cleaning pass. The protocol (detailed in
`skill/universal-provenance/references/re-extraction.md`) keeps the gate intact:
an LLM proposes candidate quotations as `{quote, approx_context}` JSON; the tool
**anchors each one byte-exactly** in the chosen representation; a span that is
found becomes a minted `char_range` extraction that passes hop B by construction;
a span that is not found is returned as `needs_review`, never written as if
verified. The model chooses *what* to extract; the tool guarantees *that it is
real*.

## Exports

CSL-JSON is authoritative; BibTeX and RIS are field mappings from it. `upc export`
emits any of them, plus `jsonl` (the raw objects) and `markdown` (a formatted
bibliography). The bibliographic mappings:

| CSL-JSON (`bibliographic`) | BibTeX | RIS |
|---|---|---|
| `item_type` (webpage/article-journal/book/…) | entry type (`@misc`/`@article`/`@book`/…) | `TY` (`ELEC`/`JOUR`/`BOOK`/…) |
| `title` | `title` | `TI` |
| `authors[]` (`family, given` / `literal`) | `author` (`and`-joined) | one `AU` per author |
| `editors[]` | `editor` | `ED` |
| `issued.date_parts[0][0]` | `year` | `PY` |
| `container_title` | `journal` / `booktitle` | `T2`/`JO` |
| `volume` / `issue` / `page` | `volume` / `number` / `pages` | `VL` / `IS` / `SP`–`EP` |
| `doi` / `url` | `doi` / `url` | `DO` / `UR` |
| `publisher` | `publisher` | `PB` |
| `abstract` | `abstract` | `AB` |
| (anything unmapped) | `note` | `N1` |

`upc export … --format ro-crate` emits a research-object projection instead of a
bibliographic one: a deterministic **RO-Crate 1.3** metadata graph
(`ro-crate-metadata.json`) conforming to the UPC RO-Crate profile
(`profiles/ro-crate/`). It carries the object graph, derivation edges, and — for
each gated extraction — a companion Web Annotation, with the UPC content-addressed
ids preserved in `identifier`/`upc:*Id` and the `char_range` kept
gate-authoritative (`crosswalks/ro-crate.md`, `crosswalks/web-annotation.md`, §11).

Because exports are projections, they are regenerated on demand and never held as
a second source of truth.

## Why this satisfies all three audiences at once

- **Machine-managed** — agents read/write the objects and regenerate projections.
- **Human-browsable & editable** — `index.html` and the readable folder/file
  names let a person find, verify, correct, and export materials.
- **LLM-renderable** — the structured, provenance-linked objects let an LLM emit
  any desired format on demand, with its quotations mechanically verified.

No audience is served by a different copy of the data; they are all served by
views over one source of truth.
