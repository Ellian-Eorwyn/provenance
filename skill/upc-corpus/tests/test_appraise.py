"""Offline tests for the evidence ratings (appraise.py) and the overviews rebuilt
from them (synthesize.py v2). No model is called: the model is a stub. Run with:

    python3 -m unittest discover -s tests -p 'test_appraise.py' -v
"""

import os
import json
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import appraise as A  # noqa: E402
import synthesize as S  # noqa: E402

R = A.rubric()
DOMAIN = json.loads((A.APPRAISAL / "domains" / "us-residential-buildings.json").read_text(encoding="utf-8"))
R["domain"] = DOMAIN   # what a corpus whose settings name this domain gets
PROF = {"profile": "t", "title": "Test", "critical": ["D2", "D3"],
        "questions": [{"id": "q1", "dim": "D1", "text": "a"}, {"id": "q2", "dim": "D2", "text": "b"},
                      {"id": "q3", "dim": "D3", "text": "c"}, {"id": "q4", "dim": "D4", "text": "d"},
                      {"id": "q5", "dim": "D5", "text": "e"}, {"id": "q6", "dim": "D6", "text": "f"}]}


def answers(**kw):
    base = {f"q{i}": "yes" for i in range(1, 7)}
    base.update(kw)
    return base


class GradeRuleTests(unittest.TestCase):
    """rubric.md 'From answers to a grade'."""

    def test_all_met_keeps_the_start(self):
        self.assertEqual(A.grade_one(PROF, "High", answers())[0], "High")

    def test_an_unmet_critical_dimension_caps_at_low(self):
        self.assertEqual(A.grade_one(PROF, "High", answers(q2="not found"))[0], "Low")

    def test_two_unmet_critical_dimensions_cap_at_very_low(self):
        self.assertEqual(A.grade_one(PROF, "High", answers(q2="not found", q3="not found"))[0], "Very low")

    def test_an_unclear_critical_dimension_takes_one_level(self):
        self.assertEqual(A.grade_one(PROF, "Moderate", answers(q3="can't tell"))[0], "Low")

    def test_two_not_found_elsewhere_take_one_level(self):
        self.assertEqual(A.grade_one(PROF, "Moderate", answers(q4="not found", q6="not found"))[0], "Low")
        self.assertEqual(A.grade_one(PROF, "Moderate", answers(q4="not found"))[0], "Moderate")

    def test_more_than_half_cant_tell_is_not_appraisable(self):
        g, _ = A.grade_one(PROF, "High", answers(q1="can't tell", q4="can't tell", q5="can't tell", q6="can't tell"))
        self.assertEqual(g, A.NA)

    def test_nothing_goes_below_very_low(self):
        g, _ = A.grade_one(PROF, "Low", answers(q2="not found", q3="not found", q4="not found", q6="not found"))
        self.assertEqual(g, "Very low")

    def test_two_strands_take_the_weaker(self):
        strands = [("quantitative-causal", "observational-quantitative", "Moderate"),
                   ("qualitative-case", "case-study", "Moderate")]
        qc = {q["id"]: "yes" for q in R["profiles"]["quantitative-causal"]["questions"]}
        qq = {q["id"]: "yes" for q in R["profiles"]["qualitative-case"]["questions"]}
        crit = R["profiles"]["qualitative-case"]["critical"][0]
        for q in R["profiles"]["qualitative-case"]["questions"]:
            if q["dim"] == crit:
                qq[q["id"]] = "not found"
        g, why = A.grade_paper(R, strands, {"quantitative-causal": qc, "qualitative-case": qq})
        self.assertEqual(g, "Low")
        self.assertTrue(any("weaker" in w for w in why))

    def test_design_picks_the_profile_and_mixed_methods_two(self):
        self.assertEqual([p for p, _, _ in A.profiles_for(R, "case-study", "none")], ["qualitative-case"])
        self.assertEqual([p for p, _, _ in A.profiles_for(R, "mixed-methods", "observational-quantitative")],
                         ["quantitative-causal"])
        both = A.profiles_for(R, "grey-report", "model-simulation")
        self.assertEqual([p for p, _, _ in both], ["grey-literature", "engineering"])
        self.assertEqual(A.profiles_for(R, "commentary", "model-simulation")[0][2], "Low")

    def test_mixed_methods_is_rated_under_both_strands(self):
        dv = {"design": "mixed-methods", "second_design": "case-study",
              "strands": A.vote_strands([{"main_design": "observational-quantitative", "other_design": "case-study"}] * 3)}
        self.assertEqual([p for p, _, _ in A.strands_of(R, dv)], ["quantitative-causal", "qualitative-case"])
        same = {"design": "mixed-methods", "second_design": "qualitative-interview",
                "strands": {"main_design": "case-study", "other_design": "qualitative-interview"}}
        self.assertEqual([p for p, _, _ in A.strands_of(R, same)], ["qualitative-case"])


