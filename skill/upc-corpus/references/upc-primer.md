# What a corpus is, in plain words

Five kinds of thing. That is the whole model.

| Thing | What it is | In the corpus |
|---|---|---|
| **Source** | One paper. | `sources/<slug>/source.json` |
| **Copy** | One rendering of that paper: the PDF, and the text pulled out of it. | `representations[]` inside the source |
| **Passage** | A span of text quoted exactly from one copy, with its position. | `extractions.jsonl` |
| **Code** | Somebody's judgement about a passage or a paper. | `codings/<set>/items.jsonl`, against a `codebooks/<id>.json` |
| **Overview** | Prose written from passages, carrying a list of what it claims and what backs each claim. | `syntheses/<id>/` |

Ids say what they are and are derived from content, so the same bytes always
produce the same id: `src-` source, `rep-` copy (`img-` for a picture), `ext-`
passage, `cod-` coding, `cbk-` codebook, `syn-` overview.

## The one promise

A passage's text is compared with the document, character for character, every
time anything is validated or rendered. There is no fuzzy match at that moment.
If the document changed, the passage is reported as broken rather than quietly
adjusted.

That is why nothing here ever types a quotation from memory. The workflow is
always: propose text → let `upc anchor` find it → use the id it gives back.

## What the tool will refuse to do

- Write a quotation it could not find in the document (`not_found`).
- Write a quotation that appears twice, because the position would be a guess
  (`ambiguous`).
- Write an overview that misquotes a passage it cites, or that never names a
  source its claims rest on.
- Let a code stand in for a position. A code always points at something that
  already passed the check; it never carries a location of its own.

## What "checked" does and does not mean

It means: this text is really in that copy, at that position.

It does **not** mean the paper is right, that the model chose a sensible passage,
or that the code is the one you would have chosen. Those are judgements, and the
corpus records who made them rather than certifying them.

A quotation taken from PDF-extracted text is badged "checked against the
extracted text" rather than "checked against the original", because the layout,
hyphenation and page numbers of the PDF are not in the text.

## Where the model may and may not be trusted

| Task | Who decides |
|---|---|
| Which passages matter | The model. That is judgement, and it is recorded as such. |
| Whether a passage exists | The tool, byte by byte. Never the model. |
| Which code applies | The model or a person, always recorded with the coder's name. |
| Whether two coders agree | Neither. Both judgements are kept and shown. |

## Positions

A passage's position is a character range into one copy, counted in Unicode
codepoints from zero. Line and page numbers shown to a reader are conveniences
computed from that range; they are navigation, never evidence.
