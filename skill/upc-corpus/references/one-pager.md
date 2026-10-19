# One-pagers

A one-pager answers one question for one reader: *why should you care about this project, in
your own terms, on one sheet of paper?* It takes the same two profiles as a dossier (an
**audience** and a **project**), a corpus, and a register of **figures**, and makes one page:
HTML that opens from disk, a US Letter PDF, and a **figures note** that lists every number on the
page with the passage it comes from and who has checked it.

It is a projection (spec/09). Everything on the page is either the **writer's own words** or a
**figure** whose passage is stored in the corpus and found again at every build. A number in the
writer's words that is not one of the page's figures stops the build.

`scripts/onepager.py` is the one command. The runbook is the SKILL's Task 14.

## The profiles

The dossier's profiles (`profiles/audience.schema.json`, `profiles/project.schema.json`), plus
optional fields checked against `profiles/one-pager.schema.json`. A dossier ignores them, so one
profile serves both formats.

| | Audience | Project |
|---|---|---|
| Reads | `decides`, `cares_about`, `objections` (with `answer_hint`), `trusts`, `numbers` (`prefer`, `avoid`), `words` (their own phrases), `reading` | `aims`, `rules`, `never_publish` |
| `one_pager` | `layout` (executive, technical, policy), `tag`, `cta`, `cta_detail`, `distribution` (internal, partner, public), `banned_words` | `brand` (palette, font, logo, org, funder, award and footer lines, `result_class`, `draft_stamp`), `assets`, `reviewers`, `clearances`, `allow_numbers`, `consent` |

- **`distribution`** is how far a page travels. An internal page may use any confirmed figure.
  A partner or public page uses only figures **cleared** to leave the team.
- **`allow_numbers`** lists numbers that are the project's own facts, not statistics: the
  temperature that defines the process, an award number. The writer may print them anywhere.
- **`assets`** are real images only (`photo`, `diagram`, `logo`), each with `alt` and `credit`.
  One whose `may_publish` is not true goes only on an internal draft.
- **`consent`** names the sources whose words may be quoted on a page that leaves the team, and
  what the consent covers. A quotation from any other source goes on internal drafts only.
- **`brand.font`** embeds a font you hold a licence to embed. Without one, the toolkit's own
  OFL face (Figtree, `assets/one-pager/fonts/`) is embedded, so the page measures and prints
  the same on every machine.

## The objects

| Object | UPC kind | Holds |
|---|---|---|
| A figure | extraction, type `data_point`, in set `exs-<ns>-onepager` | The passage that states the figure's value. Its label, value, the forms the page may print it in, its readings and its rule (if derived) are in the register |
| What a figure is, and who may see it | codings, in set `cds-<ns>-onepager` | Answers in closed codebooks: relevance to each audience, class, a reviewer's check, release |
| A page | synthesis, type `x-one-pager` | The page's words with a citation for every figure, and each figure's passage quoted under hop C. A revision supersedes the one before |
| The register | `<corpus>/.upc/upc-corpus/one-pager/figures.json` (tool state) | Every figure: `id`, `label`, `value`, `unit`, `display`, `source_id`, `quote`, `extraction_id`, `readings`, `tolerance`, `derived`, flags |
| A page's config | `<corpus>/.upc/upc-corpus/one-pager/pages/<slug>.json` | The profiles' paths, the title, the date, the layout, the distribution, writer labels |

`<ns>` is the corpus's namespace (`.upc/upc-corpus/settings.json`), else the one this format
first used in the corpus, kept in `one-pager/settings.json` so the sets keep their ids when the
folder is moved or copied.

## A figure

`onepager.py figures add --from figures.json` takes a JSON list (or `{"figures": [...]}`).

```json
{
  "id": "shelf-days",
  "label": "Shelf life of treated almond milk",
  "value": "7 days",
  "unit": "",
  "display": ["7+ days", "7+"],
  "as_of": "2026-09",
  "source": "<source_id or alias>",
  "quote": "the treated samples kept below the spoilage limit for 7 days",
  "readings": [{"source": "<a second reader's readings>", "quote": "Day 14, treated: 2.80 log CFU/mL.", "value": "2.80"}],
  "tolerance": 0.06,
  "derived": {"from": ["heat-before", "heat-after"], "rule": "(900 - 600) / 900, rounded down", "margin": 0.03},
  "needs_clearance": true,
  "note": "A ceiling: marked ≥ and rounded down."
}
```