class VoteTests(unittest.TestCase):
    def test_majority_needs_more_than_half(self):
        self.assertEqual(A.majority(["yes", "yes", "partly"]), "yes")
        self.assertIsNone(A.majority(["yes", "partly", "not found"]))
        self.assertIsNone(A.majority([None, None]))

    def test_a_yes_without_a_checked_quotation_counts_as_cant_tell(self):
        self.assertEqual(A.answer_of({"answer": "yes", "quote_check": "not found"}), "can't tell")
        self.assertEqual(A.answer_of({"answer": "partly", "quote_check": "normalized"}), "partly")
        self.assertEqual(A.answer_of({"answer": "not found", "quote_check": "missing"}), "not found")

    def test_mixed_methods_keeps_a_second_strand(self):
        runs = [{"design": "mixed-methods", "second_design": "case-study"},
                {"design": "mixed-methods", "second_design": "qualitative-interview"},
                {"design": "mixed-methods", "second_design": "none"}]
        v = A.vote_design(runs)
        self.assertEqual(v["design"], "mixed-methods")
        self.assertEqual(v["second_design"], "case-study")

    def test_check_quote(self):
        text = "Heat pumps cut bills. Heat pumps cut bills. Installers said “it’s hard” to sell them."
        nt = A.norm(text)
        self.assertEqual(A.check_quote(text, nt, "Heat pumps cut bills."), "ambiguous")
        self.assertEqual(A.check_quote(text, nt, "Installers said “it’s hard”"), "exact")
        self.assertEqual(A.check_quote(text, nt, 'Installers said "it\'s hard"'), "normalized")
        self.assertEqual(A.check_quote(text, nt, "Installers loved selling them"), "not found")
        self.assertEqual(A.check_quote(text, nt, "short"), "missing")


