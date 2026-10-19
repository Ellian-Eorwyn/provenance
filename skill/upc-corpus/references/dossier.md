# Dossiers

A dossier answers one question for one group: *what do these documents say that matters
to our project?* Hand it a set of documents, an **audience profile** and a **project
profile**, and it shows, for each document, what the document is, why it is in the file,
what it argues, what it means for each part of the project, and the passages behind every
point. A cover memo then reads across the documents.

It is a projection (spec/09). Everything a reader sees is either the **writer's own words**,
labelled with the writer's name, or a **quotation found in the saved source** character for
character. Nothing else reaches the page.

`scripts/dossier.py` is the one command. The runbook is the SKILL's Task 13.

## The two profiles

Profiles are kept outside any corpus and reused: one per group, one per project. They are
YAML or JSON, and are checked against `profiles/audience.schema.json` and
`profiles/project.schema.json`. `profiles/examples/` has a made-up pair to copy from.

| | Audience | Project |
|---|---|---|
| Says | Who reads it, what they already know, what they look for, how they like to read | What the project is, and the **lenses** relevance is judged against |
| Required | `id`, `kind: audience`, `name`, `readers` (name and role), `wants` | `id`, `kind: project`, `name`, `lenses` (slug, title, description) |
| Also | `organization`, `knows`, `style` (rules, or named facets), `summary_words`, `never_publish`, `updated`, `basis` | `full_name`, `funder`, `agreement`, `period`, `people`, `aims`, `questions`, `out_of_scope`, `terms`, `rules`, `never_publish`, `basis` |

- **Lenses** are usually the project's tasks, plus any cross-cutting concern. A lens's
  `short` is its label on chips and spreadsheet columns.
- **`never_publish`** lists exact phrases (personal matters, internal material) that must
  never appear in anything a build writes. They are matched in any case and any spacing,
  as substrings, so write whole phrases (six characters at least), never fragments.
- **`basis`** says where each field came from (`{field: [{ref, quote}]}`). It is for the
  owner, and is never published.
- Readers are named with their work roles only. A profile is a reading of the owner's notes,
  so the owner reviews it before it is used.

## The objects

| Object | UPC kind | Holds |
|---|---|---|
| An entry, one per document | generation, type `x-dossier-entry` | The writer's summary, notes and questions, and the document's key points, figures, dates, people and positions, terms and cited works, each with a quotation found in the document |
| The cover memo | synthesis, type `x-dossier-brief` | The bottom line; findings and tensions across documents, each resting on quotations; what it means for each lens; next steps; the reading order |
| The config | `<corpus>/.upc/upc-corpus/dossier/dossier.json` (tool state) | Title, who it is for and by, the date, the profiles' paths, the request it answers, the sections, the document order, extra never-publish phrases, and the passage set's `namespace` (recorded at first use, so a moved or copied corpus keeps its set) |

A rewritten entry or memo is a new object. An entry made from the same passages replaces the
old one (`--replace`); a memo supersedes the one before it. `upc validate` gates both through
hop C, like any generation or synthesis.

## An entry

`dossier.py add --from entry.json` takes one JSON object per document. `write` produces the
same shape from the configured model.

```json
{
  "source": "<source_id or alias>",
  "section": "optional; one of the config's section slugs",
  "title": "optional; else the source's title",
  "short_title": "optional; how citations name it, e.g. 'E3 2020'",
  "kind": "report | paper | white-paper | filing | comments | decision | web-page | slides | blog | docket | other",
  "authors": "…", "author_org": "…", "date": "2020-04", "identifier": "CEC-500-…", "license": "CC BY 4.0",
  "suggested_by": {"quote": "the suggester's words about it, from the request source", "by": "optional"},
  "summary": "the writer's words",
  "for_us": "the writer's words: what in it matters most for the project (at most 45 words)",
  "read_this": "which part to read, e.g. 'the executive summary and Figure 2' (at most 14 words)",
  "why_it_matters": [{"lens": "<slug>", "text": "the writer's words"}],
  "relevance": {"<slug>": 0},
  "key_points": [{"text": "the writer's words", "lens": "<slug>", "quote": "the document's words"}],
  "figures":    [{"label": "…", "value": "…", "quote": "…"}],
  "dates":      [{"date": "2024-06", "event": "…", "quote": "…"}],
  "actors":     [{"name": "…", "type": "…", "stance": "the writer's words", "quote": "…"}],
  "terms":      [{"term": "…", "definition": "the writer's words", "quote": "…"}],
  "cites":      [{"ref": "…", "note": "…", "in_corpus": "<source_id or alias, if it is in the dossier>", "quote": "the citing line"}],
  "exhibits":   [{"page": 6, "caption": "…"}],
  "questions":  ["for the team, the writer's words"]
}
```

