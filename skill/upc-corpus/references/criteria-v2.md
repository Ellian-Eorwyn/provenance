# Overviews from rated evidence: criteria v2

Approved 2026-10-05. What `synthesize.py --v2` does when it rewrites a theme's
overview from the rated evidence, and why. The rubric for the ratings themselves is
`appraisal/rubric.md`. The code is in `scripts/synthesize.py` (section "v2"), and its tests are in
`tests/test_appraise.py` (`SynthesizeV2Tests`).

## Why there is a v2

The first library's overviews (criteria v1, 179 papers) judged no evidence:

- each theme's model saw at most 26 passages, and they were the **first 26 by passage id**, a hash, so the
  choice was arbitrary. `evidence_lines()` meant to spread the passages across papers, but its "already seen
  this paper?" set was filled only after sorting, so it was always empty (fixed 2026-10-05: `spread()`);
- the model saw no author, year, design or grade;
- **92% of statements rest on one paper**, and about a quarter of sentences cite nothing.

## Which passages the model sees

1. **Candidates:** every passage coded with the theme's code, from listed passages only (never a hidden
   rating quotation).
2. **Rated papers only.** A passage whose paper has no grade isn't offered. In the full run every paper is
   rated; in the pilot this is why a theme can draw on fewer papers than v1 did.
3. **Ranked:** by the paper's grade (High, Moderate, Low, Very low), then whose claim the passage makes
   (own finding, then interpretation, then theory or recommendation, then relayed, background or speculation),
   then what backs it (data or cases, then a cited study or argument, then nothing).
4. **Spread:** the best passage of each paper first, strongest paper first; then each paper's second; then its
   third. **At most 3 passages per paper, and 30 in all.**
5. Each passage reaches the model with a header: **author and year, design, evidence grade, setting** (target =
   US residential buildings; near; elsewhere), **whose claim** and **what backs it**.

## Claim groups (criteria-v2.1, added 2026-10-05)

Under v2 alone, 850 of the 860 revised statements still rested on one paper: the writer read the passages one
by one and couldn't see which papers said the same thing, so the confidence cap for one paper (agreement at
most medium) kept nearly every statement at low. v2.1 finds those papers first (`scripts/claim_groups.py`):

1. **Who takes part:** the passages the statement confidence counts as independent, that is every passage of a
   rated paper except relayed ones (reported from cited work, background) and speculation. The strongest first,
   at most 3 per paper and 70 per theme.
2. **The model reads them together** (`chat`), placed so that passages with similar embeddings sit side by
   side, and names groups of passages from different papers that make **the same claim**, each with the claim
   in one sentence. One call misses groups by chance (Electric vehicles got none on one seed and two good ones
   on another), so it is asked **three times** and every checked group is kept; a passage stays in the
   largest group that has it. Embedding similarity alone was tried and refused: within one
   theme every passage is about the same subject, so similarity can't tell a shared claim from a shared topic.
3. **Code checks** every key is one it gave, every group spans two papers or more, and no passage is in two
   groups.
4. **The writer gets the groups first** (most papers first, at most two thirds of the 30 passages), each cut to
   its **6 strongest papers** and under a heading naming the claim and how many papers make it (a large group is
   cut, not dropped: the first pass on 10-05 dropped Niche's 24-paper group), then the strongest single passages as before. Rule 11 asks for one statement per
   group that cites every passage that really makes the claim, says how many papers found it and where, and
   leaves out any that don't.

A group is a hint, not evidence. The statement check afterwards asks of each cited passage whether it supports
the statement; only a passage that does counts toward agreement. Groups are saved per theme in
`.upc/upc-corpus/claim-groups/`. In theory themes (the multi-level perspective) most groups are papers
restating the framework's definitions: they agree on what the framework says, which is not a test of it.

## The rules (in the prompt, and checked in code)

| | Rule | Checked in code? |
|---|---|---|
| 1 | A quotation is one of the given passages, copied whole with its marker; anything else is the model's own words with a bare marker. | Yes: `upc add synthesis` refuses a misquotation; a near-quotation loses its quotation marks (`unquote_misquotes`). |
| 2 | **Every sentence cites** at least one passage, including a paragraph's first sentence. | Yes: a sentence over 25 characters without a marker. |
| 3 | A **general statement needs two papers** that make the claim themselves; otherwise it is attributed to its paper ("One UK case study (Author Year) found …"). | Yes: a sentence whose own-claim passages come from one paper must name that paper's author or say "one study", "a survey", "found", "argue" and the like. |
| 4 | A **relayed** passage (reported from cited work, or background) is said to be relayed ("citing earlier studies") and **never counts as a second paper**. | Yes: a sentence resting only on relayed passages must say so ("citing", "earlier studies", "reports that"). The statement check counts only non-relayed papers as independent. |
| 5 | **Analogies are labelled:** evidence from another country or sector, applied to US homes, says where it is from. | Partly: the setting is in every header; the statement check flags "other setting" gaps. |
| 6 | Lead with the strongest evidence; say plainly when a point rests on one paper or on Low or Very low evidence. | No: the ranking puts the strongest first; the support columns show it. |
| 7 | Say where papers disagree. | No. |
| 8 | 400–650 words, paragraphs, no preamble or headings. | Yes: word count (350–720 tolerated). |
| 9 | The header's labels are never copied into the text; it says "in the UK", "a modelling study", "citing earlier studies". | No: in the prompt only. |
| 10 | Papers are said to agree only when their passages make the same claim. | No: the statement check shows it. |
| 11 | (v2.1) A **claim group** becomes one statement citing every passage that makes the claim, saying how many papers and where. | No: the statement check decides which passages support it. |
| 12 | A claims register: each substantive claim with every passage it rests on. | Yes: a missing or broken register is a problem. |

**Two passes.** The model writes a draft; the code lists every problem it can see (rules 2, 3, 4, 8, 12 and
unknown markers); the model gets its draft and that list and rewrites the whole overview; the code checks again.
The version with fewer problems is kept, and **what is left is recorded** in the synthesis
(`ext["upc-corpus"].checks_first` and `checks_left`), never hidden.

## Each statement's confidence

After the rebuild, `appraise.py statements --set revised` checks every statement of the new overviews against
the passages it cites (three runs, majority vote): does each passage **support** it, **partly**, or **not**,
and if partly, is the statement **broader**, **stronger**, from **another setting**, or **relaying others**?
`vote` then gives each statement an IPCC-style confidence: evidence (limited, medium, robust: how many
independent papers, how well graded) × agreement (low, medium, high: how well the passages support it), as
in `appraisal/rubric.md`, Level 3. `store` writes them as a support matrix beside the overview; the page shows
them behind "Show support for each statement".

## Where the result goes

- The revised overview is a new synthesis with `supersedes` the overview it replaces (UPC 1.15.0); both stay
  in the corpus. The site shows the revision at the **same address**, labelled
  "Revised from rated evidence · <date>", linking to the previous version in the original edition
  (`publish.py --original-edition <url>`).
- Its record names the criteria (`criteria-v2.1`, or `criteria-v2` with `--no-groups`), the claim groups it
  was given, the ratings (`appraise.v1`), how many passages and papers it
  was given, and the checks before and after the fix pass.

## Deferred

- Searching the corpus for passages that **contradict** a statement (rule 7 is prompted, not checked).
- Include and exclude rules applied when a corpus is first gathered, with a person's approval at entry.
- People's calibration: about 25 papers double-coded by people, about 5 per profile.
