"""pdftext.locate_pages, page_health and page_of_quote: where each PDF page starts in
a reading copy, and whether a passage's page is right. No PDFs needed. Run with:

    python3 -m unittest discover -s tests
"""

import random
import os
import sys
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import pdftext as PT  # noqa: E402

# Long and never repeating itself, like a real page (a periodic filler would be
# ambiguous everywhere, by design).
_rng = random.Random(7)
FILLER = " ".join(_rng.choice("regime niche landscape actor policy market heat pump installer household utility "
                              "incumbent lock-in learning network vision experiment subsidy tariff retrofit "
                              "contractor supply chain justice practice routine comfort grid storage".split())
                  for _ in range(900)) + "."


def reading_copy(pages):
    """What convert() makes of pages that have already lost their furniture."""
    return PT.soft_wrap("\n\n".join(pages)) + "\n"


class LocatePagesTests(unittest.TestCase):
    def test_wrapped_lines_broken_words_and_one_letter_words(self):
        pages = ["Socio-technical transitions are long-term processes. A\nregime is stable because of lock-in mecha-\n"
                 "nisms and sunk investments in infrastructure.\n",
                 "A niche is a protected space where radical innovations emerge, and\na landscape presses on the "
                 "regime from outside.\n",
                 "References\nSmith, J. (2010). A study of lock-in mechanisms and sunk investments.\n"]
        text = reading_copy(pages)
        self.assertIn("mechanisms", text)   # the broken word was rejoined
        m = PT.locate_pages(pages, text)
        self.assertEqual(m["how"], ["located"] * 3)
        self.assertEqual(m["offsets"], [0, text.index("A niche"), text.index("References")])
        self.assertTrue(PT.page_health(m)["ok"])

    def test_a_match_far_ahead_never_drags_the_pages(self):
        # Page 2's words are garbled in the reading copy, but its opening phrase is
        # quoted in the references, far out of reach. The old search took that
        # match and lost every page after it.
        p2 = "The lock-in of incumbent technologies explains why regimes resist change for decades.\n"
        pages = ["An introduction to transitions and why they matter for energy policy.\n", p2,
                 FILLER + "\n", "References\nDoe (2001) The lock-in of incumbent technologies explains why "
                                "regimes resist change for decades.\n"]
        text = reading_copy([pages[0], "Tbe Iock-ln 0f lncumbent tecbnologles expIalns wby reglmes reslst.",
                             pages[2], pages[3]])
        m = PT.locate_pages(pages, text)
        self.assertEqual(m["how"], ["located", "interpolated", "located", "located"])
        self.assertEqual(m["offsets"][2], text.index(FILLER[:30]))
        self.assertEqual(m["offsets"][3], text.index("References"))
        self.assertTrue(m["offsets"][0] < m["offsets"][1] <= m["offsets"][2])

    def test_a_fingerprint_found_twice_within_reach_is_passed_over(self):
        heading = "Strategic niche management and the protection of radical innovations"
        pages = ["Opening words of the paper about a sustainability transition in heating.\n",
                 heading + ". Experiments show how learning happens in protected spaces over time.\n",
                 heading + ". Shielding, nurturing and empowering are its three processes in practice.\n"]
        text = reading_copy(pages)
        m = PT.locate_pages(pages, text)
        self.assertEqual(m["how"], ["located"] * 3)
        self.assertEqual(m["offsets"][1:], [text.index(heading), text.rindex(heading)])

    def test_a_caption_moved_elsewhere_does_not_pull_the_page_back(self):
        caption = "Figure three shows the multi level perspective on transitions"
        body = "The regime adapts slowly while niche innovations gather momentum and pressure builds."
        pages = ["The first page ends with a sentence about policy mixes and their design.\n",
                 caption + "\n" + body + " " + FILLER[:400] + "\n"]
        text = reading_copy([pages[0], body + " " + FILLER[:400], caption])   # the caption went to the end
        m = PT.locate_pages(pages, text)
        self.assertEqual(m["how"], ["located", "located"])
        self.assertEqual(m["offsets"][1], text.index("The regime adapts"))

    def test_an_empty_page_takes_the_next_start(self):
        pages = ["A first page with plenty of words about heat pumps and installers.\n", "  12  \n",
                 "A third page about contractors, training and the supply chain for heat pumps.\n"]
        text = reading_copy([pages[0], pages[2]])
        m = PT.locate_pages(pages, text)
        self.assertEqual(m["how"], ["located", "empty", "located"])
        third = text.index("A third")
        self.assertEqual(m["offsets"][2], third)
        self.assertLessEqual(m["offsets"][1], third)
        import bisect
        self.assertEqual(bisect.bisect_right(m["offsets"], third + 5), 3)   # a passage there is on page 3

    def test_a_page_starts_at_its_first_word_not_its_first_letter(self):
        text = "The end of the first page.\n\n2. Methods are described here at length."
        letters, where = PT._letters(text)
        s = letters.index("Methods")
        self.assertEqual(PT._char_start(text, where, s), text.index("2. Methods"))
        self.assertEqual(PT._char_start(text, where, 0), 0)
        self.assertEqual(PT._char_start(text, where, len(letters)), len(text))


class PageHealthTests(unittest.TestCase):
    def health(self, starts, letters, how=None, total=None):
        return PT.page_health({"starts": starts, "letters": letters, "how": how or ["located"] * len(starts),
                               "text_letters": total if total is not None else sum(letters)})

    def test_a_believable_map(self):
        h = self.health([0, 1000, 2100], [1000, 1100, 900])
        self.assertTrue(h["ok"])
        self.assertEqual((h["located"], h["odd_lengths"], h["backwards"]), (3, [], []))

    def test_pages_taking_an_odd_share_of_the_text(self):
        h = self.health([0, 100, 2900], [1000, 1000, 1000], total=3000)
        self.assertEqual(h["odd_lengths"], [1, 2, 3])
        self.assertFalse(h["ok"])

    def test_offsets_going_backwards(self):
        h = self.health([0, 500, 400], [500, 500, 500])
        self.assertEqual(h["backwards"], [3])
        self.assertFalse(h["ok"])

    def test_too_few_pages_located(self):
        h = self.health([0, 300, 600, 900, 1200], [300] * 5,
                        how=["located", "interpolated", "interpolated", "located", "located"])
        self.assertFalse(h["ok"])


class PageOfQuoteTests(unittest.TestCase):
    pages = [PT._letters(p)[0] for p in (
        "Incumbent firms resist change.\nThey lobby against new rules and slow the transition down.",
        "Installers are the gatekeepers of heat pump adoption in existing homes everywhere.",
        "Incumbent firms resist change. This repeats an earlier sentence, deliberately.")]

    def test_the_page_holding_the_opening_words(self):
        self.assertEqual(PT.page_of_quote(self.pages, "Installers are the gatekeepers of heat pump adoption"), 2)

    def test_a_quote_running_onto_the_next_page_starts_on_the_first(self):
        self.assertEqual(PT.page_of_quote(self.pages, "slow the transition down. Installers are the gatekeepers"), 1)

    def test_opening_words_on_two_pages_cannot_tell(self):
        self.assertIsNone(PT.page_of_quote(self.pages, "Incumbent firms resist change."))

    def test_too_short_to_tell(self):
        self.assertIsNone(PT.page_of_quote(self.pages, "Installers."))


if __name__ == "__main__":
    unittest.main()
