# UPC 05 — Multimodal Content

Images, audio, video, and their transcripts are **first-class representations**,
not artifacts discarded during text conversion. An image extracted from a PDF or
webpage is retained with enough metadata that an LLM working only from the
Markdown representation can still understand the figure without losing its
provenance.

## Images as representations

An image is a representation with `role: "image"` and an `img-<12hex>` id (§06).
Beyond the common representation fields it SHOULD carry:

```json
{
  "representation_id": "img-4d5e6f7a8b9c",
  "role": "image",
  "media_type": "image/png",
  "path": "sources/paper-2025-methods/representations/images/img-4d5e6f7a8b9c.png",
  "sha256": "sha256:…",
  "parent_representation_ref": "rep-document-pdf-id",
  "description": "Bar chart comparing migration downtime across three cutover strategies; staging-first is lowest.",
  "ocr_text": "Downtime (s)  Direct: 42  Blue-green: 9  Staging-first: 0",
  "caption": "Figure 3. Downtime by cutover strategy.",
  "dimensions": { "width": 1200, "height": 720 },
  "produced_by": "conversion"
}
```

- `parent_representation_ref` links the image back to the representation it was
  extracted from (the PDF or rendered HTML), preserving *where it came from*.
- `description` is a machine-generated textual description — first-class so a
  text-only reader understands diagrams, charts, and photographs.
- `ocr_text` holds visible text within the image, where relevant.
- `caption` holds nearby caption text; a tool MAY also record the relationship as
  a locator into the parent representation.

Image filenames SHOULD be id-named (`images/img-<12hex>.<ext>`) so a figure is
locatable from its id alone; a human-readable name is also permitted since the
manifest resolves the id to the path.

### Structured vs embedded description

The structured `description` on the representation is **canonical**. A tool MAY
*also* embed a readable rendering of it into the cleaned Markdown representation
(e.g. `![Figure 3: downtime by strategy](images/img-4d5e6f7a8b9c.png)` followed by
the description text), so an LLM consuming only the Markdown still sees the
figure. The embedded copy is a projection of the canonical structured data, never
a competing source of truth.

## What an image carries: a summary, a text flag, and a findable quotation

An image record answers three connected questions, and each has exactly one home:

1. **What is in it?** → `description`, a machine-generated summary. Canonical and
   first-class, so a reader working only from the Markdown still understands the
   figure. There is no separate `summary` field; `description` *is* the summary.
2. **Does it contain text?** → `has_text`, a boolean. It is the *indication*
   only: it says legible text is present, it does not carry that text and is
   never quotable.
3. **What does that text say, exactly?** → **not** a field on the image. When
   `has_text` is true, a producer SHOULD emit a companion **textual**
   representation with `role: "ocr"` and `parent_representation_ref` pointing at
   the image, and anchor a `char_range` `direct_quote` extraction into *that*.
   Only this path yields a verified quotation, because only text has bytes to
   compare.

`ocr_text` on the image remains available as an advisory convenience blob for a
reader that wants a glance at the content. It is **never verified and never
quotable**: it is not the findable quotation, and a surface MUST NOT present it
as one. The companion representation is what makes the text *separately findable*
— it has its own id, its own bytes, its own hash, and its own gate.

To connect the verified text back to a position on the image, the quotation
carries a **secondary `bbox` locator into the image** (§03). That is a
cross-representation locator: advisory, excluded from identity, and — like every
OCR-to-image step — recorded rather than gated.

```json
{ "representation_id": "img-4d5e6f7a8b9c", "role": "image", "media_type": "image/png",
  "path": "…/images/img-4d5e6f7a8b9c.png", "sha256": "sha256:…",
  "description": "Bar note: staging-first migration shows zero downtime.",
  "has_text": true, "dimensions": { "width": 240, "height": 120 } }

{ "representation_id": "rep-1a2b3c4d5e6f", "role": "ocr", "media_type": "text/plain",
  "path": "…/ocr/img-4d5e6f7a8b9c.txt", "sha256": "sha256:…",
  "parent_representation_ref": "img-4d5e6f7a8b9c", "produced_by": "ocr" }

{ "extraction_id": "ext-…", "source_id": "src-…",
  "representation_ref": "rep-1a2b3c4d5e6f", "type": "quote",
  "direct_quote": "Downtime: staging-first = 0s",
  "locator": { "type": "char_range", "representation_ref": "rep-1a2b3c4d5e6f",
               "value": { "start": 0, "end": 28 } },
  "secondary_locators": [
    { "type": "bbox", "representation_ref": "img-4d5e6f7a8b9c", "value": [12, 52, 200, 18],
      "unit": "pixel", "reference": { "width": 240, "height": 120 },
      "conforms_to": "media-frags",
      "quote_hint": { "exact": "Downtime: staging-first = 0s" } } ] }
```

