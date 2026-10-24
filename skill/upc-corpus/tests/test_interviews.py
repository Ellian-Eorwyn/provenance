"""Interviews from recordings: the glossary, captions, speakers, the transcript and its timings,
times on passages, answers cut from labelled turns, names, and the guide's codebooks.

No model server and no transcription server: the engines' output is written by hand, and the
model's replies are stubbed. The end-to-end test needs ffmpeg and the upc CLI, and is skipped
without them.
"""

import json
import os
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
import common as C  # noqa: E402
import glossary as G  # noqa: E402
import interview_pass as IP  # noqa: E402
import make_codebooks as MC  # noqa: E402
import timecode as TC  # noqa: E402
import transcribe as T  # noqa: E402

HAVE_FFMPEG = bool(shutil.which("ffmpeg") or Path("/opt/homebrew/bin/ffmpeg").exists())


def upc_ok():
    try:
        v = C.upc("version", "--json")
        return tuple(int(x) for x in str(v.get("spec_version", "0.0")).split(".")[:2]) >= (1, 15)
    except Exception:  # noqa: BLE001
        return False


GLOSSARY = """revision: 2
terms:
  - {term: Hollenbeck Hall, kind: place, heard: [Hollenbek Hall, Hollen Beck Hall]}
  - {term: Copper & Kettle, kind: place, heard: [Copper and Kettle]}
  - {term: Music in the Parks, kind: program}
  - {term: concerto, kind: term}
  - {term: Morgan, kind: person, heard: [Morgen]}
"""

GUIDE = """title: A guide
intake:
  - {id: circle, options: {"1": Close, "3": Beyond}}
questions:
  - {id: q1, label: What comes to mind, text: "What comes to mind?", follow_ups: ["How would you describe it?"]}
  - {id: q2, label: If it didn't exist, text: "What would be lost?", cues: [imagine it gone]}
"""


class GlossaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "g.yaml").write_text(GLOSSARY)
        self.g = G.load(self.tmp / "g.yaml")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_listed_misrecognitions_and_case_are_fixed_and_logged(self):
        text, log = G.apply("we met morgen at hollenbek hall for music in the parks; Copper and Kettle", self.g)
        self.assertEqual(text, "we met Morgan at Hollenbeck Hall for Music in the Parks; Copper & Kettle")
        self.assertEqual([c["heard"] for c in log], ["morgen", "hollenbek hall", "music in the parks", "Copper and Kettle"])

    def test_a_plain_term_keeps_its_case_and_whole_words_only(self):
        text, log = G.apply("the Concerto and the Hollenbek Hallway", self.g)
        self.assertEqual(text, "the Concerto and the Hollenbek Hallway")
        self.assertEqual(log, [])

    def test_near_misses_are_suggested_not_applied(self):
        got = G.near_misses("Then Hollenbock Hall, and Hollenbeck Hall's lobby, and Riverbend", self.g)
        self.assertEqual([(m["heard"], m["term"]) for m in got], [("Hollenbock Hall", "Hollenbeck Hall")])

    def test_words_next_to_a_term_spelled_right_are_no_near_miss(self):
        (self.tmp / "s.yaml").write_text("terms:\n  - {term: Riverbend Symphony, kind: org}\n"
                                         "  - {term: Riverbend Symphony & Friends, kind: program}\n"
                                         "  - {term: Port Royal Symphony, kind: org}\n")
        g = G.load(self.tmp / "s.yaml")
        got = G.near_misses("What does Riverbend Symphony do? The Port Royal Symphony is big. "
                            "Then Riverbnd Symphony and Friends played.", g)
        self.assertEqual([(m["heard"], m["term"]) for m in got], [("Riverbnd Symphony and Friends", "Riverbend Symphony & Friends")])

    def test_prompt_puts_people_and_places_first(self):
        self.assertTrue(G.prompt(self.g).startswith("Morgan, Hollenbeck Hall"))

    def test_a_missing_glossary_is_empty_and_a_bad_kind_refused(self):
        self.assertEqual(G.load(self.tmp / "none.yaml")["terms"], [])
        (self.tmp / "bad.yaml").write_text("terms: [{term: X, kind: thing}]")
        with self.assertRaises(ValueError):
            G.load(self.tmp / "bad.yaml")