- **Every `quote`** must be the document's own characters. It is looked for in the saved
  text. A quote that differs only in case, curly marks, dashes or spacing is replaced by the
  document's own characters, and one that occurs twice is widened to the shortest unique
  span. An item whose quotation is not found is **dropped and reported**.
- **`section`** puts the document in one of the groups set with `init --sections` (a JSON
  list of `{slug, title, description}`). Documents are shown section by section, in the
  config's order; a slug the config does not have refuses the entry.
- **`for_us`** is the document's one line on the cover, beside its first page: a finding, a
  case, a number or a gap, not a description. **`read_this`** says how much of it to read.
  Both are optional (the cover falls back to the summary's first sentence); longer than
  their limits, the entry is refused with the word count.
- **`relevance`** runs from 0 (none) through 1 (background) and 2 (useful) to 3 (central).
  Documents at 2 or more show under that lens's filter.
- **`suggested_by.quote`** is looked for in the request source (`init --request-source`).
  It shows as "Why it is in the file".
- **`exhibits`** are pages of the document's PDF, shown as pictures. A page the PDF does not
  have is refused.
- The writer is named with `--writer` ("Claude (Opus 5.5)", "Sam Example"), and the model,
  if a model wrote it, with `--model`. The pages label every summary, note and question with
  the writer's name.
- To show a writer under another name, `init --show-writer-as "Claude (Opus 5.5)=Hermes"`
  (config `writer_labels`; `WRITER=` drops it). Every label, the spreadsheet included, then
  says "Hermes". The records keep the real writer, and only the method notes name both, once:
  "The writer here: Hermes, using Claude (Opus 5.5)." (the Method page and the Word file's
  appendix).

## The memo

`dossier.py brief --from brief.json`:

```json
{
  "title": "At a glance",
  "bottom_line": "one paragraph: the point of the whole file (at most 90 words)",
  "lede": "optional: a longer opening for the memo page",
  "themes":      [{"title": "a finding, as a short statement", "text": "…", "evidence": [{"source": "<id>", "quote": "…"}]}],
  "tensions":    [{"title": "…", "text": "…", "evidence": [{"extraction_id": "ext-…"}]}],
  "for_project": [{"lens": "<slug>", "headline": "one line (at most 24 words)", "text": "…", "evidence": []}],
  "next_steps":  [{"step": "a checkable step (at most 22 words)", "detail": "the rest", "see": "leads"}, "or a plain string"],
  "reading_order": [{"source": "<id>", "why": "…"}]
}
```

- A piece of evidence is a new quotation from a named source, or a passage an entry already
  holds (`extraction_id`).
- A theme or tension with no quotation found is **left out**.
- `for_project` items may stand without evidence: they are the writer's reading.
- **The cover has to fit on one screen**, so its lines have limits, and `brief` refuses a
  memo over them with the count: the bottom line at most 90 words, at most 6 themes (each
  title at most 14 words, since the cover lists them as findings), at most 6 next steps
  (each step at most 22 words; the rest goes in `detail`, which the memo page shows), and
  each lens `headline` at most 24 words. A memo with only a `lede` still builds: the lede
  stands in for the bottom line.
- A step's **`see`** links it to a page (`leads`, `timeline`, `people`, `terms`, `memo`,
  `method`) or a document (its source id or alias).
- The first three documents of `reading_order` show on the cover as "Read first", the rest
  as "Then"; documents outside it follow by section.

## What `build` writes

