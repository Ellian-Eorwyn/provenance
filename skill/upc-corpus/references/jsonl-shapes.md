# The shapes that flow into `upc`

Every stage is JSON on stdin, JSON on stdout. Nothing here needs a library.

## Ingest config (`ingest.py --config`)

```json
{
  "corpus": "/abs/path/Corpora/library-upc",
  "corpus_id": "0123456789ab",
  "title": "Socio-technical transitions: the literature",
  "manifest": "/abs/path/corpus_manifest.csv",
  "pdf_dir": "/abs/path/PDFs",
  "namespace": "lib",
  "columns": {
    "id": "id", "title": "title", "authors": "first_author", "year": "year",
    "doi": "doi", "filename": "pdf_filename", "status": "status", "note": "source"
  }
}
```

`columns` maps *this manifest's* headers onto the fields the script needs, so a
differently-shaped spreadsheet needs no code change. `authors` may hold several
names separated by `;`, each `Family, Given`.

## `upc add source --batch` (one JSON object per line)

```json
{"slug":"s0001-geels-2017","title":"Reviewing the socio-technical dynamics of low-carbon transitions",
 "source_kind":"document",
 "bibliographic":{"item_type":"article-journal","title":"…",
   "authors":[{"family":"Geels","given":"F."}],
   "issued":{"date_parts":[[2017]]},"doi":"10.1016/j.joule.2017.09.018",
   "container_title":"Joule"},
 "field_evidence":{"doi":{"value":"10.1016/…","origin":"user_provided",
   "evidence":"corpus_manifest.csv; confirmed in the document text","confidence":0.95}},
 "identifiers":[{"scheme":"doi","value":"10.1016/j.joule.2017.09.018"}],
 "aliases":{"lib":"s0001"},
 "files":[
   {"path":"/abs/PDFs/s0001_….pdf","role":"document_pdf","media_type":"application/pdf",
    "produced_by":"import","page_count":18},
   {"path":"/abs/text/s0001.txt","role":"text","media_type":"text/plain",
    "produced_by":"conversion","parent":0}],
 "provenance":{"produced_by":{"tool":"upc-corpus","tool_version":"1.0.0","method":"import"},
   "created_at":"2026-09-09T00:00:00Z"}}
```

`files[].parent` is an **index into `files`**, so the text can point at the PDF
it came from without knowing any id yet.

Note `field_evidence.<field>.confidence` is a **score between 0 and 1**, not the
`high`/`medium`/`low` enum used on extractions and codings. Two different fields
that happen to share a name.

## `upc anchor --normalize` (candidates in)

```json
{"quote":"the exact span the model believes is in the document",
 "type":"passage","note":"why it matters","confidence":"high"}
```

Out, one result per input line, in the same order:

```json
{"i":0,"status":"anchored","extraction_id":"ext-…","char_range":{"start":812,"end":947}}
{"i":1,"status":"refound","extraction_id":"ext-…","rules":["quotes","initial-case"],
 "stored_quote":"what the document actually says"}
{"i":2,"status":"not_found","quote":"…","candidates":0}
{"i":3,"status":"ambiguous","quote":"…","candidates":2}
```

`anchored` and `refound` both produced a real, gated passage. `not_found` and
`ambiguous` wrote nothing — never treat them as passages.

## `upc code` (judgements in)

```json
{"codebook_ref":"cbk-d43216260ce6","code":"mlp",
 "target":{"kind":"extraction","id":"ext-…"},
 "coder":"lib-model-v1","confidence":"high","confidence_score":0.9,
 "rationale":"≤20 words","query":"the question that drove this pass"}
```

For a judgement about a whole paper, `"target":{"kind":"source","id":"src-…"}`.
For an open codebook, send `"value":"free text"` instead of `"code"`.

Out: `{"i":0,"status":"coded","coding_id":"cod-…"}`, or `unchanged` when the same
coder had already said the same thing, or `superseded` when they changed their
mind, or `error` with a reason.

## `upc add synthesis` (overview in)

```json
{"type":"thematic","title":"Multi-level perspective — overview",
 "question":"the code's definition",
 "claims":[{"claim_id":"cl-0001","text":"what the overview asserts",
            "evidence_ids":["ext-…","ext-…"]}]}
```

