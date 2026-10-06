"""How the skill finds the `upc` CLI: UPC_CLI, then the standard this skill ships in
(skill/universal-provenance beside skill/upc-corpus), then a checkout at
~/Documents/GitHub/provenance or ~/provenance. Offline; no CLI is run. Run with:

    python3 -m unittest discover -s tests
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import common as C  # noqa: E402

REL = Path("skill/universal-provenance/scripts/upc.mjs")


def make_checkout(root: Path) -> Path:
    script = root / REL
    script.parent.mkdir(parents=True)
    script.write_text("// stub\n")
    return root


class LocateCliTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.none = self.home / "no-sibling" / "upc.mjs"

    def locate(self, env=None, sibling=None):
        return C.locate_upc_cli(env=env or {}, home=self.home, sibling=sibling or self.none)

    def test_sibling_first(self):
        sib = make_checkout(self.home / "repo") / REL
        make_checkout(self.home / "Documents/GitHub/provenance")
        self.assertEqual(self.locate(sibling=sib), ["node", str(sib)])

    def test_env_wins(self):
        make_checkout(self.home / "Documents/GitHub/provenance")
        cli = self.locate(env={"UPC_CLI": "node /x/upc.mjs"})
        self.assertEqual(cli, ["node", "/x/upc.mjs"])

    def test_github_clone_before_old_copy(self):
        gh = make_checkout(self.home / "Documents/GitHub/provenance")
        make_checkout(self.home / "provenance")
        cli = self.locate()
        self.assertEqual(cli, ["node", str(gh / REL)])

    def test_old_copy_when_only_one(self):
        old = make_checkout(self.home / "provenance")
        cli = self.locate()
        self.assertEqual(cli, ["node", str(old / REL)])

    def test_nothing_found_names_the_first_candidate(self):
        # check_compat() then reports it as UNAVAILABLE with a path one can act on.
        cli = self.locate()
        self.assertEqual(cli, ["node", str(self.home / "Documents/GitHub/provenance" / REL)])

    def test_scripts_dir_follows_cli(self):
        self.assertEqual(C.upc_scripts_dir(["node", "/a/b/upc.mjs"]), "/a/b")


if __name__ == "__main__":
    unittest.main()
