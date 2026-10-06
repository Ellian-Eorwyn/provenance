# Writing a codebook

A codebook is the research design, not a config file. Write it with the person
whose review it is; the codes decide what the corpus can later say.

The definition file is a plain list. `make_codebooks.py` mints the ids.

```json
[
  {"slug": "theory", "title": "Theory or framework", "unit": "either",
   "multi_label": true,
   "question": "Which transitions theory does this passage invoke or discuss?",
   "codes": [
     {"code": "mlp", "label": "Multi-level perspective",
      "definition": "Explains transitions through the interaction of niche, regime and landscape levels. Not any passing mention of 'levels' in a general sense.",
      "examples": ["niche-innovations build up internal momentum"]}
   ]}
]
```

## The fields that matter

| Field | Why it matters |
|---|---|
| `definition` | This is the prompt. A vague definition produces vague coding, from a model *and* from a person. |
| `examples` | One real-sounding example does more than three more sentences of definition. |
| `unit` | `passage`, `source`, or `either`. A count that mixes the two is meaningless, so this decides how results are reported. |
| `multi_label` | True when several codes can apply at once. False makes a second answer from the same coder *supersede* the first. |
| `closed` | True means only these codes. False lets a coder write a free value — useful for a theme you cannot enumerate yet, but harder to aggregate. |

## How to write a definition

One sentence of what it means, one of what it excludes:

> **Actors.** Who is involved: their identity, roles and composition. *Not* the
> power they hold, which is coded separately.

The exclusion clause is what stops two neighbouring codes collapsing into each
other. If two codes cannot be told apart by their definitions, a coder will
apply them inconsistently and every count that uses them will be soft.

## Choosing the codes

- **Come from the questions.** If the research question names ten theories and
  six dimensions, that is two codebooks, not one with sixty codes.
- **Cross-cutting dimensions belong in separate codebooks.** A passage is about
  a theory *and* about power *and* about installers. Crossing two codebooks is
  what makes a comparison table possible; one flat list of codes cannot.
- **Include a `none`.** Without somewhere to put "this code does not apply", a
  coder will stretch the nearest one.
- **Keep it under about a dozen codes per book.** Beyond that, coders stop
  holding the whole scheme in mind and the tail codes go unused.

## Editing later is safe

A codebook's id is a hash of its namespace and slug only, never of its codes. So
you can rewrite every definition, add codes and relabel them, and no existing
coding is re-minted or orphaned. `make_codebooks.py` bumps the `revision` and
recomputes the digest; codings record which revision they were made under, so
the validator can tell you which judgements predate a definition change.

What you should **not** do is reuse a code token for a different meaning. That
silently rewrites history, because old codings still carry the token.

## After the first pass

Run `report.py`. Two signals matter:

- **A code nobody used.** Either the literature does not contain it, or the
  definition did not land. Read a few passages before deciding which.
- **A code that swallowed everything.** Usually a definition without an
  exclusion clause. Split it, or tighten it, and re-run that pass under a new
  coder handle so the two are comparable rather than overwritten.