class ConfidenceTests(unittest.TestCase):
    def row(self, sid, verdict="supports", origin="own-finding", grade="Moderate", gap="none"):
        return {"source_id": sid, "verdict": verdict, "origin": origin, "grade": grade, "gap": gap, "setting": "near"}

    def test_three_independent_papers_agreeing_are_high(self):
        c = A.confidence([self.row("a"), self.row("b"), self.row("c", grade="Low")])
        self.assertEqual((c["evidence"], c["agreement"], c["label"]), ("robust", "high", "very high"))

    def test_relayed_passages_are_not_independent(self):
        c = A.confidence([self.row("a"), self.row("b", origin="reported"), self.row("c", origin="background")])
        self.assertEqual(c["independent"], 1)
        self.assertEqual(c["evidence"], "limited")

    def test_a_systematic_review_must_show_its_search_and_weighing_to_start_high(self):
        prof = R["profiles"]["theory-review"]
        all_yes = {q["id"]: "yes" for q in prof["questions"]}
        self.assertEqual(A.grade_one(prof, "High", all_yes, "systematic-review")[0], "High")
        g, why = A.grade_one(prof, "High", all_yes | {"q7": "not found"}, "systematic-review")
        self.assertEqual(g, "Moderate")
        self.assertIn("starts at Moderate", why[0])
        self.assertEqual(A.grade_one(prof, "Moderate", all_yes | {"q7": "not found"}, "narrative-review")[0], "Moderate")

    def test_one_paper_alone_cant_have_high_agreement(self):
        c = A.confidence([self.row("a")])
        self.assertEqual((c["evidence"], c["agreement"], c["label"]), ("limited", "medium", "low"))
        c = A.confidence([self.row("a", grade="High")])
        self.assertEqual((c["evidence"], c["agreement"], c["label"]), ("medium", "medium", "medium"))

    def test_one_paper_partly_is_low(self):
        c = A.confidence([self.row("a", verdict="partly", gap="broader")])
        self.assertEqual(c["label"], "very low")

    def test_nothing_supports(self):
        c = A.confidence([self.row("a", verdict="does not support")])
        self.assertEqual(c["label"], "not supported by its passages")

    def test_papers_by_one_lead_author_count_once(self):
        rows = [self.row("a") | {"lead": "geels"}, self.row("b") | {"lead": "geels"}, self.row("c") | {"lead": "geels"}]
        c = A.confidence(rows)
        self.assertEqual((c["independent"], c["papers"]), (1, 3))
        self.assertEqual((c["evidence"], c["agreement"], c["label"]), ("limited", "medium", "low"))
        c = A.confidence(rows[:2] + [self.row("c") | {"lead": "sovacool"}])
        self.assertEqual((c["independent"], c["papers"], c["evidence"]), (2, 3, "medium"))

    def test_lead_author_is_folded(self):
        self.assertEqual(A.lead_of({"bib": {"authors": [{"family": "Gééls", "given": "F."}, {"family": "X"}]}}), "geels")
        self.assertEqual(A.lead_of({"bib": {"authors": []}}), "")

    def test_setting(self):
        self.assertEqual(A.setting_of(R, {"sector": "residential buildings", "countries": ["United States"]}), "target")
        self.assertEqual(A.setting_of(R, {"sector": "residential buildings", "countries": ["California, USA"]}), "target")
        self.assertEqual(A.setting_of(R, {"sector": "residential buildings", "countries": ["UK"]}), "near")
        self.assertEqual(A.setting_of(R, {"sector": "transport", "countries": ["Texas"]}), "near")
        self.assertEqual(A.setting_of(R, {"sector": "transport", "countries": ["Finland"]}), "other")

    def test_no_domain_no_setting(self):
        self.assertIsNone(A.setting_of({**R, "domain": None}, {"sector": "transport", "countries": ["Finland"]}))

    def test_a_corpus_names_its_domain_in_its_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            co = Path(tmp)
            self.assertIsNone(A.load_domain(co))
            (co / ".upc" / "upc-corpus").mkdir(parents=True)
            f = co / ".upc" / "upc-corpus" / "settings.json"
            f.write_text(json.dumps({"domain": "us-residential-buildings"}), encoding="utf-8")
            self.assertEqual(A.load_domain(co)["title"], "US residential buildings")
            f.write_text(json.dumps({"domain": {"target": {"sectors": ["industry"], "places": ["europe"]}}}), encoding="utf-8")
            self.assertEqual(A.setting_of(A.rubric(co), {"sector": "industry", "countries": ["Germany"]}), "target")

    def test_compound_country_names(self):
        self.assertEqual(A.region_of("California, USA"), "us")
        self.assertEqual(A.places_of(["Germany and France", "Ghana"]), ["europe", "elsewhere"])


