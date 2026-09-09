# Crosswalk: UPC → Obsidian vault

An [Obsidian](https://obsidian.md) vault is a folder of Markdown notes with YAML
frontmatter and `[[wikilink]]` cross-references. This crosswalk maps a UPC corpus
onto one, so a corpus can be *read* — by a person skimming, and by a local model
that would otherwise be parsing HTML chrome.

- **Status.** Shipped in 1.7.0. `upc export <corpus> --format obsidian -o <dir>`
  builds a standalone vault; `--into <vault>` writes into an existing vault's inbox.
- **Direction:** export/projection only. The corpus stays canonical; a fact is
  corrected there and re-exported, never edited in the vault (§09). There is no
  importer, and there will not be a useful one: the export is deliberately lossy.
- **Lossy, unlike every other UPC export.** RO-Crate, PROV, CSL-JSON and the CSV
  mirrors are faithful re-encodings. This one throws material away on purpose —
  navigation, running heads, page numbers — because a readable note is the goal and
  that furniture is what makes a converted document unreadable. What it removed is
  counted by class in each note's provenance block.

Legend: **exact** · **partial** · **incompatible** · **UPC-only**.

## Objects to notes

| UPC | Obsidian | Mapping | Notes |
|---|---|---|---|
| source | a note, `type: source` | exact | filed by `source_kind` under the sources root |
| generation | a note, `source_kind: generated` | exact | body is the generation's `output` |
| synthesis | a note, `source_kind: generated` | exact | `claims[]` become a `## Claims` list |
| codebook | a note, `type: system` | exact | one `##` per code, so a chip can link to its definition |
| representation (textual) | the note's **body** | partial | one representation is chosen; the rest are listed, not inlined |
| representation (image) | an attachment + `![[embed]]` | exact | copied into the vault's image folder |
| representation (other) | named in the provenance block | partial | bytes stay in the corpus |
| extraction, gated | a line in `> [!evidence]` | partial | carries its §09 badge and a locator footnote |
| extraction, ungated | a bullet under `## Extractions` | exact | plain prose — never a quotation (see Cautions) |
| coding | a code chip beside its target | exact | always with its coder; disagreement shown both ways |
| corpus | the vault itself + a generated schema note | partial | `corpus_id` and spec version recorded in every note |

## Fields to frontmatter

The vault's approved property set is small on purpose, and UPC does not extend it
by default: anything without an approved home goes in the provenance block, which
is a *documented* place for it rather than a private key a query will never find.

| UPC | Frontmatter | Mapping | Notes |
|---|---|---|---|
| `bibliographic.item_type` | `source_kind` | partial | via the profile's `by_item_type` table |
| `bibliographic.authors[]` | `people[]` | partial | rendered as wikilinks; `literal` wins so a corporate author is not split |
| `bibliographic.issued` | `date` | partial | `YYYY-MM-DD`; a year-only date is filled to Jan 1, which is what the vault stores |
| `bibliographic.publisher` | `organization` | partial | wikilink |
| `bibliographic.title` | the note's `# Title` and filename | exact | sanitised for wikilink-safety, never truncated silently |
| `bibliographic.abstract` | `> [!summary]` | exact | omitted entirely when absent — never invented |
| `retrieval.original_url` | `## Sources` bullet + provenance | exact | the URL appears once, where a reader looks for it |
| `identifiers[]` | provenance block | exact | DOI/ISBN/… as `SCHEME: value` |
| `relations[]` | `> [!connections]-` | exact | resolved to a wikilink when the target is in the corpus |
| `source_id` / `corpus_id` | provenance block | exact | `--frontmatter extended` also puts them in frontmatter |
| `sha256`, `char_count`, `input_digest` | provenance block | partial | digests are shown at 12 hex, enough to match against the corpus |
| every gate, id recipe and locator | — | **incompatible** | see Cautions |

## Cautions (do not over-map by wording)

- **A note is not evidence, and the vault is not the gate.** A quotation in an
  exported note is accompanied by its badge and a footnote naming the
  representation and codepoint range it was checked against — but the check itself
  happened in the corpus. Nothing in the vault can be re-verified from the vault:
  the body has been stripped, so its offsets are no longer the corpus's offsets.
  This is why the footnote names the representation rather than the note.
- **`verified` in a note means exactly what §09 means by it, no more.** A quotation
  against an OCR text or a transcript is badged *verified to the derived text*, and
  a reader must not read that as checked against the recording or the scan.
- **A paraphrase is not a quotation, and the export keeps them physically apart.**
  §09 forbids rendering an ungated `text` extraction in quotation marks or a
  blockquote — and an Obsidian callout *is* a blockquote — so ungated readings live
  under a plain `## Extractions` heading and never inside the evidence callout.
- **A `bbox` region is an inference.** An image-region reading is labelled
  "recorded not gated" wherever it appears. The export draws no overlays, so it
  cannot imply a verified position on a picture.
- **`ocr_text` is never rendered as a quotation.** §05 makes it an advisory blob;
  the note points at the companion `ocr` representation's gated extraction instead.
- **The frontmatter is not the provenance record.** It carries what the vault can
  *query*; the corpus carries what is *true*. Do not reconstruct a corpus from
  frontmatter — that is what `--format jsonl` and `--format ro-crate` are for.
- **A missing property means "not recorded", not "empty".** Empty strings, empty
  lists and nulls are dropped rather than emitted, because a property that is always
  present but always blank is a filter that silently matches nothing.

## What the export will not do

- It will not write into an owner-authored `## Notes` section, or read one back.
- It will not overwrite a note a person has edited since it was written; the
  conflict is reported and the file is left alone.
- It will not guess a `domain` when writing into someone's existing vault. An
  unclassifiable note waits in the inbox at `status: raw`, which is that vault's
  own documented answer, rather than being filed somewhere plausible.
- It will not invent a callout type outside the profile's registry, emit inline
  HTML, or write a literal colour.
