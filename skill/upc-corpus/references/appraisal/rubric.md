# Rating the evidence: the rubric

Approved for its first library on 2026-10-05. Whoever runs a project owns this wording, the profiles in
`profiles/`, the design list in `designs.json` and the domain packs in `domains/`: `appraise.py` reads those
files, so a project that needs other wording copies and edits them. Approve the wording before a full run.

The ratings answer a reader's question about a library of overviews: what holds them up? They do it at three
levels: papers, passages, and the statements an overview makes. Citation impact is shown beside them and never
combined with them.

## Principles

- **Rules, not sums.** Each paper answers a short list of concrete questions, and rules turn the answers into a
  grade. Scores are never added up: MMAT 2018 advises against a total, and a sum lets a strength in one place
  hide a fatal weakness in another ([Hong et al. 2018](https://journals.sagepub.com/doi/abs/10.3233/EFI-180221)).
- **Standards depend on the kind of research.** An argument is judged by its own field's standards (Toulmin,
  [The Uses of Argument](https://catdir.loc.gov/catdir/samples/cam034/2003043502.pdf)), and energy social science
  has codes of practice per method family
  ([Sovacool, Axsen & Sorrell 2018](https://doi.org/10.1016/j.erss.2018.07.007)). So a paper is rated under a
  **profile** chosen by its design.
- **Every judgement shows its evidence.** A "yes" or "partly" must quote the paper, and the quotation is checked
  character by character (`upc anchor`). Without a quotation that checks, the answer becomes "can't tell".
- **The rater sees the paper, not its reputation.** The model never sees the venue, the citation count or the
  earlier relevance screen.
- **Repeated, then voted.** Three runs at temperature 0.3, with the passage order shuffled, then a majority
  vote. When all three runs differ, there is no majority: an answer becomes "can't tell", and a statement
  whose every passage split three ways is shown as "runs disagreed". One model run correlates with expert quality scores at about r = 0.28, and the mean of 15 runs at 0.51
  ([Thelwall 2024](https://arxiv.org/abs/2402.05519)).
- **Advisory, and said so.** Models appraise modestly: risk-of-bias κ was 0.22–0.33 against experts, while
  people manage only 0.16 with each other
  ([Eisele-Metzger et al. 2025](https://www.cambridge.org/core/journals/research-synthesis-methods/article/exploring-the-potential-of-claude-2-for-risk-of-bias-assessment-using-a-large-language-model-to-assess-randomized-controlled-trials-with-rob-2/672B8B7C9DC80FDB60D9C2373D9BF278);
  [PLOS ONE 2026](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0353155);
  [Minozzi et al. 2020](https://www.jclinepi.com/article/S0895-4356(20)30181-5/abstract)). Every rating is
  labelled advisory and model-made. The site says how often runs agree and how often a blind second coder
  agrees, and discloses the AI use, as the
  [Cochrane, Campbell, JBI and CEE 2025 statement](https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.ED000178/full)
  requires. No study yet validates a model doing GRADE, MMAT, CERQual or AACODS end to end.

## Level 1: papers → a grade

### The six dimensions
The research briefing's dimensions, after EPPI-Centre's Weight of Evidence
([Gough 2007](https://discovery.ucl.ac.uk/id/eprint/1548262/1/Gough2007Weight213.pdf)) and MMAT. Each profile
asks 6–8 questions, each tagged with one dimension.

| | Dimension | What it asks of the paper |
|---|---|---|
| D1 | Evidence basis | What evidence does the paper itself generate or use: metered data, an experiment, a survey, interviews or documents, a model, or opinion? |
| D2 | Design–claim fit | Can the design answer the paper's own question, and do its conclusions stay within what that design can show? |
| D3 | Execution and bias control | Was the study done carefully, in the ways its kind of research requires? |
| D4 | Adequacy and precision | Enough cases, sites, time or data for the claims; uncertainty reported. |
| D5 | Corroboration | Triangulation within the study, and engagement with other work, including work that disagrees. |
| D6 | Transparency and independence | Data, code, assumptions, funding and interests disclosed; who issued it and how it was reviewed. |

### Design → profile
The model first names the paper's design, one of 12 in `designs.json`, which picks the profile:

| Profile | Designs | ★ critical | Adapted from |
|---|---|---|---|
| Quantitative / causal | experimental or quasi-experimental; observational quantitative | D2, D3 | MMAT 2018 §2–4; [Maryland Scientific Methods Scale](https://whatworksgrowth.org/resource-library/the-maryland-scientific-methods-scale-sms/); [WWC v5.0](https://ies.ed.gov/ncee/wwc/Docs/referenceresources/Final_WWC-HandbookVer5.0-0-508.pdf) |
| Engineering: measurement and modelling | measured performance; model or simulation | D1, D4 | Sovacool et al. 2018 (modelling code); ASHRAE Guideline 14 ([via OSTI](https://www.osti.gov/servlets/purl/1407808)); [Fowlie et al. 2018](https://www.nber.org/papers/w21331); [Gleeson & Lowe 2013](https://www.sciencedirect.com/science/article/abs/pii/S0378778813004556) |
| Qualitative / case study | case study; interviews, focus groups, ethnography or documents | D3, D2 | MMAT 2018 §1; [CASP qualitative](https://casp-uk.net/checklists-archive/casp-qualitative-studies-checklist.pdf); JBI qualitative; Lincoln & Guba ([Nowell et al. 2017](https://journals.sagepub.com/doi/10.1177/1609406917733847)); Yin 2018; [Gibbert et al. 2008](https://sms.onlinelibrary.wiley.com/doi/10.1002/smj.722); [GRADE-CERQual](https://link.springer.com/article/10.1186/s13012-017-0688-3) |
| Theory and reviews | systematic review; narrative review; theory or conceptual; commentary | D2, D5 | [JBI Text and Opinion](https://jbi.global/sites/default/files/2020-08/Checklist_for_Text_and_Opinion.pdf); SANRA; Toulmin; [Jaakkola 2020](https://doi.org/10.1007/s13162-020-00161-0); [CEESAT](https://environmentalevidence.org/ceeder/about-ceesat/) |
| Reports (grey literature) | a report, working paper or thesis not written as a journal study | D6, D1, D4 | AACODS ([Tyndall 2010](https://canberra.libguides.com/c.php?g=599348&p=4148869)) |

**Two strands.** A mixed-methods paper is rated under each strand's profile, and a report that carries its own
data or model is also rated under that design's profile. The paper takes the **weaker** of the two grades.
MMAT 2018 rates mixed methods by their strands, and the research briefing says a report with its own data
"take[s] the lower result".

### Answers
Each question is answered with one of:

- **yes**: the paper does this, shown by a quotation;
- **partly**: it does some of it, shown by a quotation;
- **not found**: the paper does not do this, or does not say so anywhere;
- **can't tell**: the text is unclear or garbled, or the answer's quotation did not check.

The model also gives a reason of 25 words or fewer.

### From answers to a grade (rules, after GRADE)
GRADE starts each body of evidence at a level set by its design and moves it down for problems
([Cochrane Handbook ch. 14](https://training.cochrane.org/handbook/current/chapter-14)). Here, for one paper:

1. **Start** at the design's level in `designs.json`:
   - High: experimental or quasi-experimental, measured performance, systematic review;
   - Moderate: observational quantitative, model or simulation, case study, qualitative interviews, narrative review, theory or conceptual, report;
   - Low: commentary.
   - **1b.** A systematic review keeps its High start only if it shows what makes it systematic, as its
     definition in `designs.json` says: its search and inclusion criteria (theory-and-reviews q6: yes) and a
     weighing of the studies it includes (q7: yes or partly). Otherwise it starts at Moderate, as a narrative
     review does.
2. **A critical (★) dimension is unmet** when none of its questions is yes or partly and at least one is "not found". Each unmet critical dimension **caps** the grade: one caps it at Low, two at Very low.
3. **A critical dimension is unclear** when all its answers are "can't tell". The grade goes down one level.
4. **Two or more "not found"** on questions outside the critical dimensions take the grade down one level.
5. **More than half "can't tell"** makes the paper **Not appraisable**.
6. **Engineering:** savings or performance that rest on a model never validated against measurement are capped at Moderate. A model or simulation already starts there, and rule 2 takes it lower when its calibration question is "not found" ([Fowlie et al. 2018](https://www.nber.org/papers/w21331): modelled savings ran about 2.5× realised).
7. **Grades:** High, Moderate, Low, Very low, Not appraisable. Nothing goes below Very low.

A grade judges how well the paper's own evidence supports **its own conclusions**. It is not a judgement of
the paper's importance or its relevance to the project.

## Level 2: passages → two labels

Every passage gets two labels. A passage's paper grade applies only to what that paper itself shows. A relayed
claim does not inherit the grade of the paper that relays it.

**Whose claim is it** (`claim-origin`, after
[Lauscher et al. 2018](https://aclanthology.org/W18-5206/): own versus background claims):

| Code | Meaning |
|---|---|
| own-finding | A result of this paper's own data, cases, model or analysis. In a review, a conclusion the authors draw across the studies they reviewed counts as their own. |
| reported | Reports what another work found or said, usually with a citation. |
| theoretical | A conceptual or theoretical statement: a definition, framework, proposition or typology. |
| interpretation | The authors' interpretation or explanation of findings, theirs or others'. |
| recommendation | What someone should do: policy, practice or research advice. |
| background | Context or common knowledge, setting the scene. |
| speculation | A conjecture, prediction or possibility the paper does not test. |

**What backs it** (`claim-basis`, after [Rinott et al. 2015](https://aclanthology.org/D15-1050/): study, expert
and anecdotal evidence):

| Code | Meaning |
|---|---|
| data | Measured or surveyed data, statistics or model results shown in the paper. |
| case | Evidence from cases, interviews, documents or observation shown in the paper. |
| cited-study | A study the passage cites. |
| argument | Reasoning only, with no evidence shown. |
| none | Nothing is shown: an assertion. |

A note from code, not the model, adds "cites (Smith 2019)" where the passage carries an in-text citation.

## Level 3: overview statements → a check and a confidence

**The check.** For each statement, the model reads each passage the statement cites, in its "In context" window,
and answers after SciFact ([Wadden et al. 2020](https://aclanthology.org/2020.emnlp-main.609/)):

- **supports**, **partly** or **does not support**;
- and the **gap**, if there is one:
  - **broader**: it generalises beyond the passage;
  - **stronger**: more certain or more causal than the passage;
  - **other setting**: it applies the passage to a place or sector it didn't study;
  - **relays others'**: it presents a relayed claim as the paper's own finding;
  - **none**.

Looking for overstatement is deliberate. When models rewrite text, certainty goes up 1.5–2× more often than down
([2026 study](https://arxiv.org/abs/2606.07951)), and 34% of articles already use causal language too strong for
their design ([Haber et al. 2018](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0196346)).

**The confidence** uses the IPCC's calibrated language
([guidance note](https://www.ipcc.ch/site/assets/uploads/2018/05/uncertainty-guidance-note.pdf)), the native
vocabulary of energy and climate assessment. It combines two judgements, both made by rules.

*Evidence*, counting only **independent support**: distinct studies whose passage the check says supports or
partly supports, and whose passage is not `reported` or `background`. **A study is a lead author**
(2026-10-06): papers whose first author is the same count once, so three papers by one author restating a
framework are one voice. The paper count is kept beside it, and a statement whose supporting papers all share
a lead author is flagged.

- **Robust:** three or more independent studies, at least two graded Moderate or higher (a study takes its
  best-graded paper).
- **Medium:** two independent studies; or three or more that don't meet "robust"; or one graded High.
- **Limited:** anything less, including support that is only relayed.

*Agreement*:

- **High:** every passage supports, with no gap, and at least two independent studies do. Agreement is concurrence
  across the literature (the IPCC note's own definition), so a statement resting on one paper is at most medium.
- **Medium:** some passages only partly support, or a gap is named; none fails to support.
- **Low:** any passage does not support, or most only partly support.

| Evidence \ agreement | low | medium | high |
|---|---|---|---|
| limited | very low | low | medium |
| medium | low | medium | high |
| robust | medium | high | very high |

A statement whose passages all fail to support it is labelled **not supported by its passages**, with no
confidence level.

**On the pages** the level is said in plain words, the IPCC term on hover and on the Methods page: **Well
supported** (very high or high: the two swapped places between two checks of one summary, so the line between
them isn't stable), **Some support** (medium), **Limited** (low), **Weak or unclear** (very low, not supported
by its passages, or runs that disagreed). `store` writes these, with the kind of statement (a rule over its
supporting passages' whose-claim and what-backs-it labels) and where its independent evidence comes from, into
each support matrix claim's `ext["upc-corpus"]`.

**Setting.** A corpus may name a domain in its settings (`.upc/upc-corpus/settings.json`, `"domain"`): the
setting its team works in. `domains/us-residential-buildings.json` is one: target sectors (residential and mixed
buildings) and target places (the `place` scheme's `us`). Each paper is then **target** (both), **near** (one of
the two) or **other**. This mirrors GRADE's indirectness and CERQual's relevance. Without a domain, papers get
no setting.

## Citations, beside the grade and never in it
OpenAlex's field-and-year percentile is shown as a tier next to the evidence grade. Papers under 24 months old
are marked "too recent". This follows Leiden Manifesto P1, P6 and P8
([Hicks et al. 2015](https://www.nature.com/articles/520429a)) and [DORA](https://sfdora.org/read/).
Field-normalised citations correlate with expert quality ratings at only about 0.1–0.5
([Thelwall et al. 2023](https://arxiv.org/abs/2212.05416)), and in a 179-paper library, 116 of the 178 papers OpenAlex
found are already in their field's top 10%.

## How agreement is measured
- **Run to run:** the share of items where all three runs agree; Fleiss' κ across the three runs; and
  Gwet's AC1, which stays stable when one label dominates.
- **Against a blind second coder** (40 passages, 15 papers, coded before any model output existed): κ and AC1
  between the vote and the second coder, with bootstrap 95% intervals. When the second coder is another model, not
  a person, this is a first look, not a validation. The research recommends about 25 papers double-coded by people, about 5 per
  profile, and trusting the model only where it agrees with people as well as people agree with each other.
- **The bar:** a dimension under 80% run-to-run, or under 0.4 against the second coder, is shown marked "low
  agreement" and kept out of the filters. Against the second coder the measure is κ, except where one label is 70% or more of both
  raters' labels (nearly every paper Moderate, say): there κ collapses, and Gwet's AC1 is used instead.