class CaptionsAndTracksTest(unittest.TestCase):
    def test_zoom_vtt_with_speakers(self):
        tmp = Path(tempfile.mkdtemp())
        f = tmp / "z.vtt"
        f.write_text("WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.500\nLaili Gohartaj: Is it okay if I record?\n\n"
                     "2\n00:00:05.000 --> 00:00:06.000\nSure, go ahead.\n")
        cues = T.parse_captions(f)
        self.assertEqual(cues[0], {"start": 1.0, "end": 4.5, "speaker": "Laili Gohartaj", "text": "Is it okay if I record?"})
        self.assertIsNone(cues[1]["speaker"])
        w = T.words_of_cues(cues)
        self.assertEqual(len(w), 9)
        self.assertAlmostEqual(w[-1]["end"], 6.0)
        shutil.rmtree(tmp)

    def test_a_participant_track_names_its_speaker(self):
        self.assertEqual(T.participant_of(Path("audioLailiGohartaj21117834521.m4a")), "Laili Gohartaj")
        self.assertIsNone(T.participant_of(Path("audio_only.m4a")))

    def test_intake_from_the_folder_name(self):
        tmp = Path(tempfile.mkdtemp()) / "2026-11-03 Jane Doe"
        tmp.mkdir()
        (tmp / "intake.yaml").write_text("interviewer: Morgan\ncircle: 2\n")
        intake, missing = T.read_intake(tmp)
        self.assertEqual((intake["interviewee"], intake["date"], intake["circle"]), ("Jane Doe", "2026-11-03", "2"))
        self.assertEqual(missing, [])
        shutil.rmtree(tmp.parent)


def seg(start, end, sid, text):
    words = text.split()
    step = (end - start) / len(words)
    return {"start": start, "end": end, "sid": sid, "text": text,
            "words": [{"word": w, "start": start + i * step, "end": start + (i + 1) * step} for i, w in enumerate(words)]}


class SpeakersAndCleanTest(unittest.TestCase):
    def test_the_one_who_asks_is_the_interviewer(self):
        segs = [seg(0, 3, "speaker_0", "What comes to mind for you?"), seg(3, 12, "speaker_1", "The hall and the music and the people."),
                seg(12, 14, "speaker_0", "And what would be lost?"), seg(14, 24, "speaker_1", "A place for young composers to be heard.")]
        names = T.name_speakers(segs, {"names": {}}, {"intake": {"interviewer": "Morgan", "interviewee": "Robin"}}, [])
        self.assertEqual((names["speaker_0"]["name"], names["speaker_1"]["name"]), ("Morgan", "Robin"))

    def test_a_voice_match_by_first_name_takes_the_full_name(self):
        segs = [seg(0, 3, "s0", "Hello there?"), seg(3, 9, "s1", "Hi, nice to meet you all.")]
        tj = {"names": {"s0": {"name": "Morgan", "source": "voice"}}}
        names = T.name_speakers(segs, tj, {"intake": {"interviewer": "Morgan Ash", "interviewee": "Robin"}}, [])
        self.assertEqual((names["s0"]["name"], names["s1"]["name"]), ("Morgan Ash", "Robin"))

    def test_disputes_and_the_guard(self):
        segs = [seg(0, 4, "a", "the first thing is Holobeck Hall")]
        other = [{"word": w, "start": i * 0.6, "end": i * 0.6 + 0.5} for i, w in enumerate("the first thing is Hollenbeck Hall".split())]
        d = T.disputes(segs, other)
        self.assertEqual([(x["ours"], x["theirs"]) for x in d[0]], [("Holobeck", "Hollenbeck")])
        self.assertIsNone(T.guard("the first thing is Holobeck Hall", "the first thing is Hollenbeck Hall", 3))
        self.assertIn("changed", T.guard("the first thing is Holobeck Hall", "honestly what I loved was Hollenbeck", 3))

    def test_settle_keeps_a_reply_within_the_rules_and_refuses_one_that_rewrites(self):
        items = [{"id": 0, "text": "the first thing is Holobeck Hall", "start": 0.0,
                  "disputed": [{"ours": "Holobeck", "theirs": "Hollenbeck", "t": 2.4}]},
                 {"id": 1, "text": "we loved it there truly", "start": 5.0, "disputed": [{"ours": "truly", "theirs": "really", "t": 7}]}]
        reply = {"content": json.dumps({"items": [{"id": 0, "text": "the first thing is Hollenbeck Hall"},
                                                  {"id": 1, "text": "honestly the whole season was a delight to us"}]})}
        log = []
        with mock.patch.object(C, "llm_chat", return_value=reply):
            got = T.settle(items, {"terms": []}, "", log)
        self.assertEqual(got, {0: "the first thing is Hollenbeck Hall"})
        self.assertEqual([x["status"] for x in log], ["changed", "refused"])

    def test_an_mm_hm_inside_a_turn_is_an_aside(self):
        segs = [dict(seg(0, 5, "a", "I started coming years ago"), speaker="R"), dict(seg(5, 5.6, "b", "Mm-hm."), speaker="G"),
                dict(seg(5.6, 9, "a", "and it stayed with me"), speaker="R")]
        T.mark_asides(segs)
        self.assertTrue(segs[1].get("aside"))
        text, rows = T.build_transcript(segs, [])
        self.assertEqual(text, "**R** [00:00:00]\nI started coming years ago (G: Mm-hm.) and it stayed with me\n")
        self.assertEqual(text[rows[1]["c0"]:rows[1]["c1"]], "G: Mm-hm.")


