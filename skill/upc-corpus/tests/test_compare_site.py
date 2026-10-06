"""compare_site.py: a fresh build against the published copy, by files and by content.
Offline. Run with:

    python3 -m unittest discover -s tests
"""

import copy
import os
import json
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import compare_site as CS  # noqa: E402

# A real build and its hosted copy, when this machine has them (UPC_COMPARE_BUILT, UPC_COMPARE_HOSTED).
STAGING = Path(os.environ.get("UPC_COMPARE_BUILT") or "/nonexistent")
HOSTED = Path(os.environ.get("UPC_COMPARE_HOSTED") or "/nonexistent")


class CompareSiteTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.built, self.published = root / "built", root / "published"
        for site in (self.built, self.published):
            (site / "files").mkdir(parents=True)
            (site / "index.html").write_text("<h1>Home</h1>")
        # the same PDF name, decomposed on one side and composed on the other
        (self.built / "files" / unicodedata.normalize("NFD", "Käsbohrer2024.pdf")).write_bytes(b"%PDF-1")
        (self.published / "files" / unicodedata.normalize("NFC", "Käsbohrer2024.pdf")).write_bytes(b"%PDF-1")
        (self.published / ".DS_Store").write_bytes(b"junk")

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self):
        return subprocess.run([sys.executable, str(SCRIPTS / "compare_site.py"), str(self.built), str(self.published)],
                              capture_output=True, text=True)

    def test_identical_despite_unicode_forms_and_finder_files(self):
        r = CS.compare(self.built, self.published)
        self.assertEqual((r["same"], r["differ"], r["only_built"], r["only_published"]), (2, [], [], []))
        cli = self.run_cli()
        self.assertEqual(cli.returncode, 0)
        self.assertIn("IDENTICAL", cli.stdout)

    def test_changed_new_and_gone_files_are_named(self):
        (self.built / "index.html").write_text("<h1>Home, rebuilt</h1>")
        (self.built / "new.html").write_text("new")
        (self.published / "old.html").write_text("old")
        r = CS.compare(self.built, self.published)
        self.assertEqual((r["differ"], r["only_built"], r["only_published"]), (["index.html"], ["new.html"], ["old.html"]))
        cli = self.run_cli()
        self.assertEqual(cli.returncode, 1)
        self.assertIn("differs  index.html", cli.stdout)

    def test_missing_folder_is_a_usage_error(self):
        r = subprocess.run([sys.executable, str(SCRIPTS / "compare_site.py"), str(self.built), "/no/such/folder"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)


# --------------------------------------------------------------------------- content

DATA = {
    "sources": [{"i": 0, "t": "A paper", "a": "Doe, J.", "y": 2020, "d": "10.1/x", "c": "", "k": "Doe 2020",
                 "sl": "s0001-doe-2020", "p": "s0001.pdf",
                 "g": [["relevance", "core", "screen-v1", "high", "About the topic."]]}],
    "passages": [
        {"id": "ext-aaaaaaaaaaaa", "s": 0, "q": "First quote.", "n": "", "b": "verified", "st": "", "l": 3,
         "pg": 2, "x": "before", "y": "after", "act": None, "g": [["theory", "mlp", "coder-v1", "high", ""]], "dis": 0},
        {"id": "ext-bbbbbbbbbbbb", "s": 0, "q": "Second quote.", "n": "", "b": "verified", "st": "", "l": 9,
         "pg": 5, "x": "before", "y": "after", "act": None, "g": [["theory", "mlp", "coder-v1", "high", ""]], "dis": 0},
    ],
    "codebooks": [{"slug": "theory", "title": "Theory", "question": "Which theory?", "unit": "passage",
                   "codes": [{"code": "mlp", "label": "Multi-level perspective", "def": "Niche, regime, landscape."}]}],
    "ck": {"coder-v1": "model", "screen-v1": "model"},
    "badges": {"verified": ["✓", "Checked", "Compared character by character."]},
}

OLD_LINK = ('<a class="muted" href="../files/s0001.pdf#page={pg}" title="Open the original PDF at this page">'
            'page {pg} ↗</a>')
NEW_LINK = ('<a class="muted" href="../files/s0001.pdf#page={pg}" '
            'title="Opens the PDF at its {nth} page. The printed page may differ.">See in original, p. {pg} ↗</a>')


def card(pid, quote, pg, link=OLD_LINK, nth="", ctx=None):
    body = f"<mark>{quote}</mark>"
    body = f'<blockquote class="ctx">…{ctx[0]}{body}{ctx[1]}…</blockquote>' if ctx else f"<blockquote>{body}</blockquote>"
    return (f'<article class="passage" id="{pid}" data-code="theory:mlp" data-coder="coder-v1" '
            f'data-source="src-1" data-year="2020">{body}<div class="meta">'
            f'<span class="chip" title="Multi-level perspective: Niche, regime, landscape.&#10;Coded by coder-v1">'
            f'<a href="../codes/theory/mlp.html">Multi-level perspective</a></span> '
            + link.format(pg=pg, nth=nth) + "</div></article>")


def source_page(cards, script="var a = 1;"):
    return ("<!doctype html><html><head><title>Doe 2020 — A paper</title>"
            f"<script>{script}</script><style>p{{color:red}}</style></head><body><main>"
            "<h1>A paper</h1><p class=\"lede\">Doe, J. · 2020 · <a href=\"https://doi.org/10.1/x\">doi:10.1/x</a></p>"
            "<h2>Passages (2)</h2>" + "\n".join(cards) +
            "<h2>The text this was checked against</h2><div class=\"reading\"><p>Some words. "
            "<mark id=\"t-ext-aaaaaaaaaaaa\">First quote.</mark> More words.</p></div></main></body></html>")


OVERVIEW = ("<html><body><main><h1>Overviews</h1><p>Transitions need actors who align "
            "<a class=\"pn\" href=\"../sources/s0001-doe-2020.html#ex=ext-aaaaaaaaaaaa\">1</a>.</p>"
            "<h2>What this says, and what backs it</h2><table><tr><td>Actors align.</td>"
            "<td><a href=\"../sources/s0001-doe-2020.html#ex=ext-aaaaaaaaaaaa\">Doe 2020</a></td></tr></table>"
            "</main></body></html>")


def write_site(root: Path, data=None, cards=None, overview=OVERVIEW, script="var a = 1;"):
    data = copy.deepcopy(DATA) if data is None else data
    cards = cards or [card("ext-aaaaaaaaaaaa", "First quote.", 2), card("ext-bbbbbbbbbbbb", "Second quote.", 5)]
    for d in ("data", "assets", "files", "overviews", "sources"):
        (root / d).mkdir(parents=True, exist_ok=True)
    (root / "data" / "browse.js").write_text("window.__UPCB_DATA=" + json.dumps(data, ensure_ascii=False) + ";\n",
                                             encoding="utf-8")
    (root / "assets" / "site.js").write_text(f"/* {script} */")
    (root / "files" / "s0001.pdf").write_bytes(b"%PDF-1 paper")
    (root / "index.html").write_text("<html><body><main><h1>Home</h1><p>Start here.</p></main></body></html>")
    (root / "overviews" / "syn-111111111111.html").write_text(overview, encoding="utf-8")
    (root / "sources" / "s0001-doe-2020.html").write_text(source_page(cards, script), encoding="utf-8")
    return root


def write_single(path: Path, data=None, overview_h="<p>Transitions need actors who align.</p>", text="Full text."):
    data = copy.deepcopy(DATA) if data is None else data
    data.setdefault("overviews", [{"id": "syn-111111111111", "t": "Actors", "grp": "actor", "h": overview_h}])
    data.setdefault("home", {"t": "Home", "h": "<p>Summary words.</p>"})
    data.setdefault("title", "Library")
    body = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    path.write_text('<!doctype html><html><head><title>Library</title></head><body><header>Library</header>'
                    f'<script type="application/json" id="upc-data">{body}</script>'
                    f'<script type="application/json" id="upc-t0">{json.dumps(text)}</script>'
                    "<script>/* app */</script></body></html>", encoding="utf-8")
    return path


class ContentTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.old = write_site(self.root / "old")

    def tearDown(self):
        self._tmp.cleanup()

    def new(self, **kw):
        return write_site(self.root / "new", **kw)

    def kinds(self, r, kind):
        return [(i["area"], i["where"].split(" ")[0], i["what"]) for i in r["findings"].of(kind)]

    def test_same_words_despite_new_bytes(self):
        new = self.new(script="var a = 2;")   # different code, same words
        (new / "sources" / "s0001-doe-2020.html").write_text(
            source_page([card("ext-aaaaaaaaaaaa", "First quote.", 2), card("ext-bbbbbbbbbbbb", "Second quote.", 5)],
                        "var a = 2;").replace("<h2>", "\n\n  <h2>") + "<!-- rebuilt -->")
        r = CS.compare_content(self.old, new)
        self.assertEqual((r["findings"].of("changed"), r["findings"].of("added")), ([], []))
        self.assertEqual(r["tally"]["pages"]["same"], 3)
        self.assertEqual(r["findings"].code_style, ["assets/site.js"])

    def test_changed_and_added_words(self):
        new = self.new(overview=OVERVIEW.replace("need actors", "need people")
                       .replace("</table>", "</table><p>A new note.</p>"))
        r = CS.compare_content(self.old, new)
        self.assertEqual(self.kinds(r, "changed"), [("page", "overviews/syn-111111111111.html", "words")])
        self.assertEqual(r["findings"].of("changed")[0]["old"], "actors")
        self.assertEqual(self.kinds(r, "added"), [("page", "overviews/syn-111111111111.html", "words")])
        self.assertEqual(r["findings"].of("added")[0]["new"], "A new note.")

    def test_a_link_target_is_content(self):
        new = self.new(overview=OVERVIEW.replace("#ex=ext-aaaaaaaaaaaa\">1", "#ex=ext-bbbbbbbbbbbb\">1"))
        r = CS.compare_content(self.old, new)
        self.assertEqual(len(r["findings"].of("changed")), 1)
        self.assertIn("ext-bbbbbbbbbbbb", r["findings"].of("changed")[0]["new"])

    def test_passage_fields_and_chips(self):
        data = copy.deepcopy(DATA)
        a, b = data["passages"]
        a["q"] = "First quote, edited."
        a["g"].append(["evidence", "own-finding", "appraise-v1", "medium", ""])
        b["g"] = []
        for p in data["passages"]:
            del p["x"], p["y"]          # never shown
            p["cx"] = [0, 10]           # a new field
        data["codebooks"].append({"slug": "claim-origin", "title": "Claim origin", "codes": []})
        r = CS.compare_content(self.old, self.new(data=data))
        self.assertEqual(sorted(self.kinds(r, "changed")),
                         [("passage", "ext-aaaaaaaaaaaa", "q"),
                          ("passage", "ext-bbbbbbbbbbbb", "chip gone: theory:mlp by coder-v1")])
        self.assertEqual(sorted(self.kinds(r, "added")),
                         [("passage", "ext-aaaaaaaaaaaa", "chip evidence:own-finding by appraise-v1"),
                          ("scheme", "claim-origin", "new")])
        counts = r["findings"].counts["passage"]
        self.assertEqual((counts["x (never shown) dropped from"], counts["new field cx on"]), (2, 2))

    def test_a_card_that_moves_is_changed(self):
        new = self.new(cards=[card("ext-bbbbbbbbbbbb", "Second quote.", 5), card("ext-aaaaaaaaaaaa", "First quote.", 2)])
        r = CS.compare_content(self.old, new)
        whats = [i["what"] for i in r["findings"].of("changed")]
        self.assertEqual(len(whats), 1)
        self.assertRegex(whats[0], r"passage card ext-[ab]{12} moved")
        self.assertEqual(r["findings"].of("added"), [])

    def test_order_of_passages_in_the_data_is_checked(self):
        data = copy.deepcopy(DATA)
        data["passages"].reverse()
        r = CS.compare_content(self.old, self.new(data=data))
        self.assertEqual(self.kinds(r, "changed"), [("passage", "order", "1 of 2 in a different order")])

    def test_approved_label_and_page_correction(self):
        data = copy.deepcopy(DATA)
        data["passages"][1]["pg"] = 6
        new = self.new(data=data, cards=[card("ext-aaaaaaaaaaaa", "First quote.", 2, NEW_LINK, "2nd"),
                                         card("ext-bbbbbbbbbbbb", "Second quote.", 6, NEW_LINK, "6th")])
        unapproved = CS.compare_content(self.old, new)
        self.assertGreater(len(unapproved["findings"].of("changed")), 2)

        approved = self.root / "approved.json"
        approved.write_text(json.dumps({
            "rewrites": [{"find": r"@title Open the original PDF at this page (@href=\S+#page=(\d+)) page \2 ↗",
                          "replace": r"@title Opens the PDF at its {ordinal:2} page. The printed page may differ. "
                                     r"\1 See in original, p. \2 ↗",
                          "where": "sources/*", "why": "the new link label"}],
            "passages": {"ext-bbbbbbbbbbbb": {"pg": [5, 6], "why": "page offsets fixed"}}}), encoding="utf-8")
        r = CS.compare_content(self.old, new, CS.Approved(str(approved)))
        self.assertEqual(r["findings"].of("changed"), [])
        self.assertEqual(dict(r["approved"].used), {"the new link label": 2, "page offsets fixed": 3})
        self.assertEqual(r["tally"]["passages"]["corrected"], 1)
        self.assertEqual(r["tally"]["pages"]["corrected"], 1)

        # a page change nobody approved is still a change
        data["passages"][0]["pg"] = 3
        r = CS.compare_content(self.old, self.new(data=data), CS.Approved(str(approved)))
        self.assertIn(("passage", "ext-aaaaaaaaaaaa", "pg"), self.kinds(r, "changed"))

    def test_context_around_a_quote_is_reported_apart(self):
        old = write_site(self.root / "old-ctx", cards=[card("ext-aaaaaaaaaaaa", "First quote.", 2, ctx=("a b ", " c d"))])
        new = write_site(self.root / "new-ctx", cards=[card("ext-aaaaaaaaaaaa", "First quote.", 2,
                                                            ctx=("whole sentence before. ", " After."))])
        r = CS.compare_content(old, new)
        self.assertEqual(r["findings"].of("changed"), [])
        self.assertEqual(dict(r["findings"].context), {"sources/s0001-doe-2020.html": 1})

    def test_ordinals(self):
        self.assertEqual([CS.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111)],
                         ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"])

    def test_single_file_sites(self):
        old = write_single(self.root / "old.html")
        same = write_single(self.root / "same.html")
        r = CS.compare_content(old, same)
        self.assertEqual((r["findings"].of("changed"), r["findings"].of("added")), ([], []))
        self.assertEqual(r["tally"]["full texts"]["same"], 1)
        new = write_single(self.root / "new.html", overview_h="<p>Transitions need people who align.</p>",
                           text="Full text, changed.")
        r = CS.compare_content(old, new)
        self.assertEqual(sorted(self.kinds(r, "changed")),
                         [("full text", "s0001-doe-2020", "text differs"),
                          ("overview", "syn-111111111111", "words")])

    def test_cli_exit_codes(self):
        cli = [sys.executable, str(SCRIPTS / "compare_site.py"), "--content"]
        same = subprocess.run(cli + [str(self.old), str(self.new())], capture_output=True, text=True)
        self.assertEqual(same.returncode, 0, same.stdout + same.stderr)
        self.assertIn("SAME CONTENT", same.stdout)
        changed = self.new(overview=OVERVIEW.replace("actors", "people"))
        r = subprocess.run(cli + [str(self.old), str(changed)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("CHANGED: 1 thing", r.stdout)
        mixed = subprocess.run(cli + [str(self.old), str(write_single(self.root / "x.html"))],
                               capture_output=True, text=True)
        self.assertEqual(mixed.returncode, 2)

    def test_calibration_finds_exactly_the_injected_changes(self):
        for site in (self.old, write_single(self.root / "single.html")):
            ok, lines = CS.calibrate(site)
            self.assertTrue(ok, "\n".join(lines))


@unittest.skipUnless(STAGING.is_dir(), "set UPC_COMPARE_BUILT (and UPC_COMPARE_HOSTED) to a real build")
class RealBuildTests(unittest.TestCase):
    """A real build and its hosted copy: quick, since unchanged pages are skipped by their bytes."""

    def test_calibrates_on_the_real_build(self):
        ok, lines = CS.calibrate(STAGING)
        self.assertTrue(ok, "\n".join(lines))

    @unittest.skipUnless(HOSTED.is_dir(), "the hosted copy is not on this machine")
    def test_hosted_copy_has_the_same_content(self):
        r = CS.compare_content(HOSTED, STAGING)
        self.assertEqual(r["findings"].of("changed"), [])


if __name__ == "__main__":
    unittest.main()