class PlainWordsTests(unittest.TestCase):
    """What the pages say about a statement (2026-10-06): four support words, kind, place, flags."""
    def row(self, sid, lead, verdict="supports", origin="own-finding", basis="data"):
        return {"source_id": sid, "lead": lead, "verdict": verdict, "origin": origin, "basis": basis,
                "grade": "Moderate", "gap": "none"}

    papers = {"a": {"design": {"design": "case-study", "countries": ["United Kingdom", "Norway"]}},
              "b": {"design": {"design": "qualitative-interview", "countries": ["USA"]}},
              "c": {"design": {"design": "theory-conceptual", "countries": []}}}

    def test_very_high_and_high_are_both_well_supported(self):
        self.assertEqual(A.SUPPORT["very high"], A.SUPPORT["high"])
        self.assertEqual(A.SUPPORT_LABEL[A.SUPPORT["high"]], "Well supported")

    def test_a_finding_with_its_places_and_designs(self):
        rows = [self.row("a", "x"), self.row("b", "y")]
        p = A.plain_of(rows, A.confidence(rows), self.papers)
        self.assertEqual((p["kind"], p["studies"], p["papers"]), ("finding", 2, 2))
        self.assertEqual(p["places"], ["us", "europe"])
        self.assertEqual(p["countries"], ["UK", "Norway", "US"])
        self.assertEqual(p["designs"], ["case study", "interviews"])
        self.assertFalse(p["same_lead"] or p["relayed_only"])

    def test_flags(self):
        rows = [self.row("a", "x"), self.row("b", "x")]
        self.assertTrue(A.plain_of(rows, A.confidence(rows), self.papers)["same_lead"])
        rows = [self.row("a", "x", origin="reported", basis="cited-study")]
        p = A.plain_of(rows, A.confidence(rows), self.papers)
        self.assertTrue(p["relayed_only"])
        self.assertEqual((p["kind"], p["places"], p["studies"]), ("framework", [], 0))

    def test_kinds(self):
        self.assertEqual(A.kind_of([]), "unsupported")
        self.assertEqual(A.kind_of([{"origin": "theoretical", "basis": "argument"}]), "framework")
        self.assertEqual(A.kind_of([{"origin": "recommendation", "basis": "argument"}]), "recommendation")
        self.assertEqual(A.kind_of([{"origin": "interpretation", "basis": "argument"}]), "argument")

    def test_places_of_a_paper(self):
        self.assertEqual(A.places_of(["California", "Germany", "Ghana"]), ["us", "europe", "elsewhere"])
        self.assertEqual(A.places_of([]), ["not-stated"])
        self.assertEqual(A.places_of(["North America"]), ["elsewhere"])


class AgreementTests(unittest.TestCase):
    def test_perfect_agreement(self):
        pairs = [("a", "a"), ("b", "b"), ("a", "a"), ("c", "c")]
        self.assertAlmostEqual(A.cohen(pairs), 1.0)
        k, ac1, full = A.fleiss_and_ac1([list(p) for p in pairs], ["a", "b", "c"])
        self.assertAlmostEqual(k, 1.0)
        self.assertAlmostEqual(ac1, 1.0)
        self.assertEqual(full, 1.0)

    def test_cohen_known_value(self):
        # 20 items: 10 yes/yes, 5 no/no, 3 yes/no, 2 no/yes → po .75, pe .5*... = 0.5 → κ 0.5
        pairs = [("y", "y")] * 10 + [("n", "n")] * 5 + [("y", "n")] * 3 + [("n", "y")] * 2
        po, pe = 0.75, (13 / 20) * (12 / 20) + (7 / 20) * (8 / 20)
        self.assertAlmostEqual(A.cohen(pairs), (po - pe) / (1 - pe))

    def test_bootstrap_brackets_the_estimate(self):
        pairs = [("y", "y")] * 30 + [("n", "n")] * 10 + [("y", "n")] * 5
        lo, hi = A.bootstrap(pairs, A.cohen, n=400)
        self.assertLessEqual(lo, A.cohen(pairs))
        self.assertGreaterEqual(hi, A.cohen(pairs))


class ElidedQuoteTests(unittest.TestCase):
    TEXT = ("It is difficult to assess the quality and value of such visions and scenarios. In our view, most of "
            "them suffer from one or more problems: they tend to be about end states.")

    def check(self, q):
        return A.check_quote(self.TEXT, A.norm(self.TEXT), q)

    def test_each_piece_must_be_in_the_paper(self):
        self.assertEqual(self.check("It is difficult to assess the quality ... most of them suffer from one or more problems"),
                         "elided")
        self.assertEqual(self.check("It is difficult to assess the quality … they tend to be about start states"), "not found")

    def test_a_trailing_ellipsis_is_just_the_quotation(self):
        self.assertEqual(self.check("In our view, most of them suffer from one or more problems..."), "exact")
        self.assertEqual(A.fragments("[...] most of them suffer from one [...] x"), ["most of them suffer from one"])

    def test_an_added_full_stop_or_quote_mark_is_trimmed(self):
        self.assertEqual(self.check('"In our view, most of them suffer from one or more problems."'), "exact")

    def test_an_elided_answer_counts(self):
        self.assertEqual(A.answer_of({"answer": "yes", "quote_check": "elided"}), "yes")


