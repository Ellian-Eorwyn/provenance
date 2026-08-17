# Re-extraction from the literature (via prompting)

A human can ask for the evidence to be pulled again — for a new question, or after
a better cleaning pass. This is a first-class workflow, and it keeps the byte-exact
gate intact: **the model chooses *what* to extract; the tool guarantees *that it is
real*.** Nothing unanchored is ever written as if it were verified.

## The protocol

1. **Pick the target representation.** Re-extraction always runs against one
   specific textual representation (a `clean_markdown`, `text`, `transcript`, or
   `ocr` role). Its `rep-<id>` and its exact bytes are the ground truth.

2. **The model proposes candidate quotations as data, not prose.** Prompt the LLM
   to return a JSON array of candidates, each a *verbatim* span it believes is in
   the representation, plus optional context to disambiguate:

   ```json
   [
     { "quote": "cut over DNS only after the staging copy is fully validated",
       "type": "evidence", "query": "How do you migrate without downtime?",
       "note": "answers the cutover-timing part" }
   ]
   ```

   Instruct the model to copy spans exactly (no ellipses, no fixed-up punctuation,
   no re-wrapping) and to prefer shorter, exact spans over long paraphrased ones.

3. **The tool anchors each candidate byte-exactly.** For each `quote`, search the
   representation's UTF-8-decoded text for a byte-exact occurrence:

   - **Exactly one match** → mint a `char_range` extraction at that codepoint
     offset. It passes hop B by construction; store it `status: active`.
   - **No match** → do **not** write a quotation. Return the candidate to the
     model as `not_found` so it can retry with a corrected span, or record it as a
     `text`-only (paraphrase) extraction with `status: needs_review`.
   - **Multiple matches** → ambiguous; return the candidate `ambiguous` with the
     offsets so the model (or a human) can pick, or store `needs_review`.

4. **Re-validate and regenerate.** Run `upc validate` (every new quotation is
   gated) and `upc regen` (refresh the CSV mirrors and browser).

The pseudocode the tool runs:

```
for cand in candidates:
    hits = all byte-exact occurrences of cand.quote in repText
    if len(hits) == 1:
        start = codepoint_offset(repText, hits[0])
        mint extraction { direct_quote: cand.quote,
                          locator: char_range(rep, start, start+len_codepoints(cand.quote)),
                          status: active, ... }
    else:
        record { quote: cand.quote, status: needs_review, candidates: len(hits) }   # never "active"
```

## Why the gate stays intact

The model never gets to *assert* that a quote is real — it only *proposes* text.
The tool's byte-exact search is the arbiter, and it only mints an `active`
quotation when the span is provably in the source. A hallucinated or
lightly-misremembered span simply fails to anchor and is flagged, exactly like any
other gate failure. This is the same guarantee as `upc quote` / `upc verify-quotes`,
applied at extraction time instead of emission time.

## Re-rendering vs re-extraction

- **Re-render** (the representation bytes change → a new `rep-` id): use
  `upc reanchor`, which byte-exact-searches the *successor* representation for each
  existing quote and re-locates it, or flags `needs_review`. Use this when the
  quotes are unchanged but their offsets moved.
- **Re-extract** (this document): use when you want *different* evidence — a new
  question, a new pass — not merely to move existing quotes.

Both are non-destructive: old extractions are superseded or flagged, never
silently rewritten, and every resulting quotation is byte-exact or labeled.