| File | What it is |
|---|---|
| `index.html` | The cover, made to be read without scrolling on a laptop: who it is for; the bottom line; the findings, each linking to its passages in the memo; the next steps (a note); the request as a routing slip; then the documents in reading order, each with its first page, its line for the project (`for_us`), what to read, and a dot per lens. A lens filter narrows the list and shows that lens's line from the memo |
| `memo.html` | The full memo (paper-clipped, TO/FROM/RE, the request beside it): the bottom line, then each part under a divider tab in its own colour. Findings, tensions (naming the documents that pull apart) and what it means for each lens are cards, readable in full, that open on their passages; next steps are notes with their detail; where to start shows each document's first page and why it comes where it does. The contents list beside it marks the part on screen, and a link to `memo.html#theme-N` opens that finding's passages |
| `docs/NN-<name>.html` | One per document: what matters for the project and what to read, a row of links to its parts with counts, why it is in the file, the summary, "why it matters" notes, key points (each passage one click away), and cards for numbers, dates, who's who, terms and cited works that open on their passage; exhibits, questions, the first page, the facts and the saved copy |
| `timeline.html` | Every date as a card on a year spine, under a bar per year coloured by thread (the config's sections, or the kinds of document); years still ahead of the dossier's date are faded. Once scrolled past, the bar stays at the top as a strip and marks the year in view. Filters by thread and by happened/ahead, a search, and sparse neighbouring years share a row |
| `people.html` | Every person and organization as a card, with spellings of one name joined ("California Energy Commission (CEC)", "CEC"), sorted into groups from the writer's own descriptions (agencies, lawmakers, utilities, local government, researchers, advocates, communities, industry and trades), most-named first. A card opens on each document's position and passage |
| `terms.html` | Every term as a card in one A–Z grid, spellings and plurals joined, with a search and an A–Z rail that stays in view and marks the letter on screen; a card opens on each document's meaning and passage |
| `leads.html` | Every cited work as a card, joined across the documents that cite it: not yet gathered (most-cited first) or in this file (linked). Opens on how each document cites it |
| (cards) | A card opens in one panel with its passage, page and a copy button; ← and → step through the cards shown. Without JavaScript the card opens in place, and print opens every card |
| `method.html` | How it was made, who wrote what, the readers, the lenses, and every document's origin, save date and hash |
| (every page) | A light/dark switch beside the tabs. It follows the reader's system until they choose; the choice is kept in their browser (`upc-dossier-theme`) and applied before the page paints. Print is always light. Pages widen to 1600 px; the extra width goes to columns and cards, while running text stays near 75 characters a line |
| `<name>.docx` | The same content as a Word file (pandoc), with exhibits. It opens "At a glance": the bottom line, the findings, the next steps and a table of the documents with their line for the project |
| `<name>.xlsx` | Sheets for documents (with their line for the project and what to read), key points, numbers, timeline, who's who, terms, leads, next steps, questions and lenses. Every row gives the document, page, quotation and passage id |
| `img/`, `files/` | First pages and exhibits (pdftoppm), and with `--copies` each PDF up to 25 MiB |

The build record is `<out>.build.json`, kept beside the folder and never inside it.

## The checks, in order

1. `upc validate` passes; otherwise nothing is built.
2. Every quotation (entries, memo, request) is found again at its place in the saved text,
   and is the same as the stored passage.
3. The Word file is read back, and every quotation must be in it.
4. No never-publish phrase (from either profile or the config) appears in any page, in the
   Word file or in the spreadsheet.
5. No local path appears (`/Users/`, `/home/`, `file://`, the corpus's own path).

Only then are files written. Files an earlier build made and this one did not are removed.
An unchanged dossier rebuilds the same pages, byte for byte.

## Who decides

| Decision | Who |
|---|---|
| A profile's contents, and its never-publish phrases | The group's or project's owner, after reading the draft |
| Which documents go in, and the order | The person the dossier is for, or whoever asked for it |
| The words in entries and the memo | Their writer, named on every page; the owner reviews before anything is shared |
| Putting a built dossier online | The owner, each time |

Fixity is not authenticity. A dossier shows exactly which words were read and where. It
does not show that they are right.