class CutUncitedTests(unittest.TestCase):
    def test_uncited_sentences_are_cut_and_et_al_is_not_a_sentence_end(self):
        import synthesize as SY
        prose = ("Cost remains a primary barrier to adoption, particularly in the UK. Rossi (2025) found it limited "
                 "[ext-000000000001]. A UK case study, citing Wade et al. (2016), documents poor work [ext-000000000002].")
        out, cut = SY.cut_uncited(prose)
        self.assertEqual(cut, ["Cost remains a primary barrier to adoption, particularly in the UK."])
        self.assertTrue(out.startswith("Rossi (2025)"))
        self.assertIn("Wade et al. (2016), documents", out)


class ClaimGroupTests(unittest.TestCase):
    def test_groups_need_two_papers_and_known_keys(self):
        import claim_groups as CG
        keys = {"p1": "e1", "p2": "e2", "p3": "e3"}
        src = {"e1": "A", "e2": "B", "e3": "A"}.get
        out, notes = CG.checked([{"claim": "Cost deters adoption.", "keys": ["p1", "p2", "p9"]},
                                 {"claim": "Same paper twice.", "keys": ["p3", "p1"]}], keys, src)
        self.assertEqual(out, [{"claim": "Cost deters adoption.", "passages": ["e1", "e2"], "papers": 2}])
        self.assertIn("p9", notes[0])

    def test_the_pool_drops_relayed_passages_and_keeps_like_ones_together(self):
        import numpy as np
        import claim_groups as CG
        src = {"a": "P1", "b": "P2", "c": "P3", "d": "P1", "r": "P4"}.get
        org = {"a": "own-finding", "b": "interpretation", "c": "theoretical", "d": "own-finding", "r": "reported"}.get
        got = CG.pool(["a", "b", "c", "d", "r"], src, {"a": 5, "b": 4, "c": 3, "d": 2, "r": 9}.get, org)
        self.assertEqual(got, ["a", "b", "c", "d"])
        v = {"a": np.array([1.0, 0.0]), "b": np.array([0.0, 1.0]), "c": np.array([0.99, 0.141]), "d": np.array([0.1, 0.995])}
        v = {k: x / np.linalg.norm(x) for k, x in v.items()}
        self.assertEqual(CG.neighbour_order(["a", "b", "c", "d"], v), ["a", "c", "d", "b"])

    def test_groups_come_first_and_respect_the_per_paper_cap(self):
        import synthesize as SY
        exts = {e: {"source_id": s} for e, s in {"g1": "A", "g2": "B", "x1": "A", "x2": "C", "x3": "A"}.items()}
        used, chosen = SY.choose_grouped([{"claim": "c", "passages": ["g1", "g2"], "papers": 2}],
                                         ["x1", "x2", "x3", "g1"], exts, cap=4, per_paper=2)
        self.assertEqual(chosen, ["g1", "g2", "x1", "x2"])
        lines = SY.grouped_lines(["L1", "L2", "L3", "L4"], chosen, used)
        self.assertTrue(lines[0].startswith("GROUP G1 · 2 papers"))
        self.assertEqual(lines[1:3], ["L1", "L2"])
        self.assertEqual(lines[3], "OTHER PASSAGES, strongest evidence first:")

    def test_rounds_are_pooled_without_a_passage_in_two_groups(self):
        import claim_groups as CG
        r1 = [{"claim": "cost", "passages": ["a", "b"], "papers": 2}]
        r2 = [{"claim": "cost too", "passages": ["a", "b", "c"], "papers": 3}, {"claim": "grid", "passages": ["d", "e"], "papers": 2}]
        r3 = [{"claim": "overlap", "passages": ["c", "f"], "papers": 2}]
        got = CG.merged([r1, r2, r3])
        self.assertEqual([g["claim"] for g in got], ["cost too", "grid"])
        self.assertEqual(got[0]["passages"], ["a", "b", "c"])

    def test_a_large_group_is_cut_to_its_strongest_papers_not_dropped(self):
        import synthesize as SY
        ids = [f"e{i}" for i in range(24)]
        exts = {e: {"source_id": f"P{i}"} for i, e in enumerate(ids)}
        ranked = list(reversed(ids))                       # e23 strongest
        used, chosen = SY.choose_grouped([{"claim": "c", "passages": ids, "papers": 24}], ranked, exts, cap=30, per_paper=3)
        self.assertEqual(len(used), 1)
        self.assertEqual(used[0]["passages"], ranked[:SY.MAX_IN_GROUP])
        self.assertEqual(chosen[:SY.MAX_IN_GROUP], ranked[:SY.MAX_IN_GROUP])
        lines = SY.grouped_lines([f"L{i}" for i in range(len(chosen))], chosen, used)
        self.assertIn(f"{SY.MAX_IN_GROUP} papers, the strongest of 24", lines[0])


