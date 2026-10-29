# How this library was made

**Draft: copy this file to `<corpus>/.upc/upc-corpus/site/methods.template.md`, make the words the project's own (the bracketed paragraphs above all), and have them approved.** `methods.py` fills the numbers in braces from the corpus and prefers the corpus's copy; this line never reaches the page.

This is the **updated edition** of the {title} ({date}). It holds the same {papers} papers and {passages} passages as the [original edition]({original}), and adds four things:

- every passage opens to the sentences around it ("In context");
- every paper carries an **advisory rating of its evidence**, made by a language model, and, separately, its **citation standing**;
- every statement of an overview can show **how well its passages support it**;
- the {themes} theme overviews were **rewritten from the rated evidence**, and so was the summary on the home page. Each says "{revision_label}" and links to its previous version in the original edition;
- a **Findings** page lists every statement of the overviews with how well it is supported, where its evidence comes from and what kind of statement it is, with starting points for the project's own questions; an **Evidence map** shows each overview's support at a glance; each overview opens with its **Key findings**; and each paper's page leads with what it contributes.

Ratings are judgements, shown as outlined chips and folded cards, and never as check marks. A check mark (✓) still means only one thing: the quotation was found word for word in the paper's text.

## How the papers were chosen

[Say where the papers came from: what was searched, where, and what rules decided what went in. If no rule set a year, kind of study or peer review, say so; readers will ask.]

## How the passages were chosen

A language model read each paper in full and marked the passages that bear on each theme of the codebooks. A separate tool then checked every proposed quotation character by character against the paper's text and kept only those it found: {passages} of {proposed}. "Worth quoting" meant "relevant to a theme", not "strong evidence"; the ratings below add that.

## How the evidence was rated (advisory)

A local language model ({model}, temperature {temperature}) rated every paper three times, with the order of the passages shuffled each time; the answer most runs gave stands. It read each paper's text **without** its venue, its citation counts, its reference list or the earlier relevance screen.

**Papers → a grade.** The model first names the paper's design, which picks one of five checklists adapted from published appraisal tools: quantitative or causal studies (after [MMAT 2018](https://journals.sagepub.com/doi/abs/10.3233/EFI-180221) and the [Maryland Scientific Methods Scale](https://whatworksgrowth.org/resource-library/the-maryland-scientific-methods-scale-sms/)); engineering measurement and modelling (after [ASHRAE Guideline 14](https://www.osti.gov/servlets/purl/1407808) and [Fowlie et al. 2018](https://www.nber.org/papers/w21331)); qualitative and case-study research (after [CASP](https://casp-uk.net/checklists-archive/casp-qualitative-studies-checklist.pdf) and [Gibbert et al. 2008](https://sms.onlinelibrary.wiley.com/doi/10.1002/smj.722)); theory and reviews (after [JBI Text and Opinion](https://jbi.global/sites/default/files/2020-08/Checklist_for_Text_and_Opinion.pdf) and [Jaakkola 2020](https://doi.org/10.1007/s13162-020-00161-0)); and reports (after AACODS, [Tyndall 2010](https://dspace.flinders.edu.au/xmlui/handle/2328/3326)). Each checklist asks 7 or 8 concrete questions, answered yes, partly, not found or can't tell. A yes or partly counts only with a quotation from the paper that was confirmed word for word; otherwise it becomes can't tell. Rules, not a sum, turn the answers into a grade, after [GRADE](https://training.cochrane.org/handbook/current/chapter-14): a paper starts at its design's level and goes down for an unmet or unclear critical question. The grade judges how well a paper's own evidence supports **its own conclusions**, not its importance or its relevance to the project.

- Designs: {designs_line}.
- Grades: {grades_line}.

