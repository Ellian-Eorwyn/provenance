"""annotate.py: per-paper annotations from a field spec, every quotation through `upc anchor`.

The checks on a model's answer run without a model or a corpus. End to end, a small
corpus of two saved pages (one with coded passages, one without) is annotated against
a stub model through the real `upc` CLI, then published as a site to see the card.
Skipped when the CLI is missing.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
HERE = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(HERE))
import annotate as A  # noqa: E402
import common as C  # noqa: E402


def upc_ok():
    try:
        C.check_compat()
        return True
    except C.Unavailable:
        return False


BOOKS = {
    "setting": {"slug": "setting", "title": "Setting", "unit": "source", "question": "Where was it studied?", "codes": [
        {"code": "single-family", "label": "Single-family homes",
         "definition": "Detached or attached houses, each with its own owner, as in most suburbs."},
        {"code": "multifamily", "label": "Multifamily buildings",
         "definition": "Apartment buildings where several households share one structure and its systems."}]},
    "tech": {"slug": "tech", "title": "Technology", "unit": "passage", "multi_label": True,
             "question": "Which technology does it discuss?", "codes": [
        {"code": "heat-pump", "label": "Heat pump",
         "definition": "An electric heat pump for space or water heating that replaces a gas appliance."},
        {"code": "induction", "label": "Induction cooking",
         "definition": "An induction range or cooktop that replaces a gas stove in a home kitchen."}]},
}
SPEC = [{"key": "setting", "label": "Setting", "kind": "code", "scheme": "setting", "max_words": 20},
        {"key": "tech", "label": "Technologies", "kind": "text", "max_words": 30, "guide": "what was installed"}]

P1 = "Most households replaced a gas furnace with a ducted heat pump during the program."
P2 = "Induction ranges were offered to every household that asked for one."
UNCODED = "The study followed four hundred detached homes in one county for two winters."
DOC_A = ("# Retrofits in one county\n\n" + UNCODED + " " + P1 + " " + P2 + "\n\n"
         + "Further detail on contractors and permits. " * 20)
DOC_B = ("# A survey of apartment owners\n\nOwners of apartment buildings said that the\nwiring was the "
         "hardest part of any change. " + "More survey detail follows here. " * 20)


def add_web(corpus: Path, stage: Path, key: str, text: str, title: str) -> None:
    raw = stage / (hashlib.sha256(key.encode()).hexdigest()[:8] + ".html")
    raw.write_text(f"<html><body>{text}</body></html>")
    md = raw.with_suffix(".md")
    md.write_text(text)
    url = f"https://example.org/{key}"
    prov = {"original_url": url, "final_url": url, "http_status": 200, "content_type": "text/html",
            "fetched_at": "2026-10-19T17:00:00Z", "fetch_status": "success", "fetch_method": "http",
            "extraction_method": "readability", "sha256": hashlib.sha256(raw.read_bytes()).hexdigest()}
    items = stage / "items.jsonl"
    items.write_text(json.dumps({"key": key, "kind": "web", "file": str(raw), "reading_copy": str(md), "provenance": prov,
                                 "title": title, "asr": None,
                                 "bibliographic": {"title": title, "authors": [{"family": "Rivera", "given": "Ana"},
                                                                               {"family": "Okafor", "given": "B."}],
                                                   "issued": {"date_parts": [[2024]]}, "container_title": "Example Journal"},
                                 "doi": "10.1000/" + key}) + "\n")
    subprocess.run([sys.executable, str(HERE / "add_acquired.py"), "--corpus", str(corpus), "--items", str(items)],
                   check=True, capture_output=True)


def make_corpus(root: Path) -> dict:
    """Two saved pages; two passages of the first coded; the first coded as a whole by two coders."""
    corpus, stage = root / "corpus", root / "stage"
    stage.mkdir(parents=True)
    add_web(corpus, stage, "county", DOC_A, "Retrofits in one county")
    add_web(corpus, stage, "survey", DOC_B, "A survey of apartment owners")
    defs = root / "defs.json"
    defs.write_text(json.dumps(list(BOOKS.values())))
    subprocess.run([sys.executable, str(HERE / "make_codebooks.py"), "--corpus", str(corpus), "--defs", str(defs),
                    "--namespace", "t"], check=True, capture_output=True)
    reps = C.corpus_reps(corpus)
    a, b = reps["county"], reps["survey"]
    cbk = {json.loads(f.read_text())["slug"]: json.loads(f.read_text())["codebook_id"] for f in (corpus / "codebooks").glob("cbk-*.json")}
    res = C.upc_jsonl("anchor", "--corpus", str(corpus), "--rep", a["text_rep"], "--source", a["source_id"],
                      "--set", "exs-t-v1", "--type", "passage", "--tool", "test", records=[{"quote": P1}, {"quote": P2}])
    x1, x2 = (r["extraction_id"] for r in res["results"])
    C.upc_jsonl("code", "--corpus", str(corpus), "--set", "cds-t-v1", "--coder-kind", "model", "--tool", "test", records=[
        {"codebook_ref": cbk["tech"], "code": "heat-pump", "target": {"kind": "extraction", "id": x1}, "coder": "t-v1"},
        {"codebook_ref": cbk["tech"], "code": "induction", "target": {"kind": "extraction", "id": x2}, "coder": "t-v1"}])
    for coder, code in (("t-screen", "single-family"), ("t-other", "multifamily")):
        C.upc_jsonl("code", "--corpus", str(corpus), "--set", f"cds-{coder}", "--coder-kind", "model", "--tool", "test",
                    records=[{"codebook_ref": cbk["setting"], "code": code, "target": {"kind": "source", "id": a["source_id"]},
                              "coder": coder}])
    C.upc("regen", str(corpus))
    spec = root / "fields.json"
    spec.write_text(json.dumps(SPEC))
    return {"corpus": corpus, "spec": spec, "a": a, "b": b, "x1": x1, "x2": x2}


def stub_chat(calls: list):
    """A model that tries everything the checks must catch."""
    def chat(url, system, user, max_tokens, model="chat", effort="", temperature=0, timeout=900, schema=None):
        calls.append(user)
        ids = re.findall(r"\[(ext-[0-9a-f]{12})\]", user)
        if "Retrofits in one county" in user:
            return json.dumps({"fields": {
                "setting": {"codes": ["single-family", "multifamily", "made-up"],
                            "note": f"Detached homes in one county [{ids[0]}] (ext-000000000000).",
                            "passages": [ids[0]], "quote": UNCODED},
                "tech": {"text": f'Heat pumps replaced "gas furnaces" in most homes [{ids[0]}]. ' + "More words here. " * 12,
                         "passages": [ids[1], "ext-111111111111"], "quote": P1}}})
        return json.dumps({"fields": {
            "setting": {"codes": ["multifamily"], "note": "Apartment buildings.",
                        "quote": "This sentence is not in the paper at all."},
            "tech": {"text": "", "quote": "Owners of apartment buildings said that the wiring was the hardest part of any change."}}})
    return chat


class Checks(unittest.TestCase):
    def test_a_field_spec_is_checked(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "s.json"
            f.write_text(json.dumps({"fields": SPEC}))
            got = A.load_fields(str(f), BOOKS)
            self.assertEqual([x["key"] for x in got], ["setting", "tech"])
            self.assertEqual(got[1]["guide"], "what was installed")
            for bad in ([{"key": "x", "kind": "code", "scheme": "nope"}], [{"key": "x"}, {"key": "x"}],
                        [{"key": "Bad Key"}], [{"key": "x", "kind": "essay"}], []):
                f.write_text(json.dumps(bad))
                with self.assertRaises(SystemExit):
                    A.load_fields(str(f), BOOKS)

    def test_the_answer_keeps_only_what_holds(self):
        good = "ext-0123456789ab"
        raw = {"fields": {"setting": {"codes": ["single-family", "multifamily", "made-up", "none"],
                                      "note": f"Detached homes (ext-ffffffffffff) [{good}].", "quote": "too short"},
                          "tech": {"text": f'They used "heat pumps" widely ({good}). ' + "Many more words follow. " * 10,
                                   "passages": [good, "ext-eeeeeeeeeeee"],
                                   "quote": f"A sentence copied from the paper itself. [{good}]"}}}
        recs, drops = A.clean(raw, A_FIELDS, BOOKS, {good})
        self.assertEqual(recs["setting"]["codes"], ["single-family"])  # single-label: one code
        self.assertEqual((drops["unknown_code"], drops["extra_code"]), (1, 1))
        self.assertEqual(recs["setting"]["note"], f"Detached homes [{good}].")
        self.assertEqual(drops["unknown_citation"], 2)  # one written inline, one listed
        self.assertNotIn('"', recs["tech"]["text"])
        self.assertTrue(recs["tech"]["text"].startswith(f"They used heat pumps widely [{good}]."))
        self.assertLessEqual(A.words(recs["tech"]["text"]), 30)
        self.assertEqual(recs["tech"]["cites"], [good])
        self.assertEqual(recs["tech"]["proposed_quote"], "A sentence copied from the paper itself.")
        self.assertNotIn("proposed_quote", recs["setting"])
        self.assertEqual(drops["quote_unusable"], 1)

    def test_a_listed_passage_is_cited_after_the_text(self):
        good = "ext-0123456789ab"
        recs, _ = A.clean({"fields": {"tech": {"text": "Heat pumps, mostly.", "passages": [good, good]}}}, A_FIELDS, BOOKS, {good})
        self.assertEqual((recs["tech"]["text"], recs["tech"]["cites"]), (f"Heat pumps, mostly. [{good}]", [good]))

    def test_a_missing_field_says_not_reported(self):
        recs, drops = A.clean({"fields": {}}, A_FIELDS, BOOKS, set())
        self.assertEqual((recs["setting"]["codes"], recs["tech"]["text"], drops["missing_field"]), ([], "Not reported.", 2))
        self.assertIn("**Setting:** Not reported.", A.card_markdown(A_FIELDS, recs, BOOKS, "chat", "t-annot"))

    def test_a_long_first_sentence_is_cut_at_a_word(self):
        s, _ = A.tidy("word " * 50, set(), 10, dict.fromkeys(("unknown_citation", "quotation_marks", "trimmed"), 0))
        self.assertEqual(s, "word " * 9 + "word…")

    def test_a_quotation_ends_on_its_own_words(self):
        self.assertEqual(A.whole("Costs for electrification can be high. For"), "Costs for electrification can be high.")
        self.assertEqual(A.whole("Paperwork took a day. Another said a week."), "Paperwork took a day. Another said a week.")
        self.assertEqual(A.whole("barriers such as cost and disruption,"), "barriers such as cost and disruption")
        self.assertEqual(A.whole("Heat pumps (in most homes) were kept"), "Heat pumps (in most homes) were kept")

    def test_a_repeated_quotation_is_widened_by_a_sentence(self):
        text = "Summary. Costs can be high. For homes it varies.\nBody text. Costs can be high. Grants helped most.\n"
        self.assertEqual(A.by_sentence(text, "Costs can be high."), "Costs can be high. For homes it varies.")
        twice = "Costs can be high.\nCosts can be high.\n"
        self.assertIsNone(A.by_sentence(twice, "Costs can be high."))
        last = "Rebates came late. Costs can be high.\nOwners waited. Costs can be high.\n"
        self.assertEqual(A.by_sentence(last, "Costs can be high."), "Rebates came late. Costs can be high.")

    def test_a_note_does_not_repeat_its_code(self):
        recs, _ = A.clean({"fields": {"setting": {"codes": ["multifamily"], "note": "Multifamily buildings; six in one city."}}},
                          A_FIELDS, BOOKS, set())
        self.assertEqual(recs["setting"]["note"], "Six in one city.")
        recs, _ = A.clean({"fields": {"setting": {"codes": [], "note": "Not reported; national sales only."}}}, A_FIELDS, BOOKS, set())
        self.assertEqual(recs["setting"]["note"], "National sales only.")

    def test_a_first_sentence_a_little_over_is_kept_whole(self):
        drops = dict.fromkeys(("unknown_citation", "quotation_marks", "trimmed"), 0)
        one = "Heat pumps replaced gas boilers in most of the twelve homes the study followed."
        s, _ = A.tidy(one + " The rest kept gas for cooking.", set(), 10, drops)
        self.assertEqual((s, drops["trimmed"]), (one, 1))

    def test_the_schema_offers_only_the_codebook_codes_and_the_shown_passages(self):
        sch = A.schema(A_FIELDS, BOOKS, ["ext-0123456789ab"])["properties"]["fields"]["properties"]
        self.assertEqual(sch["setting"]["properties"]["codes"]["items"]["enum"], ["single-family", "multifamily"])
        self.assertEqual(sch["tech"]["properties"]["passages"]["items"]["enum"], ["ext-0123456789ab"])
        self.assertEqual(sch["tech"]["required"], ["text", "passages"])
        none = A.schema(A_FIELDS, BOOKS, [])["properties"]["fields"]["properties"]
        self.assertEqual(none["tech"]["properties"]["passages"], {"type": "array", "maxItems": 0})


A_FIELDS = [{**f, "guide": f.get("guide", "")} for f in SPEC]


@unittest.skipUnless(upc_ok(), "needs the upc CLI")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.fx = make_corpus(self.tmp)
        self.calls = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_annotate(self, *extra):
        with mock.patch.object(A.P, "chat", stub_chat(self.calls)):
            return A.main(["--corpus", str(self.fx["corpus"]), "--fields", str(self.fx["spec"]),
                           "--coder", "t-annot-v1", "--model", "chat", *extra])

    def annotations(self):
        out = {}
        for gj in self.fx["corpus"].glob("sources/*/generated/gen-*.json"):
            g = json.loads(gj.read_text())
            out.setdefault(g["provenance"]["derived_from"]["source_ids"][0], []).append(g)
        return out

    def test_annotate_check_store_and_show(self):
        corpus, a, b = self.fx["corpus"], self.fx["a"], self.fx["b"]
        self.assertEqual(self.run_annotate(), 0)
        gens = self.annotations()
        ga, gb = gens[a["source_id"]], gens[b["source_id"]]
        self.assertEqual((len(ga), len(gb)), (1, 1))
        g = ga[0]
        self.assertEqual((g["type"], g["ext"]["upc-site"]["card"]), ("x-annotation", "Annotation"))
        self.assertEqual((g["provenance"]["produced_by"]["method"], g["provenance"]["produced_by"]["model"]), ("model", "chat"))
        fields = {f["key"]: f for f in g["ext"]["upc-corpus"]["annotation"]["fields"]}
        self.assertEqual((fields["setting"]["codes"], fields["setting"]["code_labels"]), (["single-family"], ["Single-family homes"]))
        self.assertNotIn("ext-000000000000", fields["setting"]["note"])
        self.assertNotIn('"', fields["tech"]["text"])
        self.assertEqual(fields["tech"]["cites"], [self.fx["x1"], self.fx["x2"]])
        self.assertTrue(fields["tech"]["text"].endswith(f"[{self.fx['x2']}]"))
        # a quote that is a coded passage is that passage; one that is not goes to the hidden set
        self.assertEqual(fields["tech"]["quote"]["extraction_id"], self.fx["x1"])
        hidden = (corpus / "extractions" / "exs-t-annot-v1-quotes" / "items.jsonl").read_text()
        self.assertIn(fields["setting"]["quote"]["extraction_id"], hidden)
        self.assertEqual(fields["setting"]["quote"]["text"], UNCODED)
        md = (corpus / g["output"]["path"]).read_text()
        self.assertTrue(md.startswith("*Written by a model (chat, as t-annot-v1)"))
        self.assertIn(f'"{UNCODED}" [{fields["setting"]["quote"]["extraction_id"]}]', md)
        self.assertEqual(set(g["provenance"]["derived_from"]["extraction_ids"]),
                         {self.fx["x1"], self.fx["x2"], fields["setting"]["quote"]["extraction_id"]})
        # the second paper: no coded passages; a quote not in it, and one only across a line break, both dropped
        fb = {f["key"]: f for f in gb[0]["ext"]["upc-corpus"]["annotation"]["fields"]}
        self.assertEqual(gb[0]["ext"]["upc-corpus"]["annotation"]["passages_shown"], 0)
        self.assertEqual((fb["tech"]["text"], fb["setting"].get("quote"), fb["tech"].get("quote")), ("Not reported.", None, None))
        self.assertNotIn(b["source_id"], hidden)  # checked by a dry run first: nothing left behind
        self.assertTrue(any("PASSAGES: none are coded" in c and "apartment" in c for c in self.calls))
        rep = C.upc("validate", str(corpus))
        self.assertEqual(rep.get("errors"), [], rep.get("errors"))
        timing = [json.loads(x) for x in (corpus / ".upc" / "upc-corpus" / "timing.jsonl").read_text().splitlines()]
        self.assertEqual(sum(1 for t in timing if t["stage"] == "annotate"), 2)
        # the card on the paper's page, with its checked quotation
        site = self.tmp / "site"
        C.upc("export", str(corpus), "--format", "site", "-o", str(site))
        page = next(p for p in (site / "sources").glob("*.html") if "county" in p.read_text() and "Annotation" in p.read_text())
        html = page.read_text()
        self.assertIn("<strong>Annotation</strong>", html)
        self.assertIn(f'“{UNCODED}” <span class="small" title="Found word for word in the paper">✓</span>', html)
        # done is skipped; --redo writes it again from the same inputs, still one generation
        n = len(self.calls)
        self.assertEqual(self.run_annotate(), 0)
        self.assertEqual(len(self.calls), n)
        self.assertEqual(self.run_annotate("--redo", "--ids", a["slug"]), 0)
        self.assertEqual((len(self.calls), len(self.annotations()[a["source_id"]])), (n + 1, 1))

    def test_plan_writes_nothing(self):
        before = sorted(str(p) for p in self.fx["corpus"].rglob("*") if ".upc" not in p.parts)
        self.assertEqual(self.run_annotate("--plan"), 0)
        self.assertEqual(sorted(str(p) for p in self.fx["corpus"].rglob("*") if ".upc" not in p.parts), before)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