class TranscriptAndTimesTest(unittest.TestCase):
    def setUp(self):
        segs = [dict(seg(0, 3, "a", "What comes to mind?"), speaker="Morgan"),
                dict(seg(3.2, 9, "b", "Hollenbeck Hall on a Sunday afternoon."), speaker="Robin"),
                dict(seg(9, 15, "b", "And the musicians live here."), speaker="Robin"),
                dict(seg(20, 25, "a", "A private thing said here"), speaker="Morgan"),
                dict(seg(26, 30, "a", "And what would be lost?"), speaker="Morgan")]
        self.text, self.rows = T.build_transcript(segs, [(19.5, 25.5)])
        self.m = {"text": self.text, "rows": self.rows}

    def test_turns_left_out_and_character_ranges(self):
        self.assertIn("**Robin** [00:00:03]\nHollenbeck Hall on a Sunday afternoon. And the musicians live here.", self.text)
        self.assertIn("*[left out]*", self.text)
        self.assertNotIn("private", self.text)
        for r in self.rows:
            if not r.get("left_out") and not r.get("aside"):
                self.assertTrue(self.text[r["c0"]:r["c1"]].strip())

    def test_a_passage_gets_its_words_times_and_speaker(self):
        q = "the musicians live here."
        c0 = self.text.index(q)
        got = TC.locate(self.m, c0, c0 + len(q))
        self.assertEqual(got["speakers"], ["Robin"])
        self.assertAlmostEqual(got["start"], 10.2, places=1)   # "the" is the second of five words in 9-15 s
        self.assertAlmostEqual(got["end"], 15.0, places=1)

    def test_a_passage_touching_a_left_out_stretch_gets_no_time(self):
        c0 = self.text.index("*[left out]*")
        self.assertTrue(TC.locate(self.m, c0, c0 + 5).get("left_out"))

    def test_turns_and_answers_cut_from_labels(self):
        x = {"rows": self.rows, "text": self.text, "iv": {"interviewer": "Morgan"}}
        turns = T_turns = IP.turns_of(x)
        self.assertEqual([t["speaker"] for t in T_turns], ["Morgan", "Robin", None, "Morgan"])
        who = IP.interviewer_of(x, turns)
        self.assertEqual(who, "Morgan")
        answers = IP.cut_answers(turns, who, {0: {"kind": "question", "questions": ["q1"]},
                                              3: {"kind": "question", "questions": ["q2"]}})
        self.assertEqual(len(answers), 1)   # q2 was asked at the end and never answered
        a = answers[0]
        self.assertEqual(self.text[a["c0"]:a["c1"]], "Hollenbeck Hall on a Sunday afternoon. And the musicians live here.")
        self.assertEqual(a["questions"], ["q1"])

    def test_a_name_is_anchored_on_its_own_words_at_its_first_mention(self):
        text = "We went to Oakland. Later, Oakland again, and Oakland once more with feeling."
        self.assertEqual(IP.first_mention(text, "Oakland", "Later, Oakland again"), "Oakland again,")
        self.assertEqual(IP.first_mention("only Dana here", "dana"), "Dana")


class GuideTest(unittest.TestCase):
    def test_a_guide_makes_the_questions_and_summary_codebooks(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "guide.yaml").write_text(GUIDE)
        qs, sm = MC.guide_defs(tmp / "guide.yaml")
        self.assertEqual([c["code"] for c in qs["codes"]], ["q1", "q2"])
        self.assertTrue(qs["multi_label"])
        self.assertEqual(qs["ext"]["upc-interview"]["role"], "questions")
        self.assertEqual(qs["ext"]["upc-interview"]["circles"], {"1": "Close", "3": "Beyond"})
        self.assertEqual(qs["codes"][0]["ext"]["upc-interview"]["follow_ups"], ["How would you describe it?"])
        self.assertFalse(sm["closed"])
        self.assertEqual(sm["ext"]["upc-interview"]["role"], "summary")
        shutil.rmtree(tmp)