- **The value must be in its quote** (`corpus_view.value_in`). A figure read off a chart is
  anchored in a readings table saved as its own source (spec/05's OCR pattern: values, the
  box, the calibration; the slide image as its parent). Two readers are two readings.
- **`rep`** (optional, on a figure or a reading) names one of the source's text representations to
  anchor in instead of its reading copy: for a chart, the readings of that one slide, whose parent
  is the slide's picture, so the passage points at the picture it was read from.
- **Each figure has its own passage.** Two figures on one span are refused: give each the
  span that states it.
- **`display`** lists the forms a page may print ("5-log", "7+", "⅓ less"). A form whose
  numbers are not in the value is flagged `rounded`, and the note asks the engineers whether
  it is fair.
- **Readings** are checked against `tolerance`: each is marked `agrees` or not. A figure whose
  readings disagree stays off final pages.
- **A derived figure** names the figures it is worked out from and its rule; it needs no quote.
  A `margin` within its inputs' tolerance is flagged `thin`: a second reading could reverse it.
- The whole file is checked first; one malformed entry stores nothing. A quotation not found
  in its source drops that figure and is reported (exit 1). Re-adding the same entry changes
  nothing; a changed entry needs `--replace`, and a new passage starts its codings again.

`figures import --from-dossier` adds the figures of a dossier in the same corpus, whose
passages are anchored already.

## Codings: what matters to whom, what a figure is, who checked it

Four kinds of answer, each a closed, single-label codebook made on first use:

| Codebook | Codes | Answered by |
|---|---|---|
| `onepager-rel-<audience id>`, one per audience | `lead` (headline-worthy for this reader), `support`, `background` (true, but not for their page), `avoid` (accurate but wrong for this reader: the wrong units or scale, or an objection the page can't answer) | the model (`code`), then the owner (`review --apply`) |
| `onepager-figure-class` | `measured`, `modelled`, `literature`, `derived` | the model proposes; the owner sets |
| `onepager-figure-check` | `confirmed`, `corrected`, `query` | a reviewer (`signoff --check`), citing their reply, saved as a source with `reply` |
| `onepager-figure-clearance` | `cleared`, `internal-only`, `withheld` | whoever may release the result (`signoff --clearance`) |

- **One codebook per audience** keeps coding one audience from superseding another's answers.
- **Every coder keeps their answer.** A coder's new answer supersedes only their own earlier
  one. The answer that counts is a person's (or an adjudicator's) over a model's; among equals,
  the newest. Disagreements are shown in the review sheet and the figures note.
- **`code` fills gaps.** It asks the model only about figures no one has judged yet for the
  page's audience. Among model answers the newest counts, so a second pass would otherwise
  quietly replace the first; `--redo` asks again on purpose.
- A derived figure has no passage for UPC to code, so its answers are kept in the register in
  the same shape.
- The model's rationale ends with `Angle: …`, how this reader would see the figure. `write`
  passes it on.

## Which figures a page may use

| Blocks | A draft | A final internal page | A partner or public page |
|---|---|---|---|
| `withheld` (the figure or any input) | yes | yes | yes |
| relevance not `lead` or `support` for the page's audience | listed | yes | yes |
| no class | listed | yes | yes |
| not `confirmed` (the figure or any input) | listed | yes | yes |
| readings that disagree | listed | yes | yes |
| not `cleared` (the figure or any input) | — | — | yes |
| a voice quotation from a source without `consent` | listed | yes | yes |
| an image not `may_publish` | listed | yes | yes |

A draft (`build --draft`) is stamped "Internal draft, not for distribution" (or the project's
`brand.draft_stamp`), as is any internal page, and its figures note opens with what is still open
and, from the project's `clearances`, who may release what.

## A page

`onepager.py add --from page.json --writer "<who>"` stores a page written anywhere. `write` asks
the configured model for the same shape, offering only the figures judged `lead` or `support` for
the page's audience, as an enum it cannot leave.

