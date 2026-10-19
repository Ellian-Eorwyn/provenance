# Changelog

All notable changes to the Universal Provenance Corpus (UPC) standard.
Versioning is semantic (§00 Versioning policy).

## Unreleased — toolkit 1.2.0: one-pagers

**No schema or specification change.** Corpora and the site are as in 1.15.1. The new objects
use the `x-` extension point.

### Fixed

- **`upc code` going back to an earlier answer.** A coding's id is its content (codebook,
  target, coder, code), so a coder who answers lead, then avoid, then lead again gives the
  first coding's id a second time. `code` revived it as active but left the avoid answer
  active too, so a closed, single-label codebook held two live answers from one coder. The
  revived coding now supersedes the answer it replaces (the result says `revived: true` and
  names it), and the run is logged like any other change.
- **`upc validate` and coded corpora.** `upc code` records the ids of the codings it writes
  in its journal event, but the journal check knew only sources, representations,
  extractions, generations and syntheses, so every coding run left an `event_dangling_ref`
  warning per coding (66 for one page's figures). It now knows codings and codebooks too.

### Added

- **One-pagers** (`skill/upc-corpus/scripts/onepager.py`, `references/one-pager.md`): one
  printable page for one audience, from the same audience and project profiles a dossier
  uses, where every number on the page is a figure whose passage is stored in the corpus.
  - **Figures** are `data_point` extractions with a register beside them (label, value, the
    forms a page may print it in, readings with a tolerance, a rule for a derived one). A
    value not in its passage is refused; readers who disagree, a thin derived margin and a
    rounded display form are flagged.
  - **What a figure is, and who may see it, are codings** in closed codebooks: relevance to
    each audience (lead, support, background, avoid; one codebook per audience), class,
    a reviewer's check and its release. A person's answer outranks a model's; every
    answer stays visible.
  - **A page** is an `x-one-pager` synthesis, gated by hop C; a revision supersedes the last
    and records the wording changes.
  - One command: `init`, `figures add|import|list`, `code` and `write` (the configured local
    model), `review` (a sheet out and back), `signoff`, `add`, `build` and `check`.
  - `build` writes the page (HTML with everything embedded, and a US Letter PDF through a
    Playwright already installed) and the **figures note** (Markdown and Word): every number,
    its passage, readings, checks, release, and the questions still open. It refuses a final
    page with an unconfirmed, irrelevant or (for partners and the public) uncleared figure,
    a number that is not one of its figures, a never-publish phrase, a local path, a voice
    quotation without recorded consent, or a PDF longer than one page. `--draft` builds
    anyway, stamped, and lists what is open. An unchanged page rebuilds to the same bytes.
  - Charts plot figures only, with an optional dashed line at a figure's value (a target);
    the numbers behind the hero chart are a table in "About the data". Steps are a drawn
    flow, and a numbered list on a phone.
- `references/profiles/one-pager.schema.json`: the optional fields a one-pager reads from
  the dossier profiles (what readers decide, their objections and numbers, the layout, the
  ask, how far the page travels; the project's brand, images, reviewers and own numbers).
- `assets/one-pager/`: the page's stylesheet and an embedded OFL font (Figtree).

## Unreleased — toolkit 1.1.0: dossiers

**No schema or specification change.** Corpora and the site are as in 1.15.1; the CLI
gains one option. The new objects use the `x-` extension point.

### Fixed

- **`upc anchor` on a shared representation.** When one document is saved as two sources
  (two PDFs of one paper whose text is identical), their reading copies are one
  representation (spec/08 rule 1.1, `representation_shared`). `anchor` attached every
  passage to whichever source loaded last, so a generation written about the other copy
  was refused for quoting another source. `--source <src-id>` now names the source the
  passages belong to (a source that does not record the representation is refused), and
  without it the result carries a `warning` naming every holder. `dossier.py` and
  `code_pass.py` pass `--source`.

### Added

- **Dossiers** (`skill/upc-corpus/scripts/dossier.py`, `references/dossier.md`, the
  SKILL's Task 13): what a set of documents says that matters to one project, written for
  one audience. Each document gets an `x-dossier-entry` generation: the writer's summary,
  notes per lens and questions, labelled with the writer's name, plus key points, figures,
  dates, people and positions, terms and cited works, each resting on a quotation that
  `upc anchor` found in the saved source. A quotation it cannot find is dropped and
  reported. The cover memo is an `x-dossier-brief` synthesis, gated by hop C.
  - One command: `init`, `add` (an entry written by a person or any model), `write` (the
    configured local model), `brief`, `build` and `check`.
  - `build` writes a site styled as a dossier (folders, tabs, a paper-clipped memo, notes,
    exhibits), a Word file (pandoc) and a spreadsheet (openpyxl). It refuses a corpus that
    does not validate. It also refuses if a quotation is not found again or is missing from
    the Word file, if a never-publish phrase would appear, or if a local path would.
  - Every page puts what matters at a glance and the detail one click away. The cover fits on
    one laptop screen: the bottom line, the findings (each opening its passages in the memo),
    the next steps, and the documents in reading order, each with its first page, one line
    on what matters for the project, what to read, and a dot per lens, filterable by lens.
    The memo has its own page, each part under a divider tab in its own colour: findings,
    tensions (naming the documents that pull apart) and lenses as cards that open on their
    passages, next steps as notes, and the reading order with each document's first page;
    its contents list marks the part on screen, and a link to a finding opens it. The
    timeline is a year spine of cards under a bar per year, which stays at the top as a
    strip once scrolled past and marks the year in view. Who's who, terms and leads are
    cards with spellings of one name joined (a term and its plural too), filters that wrap
    and a search; terms keep an A–Z rail in view. A card opens its passage in one panel.
    Pages widen to 1600 px, the width going to columns while lines of text stay near 75
    characters. Small labels take their digits from a plain monospace where one is
    installed, since the typewriter face's small 5 reads as a 6.
  - The cover's lines have word limits, which `add` and `brief` enforce: an entry's `for_us`
    (45) and `read_this` (14); the memo's `bottom_line` (90), at most 6 themes (titles 14) and
    6 next steps (each 22, the rest in `detail`), and each lens `headline` (24). A next step
    can link to a page or a document (`see`).
  - Every page has a light/dark switch. It follows the system until the reader chooses, and
    the choice carries across pages. Print is always light.
  - `init --show-writer-as WRITER=LABEL` shows a writer under another name on the pages, the
    Word file and the spreadsheet. The records keep the real writer, and the method notes name
    both.
  - The passage set's namespace is recorded in the config at first use, so a corpus that is
    moved or copied keeps its set instead of starting a new one under its new folder name.
- **Audience and project profiles** (`references/profiles/`): JSON Schemas, a made-up
  example of each, and a small built-in checker. Profiles live with their owner and are
  reused across dossiers. A project's lenses are what relevance is judged against.
- `requirements.txt`: `pyyaml` for profiles written as YAML. pandoc and pdftoppm are
  optional, for the Word file and pictures.
- Tests: `tests/test_dossier.py` (26, no model server), and five selftests for `anchor --source`.

## 1.15.1 — 2026-10-06

**Patch release: the upc-corpus toolkit joins the repository.** No schema or
specification change; corpora, the CLI and the site are as in 1.15.0.

### Added

- **`skill/upc-corpus/`**, a Python toolkit (3.11+, `requests`, `numpy`,
  `openpyxl`) that builds, codes, rates and publishes UPC corpora with local
  language models, driving `upc` for every write. It finds the CLI beside it, in
  `skill/universal-provenance/`.
  - In: PDFs and a manifest (`ingest.py`), Markdown bundles (`import_bundle.py`),
    fetched material with its retrieval record (`add_acquired.py`), spreadsheets
    (`tables.py`).
  - Coding, screening, search, spot-checks and overviews (`code_pass.py`,
    `screen.py`, `embed.py`, `search.py`, `spotcheck.py`, `synthesize.py`).
  - Evidence ratings (`appraise.py`): a grade per paper from one of five
    appraisal profiles, passage labels, and a check of every overview statement
    against its passages, three runs with a majority vote; every yes or partly
    needs a quotation the CLI finds in the paper. Agreement run to run and against
    a blind second coder. Citation standing beside the grade, never combined
    (`citations.py`). The rubric and its sources are in
    `references/appraisal/`.
  - Overviews revised from rated evidence, with claim groups (`synthesize.py
    --v2`, `claim_groups.py`, `references/criteria-v2.md`), a Methods page
    (`methods.py`), and site builds compared with what is published
    (`publish.py`, `compare_site.py --content`).
  - Settings: a machine config (model servers, a server pool, an optional notice
    command) and per-corpus settings (namespace, coders, the team's setting, the
    audience), in `references/settings.md`.
  - Tests: `python3 -m unittest discover -s skill/upc-corpus/tests`, with no model
    server needed.

## 1.15.0 — 2026-10-05

**Minor release: ratings of the evidence, kept apart from the themes, and revised
overviews.** One enum value is added (coder kind `rule`) and two optional fields
(a synthesis's `supersedes` / `superseded_by`), so a 1.14 corpus is a valid 1.15
corpus and is rendered exactly as before: a 179-paper library rebuilt with
1.15.0 shows 0 changed and 0 added against its 1.14.2 build.

### Added

- **Coder kind `rule`** (spec/12, `schemas/coding-set.schema.json`): a
  deterministic procedure, such as a citation tier, which no model or person
  judged. `upc code --coder-kind rule`. A chip's tooltip names the kind ("a
  rule", "a vote of model runs"), and the visible coder note mentions rules.
- **Revising a synthesis** (spec/04, spec/07): `upc add synthesis --supersedes
  <syn-id>` refuses an unknown id, records `supersedes`, and writes
  `superseded_by` into the old synthesis. Neither field is in the id recipe. The
  validator reports a link that resolves to nothing, or to itself, as
  `dangling_synthesis`. When only fields outside the id recipe changed (a claim's
  `ext`, such as a support matrix's verdict labels), the new synthesis has the old
  one's id: it is rewritten in place and `supersedes` is left out, rather than
  written as a synthesis that supersedes itself.
- **Hidden extraction sets** (spec/09 req. 10): `upc anchor --set <id> --hidden`
  marks the set's manifest `ext["upc-site"].hidden`; its quotations are checked
  like any other but never listed as passages. A set already holding listed
  passages can't be made hidden.
- **The reader's site** (spec/09 req. 9–14):
  - evidence schemes (`ext["upc-site"].group: "evidence"`): their own section on
    Codes, "Evidence ratings (advisory)"; not counted on Home; last and closed in
    the filters; chips only on a paper's page and in an opened passage; an "About
    the paper" filter group from source-level evidence codes; `facet: false`
    keeps a scheme out of the filters;
  - cards about a paper: a generation with `ext["upc-site"].card` shows, folded,
    on its paper's page;
  - revisions: the newest overview in a chain at the first one's address, with
    its label and date, and a link to the previous version given
    `--original-edition <url>`;
  - statement support: an `evidence_matrix` derived from an overview joins its
    claims table as columns behind "Show support for each statement" (off by
    default);
  - `--about <md>`: a Methods page and a nav item;
  - **findings** (spec/09 req. 15): a Findings page with filters and the
    corpus's starting points (`--findings <json>`: `starting_points` with a
    `match` on groups, themes, kinds, places or support; `words`; `map_place`),
    an Evidence map, a Key findings box above each rated overview, and "What
    this paper contributes" first on a paper's page. Support in four plain
    words, the IPCC term on hover; the support table's columns are now
    "Support" and "Studies agreeing". `[view:findings]`, `[view:evidence]` and
    `[view:methods]` link to them. With findings, the nav leads with Findings,
    Evidence map and Overviews.
  - a paper's evidence chips: two coders giving the same code make one chip
    whose tooltip names both (different codes still get a chip each).
  Both shapes (folder and single file) and the light file render all of these.
  Evidence chips are drawn as outlines, so a rating never looks like a theme.
- **Overview markdown** gains `**strong**` and `[text](https://…)` links (rating cards and
  Methods pages use them). No overview written before used either, so nothing
  already published renders differently.

## 1.14.2 — 2026-10-05

**Patch release: passages in context.** No schema, vocabulary, id recipe, gate or
spec requirement changed; context is read from the representation bytes at build
time, as spec/09 already requires.

### Added

- **A passage opens to the sentences around it.** Clicking a quotation (or Enter
  or Space on it) shows it **In context**: whole sentences before and after it,
  at most about 1,600 characters, the passage marked, with "See in original,
  p. N ↗" and a note that the text is the one extracted from the PDF. Opening
  another passage closes the open one, keeping the one clicked where it was;
  Escape closes it. Print shows passages closed.
- **How a window is drawn** (`scripts/context.mjs`, new). A reading copy's
  blank-line blocks are classed as prose, headings, captions, footnotes, labels,
  noise or end matter. From the passage outwards, prose blocks join into one run;
  captions, footnotes and figure labels between them are skipped, so a sentence
  broken by a footnote reads whole. Sentences are split with abbreviations,
  initials, section numbers and bullets in mind, and added before and after in
  turn until the cap. A heading ends the window on its side — including one glued
  to a paragraph by the PDF's text layer ("4.1. Politics and power To elaborate
  …"), a section number left at a paragraph's end with its title in the next
  block, and a footnote set inline ("34 In 2017 Volvo …"); a numbered list item
  is text and does not. Front matter before the abstract and end matter
  (references, declarations, CRediT) are never context. "…" marks a window that
  starts or ends mid-sentence. Nothing is rewritten: a window is ranges of the
  stored text, joined by a space.
- Windows are drawn only around a quotation this build has just verified, and
  only offered when they add at least 40 characters: a passage that already is
  its whole paragraph does not offer to expand.
- **Where the sentences travel.** The folder site writes one
  `data/ctx/<paper>.js` per paper, loaded by `<script src>` on the first click
  (so it works opened from disk); the browse data only flags which passages have
  a window (`w`). The single file carries each window as ranges of the paper's
  text it already embeds (`cw`, UTF-16), joined in the browser exactly as at
  build time; the light file, which has no texts, carries the window text (`cx`).
  The code pages' no-JavaScript lists show each window open.
- From the light file, which has no texts to highlight in, "line N →" opens the
  passage's card in context instead.

On a library of 3,239 passages from 179 papers, 3,233 passages offer a window,
median 1,517 characters. Of 60 windows read by hand, weighted to the hard cases
(a line per block, characters outside the Basic Multilingual Plane, windows cut
by a heading, windows over several blocks), 48 were clean, 8 carried an artefact
of the extracted text (an equation, a running header, a table row) and 4 were not
usable (a jump in the extraction, a table, figure text). Sizes: the folder site's
`data/ctx` 5.0 MB over 179 files, `data/browse.js` 2.0 MB (+19 KB), the code
pages +5.6 MB (their no-JavaScript lists), the single file 19.8 → 19.9 MB, the
light file 2.8 → 7.7 MB.

## 1.14.1 — 2026-10-05

**Patch release: the reader's site.** No schema, vocabulary, id recipe, gate or
spec requirement changed.

### Changed

- A passage's link to its original reads **"See in original, p. 14 ↗"**, and on
  hover says it opens the PDF at its 14th page and that the page number printed
  on the paper may differ. Without the PDFs it opens the publisher's page by DOI
  ("See in original (publisher) ↗", the PDF page on hover); with neither, the
  bare "p. 14".
- **"line N →" opens the passage where it sits in the paper's text**
  (`#text=<id>`; `?text=<id>` in the single file), not its own card.
- **Highlights in a paper's text follow the record.** Once this build has
  verified a passage, its stored position is highlighted, so a sentence a paper
  repeats is marked where the passage is rather than at its first occurrence. A
  quotation that runs over a paragraph break is highlighted in each paragraph
  (only the first piece is the link target). The single file carries each
  verified passage's position in UTF-16 units (`o`), which is how a browser
  indexes the text.
- **Matrix numbers are links:** the row's code, with the column's code already
  ticked (`codes/<scheme>/<code>.html#with=<scheme>:<code>`). A scheme the page
  leaves out narrows the list instead, and the sidebar says so.
- **The browse data no longer carries 320 characters of context each side of
  every passage,** which no view showed. On a 179-paper library the folder's
  `data/browse.js` goes from 4.1 to 2.0 MB, the single file from 21.8 to 19.8 MB
  and the light file from 5.0 to 2.8 MB. The no-JavaScript fallback on code pages
  still shows context, from the corpus itself.

### Fixed

- Codes drawn by the browse engine on a quotation that failed its check were
  not struck through, as the server-built pages strike them.
- The links at the end of a passage card now sit right and wrap together
  (`.spacer` had no style outside the page header).
- A code page's lede ended in two periods.
- PDF names in the browse engine's links are encoded whole
  (`encodeURIComponent`), so a `#` or `?` in a file name no longer breaks them.

## 1.14.0 — 2026-09-29

**Minor release: `upc add generation`.** Producers can now write single-source
derived material through the CLI, as they already could syntheses. No schema,
vocabulary, id recipe or gate changed.

### Added

- `upc add generation --corpus <dir> [--output <file>] [--replace] < generation.json`
  (spec/04): one source's summary, note, rating or catalog entry. Runs hop C
  over the output; refuses any quotation or extraction from another source
  (that is a synthesis); records the representation read and sets
  `input_digest` to its hash, so the validator's staleness check applies;
  mints the `gen-` id; writes `<source>/generated/<gen-id>.json` beside the
  output; journals a `generate` event. The same inputs with a different output
  are refused unless `--replace`. Inline `output.value` needs no file.
  First user: Hermes's digest cards (one summary and pull quote per article).

## 1.13.1 — 2026-09-10

**Patch release: a fix to the reader's site.** No schema, vocabulary, id recipe,
gate or spec requirement changed.

### Fixed

- On the folder site's source pages, a passage's "page N" never opened the
  original PDF: it was folded into the link to the passage in the reading copy,
  while the same passage on the passages page opened the PDF at that page. Source
  pages are rendered by a separate server-side template that never learned the
  PDF link. Now "line N →" opens the passage in the reading copy and "page N ↗"
  opens the PDF at that page whenever the PDFs travel with the site (`--bundle`);
  without them the page number is plain text.
- A source page's "open the PDF" link was printed even when the PDFs were not
  bundled, pointing at a folder that did not exist. It now appears only when there
  is a PDF to open.

## 1.13.0 — 2026-09-10

**Backward-compatible minor release: the home summary comes first.** No schema,
vocabulary, id recipe or gate changed; schema `$id`s stay at `1.8.0`. One
projection rule is relaxed (a minor change under §00).

### Changed — the home summary no longer opens with a paragraph about itself (spec/09)

- The card led with a note: who wrote the summary and when, from what, and that
  its sentences — unlike its quotations — were not checked. At the publisher's
  request it is gone, so the summary is what a reader meets first. Who wrote it
  and what it rests on stay in its record (`produced_by`, `derived_from`), which
  the verification browser shows; spec/09 requirement 8 makes stating them on the
  page a MAY. A summary edited after its quotations were checked still says so on
  the card.
- The summary card takes the page's full width, like the other cards on Home.

### Fixed

- On the folder site, Home could not be reached from the matrix page. Pages at
  the top level linked Home as an empty address, which a browser reads as "this
  page"; pages one folder down got `../` and worked, which is why only the matrix
  misbehaved. Home now links to `index.html` from every page.

## 1.12.0 — 2026-09-10

**Backward-compatible (additive) minor release: a summary on the home page.** No
schema, vocabulary, id recipe or gate changed; schema `$id`s stay at `1.8.0`. A
1.11 site export would list a placed summary among the overviews.

### Added — a placed summary, and links that survive a rebuild

- A synthesis whose `ext["upc-site"].placement` is `"home"` is shown at the top of
  the site's home page, in both shapes, under a line that says who wrote it and
  when, from how many passages and papers, and that its own sentences — unlike
  its quotations — were not checked. It is never listed or counted among the
  overviews, its reference list folds away, and exports report which summary they
  showed and how many were placed (spec/09 requirement 8).
- `[theme:<codebook>/<code>]` in overview or summary prose names a theme, links it
  to that theme's *current* overview and states live counts ("528 passages from
  120 papers"). Overview ids are content hashes, so a link by id would break the
  next time an overview was written; a link by theme cannot, and no count is ever
  typed into prose to go stale. `[view:<name>]` links one of the site's views.
  `upc add synthesis` refuses a theme link to a code that does not exist.
- `upc add synthesis` merges a caller's `derived_from` with the one it derives,
  where the caller's used to *replace* it — so a summary can record the overviews
  it drew on without losing its passages and papers. A named synthesis that does
  not exist is refused.

### Fixed — quotations and counts in prose

- A quotation containing an apostrophe or an ampersand was never recognised in
  overview prose: escaping turned those characters into entities and the pattern
  stopped at the first `&`, so the quotation showed as plain text, unlinked,
  without its check mark. It now runs to the closing quote, with the gate's own
  spacing rule.
- A check mark on a quotation in prose now means what it says: the quoted words
  are compared with the passage they cite each time the page is built, and a
  mismatch shows ⚠ "Doesn't match the passage it cites". Before, ✓ said only that
  the passage matched its paper.
- Counts beside a code say what they count — "528 passages from 120 papers, plus 3
  papers coded as a whole" — where code pages printed one number that mixed papers
  with coded passages and papers coded as a whole (spec/09).

## 1.11.0 — 2026-09-10

**Backward-compatible (additive) minor release: overviews readable, codes
uncluttered.** No schema, vocabulary, id recipe or gate changed; schema `$id`s
stay at `1.8.0`. One projection rule is relaxed, for the reader's site only.

### Fixed — an overview's list of papers rendered as one line

Every overview ends with the papers it drew on, written as a markdown list. Both
shapes of the site rendered overview text with their own small converter that
knew paragraphs and headings but not lists, so the list ran together into one
block — raw source ids in backticks, and each paper's citation repeated once per
passage. Found on the hosted site. There is now one renderer,
`renderOverviewMarkdown`, run at build time for both shapes; the single file
carries its output instead of raw markdown, so the two cannot disagree again.
Lists render as lists, a source id becomes a link to its paper, a paper's
passages become small numbered links, and adjacent citations in prose are
separated. Everything is escaped before any rule applies.

### Changed — who made a code moves into its tooltip (spec/09, site only)

Every chip printed its coder's handle ("project-27b-v1 (model)"): identical on every
chip of a single-coder corpus, and meaningless to a reader of the literature. The
site now carries the coder — with the confidence and the rationale — in the
chip's tooltip, and every view that shows codes says once, visibly, what kind of
coder made them ("Codes were assigned by a language model"). spec/09's
requirement 5 for the reader's site gains exactly this relaxation. The guarantee
the rule exists for — a model's judgement never passes for a fact — is kept; only
its placement moves. The verification browser still prints the coder.

## 1.10.0 — 2026-09-10

**Backward-compatible (additive) minor release: the library becomes browsable.**
No schema, vocabulary, id recipe or gate changed; schema `$id`s stay at `1.8.0`.

### Fixed — a source the index did not name could never be adopted

`loadCorpus` read `corpus.sources` **instead of** scanning the sources directory,
which made the index self-perpetuating: a source written by any other tool was
invisible, `regen` rebuilt the index from the same short list it had just failed
to extend, and `validate` then reported the new directory as an orphan
(`manifest_source_unlisted`) that no amount of regenerating could fix. The index
and the directory are now unioned, exactly as syntheses have been since 1.9.0 —
corpus.json is machine-owned and regenerable (§01), so the objects on disk are
the truth and the index is only an ordering hint. Found by adding one corrected
paper to a finished 178-paper corpus.

### Changed — how a reader narrows three thousand passages

Both shapes of `upc export --format site` now browse the same way, from one
shared engine:

- **A sidebar of checkable codes** replaces the row of dropdowns. Ticks inside
  one scheme widen the set, ticks across two narrow it, and each code's count is
  computed *ignoring its own scheme's ticks* — otherwise every unchecked sibling
  reads zero and the reader cannot see what else is there. The scheme covering
  most of the list is first and open.
- **The list is built as it is scrolled**, thirty at a time. Filtering runs over
  the data; the previous page walked every rendered article and read its
  `textContent` on each keystroke. Measured on 3,239 passages: the page now
  builds 60 cards and ~1,100 DOM nodes instead of 3,239 and ~40,000, and a filter
  applies in 2–9 ms.
- **Counts and exports cover the whole filtered set**, never what happens to be
  rendered, and printing draws everything that matches first.
- **Overviews are a list beside a reading pane.** Picking one swaps the pane
  only: the list keeps its scroll position, its open sections and its filter.
- Code pages use the same sidebar, minus the scheme they are already filtered by.

### Changed — the one-file export starts faster

Reading copies now ride in their own JSON islands, parsed when a paper is opened
rather than all at once with the rest of the payload. On the 178-paper corpus
that is 17 MB of the 21 that no longer has to be parsed to show the first page.

## 1.9.0 — 2026-09-09

**Backward-compatible (additive) minor release: the library as one file.** No
schema, vocabulary, id recipe or gate changed; schema `$id`s stay at `1.8.0`.

### Added — the PDFs, and a page number to open them at

- `--format site-one --bundle` copies the original PDFs into a folder beside the
  file and links **every passage to its own page** in them. They cannot go inside
  the file: 343 MB of PDFs base64s to well over twice that. The file still opens
  without the folder; it simply does not offer the PDF.
- The page comes from a `secondary_locators` entry of type `page`, which is
  advisory and excluded from the `ext-` identity recipe — so recording one
  re-mints nothing and cannot affect whether a quotation verifies. A page is
  navigation, never evidence.

### Added — `upc export --format site-one`

- The same library as **one self-contained HTML file**: stylesheet, data, every
  passage with its context, every overview, and (by default) the full reading copy
  of every source, with a small router rendering the views from memory.
- The multi-file site remains the better artifact — real URLs, one page per
  source, a printable theme — but it is a *folder*, and a folder is not what gets
  emailed, dropped in a shared drive, or opened by someone who was sent "the
  literature review". Detached from its siblings, its index page is a set of dead
  links. This opens from a USB stick with nothing beside it.
- `--no-text` drops the embedded reading copies, which dominate the size: measured
  on a 178-paper corpus, 21 MB becomes 4.7 MB and every passage, code, overview
  and matrix cell survives.
- Same §09 rules as the multi-file site, enforced by the same renderer: a code
  chip is not a badge, no code without its coder, disagreement displayed rather
  than resolved, counts that state their unit.

### Fixed

- The codes index linked every code to a page, including codes nothing had been
  coded against — whose pages are deliberately not generated. Nine dead links on a
  real corpus. An unapplied code now reads as plain text, and a scheme with
  nothing coded against it says so.
- Overviews were listed flat. They are now grouped by the scheme they were written
  for, with that scheme's question as context, and the home page points at them as
  the place to start — a short review per theme is what "the lay of the land"
  actually means.

## 1.8.1 — 2026-09-09

**Patch release: three bugs that only a real corpus could surface.** No schema,
vocabulary, id recipe or gate changed; schema `$id`s stay at `1.8.0`.

- **Large reports were silently truncated when piped.** Every command that printed
  a report and then called `process.exit()` discarded whatever stdout had not yet
  drained — 64 KB on a pipe. A 923 KB validation report for a 178-source corpus
  arrived cut in half and parsed as nothing. The Obsidian export already
  documented this hazard and set `process.exitCode`; every other command now does
  the same.
- **The synthesis index was self-perpetuating.** `loadCorpus` read corpus.json's
  `syntheses` index *instead of* scanning the declared directory, so once the
  index held anything, a synthesis written later could never be discovered — and
  `regen` rebuilt the index from the same short list it had just failed to extend.
  The index is an ordering hint, not the authority on what exists.
- **`upc add synthesis` checked sources but not passages.** Rule 2.4 requires the
  output to cite every id its claims depend on; the guard covered only the source
  ids, so prose whose claim cited a passage it never marked was written and then
  failed validation.

## 1.8.0 — 2026-09-09

**Backward-compatible (additive) minor release: getting documents in, and getting
a readable library out.** No object field, vocabulary, id recipe or quotation gate
changed; the schema `$id`s bump to `1.8.0` (which changes `integrity.schema_hash` —
regenerate projections with `upc regen`). Every 1.7.0 corpus remains valid.

Everything here came out of putting the standard to work on a real corpus for the
first time: 179 PDFs of transitions literature, coded by a local 27B model against
nine codebooks. Each item below is a thing that was measured, not a thing that
seemed like a good idea.

### Added — `upc anchor --normalize`, so a model's quotation can be found

- A model asked to copy a span verbatim out of PDF-extracted text does not. It
  straightens a curly quote, writes `fi` for an `ﬁ` ligature, puts a space where
  the page had a line break, rejoins a word the typesetter hyphenated, capitalises
  the first letter because it is starting a sentence, and ends with a full stop
  the document does not have there. **The span is genuinely in the document.**
  A byte-exact search finds none of these.
- So the *search* may be normalized while **what is stored never is**: the
  extraction's `direct_quote` is always the representation's own codepoints,
  sliced at the offsets the search found, and hop B still compares raw codepoints
  with `===`. Nothing here can make a quotation verify that would not have
  verified anyway; it only changes which spans a producer can find.
- Nine normalization classes, all reported: `whitespace`, `quotes`, `dashes`,
  `soft-hyphen`, `hyphenation`, `ligatures`, `ellipsis`, `initial-case`,
  `trailing-period`. Case is **not** folded beyond that first character, and
  Unicode normal forms are **not** applied — both would let visibly different
  text match, and the point of the gate is that what is stored is what the
  document says.
- Zero or several normalized hits are still `not_found` / `ambiguous`. A span
  that cannot be located uniquely is never minted, however it was rendered.
- New optional `extraction.anchoring` records `{method, proposed_quote, rules[]}`
  — the provenance of the *search*, excluded from the `ext-` identity recipe, so
  a reviewer can see what the model typed next to what the document says. New
  advisory `anchored_by_normalization` (never promoted under `--strict`).
- **Measured:** on 67 model-proposed passages from three papers, the exact search
  found 59 and normalization found 4 more, for 94%. Of the misses, two were the
  model inventing a sentence boundary and two were faults in the *text* rather
  than the search (below).

### Added — `upc add`, so a producer does not reimplement the layout rules

- **`upc add source --corpus <dir> [--batch] [--hardlink]`** takes a JSON
  description plus a list of files and writes the source: hashing bytes, minting
  `src-`/`rep-`/`img-` ids, slugifying with collision handling, checking portable
  filenames and containment, wiring `parent_representation_ref` by index, and
  appending one `import` event.
- UPC still has no PDF reader, no fetcher and no OCR, deliberately: what a
  document is made of is the tool's business. What is *not* the tool's business is
  identity and layout, and every producer that reimplements those gets some of
  them subtly wrong in a way that cannot be repaired from outside.
- **`upc event --corpus <dir>`** appends one activity to the journal, so a tool
  that derives something from a corpus — an index, a conversion — can say so
  without reimplementing the journal's numbering or its atomic write.

### Added — `upc export --format site`, a library rather than an audit

- **`upc export <corpus> --format site -o <dir> [--matrix a:b] [--bundle]`** — a
  static, multi-file site for the person who has a question about the literature
  rather than about the corpus. Home, codes, per-code passage pages with filters
  and CSV export, per-source pages carrying the full reading copy with every
  passage highlighted in place, a searchable passage index, rendered overviews
  with their claim registers, and an optional two-codebook matrix.
- `index.html` (`build-index.mjs`) remains what it has always been: a
  *verification* surface that speaks the standard's vocabulary. This is the other
  audience, and it never uses the words extraction, representation, locator or
  hop. The translation is the one in `docs/adoption-plan.md`: Copy, Passage, Note,
  "Checked against the extracted text", "Doesn't match the source".
- It is a pile of files, not an app: no fetch, no router, no CDN, so it works from
  `file://` — which is what "email someone the folder" actually requires.
- §09's code rules are enforced by the renderer, not left to a template: a code
  chip is shaped and coloured unlike any badge, no code is shown without its
  coder, a disagreement is displayed with neither judgement winning, a code on a
  broken span is struck through, a definition is one hover away, and every count
  states whether it counts passages or sources.
- Quotations and their context are sliced from the representation bytes and
  re-gated at build time, so a page cannot show a quotation the corpus can no
  longer prove; a failure is rendered as a failure. A reading copy too large to
  embed is omitted whole with a message, never truncated.

### Fixed — three defects real use exposed

- **`upc anchor --set` wrote where the corpus could not see.** `loadCorpus` reads
  only what `sections` declares — there is no directory sniffing — so an extraction
  set written into an undeclared `extractions/` was invisible: the objects were on
  disk, every coding that targeted one dangled, and nothing said why. `anchor` and
  `code` now declare the section they write into. This was found by coding a real
  corpus and getting 28 dangling targets out of 28.
- **A failed `upc code` run left the corpus invalid.** The coding-set manifest was
  written before any coding succeeded, so a run in which everything failed left a
  manifest with `coders: []`, which violates its own schema. A run that lands
  nothing now writes nothing.
- **A raw NUL and a raw US byte sat in `upc_common.mjs`** inside a regex character
  class, where the `\x00`/`\x1f` escapes were meant. Functionally identical, but
  it made every `grep` treat the reference implementation as a binary file.

### Notes for producers

- Text handed to `upc add` should be **soft-wrapped** (one line per paragraph),
  per §02. Measured: a hard-wrapped copy puts a newline inside most multi-line
  quotations, which then cannot use the inline `"…" [ext-id]` marker form.
- Two faults in *converted text* accounted for every anchoring failure that was
  not the model's fault: a running head emitted inline at a page break, splicing a
  journal citation into the middle of a sentence; and a word broken across lines
  with a SOFT HYPHEN rather than a hyphen-minus, which naive rejoining turns into
  "en ables". Fix the text; do not loosen what counts as a match.
- An **open codebook** (`closed: false`) still needs at least one entry in
  `codes[]`, because the schema requires it. A codebook whose values are genuinely
  open-ended should seed one illustrative code rather than shipping an empty array.

## 1.7.0 — 2026-08-28

**Backward-compatible (additive) minor release: an Obsidian vault export.** No
object field, vocabulary, id recipe, or quotation gate changed; the schema `$id`s
bump to `1.7.0` (which changes `integrity.schema_hash` — regenerate projections with
`upc regen`). Every 1.6.0 corpus remains valid.

### Added — Obsidian vault export

- **`upc export <corpus> --format obsidian -o <dir>`** — a deterministic,
  zero-dependency projection of a corpus into a readable **Obsidian vault**: one
  Markdown note per source, generation and synthesis, images copied into the
  vault's attachment folder with their `description` as a folded caption, a
  `## Codes` section for any codings, and each note's origin in a folded
  `> [!provenance]-` callout. `--into <vault>` writes into an existing vault's
  inbox instead.
- **Codes display under §09's rules, not as decoration.** A chip is plain text so it
  cannot be mistaken for a gate badge, it is never shown without its coder, a
  codebook becomes a note so every code's definition is one click away, and where
  two coders disagree **both judgements are shown and neither wins**. Source-level
  and span-level codings are labelled separately rather than merged, because §09
  requires a count to state its unit.
- **This is the first LOSSY export, and deliberately so.** RO-Crate, PROV, CSL-JSON
  and the CSV mirrors are faithful re-encodings; this one removes navigation,
  running heads and page numbers, because a converted document is unreadable until
  that furniture is gone. §09 gains three normative rules that keep the loss honest:
  quotations are rendered from **representation bytes at the locator** (never from
  the stripped body, whose offsets are no longer the corpus's), **what was removed
  is reported by class** in every note, and a **model-rewritten representation is
  not used as a body** unless asked for, with the note saying so when it is.
- **The vault's conventions are a profile, not code** (`profiles/obsidian/`):
  frontmatter vocabulary and order, callout registry, block order, folder routes,
  and the source-kind mapping. `--profile <file>` replaces it. A standard must not
  compile one vault's private schema into its tooling.
- **A vault is also somewhere a person writes**, so the export is byte-idempotent
  and remembers what it wrote: a note edited by hand is **left alone and reported**
  rather than overwritten (`status: "partial"`, exit 1), an owner-authored `## Notes`
  section is carried across a `--force` rewrite, and an attachment already matching
  the corpus is not rewritten.
- Boilerplate removal is deterministic and model-free. Page numbers and running
  heads are only stripped **at a page boundary** the document actually declares —
  measured against real converted documents, an unconditional rule ate a map
  legend's `0.0`/`10.5` and a wiring manual's `C`/`L1` terminal labels. Repository
  coversheets are **detected and never removed**: a false positive would delete the
  opening of an article.
- New crosswalk [`crosswalks/obsidian.md`](crosswalks/obsidian.md) and profile
  [`profiles/obsidian/profile.md`](profiles/obsidian/profile.md).

### Changed — one badge implementation, not three

- **`badgeForExtraction(ext, repObj, repRec, lookupRep)`** and `VERIFIED_BADGES`
  move into `upc_common.mjs`. The §09 badge taxonomy was implemented twice — in
  `locateCmd` and in the browser — and the Obsidian export would have made a third.
  It is normative, and three copies of a normative rule is three chances to drift.
  Both existing callers now use the helper; `index.html` regenerates byte-identically.

### Fixed

- **The examples declared `upc_spec_version: "1.5.0"` throughout the 1.6.0 release**,
  and the conformance fixtures hardcoded their own copy. Both generators now read
  `VERSION`, so the version cannot drift from the release again.
- **`profiles/ro-crate/`** still declared `1.5.0` at 1.6.0; the profile id is emitted
  into every exported crate's `conformsTo`, so the drift was user-visible.
- **`upc export` argument parsing** read a flag's value as the corpus directory when
  the flag came before the positional. Harmless with two options; not with nine.

### Not carried into the vault (by design)

- **The vault cannot re-verify anything.** A note's body is stripped, so its offsets
  are not the corpus's offsets; a quotation's footnote names the *representation* it
  was checked against, and the check itself lives in the corpus. There is no
  importer, and the export is lossy precisely so that there cannot usefully be one.
- **A paraphrase is never rendered inside the evidence callout.** §09 forbids a
  blockquote for an ungated `text` extraction, and an Obsidian callout is one, so
  ungated readings sit under a plain `## Extractions` heading instead.
- **No `bbox` overlay is drawn**, so the export cannot imply a verified position on
  an image; a region reading is labelled "recorded not gated" wherever it appears.
- **`ocr_text` is never rendered as a quotation** (§05 makes it advisory).
- **`--into` never guesses a `domain`.** An unclassifiable note waits in the inbox at
  `status: raw` rather than being filed somewhere plausible and wrong.

## 1.6.0 — 2026-08-21

**Backward-compatible (additive) minor release: codes & codings, plus two
correctness fixes the coding work exposed.** No id recipe and no quotation gate
changed; hop B is still codepoint-exact, `char_range`-only, and unnormalized. The
schema `$id`s bump to `1.6.0` (which changes `integrity.schema_hash` — regenerate
projections with `upc regen`). **Every 1.5.0 corpus remains valid under 1.6.0.**

Forward compatibility, stated precisely rather than generally, because the two
changes below behave differently and only one of them is fully forward-compatible:

- **Codings are invisible to an older reader.** A 1.5.0 validator reads a 1.6.0
  corpus containing codebooks and codings and reports `passed` at the same level,
  because they live under `sections` keys it never looks for. Tested, not asserted:
  the `pass-coded` conformance fixture is run under the pinned 1.5.0 script.
- **The shared-representation loosening is *not* forward-compatible, by
  construction.** 1.6.0 accepts corpora that 1.5.0 rejects — that is what a
  loosening *is*. A corpus that records the same bytes under one `rep-` id for two
  sources is valid at 1.6.0 and still fails `id_duplicate` at 1.5.0. Nothing that
  was valid becomes invalid, so no existing corpus breaks; but a corpus exploiting
  the new laxity requires a ≥ 1.6.0 reader. This is the same class of one-way skew
  the 1.5.0 release flagged for `role: "ocr"`, and it is the reason
  `upc check-compat --requires "^1.6"` exists.

### Added — codes & codings (§12)

- **`codebook`** (`codebooks/<cbk-id>.json`, `sections.codebooks`) — a named
  coding scheme. Identity is `cbk-` over `(namespace, slug)` **only**: a
  controlled vocabulary must keep one id while its contents evolve, so hashing
  `codes[]` would dangle every reference on every edit. Evolution rides on the
  advisory `revision` / `revision_digest` pair instead, which means **editing a
  codebook never re-mints a coding**. Supports `closed` (pick from the list) vs
  open schemes, `multi_label`, a `parent` hierarchy, and per-code `definition`s.
- **`coding`** (`codings/<set-id>/items.jsonl`, `sections.codings`) — one coder's
  judgement that one code applies to one target. Identity is `cod-` over
  `(codebook_ref, target.kind, target.id, coder, code|value)`.
- **The span is not the judgement.** An extraction is content-addressed over its
  location and text, so two coders who select the same sentence converge on one
  `ext-` id — which is why the verdict cannot live on the extraction. Putting the
  coder and the code in the `cod-` key makes agreement, disagreement, and
  multi-labelling representable without collision, while leaving `created_at`,
  `confidence`, `rationale`, `query` and `status` *out* of the key so re-running
  an unchanged coding pass **writes nothing**.
- **A coding MUST NOT carry a locator.** A span-level coding targets an `ext-` id
  that has already passed hop B, so a code can never become a second, ungated way
  to point at text. Every coded passage is proved real before it can be labelled.
- **Disagreement is data.** Two coders disagreeing raises the advisory
  `coding_disagreement`; there is deliberately no `gold` / `resolved` /
  `final_code` member, because an adjudication is just another coding by a coder
  whose handle says so. Agreement statistics are projections and are never stored.
- **`coder` is a stable handle, not a model string.** The volatile detail (model,
  prompt version, person) lives in the coding-set manifest's `coders[]`, so a
  model upgrade does not re-mint every coding id and destroy the agreement history.

### Added — commands

- **`upc anchor --corpus <dir> --rep <rep-id> [--set <id>] [--dry-run]`** — the
  first *implementation* of the re-extraction protocol, which had been normative
  prose in §03/§09 with no code behind it. Reads candidate quotations as JSONL,
  byte-exact-searches the representation, and mints an `active` `char_range`
  extraction **only** for a unique hit; zero or several hits return `not_found` /
  `ambiguous` and are never written as verified. This is what makes a model-driven
  coding pass safe: the model chooses what to select, the tool decides what is real.
- **`upc code --corpus <dir> --set <cds-id>`** — batch-apply codings, validating
  each against its codebook and superseding any prior judgement by the same coder
  on the same target. Batch-only by design; a per-object form invites one process
  per coding, which is what made `mint` unusable at scale.
- **`upc codebook <dir> [<cbk-id>]`** — read-only inspection, with applied counts
  computed (never stored).
- **`upc batch --corpus <dir>`** — NDJSON commands in, NDJSON out, over one
  `loadCorpus` with a warm representation cache. `locate` is O(whole corpus) per
  call, so a reader rendering 50 passages cannot shell out 50 times. Deliberately
  not a server: no port, no auth, no dependency.
- **`upc mint --batch <kind>`** — JSONL in, `{i, id}` out; `cod` and `cbk` added.
- **`upc version [--json]`** and **`upc check-compat --requires "^1.6"`** — the
  version handshake for embedding tools.
- **`upc mint rep`** now works. It was documented in the `upc.mjs` header and
  rejected by `mintCmd`.

### Fixed — a duplicate shared representation is not a defect

`rep-`/`img-` ids are pure byte hashes but representation *records* are
source-scoped, so the same bytes legitimately appear more than once: a figure
syndicated across sources, or one file serving two roles. Rule 1.1 previously
called every such pair `id_duplicate`, an L1 error. It now compares hashes first:
**equal hashes are the advisory `representation_shared`; unequal hashes remain
`id_duplicate`**, because the id *is* the hash, so disagreeing hashes mean a record
is misdescribing its own bytes. This is a pure loosening — it accepts strictly more
corpora — and is therefore minor-safe. Measured on a real 106-source corpus this
was the difference between 181 spurious errors and a clean L1.

### Fixed — a model rewrite no longer badges as `verified`

Through 1.5.0 the badge was decided from the derivation's *media types*, so any
text-to-text step counted as fidelity-preserving and a model-"cleaned" Markdown
badged plain **verified**. On a real corpus, 68% of substantive lines in the
model-cleaned copies were not verbatim in the deterministic extraction they came
from — including a source whose "cloud-based system that integrates" the model
silently corrected to "cloud-based systems that integrate". A quotation anchored
there passes hop B honestly and still attributes to the source a sentence it never
wrote. §09 gains a fourth badge scope, **`verified-to-rewrite`**, decided from
`produced_by` plus the parent's media type rather than from the role name (a
model-cleaned Markdown and a deterministic conversion share the `clean_markdown`
role; only the derivation separates them), and §11 gains the matching non-guarantee
row. No schema change.

### Added — validation

Errors (all **vacuous on a corpus with no codings**, so L1 is unchanged for every
pre-1.6.0 corpus, and codings never move a conformance level): `dangling_codebook`,
`dangling_coding_target`, `coding_code_unknown`, `coding_open_closed_mismatch`,
`codebook_code_duplicate`, `codebook_parent_cycle`, `codebook_parent_dangling`,
plus `id_format` / `id_duplicate` / `id_mismatch` / `missing_provenance` extended
to `cbk-` and `cod-`.

Advisories: `representation_shared`, `coding_targets_failed_gate` (**never an
error** — a coding stays a faithful record of a judgement; the *span* is what
broke), `coding_codebook_drift`, `coding_coder_undeclared`, `coding_disagreement`,
`codebook_code_unused`, `codebook_revision_stale`.

### Added — packaging

The repository is now an installable, versioned artifact (`@ellian-eorwyn/upc`,
`bin: upc`, zero dependencies, Node ≥ 18) shipping the scripts, schemas, vocab,
spec, profiles, and crosswalks. Consumers pin a version and verify it with
`upc check-compat` instead of vendoring by absolute path and silently drifting.
`VERSION` is now the single source of truth the CLI reads, rather than a string
duplicated in the code.

### Interface

`index.html` renders codes as chips that are visually distinct from verification
badges, always name their coder, carry the code's definition, and show **both**
sides of a disagreement without picking a winner (§09).

## 1.5.0 — 2026-08-21

**Backward-compatible (additive) minor release: anchored context navigation and
structured image info.** No id recipe and no quotation gate changed; hop B is
still codepoint-exact, `char_range`-only, and unnormalized. The schema `$id`s bump
to `1.5.0` (which changes `integrity.schema_hash` — regenerate projections with
`upc regen`). Every 1.4.0 corpus remains valid.

### Added — select-to-source navigation

- **`upc locate <ext-id> --corpus <dir> [--format json|web-annotation]`** — a
  read-only command that resolves an extraction's **primary and every secondary**
  locator into a structured *context bundle*: the verified span with its
  surrounding text, its derived 1-based line number, and each advisory
  presentation locator with its representation, reference frame, and trust label.
  This is the backend call a reading surface makes to bring a quotation's source
  up in place.
- **`resolveLocator` / `charToLine` / `lineRangeForCharRange` / `textLines`** in
  `upc_common.mjs` — pure, zero-dependency helpers behind the command.
- **Advisory locator metadata**, all optional and all *siblings* of `value` so
  they stay outside the `ext-` identity recipe: `conforms_to`, `unit`,
  `reference` (a bbox's `{width, height}` frame), and `quote_hint`
  (`{exact, prefix?, suffix?}`, a content-based re-find aid that is **never** a
  verification path).
- **`secondary_locators[]` is now formalized** (§03) as the home for presentation
  *and cross-representation* locators. A secondary locator MAY address a
  different representation of the same source; `locator_rep_mismatch` constrains
  only the primary locator, which is what makes that expressible.
- **`line_range` is normatively 1-based and inclusive** (§03). The schema keeps
  `minimum: 0` so no existing corpus can be invalidated; the bound is enforced by
  a new advisory instead.
- Four new **advisory** rules, warnings only and inert to the conformance level:
  `secondary_locator_dangling`, `secondary_locator_cross_source`,
  `bbox_out_of_bounds`, `line_range_out_of_bounds`.

### Added — structured image info

- **`ocr` joins the `representation_role` vocabulary.** §05 has referenced this
  role since 1.0.0, but the closed enum only had `ocr_pdf`, so no producer could
  actually emit it. The mechanism §05 prescribes is now expressible.
- **`has_text`** (optional boolean) on a representation — the text-presence
  indication of the image triple: `description` says what the image *is*,
  `has_text` says whether it *says* anything, and the findable, gate-verified
  quotation of that text lives in a companion `ocr`-role textual representation.
- `ocr_text` is documented as what it always was: an advisory blob, never
  verified and never quotable.
- The web-research example now exercises the whole path end to end — an image
  with `has_text`, a companion `ocr` representation, a `direct_quote` that
  **passes the codepoint gate** against it, and a secondary `bbox` carrying that
  verified text back to a region on the picture.
- It also carries a **real native PDF** (`document_pdf`, 2 pages, generated
  deterministically with no dependencies) plus its extracted text layer, a
  quotation gated against that layer, and a secondary `page` locator producing a
  `paper.pdf#page=2` deep link — so the `page` presentation locator is exercised
  against actual PDF bytes rather than only unit-tested.

### Added — reference browser

- Images render inline with their description, text flag, caption, and
  dimensions; a `bbox` is drawn as an overlay positioned in **percent of its
  reference frame**, so it stays correct at any display scale.
- Quotations show their derived line number and an RFC 5147 `#line=` link to the
  source file; `page` locators deep-link with `#page=N`.
- The cross-representation case is rendered in full: an OCR quotation is shown
  verified *and* highlighted on the image it was read from.
- **An in-page source viewer.** A sticky pane beside the evidence list (and an
  inline one under a source's representations) shows the representation itself,
  positioned at the locator: numbered lines with the quoted span marked, the PDF
  at its page, the image with its region highlighted. Position chips drive the
  pane instead of opening a new tab; an "open externally" link remains in the
  pane header. Textual representations are **embedded at build time** — the same
  bytes the gate ran against — because `fetch` is unavailable from a `file:`
  origin and an iframe of a text file cannot be annotated cross-origin, so
  embedding is the only way the offline browser can show and mark up a source.
  Embedding is budgeted (512 KiB per representation, 8 MiB per corpus, with
  representations that extractions point into served first); anything over budget
  is **omitted entirely and offered as a link**, never truncated, because half a
  document shown as if it were whole is the exact failure this browser exists to
  prevent.
- **§09 deep links are now actually implemented.** The hash carries the view, the
  selected extraction, the active search, and the sort key/direction
  (`#/evidence/<ext-id>?q=…&sort=…&dir=…`), so a filtered view is shareable and
  reloads identically. The `#ex=<ext-id>` shorthand addresses one extraction
  directly. Evidence columns are sortable. Typing updates the hash in place
  without re-routing, so focus is never lost.

### Added — Web Annotation emission

- Presentation locators now project to `FragmentSelector`s: `line_range` → RFC
  5147 `#line=`, `page` → `#page=`, `bbox` → Media Fragments `#xywh=pixel:`,
  `timestamp_range` → `#t=`, each tagged `upc:conformsTo` and `upc:unit`, and
  each paired with a `TextQuoteSelector` re-find hint.
- A locator addressing a **different representation** becomes an **additional
  `target`**, not another selector on the existing one — an OA selector is only
  meaningful against its own `target.source`. An annotation with a single target
  keeps the 1.4.0 bare-object shape, so existing exports are byte-identical.
- New `upc:` terms: `upc:conformsTo`, `upc:reference`.

### Fixed — the trust boundary now follows the bytes, not the role name

- **A text layer extracted from a PDF is derived text.** §05 has always said a
  quotation of PDF text "lands on the trust boundary", but the badge was decided
  from the role *string* (`transcript`, `ocr*`), so a `role: "text"` layer whose
  parent is a PDF was badged plain **verified** — claiming the quote had been
  checked against the document when it had only been checked against a rendering
  of it. `isDerivedText` now decides from the derivation: a textual
  representation is derived text when the bytes it came from were not themselves
  text. A text-to-text conversion (raw HTML → cleaned Markdown) is unaffected and
  still badges **verified**, matching §11's "exact in the cleaned representation".
- The badge label broadens from "≈ to transcript" to **"≈ to derived text"**,
  which is accurate for transcripts, OCR, and extracted text layers alike. The
  badge *identifier* (`verified-to-transcript`) is unchanged.
- The `TEXTUAL` media predicate, previously duplicated in two scripts, is now the
  shared `isTextualMedia`.

### Fixed — browser

- A line position no longer renders twice when an extraction carries both a
  derived line number and an explicit `line_range` secondary for the same place.
- The source metadata grid sized its key column at a fixed `130px`, so a long key
  (`alias:researchassistant`) overlapped its value. It now sizes to content,
  cannot starve the value column, and stacks below 560px.
- `line_range` resolution now returns `path`, so its RFC 5147 link is emitted.
- A new selftest **parse-checks every generated `index.html`**. The client is
  emitted from a template literal, where a single lost backslash produces a page
  that looks fine on disk and dies on load; nothing caught that before.

### Not weakened (the point of the release)

- **The gate is untouched.** `verifyHopB` still keys on the primary `char_range`
  alone, over codepoints, with no normalization. Presentation locators are never
  verified and can never carry a `direct_quote`.
- **Identity is untouched.** `mintExtId` still hashes only
  `{type, representation_ref, value}` of the primary locator. Selftests assert the
  `ext-` id is unchanged by adding `secondary_locators` or locator metadata, and
  still changes when `locator.value` does.
- **The trust boundary is louder, not blurrier.** A region drawn on an image is
  *recorded, not gated*, and §09 now **requires** a conforming surface to say so
  wherever it draws one.

### Compatibility

- **The new optional members are invisible to a 1.4.0 reader.** `has_text` sits on
  a representation and the locator metadata sits on a locator; both schemas are
  `additionalProperties: true`, and the `unknown_field` advisory scans only the
  *top level* of source / extraction / generation / synthesis objects. So a 1.4.0
  validator accepts them silently — it does not even warn, unlike the
  `identifiers`/`relations` case in 1.3.0, which added top-level members.
- **`role: "ocr"` is the one genuine forward-incompatibility.**
  `representation_role` is a closed enum with no `x-` escape, so a 1.4.0
  validator raises `schema_invalid` (an L0 error) on a corpus that uses it. A
  producer targeting mixed readers should keep emitting `transcript` until its
  readers are on 1.5.0.
- Existing RO-Crate exports are unchanged: an extraction with no
  cross-representation locator still emits the 1.4.0 annotation shape byte for
  byte.

## 1.4.0 — 2026-08-20

**Backward-compatible (additive) minor release: W3C PROV-O export.** No object
field, vocabulary, id recipe, or quotation gate changed; the schema `$id`s bump to
`1.4.0` (which changes `integrity.schema_hash` — regenerate projections with
`upc regen`). Every 1.3.0 corpus remains valid.

### Added — PROV-O export

- **`upc export <corpus> --format prov`** — a deterministic, zero-dependency
  **W3C PROV-O** projection as flattened JSON-LD (streamed to stdout or `-o
  <file>`). Reuses the RO-Crate exporter's agent/entity machinery and realizes the
  [crosswalks/prov.md](crosswalks/prov.md) mapping: derived objects → `prov:Entity`,
  events → `prov:Activity`, tools/people → `prov:SoftwareAgent`/`prov:Person`,
  `derived_from` → `prov:wasDerivedFrom`, event inputs → `prov:used`, production →
  `prov:wasGeneratedBy`, `supersedes` → `prov:wasRevisionOf`, `direct_quote` →
  `prov:wasQuotedFrom`.
- Like `index.html` / CSV / RO-Crate, the PROV output is a **regenerable,
  non-canonical** view; the UPC objects stay the single source of truth.

### Not carried into PROV (by design)

- The **hop-B/C quotation gate is UPC-only.** `prov:wasQuotedFrom` records where a
  quotation came from but carries **none** of UPC's mechanical guarantee (§11).
- A source is a captured resource, **not** a claimed primary source: the export
  **never** emits `prov:hadPrimarySource`. A representation's `duplicate_of` is
  **not** a revision, so it is never mapped to `prov:wasRevisionOf`.

## 1.3.0 — 2026-08-20

**Backward-compatible (additive) minor release: optional source identity
enrichment.** Every 1.2.0 corpus remains valid, and a 1.3.0 validator accepts a
1.2.0 corpus. No object field was removed or renamed, and no id recipe or
quotation gate changed; the schema `$id`s bump to `1.3.0` (which changes
`integrity.schema_hash` — regenerate projections with `upc regen`).

### Added — optional source identity

- **`source.identifiers[]`** — optional external identifiers for the conceptual
  work, each `{ scheme, value, url? }`. `scheme` is a free string; recommended
  values live in the new `vocab/identifier_scheme` vocabulary (`doi`, `isbn`,
  `issn`, `pmid`, `pmcid`, `arxiv`, `handle`, `ark`, `urn`, `oclc`, `wikidata`,
  plus an `x-` escape). Never feeds the `src-` id recipe; UPC never resolves an
  identifier against an external registry.
- **`source.relations[]`** — optional typed links to other works, each
  `{ type, target }`, with `type` from the new `vocab/relation_type` vocabulary
  (`same_work_as`, `is_version_of`, `has_version`, `is_capture_of`, `is_part_of`,
  `has_part`, `is_format_of`, `is_translation_of`, `supersedes`, `superseded_by`,
  plus an `x-` escape). Intra-corpus supersession stays on the scalar
  `supersedes`/`superseded_by` fields; these relations never substitute for them.
- **Two advisory rules** (§08, Class `Advis`, warnings only):
  `identifier_scheme_unknown` (a non-`x-` scheme outside the recommended
  vocabulary) and `relation_dangling` (an intra-corpus, id-shaped relation target
  that does not resolve). Neither is ever a hard error; external identifiers and
  URLs are never checked.
- **RO-Crate export** surfaces both fields as `upc:` terms (`upc:identifiers` /
  `upc:relations`, with nested `upc:identifierScheme` / `upc:relationType` /
  `upc:relationTarget`); the `profiles/ro-crate/` term set is extended to match.

### Compatibility

- `identifiers[]` / `relations[]` are additive optional fields and **recipe-inert**
  (the `src-` recipe reads only URL/bytes). A 1.2.0 reader ignores them
  (must-ignore-unknown); a **1.2.0 validator under `--strict`** will
  `unknown_field`-flag them — expected minor-version forward-compat behavior.

## 1.2.0 — 2026-08-18

**Backward-compatible (additive) minor release: interoperability + epistemic
precision.** Every 1.1.0 corpus remains valid, and a 1.2.0 validator accepts a
1.1.0 corpus. No object field, id recipe, or quotation gate changed; the schema
`$id`s bump to `1.2.0` (which changes `integrity.schema_hash` — regenerate
projections with `upc regen`).

### Added — epistemic framing

- **§11 Guarantees & Non-Guarantees** — a normative guarantee/non-guarantee
  matrix stating exactly what a passing corpus mechanically proves (fixity,
  codepoint-exact quotation at each hop, content-addressed identity, referential
  integrity) and what it deliberately does **not** (source truth/authority, OCR/
  transcript fidelity, paraphrase faithfulness, synthesis soundness).
- **Rule classes** in §08 — a `Class` column tags every rule **mechanical
  invariant** / **producer obligation** / **advisory semantic**, so "the validator
  passed" is never over-read. No rule number, code, severity, or hop changed.
- **"byte-for-byte" reconciled** with the normative algorithm in §03: the slogan
  denotes codepoint-exact equality over the hash-fixed UTF-8 bytes (the two
  coincide for valid UTF-8). The slogan is retained.

### Added — RO-Crate interoperability (export projection)

- **`upc export … --format ro-crate`** — a deterministic, zero-dependency
  [RO-Crate 1.3](crosswalks/ro-crate.md) flattened-JSON-LD projection. Zero-copy
  by default (writes `ro-crate-metadata.json` into the corpus root); `--copy -o
  <dir>` emits a detached, self-contained crate. Like `index.html`/CSV, it is a
  regenerable view — the UPC objects stay canonical.
- **UPC RO-Crate profile** (`profiles/ro-crate/`, id
  `https://provenance.dev/upc/1.2.0/profiles/ro-crate`), declared in exported
  crates via `conformsTo`. Content-addressed ids are preserved in `identifier` /
  `upc:*Id` and never overloaded onto `@id`.
- Gated extractions carry a companion **W3C Web Annotation** (`TextPositionSelector`
  + `TextQuoteSelector`) flagged `upc:interopOnly: true`; the UPC `char_range`
  stays `upc:gateAuthoritative: true`. The codepoint-vs-UTF-16 / normalization
  divergence is documented in [crosswalks/web-annotation.md](crosswalks/web-annotation.md).
- **Crosswalk documents** — RO-Crate, Web Annotation, and W3C PROV (each row
  tagged exact/partial/incompatible/UPC-only), plus deferral notes for
  nanopublications, BagIt, and WARC/Memento.

### Notes

- Deferred to a later release: source `identifiers[]`/`relations[]` enrichment, a
  PROV-O export, an RO-Crate importer / round-trip, and the packaging/capture
  standards above. The quote gate is unchanged and remains the authority on any
  cross-standard conflict.

## 1.1.0 — 2026-08-17

**Supersedes 1.0.0 wholesale.** UPC 1.0.0 was a draft with no adopters, so this
release makes breaking changes freely to lock in best practices before any tool
depends on the standard. There is no 1.0 → 1.1 migration tooling because nothing
was written against 1.0.

### Added — byte-exact quotation gates (the headline)

- A three-hop verification chain, output quote → extraction → original source,
  with an **exact-match gate at each hop** and no normalization at verification
  time (§03 hop A/B, §04 hop C). Failures are flagged, never absorbed.
- `char_range` defined normatively as **Unicode codepoints** (0-based,
  end-exclusive) into the representation's UTF-8-decoded bytes (§03).
- A **citation-marker grammar** (`"…" [ext-<id>]` inline, ```` ```quote ext-<id> ````
  block, bare `[ext-<id>]` paraphrase) so quotations in generated output are
  machine-verifiable (§04).
- Extraction lifecycle: `status` (active/needs_review/superseded/retracted),
  `supersedes`/`superseded_by`, and advisory `secondary_locators[]` for coarse
  context that never gates (§03).
- The trust boundary for non-text media: quote→transcript is gated; transcript→
  original is recorded provenance, labeled as inference (§05).

### Added — storage, durability, and the human layer

- New **§10 Storage & Durability**: atomic writes (temp+rename+fsync), JSONL
  rules (torn-tail tolerance, atomic whole-file edits, append-only journal),
  removal/tombstone semantics, an advisory `.upc/lock`, and portable-filename
  rules.
- New **Appendix A**: the per-source vs per-media-type layout decision record;
  per-source is canonical for writers, per-media-type stays readable via
  `sections`.
- First-class **modify / re-anchor / re-extraction** workflows and **verified
  browser display** — context read from the representation at the locator,
  per-quote badges, paraphrases never styled as quotes, a gate-failure banner,
  extraction deep links (§09).
- **Export** mappings: CSL-JSON authoritative → BibTeX/RIS field tables (§09).

### Changed — identity, schemas, conformance

- Identifier recipes fully specified and reproducible in any language: **JCS
  (RFC 8785)** for JSON in id keys; the `ext-` key uses the exact `direct_quote`
  (or `text`); a **closed** URL-normalization algorithm; a specified slug
  algorithm (§06). `rel=canonical`/`og:url` no longer feed identity.
- Validators MUST **recompute every content-addressed id** (`id_mismatch`) and
  detect duplicates (`id_duplicate`).
- §08 rewritten as a **numbered rule registry** with a normative error-code
  table; conformance **level is computed from rules passed, not object counts**.
  L1 now guarantees "no unverified quotations in the corpus."
- All object schemas flip to `additionalProperties: true` with a **must-ignore-
  unknown** rule and an open per-tool `ext` extension object, resolving the
  additive-minor-version contradiction. `$id`s embed the minor version.
- `input_digest` has a single home (`provenance.input_digest`) with a specified
  multi-input recipe; generations/syntheses gain `output.sha256`.
- `field_evidence` moved to a source-level sibling of `bibliographic` so CSL
  exports round-trip; bibliographic dates use CSL `date-parts`; `editors`/
  `translators` added.
- Provenance stamp gains `produced_by.method`, `produced_by.person`,
  `modified_at`, and `derived_from.synthesis_ids`.

### Added — schemas and fixtures

- New schemas: `event.schema.json`, `extraction-set.schema.json`.
- New vocab: `extraction_status`; `activity_type` gains `modify`, `reanchor`,
  `retract`, `remove`, `redact`.
- `tests/conformance/` fixtures (a passing corpus per level, a failing corpus per
  error code) so independent implementations self-test against the registry
  without this repo's code.
- Examples and fixtures are **regenerated by committed scripts**
  (`examples/build-examples.mjs`) with true content-addressed ids and byte-exact
  quotes — the 1.0 examples had hand-typed placeholder ids and quotes that were
  not byte-exact.

### Fixed — spec now matches implementation

- The reference validator implements the §08 registry exactly (1.0's validator
  computed level from counts and never ran a real quote check).
- Removed all normative delegation to external tool source files; every algorithm
  is written out in the spec.
- The reference browser no longer reconstructs quote context from the extraction
  record (self-confirming), no longer presents a paraphrase as a quotation, and
  writes atomically.

## 1.0.0 — 2026-08-15

Initial draft: five-object provenance graph, content-addressed ids, CSL-JSON
bibliography, conformance levels L0/L1/L2, file-based corpus with CSV mirrors and
an HTML browser. Superseded by 1.1.0.