The prose itself is a separate `--output <file.md>`. It must:

- quote only in the marker grammar `"exact text" [ext-…]`;
- paraphrase with a bare `[ext-…]` and no quotation marks;
- name every source id its claims rest on, which is what a `## Sources` list is for.

`upc add synthesis` refuses and writes nothing if a quotation does not match, or
if a cited source is never named.

## `upc batch` (many read-only calls, one corpus load)

`locate` walks the whole corpus each time it runs, so shelling out once per
passage is quadratic. Batch them instead. The id field is **`ext`**, not `id`:

```
{"cmd":"verify","ext":"ext-979053746723"}
{"cmd":"quote","ext":"ext-979053746723"}
{"cmd":"locate","ext":"ext-979053746723","context":200}
{"cmd":"codebook","id":"cbk-…"}
```

Out, one line per command, in order:

```json
{"i":0,"cmd":"verify","result":{"hopA":"pass","hopB":"pass","verified":true}}
{"i":1,"cmd":"quote","result":{"marker":"\"…the exact text…\" [ext-979053746723]"}}
```

The `marker` string is what you paste into an answer. Copy it whole; do not
retype the text inside it.

## Model output the coding pass expects

```json
{"passages":[
  {"quote":"verbatim span, 24–380 characters",
   "codes":[{"codebook":"theory","code":"mlp"},
            {"codebook":"analytical-dimension","code":"power"}],
   "rationale":"≤20 words","confidence":"high"}]}
```

One passage carries codes from **several** codebooks. That is what makes a
theory × dimension table possible; asking one codebook at a time produces
passages with a single code each and every cell of the table comes out empty.

## A literature-extraction bundle (`import_bundle.py --bundle`)

Written by `literature-extraction.py export-bundle`; format
`literature-extraction-bundle/1`. A folder:

```
bundle.json      {"format", "name", "sourcesOnly", "input": {"root", "exclude"},
                  "run": {"directory", "itemTypes": [{"type", "definition"}],
                          "researchFocus", "promptVersion"} | null,
                  "counts": {...}, "duplicates": [{"path", "sameAs"}]}
sources.jsonl    one per document: documentId, title, authors [{family, given?}],
                 authorsFrom, year, yearFrom, yearNote, url (http(s) only),
                 sourceType, role, originalPath, originalSha256, originalMediaType,
                 text ("text/<file>.txt"), textSha256, chars,
                 pages [[offset, label]], sections [[offset, heading]],
                 status, items, model
text/<file>.txt  the reading copy: the body as the extraction model read it
                 (header removed, columns re-flowed, running heads removed),
                 page markers and form feeds turned into line breaks
items.jsonl      one per item: itemId (i######), documentId, itemType, text,
                 directQuotes, interpretation, confidence, locator, notes,
                 span (the reading copy's own characters), spanStart,
                 occurrences, widenedBy, notResolved (why it cannot be placed)
```

How it maps onto UPC:

| Bundle | UPC |
|---|---|
| a document | a source; `files` = [reading copy (role `text`, produced_by `conversion`, `parent: 1`), original (role `markdown` or `text`, produced_by `import`)]; alias `{namespace: documentId}`; `ext.literature-extraction` records bundle, run and status |
| title, authors, year, url | `bibliographic` (url only there: a top-level url would set the source's id), with `field_evidence` saying whether each came from the header or the file name |
| an item with `span` and `occurrences == 1` | a passage via `upc anchor --normalize --rep <reading copy> --set exs-le-<name>[-NNN]`: `quote` = span, `text` = the paraphrase, `interpretation`, `confidence`; type claim/finding/method/limitation/definition kept, quoted_evidence → `quote`, others → `evidence` |
| the item's own type | a coding in codebook `item-type` (multi-label), coder `le-<name>`, rationale = the paraphrase |
| `pages`, `sections` | `secondary_locators` of type `page` (whole numbers ≥ 1 only) and `section`, each naming its representation |

The reading copy goes first because the site shows the first text copy and
highlights passages by exact match in it. A source's id is therefore a hash of
its reading copy, so a document whose reading copy changed since it was
imported is refused (import the new bundle into a new corpus).