**Passages → whose claim, and what backs it.** Each passage is labelled with whose claim it makes (the paper's own finding, an interpretation, theory, a recommendation, something reported from other work, background or speculation) and what backs it in the paper (data, cases, a cited study, argument only, or nothing shown), after [Rinott et al. 2015](https://aclanthology.org/D15-1050/) and [Lauscher et al. 2018](https://aclanthology.org/W18-5206/). A passage that relays other work does not take its paper's grade.

- Whose claim: {origins_line}.

**Statements → support.** Each statement of an overview was checked against the passages it cites: does each one support it, partly, or not, and if partly, does the statement say more than the passage (broader, stronger, another setting, or relaying others)? Each statement then gets a confidence in the [IPCC's calibrated language](https://www.ipcc.ch/site/assets/uploads/2018/05/uncertainty-guidance-note.pdf): the evidence (limited, medium or robust: how many independent studies make the claim themselves, and how well graded) against the agreement (low, medium or high: how well they support it; one study alone can't agree with itself, so it is at most medium).

**Independent means a different lead author.** Papers whose first author is the same count as one study: three papers by one author restating a framework are one voice, not three. {same_lead} statements are backed only by papers that share a lead author; they are marked "one lead author". A passage that only relays other work counts for none.

The pages say the IPCC level in plain words, and show the IPCC term when you hover over it:

- **Well supported**: very high or high confidence. The two are one word here because the line between them isn't stable: in two checks of the same summary they swapped places.
- **Some support**: medium confidence.
- **Limited**: low confidence. Most limited statements rest on one study, which makes them leads to test rather than failures.
- **Weak or unclear**: very low confidence, not supported by its passages, or runs that disagreed.

Each overview's Key findings list its best-supported statements first; tick "Show support for each statement" under an overview for the full check.

## How far to trust the ratings

No study yet shows a language model doing these appraisals end to end, and people disagree with each other about them too ([Minozzi et al. 2020](https://www.jclinepi.com/article/S0895-4356%2820%2930181-5/abstract)). So:

- **Between the three runs**, the answer was the same every time for {run_agree}.
- **Against a second rater:** {blind_who}, coding {blind_papers} papers and {blind_passages} passages blind to these ratings, agreed {blind_line}. [If the second rater is a model, say whether any person has double-coded papers yet.]
- Where agreement is low, the ratings are still shown but marked so, and kept out of the filters.

AI use is disclosed as the [Cochrane, Campbell, JBI and CEE 2025 statement](https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.ED000178/full) asks: every rating says it is model-made and advisory.

## Citations, beside the grade and never in it

Each paper also shows how often it is cited compared with other works of its field and year, from [OpenAlex](https://openalex.org/) ({citations_date}), in tiers: {impact_line}. A paper under 24 months old is "too recent". Citations measure attention, not rigour: field-normalised citations correlate with expert ratings of quality at only about 0.1–0.5 ([Thelwall et al. 2023](https://arxiv.org/abs/2212.05416)), and here most papers are already in their field's top 10%. So the two are shown side by side and never combined ([Leiden Manifesto](https://www.nature.com/articles/520429a); [DORA](https://sfdora.org/read/)).

## Findings: kinds of statement, and where the evidence comes from

These are rules over the labels above, not new judgements by a model.

- **What kind of statement.** A *finding from data or cases* is backed by a paper's own finding or interpretation that rests on data or cases. A statement *about a framework* is backed only by theory, background or relayed passages with no data or cases. A *recommendation* is backed only by recommendations, speculation or theory. Anything else is an *argument or interpretation*. Kinds rest on the whose-claim labels, which the three runs gave identically for {origin_agree} of passages, so read them as a guide.
- **Where the evidence comes from.** Each paper's place is a rule over the countries most runs named when they read its design: the United States, Europe, elsewhere, or no one place (theory, most reviews, global studies). Papers: {places_line}. A statement's places are those of the papers that support it with their own claims; a statement only relayed from other work has none.
- **Starting points.** The Findings page can open with filters the project names in its findings settings (`.upc/upc-corpus/site/findings.json`), each with a note on how to read it. [Name them here, and the question each one serves.]

## The overviews

The original overviews were written from at most 26 passages per theme, chosen in effect arbitrarily, by a model that saw no author, year or design; {old_single} of {old_statements} statements rested on one paper. The revised overviews were written from up to 30 passages per theme, strongest evidence first and spread across papers, each with its author, year, design, grade and setting. Before writing, the model read each theme's independent passages together and grouped those from different papers that make the same claim; each group became one statement citing every paper in it, and the statement check then decided which of them really support it. A general statement needs two papers that make the claim themselves; a single-paper statement names its paper; a claim relayed from other work says so; evidence from elsewhere says where it is from; every sentence cites. A checker lists every rule it can see broken and the model rewrites once; what is left is recorded.

- Statement support, original overviews: {support_old} (IPCC: {conf_old}).
- Statement support, revised overviews: {support_new} (IPCC: {conf_new}).

The summary on the home page was rewritten by a language model ({home_model}) from the revised overviews and their statement checks, then checked the same way: {home_line}. Where several studies agree it says so; where a point rests on one study it names that study.

## The relevance screen

A separate screen (core, candidate, orientation, exclude) was run on the original edition and is still shown on each paper's page. It played no part in choosing passages or writing either edition's overviews.