@unittest.skipUnless(HAVE_FFMPEG and upc_ok(), "needs ffmpeg and the upc CLI")
class EndToEndTest(unittest.TestCase):
    """A made-up recording (two tones), hand-written engine output, saved, timed, coded, built."""

    def test_saved_timed_and_playable(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            corpus = tmp / "corpus"
            (corpus / ".upc" / "upc-corpus").mkdir(parents=True)
            (corpus / "glossary.yaml").write_text(GLOSSARY)
            (corpus / ".upc" / "upc-corpus" / "settings.json").write_text(json.dumps(
                {"namespace": "t", "interviews": {"glossary": "glossary.yaml"}}))
            folder = tmp / "drop" / "2026-11-03 Robin Alvarez"
            folder.mkdir(parents=True)
            ff = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
            subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=12", "-c:a", "aac",
                            str(folder / "memo.m4a")], check=True)
            (folder / "intake.yaml").write_text("interviewer: Morgan\ncircle: 1\nleft_out: [{from: '00:00:09', to: '00:00:10', why: personal}]\n")
            T.ensure_corpus(corpus)
            work = T.cmd_prepare(folder, corpus)
            w = T.load_work(work)
            w["corpus"] = str(corpus)
            T.save_work(work, w)
            words = [("What", 0.2), ("comes", 0.5), ("to", 0.8), ("mind?", 1.0), ("I", 2.0), ("love", 2.3), ("Hollenbek", 2.6),
                     ("Hall", 3.2), ("on", 3.5), ("Sundays.", 3.8)]
            ws = [{"word": a, "start": t, "end": t + 0.3} for a, t in words]
            C.save_json(work / "transcript.json", {
                "meta": {"sha256": w["probe"]["sha256"]}, "names": {},
                "result": {"model": "test-engine", "segments": [
                    {"start": 0.2, "end": 1.3, "speaker": "s0", "text": "What comes to mind?", "words": ws[:4]},
                    {"start": 2.0, "end": 4.1, "speaker": "s1", "text": "I love Hollenbek Hall on Sundays.", "words": ws[4:]},
                    {"start": 9.2, "end": 9.8, "speaker": "s1", "text": "Something personal.", "words": []}]}})
            T.cmd_clean(work, use_model=False)
            T.cmd_save(work)
            src = T.current_revision(corpus, w["slug"])
            reps = T.reps_of(src)
            text = (corpus / reps["transcript"]["path"]).read_text()
            self.assertIn("I love Hollenbeck Hall on Sundays.", text)
            self.assertNotIn("personal", text)
            self.assertEqual(src["ext"]["upc-interview"]["speakers"], {"Morgan": "intake (asks the questions)", "Robin Alvarez": "intake"})
            res = C.upc_jsonl("anchor", "--corpus", str(corpus), "--rep", reps["transcript"]["representation_id"], "--type", "quote",
                              records=[{"quote": "Hollenbeck Hall on Sundays."}])
            self.assertEqual(res["tally"]["anchored"], 1)
            TC.run(corpus, quiet=True)
            e = next(json.loads(l) for l in next(corpus.glob("sources/*/extractions.jsonl")).read_text().splitlines() if l.strip())
            t = e["secondary_locators"][0]
            self.assertEqual((t["type"], t["representation_ref"]), ("timestamp_range", reps["web"]["representation_id"]))
            self.assertAlmostEqual(t["value"]["start"], 2.6, places=1)
            self.assertAlmostEqual(t["value"]["end"], 4.1, places=1)
            rep = C.upc("validate", str(corpus))
            self.assertEqual(rep["errors"], [])
            out = tmp / "site"
            C.upc("export", str(corpus), "--format", "site", "-o", str(out))
            page = next((out / "sources").glob("2026-11-03*.html")).read_text()
            self.assertIn('data-t0="2.20"', page)       # the passage's ▶, from just before its first word
            self.assertTrue((out / "files" / reps["web"]["path"].split("/")[-1]).exists())
            # Saving again with only the intake changed updates the record in place.
            w = T.load_work(work)
            w["intake"]["circle"] = "2"
            T.save_work(work, w)
            T.cmd_save(work)
            self.assertEqual(T.current_revision(corpus, w["slug"])["ext"]["upc-interview"]["circle"], "2")
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
