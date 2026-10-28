# Full text from publisher XML

Some papers come only as the publisher's full-text XML (Elsevier's Article Retrieval API gives
an entitled request the whole article as XML, but its PDF is the first page). This note says
how such a paper becomes a source that can be read, quoted and cited like a PDF, and what
never changes once it is in a corpus.

## What a source holds

| Representation | Role | What it is |
|---|---|---|
| The XML, as fetched | `original` (`text/xml`) | The evidence. Linked from the paper's page; never shown as the reading copy. |
| The reading copy | `text` (`text/plain`), parent the XML | `xmltext.py`'s plain text: `# ` headings, one block per paragraph, a table's rows as lines of cells joined by ` \| `, captions as "Fig. 1. …", notes, references. Every passage is anchored here by `char_range`. |
| The structure map | `metadata` (`application/vnd.upc.structure+json`), parent the reading copy | What each block of the reading copy is, its section and its paragraph number (spec/02 "Structure"). Added by `paginate.py`. |

`add_acquired.py` (kind `xml`) and `ingest.py` (an `.xml` manifest row) store the first two.
`paginate.py` adds the third after coding (Task 3, step 10).

## The rule that never bends: the reading copy's bytes

Every quotation is anchored in the reading copy by codepoint offsets. So once a corpus has
passages, its reading copies **must never change**, not by a byte. That is why:

- each new `xmltext.py` must write exactly the text the version before it wrote. The tests
  compare it with a frozen copy of 1.1.0 (`tests/frozen/xmltext_1_1_0.py`) on every fixture;
  with `UPC_XML_SAMPLES=<folder of .xml>` set they compare every real file there too;
- structure is never written into the text (no new headings, no ¶ numbers). It lives in the
  map, beside it;
- `paginate.py` makes a map only when converting the XML again gives the stored reading copy
  byte for byte. A copy made another way (an earlier converter, by hand) is named under
  `text differs …` and left without a map: its passages keep line numbers and stay verified.

## How a passage is cited

`paginate.py` gives each passage a `section` secondary locator (spec/03 "A section and its
paragraph"): the section's number and title, the paragraph it starts in, the kind of block,
and a table's, figure's or note's own label. Every output cites it the same way:

| Where the passage starts | Cite |
|---|---|
| A paragraph in a numbered section | `§3.2 ¶4` |
| A paragraph in a section without a number | `Abstract ¶1`, `Acknowledgements ¶1`, `Appendix A ¶2` |
| A table row, caption or table note | `Table 2`, `Fig. 1` |
| A footnote | `n. 3` |
| The reference list, the keywords | `References`, `Keywords` |

A paragraph is counted within its own section: §3 ¶2 and §3.1 ¶2 are different paragraphs.
The rule lives once in each language (`common.py` `place_of`, `upc_common.mjs` `placeOf`), and
both are tested against `tests/section-cites.json`.

The site's passage cards, the browse view and its spreadsheet, the corpus browser's chips,
the Annotated List, dossiers and one-pagers all use it where a PDF passage says `p. 12`.

## What a reader sees

The paper's page shows the reading copy as the paper it is: headings, tables as tables,
captions and notes set apart, each paragraph's number in the margin (outside the text, so a
copied quotation never picks it up), a section whose heading the text lacks named above it,
and the passages highlighted. One line says it was converted from the publisher's full-text
XML, with links to the XML (copied into the site bundle) and the DOI. The badge stays
**verified**: XML to text is a text-to-text conversion (spec/09).

A paper without a map (rawtext, a `text differs` copy) shows its text plainly, as before.

## Checking one paper by hand

```
<python> <skill>/scripts/xmltext.py <file.xml> --info
<python> <skill>/scripts/xmltext.py <file.xml> --blocks > <scratch>/map.json
```

`--info` must say `"full_text": true` and `"format": "elsevier-ce"` (a `rawtext` paper gets no
map). `--blocks` writes the map as JSON: each block's kind, span (`c0`, `c1`), section (`s`)
and paragraph (`p`).