```json
{
  "headline": "Gentler pasteurization, longer shelf life.",
  "subhead": "Two sentences.",
  "hero": {"chart": {"type": "bars", "title": "Heat per batch", "sub": "kWh", "groups": ["Before", "After"],
                     "y": {"min": 0, "max": 1000, "ticks": [[0, "0"], [500, "500"], [1000, "1,000"]]},
                     "series": [{"label": "Heat used", "tone": "cool", "points": ["heat-before", "heat-after"]}]}},
  "tiles": [{"figure": "shelf-days", "big": "7+", "unit": "days", "line": "Why it matters to them.", "source_line": "UC Davis lab trial, 2026"}],
  "how": {"title": "One sentence.", "steps": [{"title": "Recover the heat", "text": "At most 18 words.", "figures": []}], "image": "<asset id>"},
  "status": {"labels": ["Shown in the lab", "Underway", "On the roadmap"], "shown": "…", "underway": "…", "next": "…", "figures": []},
  "cta": {"ask": "Host a pilot run.", "detail": "What they would share or do."},
  "voice": {"source": "<a pseudonymized interview>", "quote": "Their words, copied whole.", "attribution": "A plant manager"},
  "about": {"items": ["Methods, on screen only."]},
  "figures": ["any other figure the page relies on"],
  "plain_numbers": [{"text": "3 steps", "why": "the count of steps below"}],
  "limits": ["What the page leaves out; it goes in the note."],
  "questions": ["For the engineers."]
}
```

- One to three **tiles**; a tile's `big` must be one of its own figure's forms.
- Two to four **steps**, drawn as a numbered process flow (on a phone, a numbered list, since the
  drawing would shrink its words too small to read).
- **Charts** (`bars` with `groups`, or `lines` with `x`) plot figures only: every point is a
  figure id, drawn at its value and labelled with it. Axis ticks are the only numbers the chart
  adds; on a log scale, label the ticks in the reader's units (`[2, "100"]`), not the logs.
- A chart's **`refs`** (`[{"figure": "fda-5log", "label": "5-log target"}]`) draw a dashed line
  at a figure's value, a target or a limit, keyed in the legend. The figure counts as cited and
  the label is checked like the page's other words.
- "About the data" ends with **the numbers behind the hero chart**, a table of the plotted
  figures' own values (their unit in the caption when they share one), so a reader can read
  exact values the chart only shows as shapes.
- On the page, a number keeps its unit on one line ("55 °C", "28 days"), and so does a range
  ("1 to 2") and a "5-log": the build adds no-break spaces and a word joiner, and the checks
  read them as plain spaces.
- **The number check:** every number in the page's words must be a value or display form of a
  figure the page cites, one of the project's `allow_numbers`, or a `plain_numbers` entry with a
  reason (listed in the note). Years (1900–2099) pass. A number inside a word (CO2, an award
  code) is not a number. A verbatim quotation is the source's words, checked at hop C instead.
  Write no number as a word to get round it.
- A rewritten page is a new revision: a new synthesis that supersedes the last, recording the
  wording changes, which the note lists.

## The build

`onepager.py build --slug S --out <dir> [--draft] [--no-pdf] [--no-docx] [--playwright-dir <dir>]`
writes `index.html`, `<slug>.pdf`, `<slug>-figures.md` and `<slug>-figures.docx`, and a build
record beside the folder (`<dir>.build.json`: the files' SHA-256s, the profiles' digests, the
figures and codings it used). `--out` must be empty or a folder an earlier build of the page
wrote; a rebuild replaces only the files the last build made. It refuses, in this order:

1. `upc validate` errors.
2. Figures that changed since the page was written (add the page again).
3. A passage not found again in its source.
4. A figure the table above blocks (`--draft` lists them instead, except `withheld`).
5. An unsourced number.
6. A `never_publish` phrase from either profile, or a local path, in the page, the note or the
   Word copy. The note lists the last revision's wording, so a phrase removed from the page is
   gone from the note one revision later.
7. In headless Chromium: a PDF that is not exactly one page (it names the blocks that run past
   the sheet), sideways scrolling at 390 px, or a browser error.

`banned_words` only warns. The layout sets the order of the blocks: executive (headline, numbers,
voice, how it works, the ask, where it stands), technical (headline, numbers, how it works, where
it stands, the ask, voice), policy (headline, numbers, where it stands, the ask, how it works,
voice). "About the data" shows on screen only. On paper the type is small but not tiny: body
text is 11.5 px (8.6 pt) or more, and only source lines and the footer go below it.

An unchanged page rebuilds to the same bytes: the font is embedded, the PDF's dates are the
page's date, and the Word file's parts carry it too.

The PDF needs a Playwright already installed (`--playwright-dir`, `PLAYWRIGHT_DIR`, or
`playwright_dir` in the toolkit config); nothing is downloaded.

## Known limits

- The page is measured at the printable width before printing; the PDF's page count is the
  check that counts, and the measured blocks only explain an overflow.
- Needs the `upc code` from the same release (CHANGELOG, toolkit 1.2.0): before it, a coder
  going back to an earlier answer (lead, then avoid, then lead) left two answers active.
