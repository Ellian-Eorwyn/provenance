# The small-LLM quotation protocol

A 10-step gate simple enough to follow verbatim. Follow it and you cannot emit a
fabricated quotation: every quote you write is copied from the corpus and checked
by dumb byte-for-byte comparison, and anything that fails is flagged, not shipped.

The whole idea in one line: **draw from the repository and pass the gates when you
use the data — don't type quotes from memory.**

## The 10 steps

1. **Find evidence.** Look in `extractions.csv` (or the browser's Evidence table)
   for an extraction whose `direct_quote` says what you need. Note its
   `extraction_id`.
2. **Never retype a quote.** To quote it, run
   `node scripts/upc.mjs quote <ext-id> --corpus <dir>`. It prints
   `"<the exact quote>" [<ext-id>]`.
3. **Paste that line unchanged.** Do not edit anything inside the quotation marks.
   The marker is what the verifier reads.
4. **Need only part of it?** Run
   `upc quote <ext-id> --narrow <start> <end> --corpus <dir>` (offsets are
   codepoints within the quote). Use the new marker it prints — it mints a real,
   independently verified sub-quote.
5. **Paraphrase freely.** If you want to restate the idea in your own words, just
   write it and add a bare citation `[ext-id]` after the sentence. A bare marker
   is a paraphrase citation and is not gated — but it also must not have quotation
   marks around borrowed wording.
6. **Quotation marks are a promise.** Only ever put straight double quotes around
   text that came out of `upc quote`. If it is not a pasted quote, do not quote it.
7. **Verify your output.** Run
   `node scripts/upc.mjs verify-quotes <your-file> --corpus <dir>`.
8. **On failure, fix it, don't force it.** `output_quote_mismatch` means your
   quoted text is not exactly the extraction's — re-paste from `upc quote`, or turn
   it into a paraphrase. `output_cites_unknown_extraction` means the id is wrong.
   `cited_extraction_not_quotable` means you cited a paraphrase-only extraction as
   a quote — cite it bare or quote a different extraction.
9. **If it can't be verified, mark it.** Evidence you cannot anchor stays a
   paraphrase, and you write `(unverified)` next to any claim you could not back.
   Never dress an unverified claim as a quotation.
10. **Ship only on exit 0.** `verify-quotes` exiting 0 means every quotation you
    emitted is real. That is the bar.

## Why this works

`upc quote` reads the extraction, confirms it still matches its source
(hop A + hop B), and prints the exact bytes. `verify-quotes` re-checks every
marker in your output against the extractions (hop C). Because both comparisons
are exact and no normalization is applied, there is no room for a quote to drift:
either it is byte-identical to a real, source-verified extraction, or it is
flagged. You do not need to be a large model to be trustworthy here — you only
need to follow the steps.

## The two marker forms

- **Inline** (default, from `upc quote`): `"the exact quote" [ext-0123456789ab]`.
  The quote has no line breaks or double quotes inside it.
- **Block** (for a quote containing a newline or a `"`):

  ````
  ```quote ext-0123456789ab
  the exact multi-line
  quoted text
  ```
  ````

Soft-wrapped clean representations keep most quotes on one line, so the inline
form is almost always what you need.