Read that object as two claims of different strength, which §09 requires a
surface to keep visibly apart:

- *"The quotation is exactly what the OCR text says"* — **gated**, badge
  `verified-to-transcript`.
- *"The OCR text is what that region of the image shows"* — **recorded, not
  gated**; the region highlight is an inference and MUST be labelled as one.

## Image regions as extractions

A specific region or reading of an image is an extraction of
`type: "image_region"` whose locator is a `bbox` of `[x, y, w, h]` in **image
pixels, origin top-left**:

```json
{
  "extraction_id": "ext-…",
  "source_id": "src-…",
  "representation_ref": "img-4d5e6f7a8b9c",
  "type": "image_region",
  "text": "Staging-first strategy shows zero downtime.",
  "locator": { "type": "bbox", "representation_ref": "img-4d5e6f7a8b9c", "value": [820, 40, 300, 640] },
  "interpretation": "explicit",
  "confidence": "high"
}
```

A `bbox` is not a gate-bearing locator: the `text` here is an ungated reading, not
a verified quotation. To carry a *verified* quotation of text visible in an image,
extract that text into a textual representation (an `ocr` or `transcript` role
with `parent_representation_ref` to the image) and anchor a `char_range` quote
into it — which lands on the trust boundary below.

## Audio and video

Audiovisual sources are stored as representations with `role: "audio"` or
`"video"`, and their transcripts as `role: "transcript"` (with
`parent_representation_ref` pointing at the media). A transcript is text, so
extractions from it use a `char_range` locator into the transcript; extractions
tied to a moment in the media use a `timestamp_range` locator (seconds, relative
to the media start) into the audio/video representation.

```json
{ "representation_id": "rep-…", "role": "video", "media_type": "video/mp4", "path": ".../media/talk.mp4", "sha256": "…", "duration_seconds": 3612 }
{ "representation_id": "rep-…", "role": "transcript", "media_type": "text/plain", "path": ".../transcripts/talk.txt", "sha256": "…", "parent_representation_ref": "rep-video-id" }
```

## The trust boundary: what "verified" means for non-text media

The quote gate is byte-exact, and bytes only exist for text. So UPC draws an
explicit boundary and never blurs it:

- **Quote → transcript / OCR text is gated.** A `direct_quote` anchored by
  `char_range` into a `transcript`, `ocr`, or other textual representation is
  verified byte-for-byte exactly as in §03. This is a real, deterministic
  guarantee: the quote is exactly what the transcript says.
- **Transcript / OCR → original media is recorded, not gated.** The step from the
  audio/video/scan bytes to the text a model transcribed or OCR'd is
  *inference*, not equality. It is captured as conversion provenance
  (`parent_representation_ref` + `provenance.produced_by.method`, e.g. `ocr`,
  `model`) and MUST be **labeled as such** wherever a quotation from a derived
  text is surfaced. A quote verified against a transcript is "verified to the
  transcript," which is *not* the same claim as "verified to the recording," and
  §09 requires the browser to show that distinction (a distinct badge). Never
  present a transcript-anchored quote as if it were checked against the audio.

This honesty is the point: UPC guarantees exactly what it can compute, and marks
the rest as the inference it is.

## Native PDFs vs web renders

A native PDF is preserved with `role: "document_pdf"` — it is the original, not a
render. A print-to-PDF *of a web page* is `role: "rendered_pdf"`. Keeping these
distinct matters for provenance: one is the source document, the other is a
capture artifact of an HTML source. A PDF's only locator is `page` (an integer,
physical page from 1), which is coarse and non-gating; a verified quotation of PDF
text requires extracting a textual representation (an `ocr` or text layer) and
anchoring a `char_range` into it — again landing on the trust boundary above.
That text layer is **derived text** even when its role is the generic `text`,
because the bytes it came from (the PDF) are not text. A quotation against it is
verified *to the extracted layer*, and §09 requires it to be badged that way; the
step from the PDF's own rendering to those characters is a conversion, not an
equality.

## Thumbnails and derived media

Thumbnails use `role: "thumbnail"` with `parent_representation_ref` to the media
they preview. Any representation produced by extracting/transcoding another SHOULD
set `parent_representation_ref` and a `produced_by` method (the representation's
own `produced_by` field, or `provenance.produced_by.method` on its stamp) so the
derivation is explicit.
