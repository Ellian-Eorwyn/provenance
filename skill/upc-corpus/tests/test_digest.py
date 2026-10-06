"""digest.py: a site for people, built only from a corpus that validates.

A synthetic corpus: two web articles, one card each (upc add generation, one
with a byte-checked pull quote), and a profile corpus with an
x-organization-profile synthesis. No network: images are not fetched.
"""

import hashlib
import os
import json
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
HERE = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(HERE))
import common as C  # noqa: E402
import digest as D  # noqa: E402


def upc_ok():
    try:
        v = C.upc("version", "--json")
        return tuple(int(x) for x in str(v.get("spec_version", "0.0")).split(".")[:2]) >= (1, 14)
    except Exception:  # noqa: BLE001
        return False


SECRET = "This sentence is only in the article body and must never appear on the site."
ART = ("# The Sea Overture\n\nThe composer sketched the opening on the island in 1829. "
       "The cellos and bassoons carry the rolling figure that opens the overture.\n\n" + SECRET + "\n\n" + "Context. " * 60)


def add_web(corpus: Path, stage: Path, key: str, url: str, text: str, title: str):
    raw = stage / (hashlib.sha256(key.encode()).hexdigest()[:8] + ".html")
    raw.write_text(f"<html><body>{text}</body></html>")
    md = raw.with_suffix(".md")
    md.write_text(text)
    prov = {"original_url": url, "final_url": url, "http_status": 200, "content_type": "text/html",
            "fetched_at": "2026-09-29T20:00:00Z", "fetch_status": "success", "fetch_method": "playwright",
            "extraction_method": "readability", "sha256": hashlib.sha256(raw.read_bytes()).hexdigest()}
    items = stage / "items.jsonl"
    items.write_text(json.dumps({"key": key, "kind": "web", "file": str(raw), "reading_copy": str(md),
                                 "provenance": prov, "title": title, "asr": None}) + "\n")
    import subprocess
    subprocess.run([sys.executable, str(HERE / "add_acquired.py"), "--corpus", str(corpus), "--items", str(items)],
                   check=True, capture_output=True)
    return C.corpus_reps(corpus)[key]


def card(corpus: Path, info: dict, stage: Path, summary: str, quote: str | None, meta: dict):
    body = summary + "\n"
    if quote:
        res = C.upc_jsonl("anchor", "--corpus", str(corpus), "--rep", info["text_rep"], "--set", "exs-t",
                          records=[{"quote": quote}])
        eid = res["results"][0]["extraction_id"]
        body += f'\n> "{quote}" [{eid}]\n'
    f = stage / (info["slug"] + ".md")
    f.write_text(body)
    return C.upc("add", "generation", "--corpus", str(corpus), "--output", str(f), check=False,
                 stdin=json.dumps({"type": "summary", "title": meta["title"], "source_id": info["source_id"],
                                   "ext": {"hermes": {"digest_card": meta}}}))