class BlindCodingTests(unittest.TestCase):
    """The blind second coding: a person's or another model's, and the older file name."""

    def write(self, corpus: Path, name: str, data: dict) -> None:
        folder = A.C.state_dir(corpus, "appraise") / "blind"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(json.dumps(data))

    def test_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(A.C.blind_coding(Path(tmp)), {})

    def test_person(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write(Path(tmp), "coding.json", {"coder": "jd", "kind": "human", "name": "J. Doe", "papers": {}})
            b = A.C.blind_coding(Path(tmp))
            self.assertEqual((b["kind"], b["name"]), ("human", "J. Doe"))
            self.assertNotIn("model", b)

    def test_older_file_names_its_model_by_the_coder_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write(Path(tmp), "claude.json", {"coder": "some-model-blind", "kind": "model", "papers": {}})
            b = A.C.blind_coding(Path(tmp))
            self.assertEqual((b["model"], b["name"]), ("some-model", "some-model-blind"))

    def test_new_file_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write(Path(tmp), "claude.json", {"coder": "old-blind", "kind": "model"})
            self.write(Path(tmp), "coding.json", {"coder": "new", "kind": "model", "model": "m2"})
            self.assertEqual(A.C.blind_coding(Path(tmp))["model"], "m2")


class StaleCheckTests(unittest.TestCase):
    def test_an_edited_claim_is_checked_again(self):
        import appraise as A
        rec = {"text": "Heat pumps cut CO2.", "evidence": {"e1": "ext-a"}, "runs": [{}, {}, {}]}
        self.assertFalse(A.stale_check(rec, {"text": "Heat pumps cut CO2.", "evidence_ids": ["ext-a"]}))
        self.assertTrue(A.stale_check(rec, {"text": "Heat pumps almost always cut CO2.", "evidence_ids": ["ext-a"]}))
        self.assertTrue(A.stale_check(rec, {"text": "Heat pumps cut CO2.", "evidence_ids": ["ext-a", "ext-b"]}))


class SplitVoteTests(unittest.TestCase):
    def test_a_three_way_split_is_runs_disagreed_not_unchecked(self):
        import appraise as A
        rows = [{"source_id": "s1", "verdict": None, "verdict_runs": ["supports", "partly", "does not support"]}]
        self.assertEqual(A.confidence(rows)["label"], "runs disagreed")
        self.assertEqual(A.confidence([{"source_id": "s1", "verdict": None, "verdict_runs": [None, None, None]}])["label"],
                         "not checked")


class AgreementRuleTests(unittest.TestCase):
    def test_a_low_agreement_scheme_leaves_the_filters(self):
        report = {"run_to_run": {"claim-origin": {"all_agree": 0.7}, "claim-basis": {"all_agree": 0.9},
                                 "design": {"all_agree": 0.95}, "criteria (all questions)": {"all_agree": 0.85}},
                  "vs_blind": {"claim-basis": {"kappa": 0.3, "n": 40}, "design": {"kappa": 0.2, "n": 5},
                               "grade": {"kappa": 0.5, "n": 15}}}
        books = {b["slug"]: b for b in A.evidence_codebooks(R, report)}
        self.assertFalse(books["claim-origin"]["ext"]["upc-site"].get("facet", True))
        self.assertFalse(books["claim-basis"]["ext"]["upc-site"].get("facet", True))
        self.assertTrue(books["study-design"]["ext"]["upc-site"].get("facet", True))     # n under 10
        self.assertTrue(books["evidence-grade"]["ext"]["upc-site"].get("facet", True))
        self.assertIn("Low agreement", books["claim-origin"]["question"])

    def test_a_skewed_label_is_judged_by_ac1(self):
        report = {"run_to_run": {"grade (each run alone)": {"all_agree": 0.9}},
                  "vs_blind": {"grade": {"kappa": -0.05, "ac1": 0.77, "n": 14, "top_share": 0.85}}}
        self.assertFalse(A.agreement_of(report, "evidence-grade")["low"])
        report["vs_blind"]["grade"]["top_share"] = 0.5
        self.assertTrue(A.agreement_of(report, "evidence-grade")["low"])


class TextTests(unittest.TestCase):
    def test_references_are_cut_and_the_venue_taken_out(self):
        body = "Energy Policy 120 (2018) 1-10\n\nIntroduction. " + ("We study heat pumps in homes. " * 60) + \
               "\n\nReferences\n\n" + "".join(f"Smith, J. ({2000 + i}). A paper. Energy Policy 12, 1-{i}.\n" for i in range(40))
        text, notes = A.model_text(body, "Energy Policy")
        self.assertNotIn("Smith, J. (2001)", text)
        self.assertNotIn("Energy Policy", text)
        self.assertIn("We study heat pumps", text)

    def test_widened_makes_a_repeated_quote_unique(self):
        raw = "Costs are high. Costs are high in cold climates for retrofits. Costs are high."
        w = A.widened(raw, "Costs are high")
        self.assertEqual(w, "Costs are high in cold climates for retrofits.")
        self.assertEqual(raw.count(w), 1)

    def test_prose_never_carries_a_double_quote(self):
        self.assertEqual(A.prose('It says "small" and “tiny”.'), "It says 'small' and ‘tiny’.")

    def test_a_quotation_that_cant_sit_in_a_marker_is_noted_not_quoted(self):
        self.assertIn("confirmed", A.marker({"quote": 'a "b" c', "id": "ext-000000000000"}))
        self.assertEqual(A.marker({"quote": "abc", "id": "ext-000000000001"}), '"abc" [ext-000000000001]')


class OverviewPromptTests(unittest.TestCase):
    def test_the_audience_and_setting_come_from_the_corpus(self):
        with tempfile.TemporaryDirectory() as tmp:
            co = Path(tmp)
            plain = S.sys_v2(co)
            self.assertIn("for a research team.", plain)
            self.assertIn("(countries and sector), whose claim", plain)
            (co / ".upc" / "upc-corpus").mkdir(parents=True)
            (co / ".upc" / "upc-corpus" / "settings.json").write_text(json.dumps(
                {"audience": "a city's housing team", "domain": "us-residential-buildings"}), encoding="utf-8")
            own = S.sys_v2(co)
            self.assertIn("for a city's housing team.", own)
            self.assertIn("(countries and sector; the team's own setting is US residential buildings), whose claim", own)
            self.assertNotIn("{audience}", own)
            self.assertNotIn("{own_setting}", own)


class StubbedRunTests(unittest.TestCase):
    """Runner.work with the model replaced: three runs each step, saved, and voted."""

    def test_a_paper_is_rated_and_an_unchecked_quotation_voids_its_yes(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp)
            paper = "We interviewed 24 installers in Oregon about heat pump sales. " * 20
            tp = corpus / "paper.txt"
            tp.write_text(paper, encoding="utf-8")
            sid = "src-000000000001"
            data = {"sources": {sid: {"slug": "s0001-x-2024", "text_path": str(tp), "text_rep": "rep-1", "container": "",
                                      "passages": ["ext-000000000001"], "chars": len(paper), "bib": {}, "year": "2024"}},
                    "exts": {"ext-000000000001": {"source_id": sid, "direct_quote": "We interviewed 24 installers"}},
                    "syntheses": {}}
            prof = R["profiles"]["qualitative-case"]
            real = "We interviewed 24 installers in Oregon"

            def fake(url, system, user, schema, cap, seed=None, model=None, effort=None):
                props = schema.get("properties", {})
                if "design" in props:
                    return ({"design": "qualitative-interview", "second_design": "none", "sector": "residential buildings",
                             "countries": ["United States"], "quote": real, "reason": "interviews"}, {})
                if "answers" in props:
                    # q1 quotes the paper; q2 quotes words the paper doesn't have
                    out = [{"id": q["id"], "answer": "yes", "quote": real if q["id"] != "q2" else "Installers loved it",
                            "reason": "r"} for q in prof["questions"]]
                    return {"answers": out}, {}
                keys = schema["properties"]["passages"]["items"]["properties"]["key"]["enum"]
                return {"passages": [{"key": k, "origin": "own-finding", "basis": "case", "reason": "r"} for k in keys]}, {}

            (corpus / ".upc" / "upc-corpus").mkdir(parents=True)
            (corpus / ".upc" / "upc-corpus" / "settings.json").write_text(
                json.dumps({"domain": "us-residential-buildings"}), encoding="utf-8")
            old_load, old_chat = A.load_corpus, A.chat_json
            A.load_corpus, A.chat_json = (lambda c: data), fake
            try:
                run = A.Runner(corpus, "", 3, None)
                res = run.work(sid, "stub", "http://stub")
            finally:
                A.load_corpus, A.chat_json = old_load, old_chat
            self.assertNotIn("error", res)
            st = json.loads(A.paper_file(corpus, "s0001-x-2024").read_text())
            self.assertEqual(len(st["design"]["runs"]), 3)
            self.assertEqual(st["design"]["vote"]["design"], "qualitative-interview")
            v = A.vote_paper(R, st)
            self.assertEqual(v["answers"]["qualitative-case"]["q1"]["answer"], "yes")
            self.assertEqual(v["answers"]["qualitative-case"]["q2"]["answer"], "can't tell")
            self.assertEqual(v["setting"], "target")
            self.assertIn(v["grade"], A.LEVELS)
            self.assertEqual(v["passages"]["ext-000000000001"]["origin"], "own-finding")
            self.assertEqual(v["passages"]["ext-000000000001"]["origin_runs"], ["own-finding"] * 3)


class SynthesizeV2Tests(unittest.TestCase):
    exts = {f"ext-00000000000{i}": {"source_id": s} for i, s in enumerate("aaabbc")}

    def test_spread_takes_a_paper_at_a_time(self):
        order = S.spread(list(self.exts), self.exts)
        self.assertEqual([self.exts[e]["source_id"] for e in order[:3]], ["a", "b", "c"])

    def test_rank_puts_the_strongest_paper_first_and_caps_each_paper(self):
        ratings = {"a": {"grade": "Low"}, "b": {"grade": "High"}, "c": {"grade": "Moderate"}}
        order = S.rank_v2(list(self.exts), self.exts, ratings, cap=10, per_paper=1)
        self.assertEqual([self.exts[e]["source_id"] for e in order], ["b", "c", "a"])

    def test_checks(self):
        info = {"ext-000000000001": {"who": "Kale 2025", "origin": "own-finding", "source_id": "a"},
                "ext-000000000002": {"who": "Gaur 2020", "origin": "reported", "source_id": "b"},
                "ext-000000000003": {"who": "Bouw 2023", "origin": "own-finding", "source_id": "c"}}
        claims = [{"text": "x", "evidence_ids": ["ext-000000000001"]}]
        bad = ("Heat pumps are mostly bought by affluent households everywhere in the world [ext-000000000001]. "
               "Costs are the largest barrier across Europe today [ext-000000000002]. "
               "Installers are the key to everything that happens next.")
        probs = S.v2_checks(bad, claims, info)
        self.assertTrue(any("one paper (Kale 2025)" in p for p in probs))
        self.assertTrue(any("report other work" in p for p in probs))
        self.assertTrue(any("cites no passage" in p for p in probs))
        good = ("Kale (2025) found that affluent households were the most interested in heat pumps [ext-000000000001]. "
                "Gaur (2020), citing earlier studies, list costs as the largest barrier in Europe [ext-000000000002]. "
                "Two papers report installers shaping what households buy [ext-000000000001] [ext-000000000003].")
        probs = S.v2_checks(good, claims, info)
        self.assertEqual([p for p in probs if "words" not in p], [])

    def test_an_unknown_marker_is_flagged(self):
        probs = S.v2_checks("Kale (2025) found something important here [ext-0000000000ff].", [{"text": "x"}], {})
        self.assertTrue(any("not one of the given passages" in p for p in probs))


if __name__ == "__main__":
    unittest.main()
