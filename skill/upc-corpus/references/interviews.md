# Interviews from recordings

A study that interviews people (stakeholders, patrons, participants) and wants to read and
hear every answer to each question. Recordings arrive however interviewers made them; the
toolkit transcribes, cleans, codes by the interview guide, and builds a site where a reader
picks a question and sees who answered, a brief, the key words verbatim, and ▶.

```
drop folder ──► transcribe.py ──► the corpus (one source per interview) ──► interview_pass.py ──► upc export --format site
 (a folder per    two engines,       transcript + timings + web audio          answers, briefs,        Questions · Interviews ·
  interview)      glossary, model     + raw engine output + clean-up log       highlights, names       People · Passages
```

`interview_drop.py` runs all of it on a schedule.

## What a person sets up once

`<corpus>/.upc/upc-corpus/settings.json`:

```json
{
  "namespace": "orch",
  "short_name": "Stakeholder interviews",
  "interviews": {
    "drop": "~/Library/Mobile Documents/com~apple~CloudDocs/Interviews Drop",
    "guide": "guide.yaml",
    "glossary": "glossary.yaml",
    "about": "Riverbend Symphony, an orchestra in Riverbend",
    "site": {"out": "site", "publish": [["python3", "/path/to/publish.py", "{out}"]]}
  },
  "coders": {"interview": "orch-27b-interview-v1"}
}
```

Paths are relative to the corpus. `about` goes into the model prompts ("an interview about …").
`site.publish` is a list of commands run after each build, `{out}` replaced by the site folder;
the first `URL: …` line any of them prints goes in the message.

### The guide (`guide.yaml`)

```yaml
title: Stakeholder interview
intake:
  - {id: circle, label: Circle, options: {"1": Close, "2": Connected, "3": Further out}}
questions:
  - id: q1
    label: What comes to mind          # short: it is the page's title
    text: "When you think of …, what comes to mind? Why that?"
    follow_ups: ["How would you describe … to a friend?"]
    cues: ["what do you think of when", "first thing that comes to mind"]   # how an interviewer might put it
probes: [{id: universal, text: "Can you say more?"}]
debrief: [{id: values, text: "What matters most to this person?"}]
```

Then `make_codebooks.py --corpus <dir> --guide guide.yaml`. It makes two codebooks: `questions`
(closed, multi-label: one answer can answer two questions) and `summary` (open). Edit the guide
and run it again: the codebooks keep their ids and their revision goes up.

Quote anything with `?` or `:` in YAML.

### The glossary (`glossary.yaml`)

```yaml
revision: 3
terms:
  - {term: Hollenbeck Hall, kind: place, heard: [Hollenbek Hall, Hollen Beck Hall], source: profile corpus}
  - {term: Dana Okafor, kind: person, heard: [Dana Okafur]}
  - {term: Music in the Parks, kind: program}
```

- `heard` lists misrecognitions that are **safe to replace everywhere**, whole words only. They are
  replaced automatically, and each replacement is logged.
- A name of any kind but `term` is also put in its own case ("music in the parks" becomes
  "Music in the Parks"). A `term` (an ordinary word, like "concerto") is left alone.
- A spelling close to a term but not listed is never replaced. It is reported as a **glossary
  suggestion** in the message and the clean-up log, so a person can add it to `heard`.
- The terms prime the second engine (Whisper's context).
- Neither engine can catch a word both mishear the same way ("Riverbed" for Riverbend). Only the
  glossary fixes those, so list a project's most common place and person names.

### An interview folder

```
2026-11-03 Jane Doe/
  New Recording 12.m4a           a phone memo, Zoom's audio_only.m4a, or …
  Audio Record/audioJaneDoe2….m4a  … Zoom's one-file-per-participant tracks (best: speakers are certain)
  GMT2026…transcript.vtt         Zoom's transcript, if there is one
  notes.pdf                      the interviewer's filled notes form
  intake.yaml                    interviewee, affiliation, interviewer, date, circle,
                                 hoped_perspective, left_out: [{from: "00:41:10", to: "00:42:05", why: personal}]
```

The folder name gives the date and interviewee when the intake doesn't. A folder is taken once
nothing in it has changed for two minutes. Changing the intake later (adding the circle, say)
brings it round again, and the site catches up.

## What happens to a recording

1. **Two engines.**
   - The primary is the transcription server (`transcribe.url` in the machine config; Parakeet
     here). It gives words with times, speakers diarized and matched to enrolled voices.
   - The second (`transcribe.second`) is an independent reading primed with the glossary
     (Whisper large-v3-turbo through mlx-audio by default; any mlx-audio model, or an
     OpenAI-style URL). Zoom's own transcript stands in when no second engine runs.
   - When the server is down and Zoom's transcript exists, Zoom's becomes the primary.
2. **Speakers named**, most certain first:
   1. a participant track;
   2. an enrolled voice (a voice match by first name takes the intake's full name);
   3. Zoom's labels;
   4. the intake: of the two main voices, the one asking the questions is the interviewer.

   Anyone left is "Speaker N" and the message says so. A short "mm-hm" inside another's turn is
   kept, in parentheses, without breaking the turn.
3. **Clean-up, automatic.**
   - The glossary's `heard` list is applied first.
   - Then each stretch where the engines disagree, or a near-miss was found, goes to the chat
     model with both readings and the glossary.
   - The model may change only the disputed words: at most twice their number (three minimum),
     and in a long stretch it must keep 90% of the words. Otherwise the stretch stays as heard
     and the refusal is logged.
   - Fillers and false starts stay.
4. **Saved** as a source (`source_kind: audio`, `ext["upc-interview"]`) with:
   - the transcript (role `transcript`);
   - its timings;
   - the recording as it came;
   - a web copy: mono AAC 48 kbps, loudness levelled, left-out stretches silenced, about 21 MB
     an hour;
   - both engines' output;
   - the clean-up log;
   - the notes form.
5. **Times**: `timecode.py` gives every passage in the transcript its `timestamp_range` and
   speakers.
6. **Coding** (`interview_pass.py`):
   - Interviewer turns are labelled by question, follow-up or other.
   - Answers are cut deterministically from those labels and coded.
   - Each answer gets a brief (open coding; the assistant's words, never the interviewee's, and
     no gendered pronouns).
   - Each answer gets one to three highlights, copied verbatim and anchored. A pick the
     transcript doesn't contain is dropped, never repaired.
   - Names are anchored on their own words where first said, with referrals marked.
   - `--redo` codes again: the earlier pass's answers and highlights it doesn't find again are
     marked superseded, with their codings. Names stay.

## Later codes

A theme codebook (`make_codebooks.py --defs themes.json`) codes the same answers and highlights.
`code_pass.py` or a person (`upc code --coder-kind human`) applies it. On a question page a theme
shows as a chip on each answer. The Passages page filters by any mix of question and theme.

## Checking an engine (`transcribe.py bench`)

Correct a stretch by hand, then:

`transcribe.py bench <work folder> --truth corrected.txt --from 00:05:00 --to 00:10:00`

It prints the word error rate (fillers ignored) of the primary, the second engine and the
cleaned transcript, and how many of the glossary's terms each got right. Do this on two or three
real interviews (one Zoom, one phone) before trusting a new engine, and when choosing one.

## What a reader is told

- Every quotation is checked against the transcript, character for character. The transcript is
  a machine's hearing of the recording, and each page says so.
- A brief is labelled with the assistant's name.
- A name is shown as heard.
- A question nobody answered in an interview is listed as "not asked, or no answer found",
  never filled in.