@unittest.skipUnless(upc_ok(), "needs the upc CLI 1.14+ (add generation)")
class Digest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(tempfile.mkdtemp())
        cls.corpus, stage = root / "digest", root / "stage"
        stage.mkdir()
        a = add_web(cls.corpus, stage, "url:https://ex.org/a", "https://ex.org/a", ART, "Listening to the Sea Overture")
        b = add_web(cls.corpus, stage, "url:https://ex.org/b", "https://ex.org/b",
                    "# Chorale\n\n" + "The symphony quotes a Lutheran chorale in its finale. " * 12, "The Chorale Symphony")
        r1 = card(cls.corpus, a, stage, "A guide to the overture's opening.",
                  "The cellos and bassoons carry the rolling figure that opens the overture.",
                  {"title": "Listening to the Sea Overture", "sections": ["overture"], "kind": "program-note",
                   "reading_minutes": 3, "site_name": "Example Notes", "author": "A. Writer", "url": "https://ex.org/a"})
        r2 = card(cls.corpus, b, stage, "Why a chorale closes the symphony.", None,
                  {"title": "The Chorale Symphony", "sections": ["chorale"], "kind": "musicology",
                   "reading_minutes": 2, "url": "https://ex.org/b"})
        assert r1["status"] == "ok" and r2["status"] == "ok", (r1, r2)
        C.upc("regen", str(cls.corpus))
        cls.cfg = {"title": "An autumn concert", "organization": "Example Orchestra", "subtitle": "Readings.",
                   "request": "Readings for the concert.",
                   "sections": [{"slug": "overture", "title": "Sea Overture", "description": "Readings on it."},
                                {"slug": "chorale", "title": "Symphony No. 5", "description": "Readings on it."}]}
        # A profile corpus with one fact.
        cls.about = root / "profile"
        p = add_web(cls.about, stage, "url:https://org.example/about", "https://org.example/about",
                    "# About\n\nJane Example is the orchestra's Music Director. " + "More. " * 60, "About us")
        res = C.upc_jsonl("anchor", "--corpus", str(cls.about), "--rep", p["text_rep"], "--set", "exs-p",
                          records=[{"quote": "Jane Example is the orchestra's Music Director."}])
        eid = res["results"][0]["extraction_id"]
        md = stage / "profile.md"
        md.write_text(f'# Profile\n\n## Music director\n\n- Jane Example: "Jane Example is the orchestra\'s Music Director." '
                      f'[{eid}] (About us · {p["source_id"]})\n\n## Not found in any source\n\n- Founded\n')
        C.upc("add", "synthesis", "--corpus", str(cls.about), "--output", str(md), stdin=json.dumps({
            "type": "x-organization-profile", "title": "Profile", "claims": [
                {"claim_id": "cl-0001", "text": "Music director: Jane Example", "evidence_ids": [eid],
                 "source_ids": [p["source_id"]], "confidence": "high"}], "ext": {"hermes": {"org": {"name": "Example Orchestra"}}}}))
        cls.out = root / "site"
        cls.res = D.build(cls.corpus, cls.cfg, cls.out, cls.about, fetch_images=False)
        cls.index = (cls.out / "index.html").read_text()

    def test_cards_by_section(self):
        self.assertEqual((self.res["cards"], self.res["sections"]), (2, 2))
        self.assertIn('id="overture"', self.index)
        self.assertIn("Listening to the Sea", self.index)
        self.assertIn("Summary by the assistant", self.index)
        self.assertIn("Read at Example Notes", self.index)

    def test_a_card_appears_once_and_whole_program_items_go_to_the_overview(self):
        cfg = {**self.cfg, "overview": {"slug": "concert", "title": "The concert", "description": "", "min_sections": 2}}
        out = self.out.parent / "site-ov"
        D.build(self.corpus, cfg, out, fetch_images=False)
        index = (out / "index.html").read_text()
        self.assertEqual(index.count("Listening to the Sea"), 1)  # each card appears once
        cs = D.cards(self.corpus)
        self.assertTrue(all(len(c["sections"]) < 2 for c in cs))
        self.assertNotIn('id="concert"', index)  # no card belongs to two sections here

    def test_only_the_checked_pull_quote_is_published(self):
        self.assertIn("The cellos and bassoons carry the rolling figure", self.index)
        for f in self.out.glob("*.html"):
            self.assertNotIn(SECRET, f.read_text(), f.name)

    def test_about_page_quotes_each_fact(self):
        about = (self.out / "about.html").read_text()
        self.assertIn("Jane Example is the orchestra", about)
        self.assertIn("Not found in any source", about)

    def test_sources_page_lists_hashes_and_method(self):
        src = (self.out / "sources.html").read_text()
        self.assertIn("Fixity is not authenticity", src)
        self.assertIn("https://ex.org/a", src)

    def test_light_and_dark_and_noindex(self):
        self.assertIn("prefers-color-scheme:dark", self.index)
        self.assertIn('name="robots" content="noindex', self.index)
        self.assertIn('name="viewport"', self.index)

    def test_the_build_record_is_kept_beside_the_site_not_in_it(self):
        self.assertFalse((self.out / "digest.json").exists())
        rec = json.loads((self.out.parent / "site.build.json").read_text())
        self.assertEqual(rec["cards"], 2)
        for f in self.out.rglob("*"):
            if f.is_file():
                self.assertNotIn(str(self.out.parent), f.read_text(errors="replace"), f.name)  # no local paths published

    def test_about_and_method_pages_can_be_left_out(self):
        out = self.out.parent / "site-lean"
        out.mkdir()
        (out / "about.html").write_text("left over from an earlier build")  # must not linger
        res = D.build(self.corpus, {**self.cfg, "about": False, "method_page": False}, out, self.about, fetch_images=False)
        self.assertEqual(res["pages"], ["index.html"])
        self.assertEqual(sorted(f.name for f in out.iterdir()), ["index.html"])
        index = (out / "index.html").read_text()
        self.assertNotIn("sources.html", index)
        self.assertNotIn("about.html", index)
        self.assertNotIn("Jane Example", index)
        self.assertIn("saved 29 Sep 2026", index)  # the saved date stays, unlinked

    def test_a_suppressed_string_refuses_the_build(self):
        out = self.out.parent / "site-suppressed"
        with self.assertRaises(SystemExit) as cm:
            D.build(self.corpus, {**self.cfg, "suppress": ["jane  EXAMPLE"]}, out, self.about, fetch_images=False)
        self.assertIn("about.html", str(cm.exception))
        self.assertFalse((out / "about.html").exists())  # nothing written
        # Split across tags or hidden in an attribute still counts.
        hits = D.suppressed_in({"a.html": "<p>Jane <b>Example</b></p>", "b.html": '<img alt="Jane&nbsp;Example">',
                                "c.html": "<p>Jane Examplewood</p>"}, ["Jane Example"])
        self.assertEqual([h[0] for h in hits], ["a.html", "b.html", "c.html"])
        self.assertEqual(D.suppressed_in({"d.html": "<p>Sam Conductor</p>"}, ["Jane Example"]), [])

    def test_a_cached_preview_image_keeps_its_credit(self):
        out = self.out.parent / "site-img"
        (out / "img").mkdir(parents=True)
        url = "https://ex.org/a.jpg"
        name = f"img/{hashlib.sha256(url.encode()).hexdigest()[:16]}.jpg"
        (out / name).write_bytes(b"jpeg")
        credit = {"url": url, "status": "saved", "file": name, "sha256_served": "ab" * 32, "fetched_at": "2026-09-29T20:00:00+00:00"}
        log: list = []
        self.assertEqual(D.thumbnail(url, out, log, {name: credit}), name)
        self.assertEqual(log, [credit])
        log2: list = []
        D.thumbnail(url, out, log2)
        self.assertEqual(log2[0]["url"], url)

    def _tamper(self, old, new):
        gen = next(g for g in self.corpus.glob("sources/*/generated/gen-*.md") if old in g.read_text())
        good = gen.read_text()
        try:
            gen.write_text(good.replace(old, new))
            with self.assertRaises(SystemExit) as cm:
                D.build(self.corpus, self.cfg, self.out.parent / "site2", fetch_images=False)
            return str(cm.exception)
        finally:
            gen.write_text(good)

    def test_a_misquoting_card_refuses_to_build(self):
        self._tamper("rolling figure", "ROLLING figure")

    def test_an_edited_card_fails_validation(self):
        why = self._tamper("A guide to the overture", "A guide to the famous overture")
        self.assertIn("does not validate", why)


if __name__ == "__main__":
    unittest.main()
