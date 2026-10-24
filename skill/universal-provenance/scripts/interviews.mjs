// Recordings and interviews in the reader's site (1.16.0, spec/05, spec/09).
//
// Two things, kept apart from site.mjs so the paper-shaped pages stay as they were:
//
//   * **Audio for any corpus.** A passage anchored in a transcript carries a secondary
//     `timestamp_range` on the recording's web copy (timecode.py writes it). Its card
//     gets ▶ and the time; the source page gets the whole recording and a transcript
//     whose turns start playback where they were said. One shared player: a passage's
//     ▶ plays from its first word to its last and stops.
//   * **Interviews.** Sources an interview pipeline saved (ext["upc-interview"]: who,
//     when, who asked, the circle) get interview wording, a table of
//     interviews, and a page per guide question: every answer to it, who gave it, a
//     brief in the assistant's words (labelled), the key words verbatim, and ▶ for each
//     and for the whole answer.
//
// Nothing here verifies anything. A time is navigation (spec/03); a quotation is checked
// against the transcript (spec/05), never the recording, and every page says so.

import path from "node:path";

export const IV_EXT = "upc-interview";
export const AUDIO_EXT = "upc-audio";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const attr = esc;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** 75.4 -> "1:15"; 3725 -> "1:02:05". */
export function clock(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function niceDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(d || "");
}

/** The interview record a source carries, or null; a superseded revision is not one. */
export function interviewOf(srcObj) {
  const iv = ((srcObj && srcObj.ext) || {})[IV_EXT];
  return iv && typeof iv === "object" ? iv : null;
}
export const isSuperseded = (srcObj) => !!(interviewOf(srcObj) || {}).superseded_by;

/** The recording a page plays: the web copy (an `audio` representation produced by
 *  conversion), else any audio representation with a browser-playable type. */
export function playableAudio(reps) {
  const list = (reps || []).filter((r) => r.role === "audio" || r.role === "video");
  return list.find((r) => r.produced_by === "conversion" && /^audio\/(mp4|mpeg|aac|ogg|webm|wav)/.test(r.media_type))
    || list.find((r) => /^audio\/(mp4|mpeg|aac|ogg|webm|wav)/.test(r.media_type)) || null;
}

/** A passage's time and speakers, from its secondary locators and tool data. */
export function timeOf(o) {
  const t = (o.secondary_locators || []).find((s) => s.type === "timestamp_range" && s.value);
  if (!t || !Number.isFinite(t.value.start) || !Number.isFinite(t.value.end)) return { time: null, speakers: [] };
  const sp = (((o.ext || {})[AUDIO_EXT]) || {}).speakers || [];
  return { time: { start: t.value.start, end: t.value.end, rep: t.representation_ref }, speakers: sp };
}

/** The names a passage records (interview_pass.py): [{name, kind, referral}]. */
export function namesOf(o) {
  const x = ((o.ext || {})[IV_EXT]) || {};
  return Array.isArray(x.names) ? x.names.filter((n) => n && n.name) : x.name ? [x] : [];
}

/** A transcript's speaker headings (`**Name** [00:12:34]`), already escaped, as the
 *  page shows them: the name in bold, the time small. */
export function speech(html) {
  return String(html).replace(/\*\*([^*<>\n]{1,80})\*\* \[(\d{2}:\d{2}:\d{2})\]\n?/g,
    (m, who, t) => `<span class="who">${who}</span> <span class="ts">${t}</span> `);
}

/** ▶ for one stretch of a recording. `whole` plays to the end of the recording. */
export function playButton(src, t0, t1, label, cls = "") {
  if (!src) return "";
  return `<button type="button" class="play${cls ? " " + cls : ""}" data-play data-src="${attr(src)}" data-t0="${(+t0).toFixed(2)}"` +
    (t1 != null ? ` data-t1="${(+t1).toFixed(2)}"` : "") + ` aria-pressed="false" title="Listen">` +
    `<span class="i" aria-hidden="true">▶</span> ${esc(label)}</button>`;
}

/** A passage's ▶ and time, with a second's lead-in so the first word isn't clipped. */
export function passagePlay(p, src, { around = false } = {}) {
  if (!p.time || !src) return "";
  // A name is a second or two: heard with what comes before and after it.
  const a = Math.max(0, p.time.start - (around ? 2 : 0.4)), b = p.time.end + (around ? 3 : 0.6);
  return playButton(src, a, b, clock(p.time.start));
}

export const AUDIO_CSS = `
button.play{font:600 .8rem/1 ui-sans-serif,system-ui,sans-serif;background:var(--accent-soft);color:var(--accent);
  border:1px solid transparent;border-radius:999px;padding:.32rem .65rem;cursor:pointer;white-space:nowrap;
  display:inline-flex;gap:.35rem;align-items:center;min-height:2rem}
button.play:hover{border-color:var(--accent)}
button.play.on{background:var(--accent);color:var(--panel)}
button.play.on .i{font-size:0}
button.play.on .i::before{content:"❚❚";font-size:.7rem}
button.play.whole{background:var(--panel);border-color:var(--line);color:var(--ink)}
.who{font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.9em}
.ts{color:var(--muted);font:.78rem ui-monospace,SFMono-Regular,Menlo,monospace}
.speaker{font:.8rem ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
.player{position:sticky;top:3.1rem;z-index:5;background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:.6rem .8rem;margin:1rem 0;display:flex;flex-direction:column;gap:.3rem}
.player audio{width:100%}
.player .small{font-family:ui-sans-serif,system-ui,sans-serif}
.reading.transcript p{cursor:pointer;border-left:3px solid transparent;padding-left:.6rem;margin-left:-.6rem;border-radius:2px}
.reading.transcript p:hover{background:var(--accent-soft)}
.reading.transcript p.now{border-left-color:var(--accent);background:var(--accent-soft)}
.reading.transcript p.gap{color:var(--muted);font-style:italic;cursor:default}
.iv-head{display:flex;flex-wrap:wrap;gap:.35rem .7rem;align-items:baseline;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.86rem}
.iv-head .name{font:700 1.05rem ui-serif,Georgia,serif}
.circle{display:inline-block;border-radius:999px;padding:.05rem .5rem;font:600 .74rem ui-sans-serif,system-ui,sans-serif;
  background:var(--chip);color:var(--chip-ink)}
.circle.c1{background:var(--well-bg);color:var(--well)}.circle.c2{background:var(--some-bg);color:var(--some)}
.circle.c3{background:var(--limited-bg);color:var(--limited)}
article.answer{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.9rem 1rem;margin:.8rem 0}
article.answer .brief{margin:.55rem 0;font-size:1.02rem}
.by{display:inline-block;font:600 .68rem ui-sans-serif,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;
  color:var(--muted);margin-right:.4rem;border:1px dashed var(--line);border-radius:4px;padding:0 .3rem}
ul.hl{list-style:none;padding:0;margin:.5rem 0}
ul.hl li{display:flex;gap:.6rem;align-items:flex-start;margin:.45rem 0}
ul.hl li blockquote{margin:0;flex:1}
ul.hl li .also{display:block;font:.76rem ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
.acts{display:flex;flex-wrap:wrap;gap:.5rem .9rem;align-items:center;font:.84rem ui-sans-serif,system-ui,sans-serif;margin-top:.5rem}
article.answer details{margin-top:.5rem;font-size:.95rem}
article.answer details summary{cursor:pointer;font:.84rem ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
.qtext{font-size:1.15rem;margin:.2rem 0 .5rem}
.follow{color:var(--muted);font-style:italic;margin:.2rem 0}
table.qgrid td.dot{text-align:center}
table.qgrid td.dot a{display:inline-block;width:1.4rem;height:1.4rem;border-radius:50%;background:var(--accent-soft);
  color:var(--accent);line-height:1.4rem;font-size:.75rem;text-decoration:none}
table.qgrid td.dot span{color:var(--line)}
.notasked{font:.86rem ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
@media (max-width:640px){.player{top:0}ul.hl li{flex-direction:column;gap:.3rem}}
@media print{button.play,.player{display:none}}
`;

// One player for the whole page: the source page's visible <audio id="upc-audio">,
// else a hidden one. A ▶ plays its stretch and stops at the end of it; pressed again,
// it pauses. On a transcript, the turn being heard is marked and a click on a turn
// plays from there.
export const AUDIO_JS = String.raw`
(function(){
  var A=null, cur=null, stopAt=null, turns=null;
  function audio(){
    if(A) return A;
    A=document.getElementById("upc-audio")||new Audio();
    if(!A.getAttribute("data-src")&&A.getAttribute("src")) A.setAttribute("data-src",A.getAttribute("src"));
    A.preload=A.preload||"none";
    A.addEventListener("timeupdate",function(){
      if(stopAt!=null&&A.currentTime>=stopAt){ A.pause(); stopAt=null; }
      follow();
    });
    A.addEventListener("pause",function(){ mark(false); });
    A.addEventListener("play",function(){ mark(true); });
    window.__upcAudio=A;   // for a test, or a reader's console
    return A;
  }
  function mark(on){ if(cur){ cur.classList.toggle("on",on); cur.setAttribute("aria-pressed",on?"true":"false"); } }
  function play(b){
    var a=audio(), src=b.getAttribute("data-src");
    if(cur===b&&!a.paused){ a.pause(); return; }
    mark(false); cur=b;
    var t0=parseFloat(b.getAttribute("data-t0"))||0, t1=b.getAttribute("data-t1");
    stopAt=t1==null?null:parseFloat(t1);
    // Already playing, a new stretch fires no "play" event: mark the button here.
    function go(){ try{ a.currentTime=t0; }catch(e){} var p=a.play();
      if(p&&p.then) p.then(function(){ mark(true); },function(){ mark(false); }); else mark(true); }
    if(a.getAttribute("data-src")!==src){
      a.setAttribute("data-src",src); a.src=src;
      a.addEventListener("loadedmetadata",function once(){ a.removeEventListener("loadedmetadata",once); go(); });
      a.load();
    } else if(a.readyState>=1) go();
    else a.addEventListener("loadedmetadata",function once(){ a.removeEventListener("loadedmetadata",once); go(); });
  }
  function follow(){
    if(!turns){ turns=[].slice.call(document.querySelectorAll(".reading.transcript p[data-t0]")); }
    if(!turns.length||!A) return;
    var main=document.getElementById("upc-audio");
    if(!main||A!==main) return;
    var t=A.currentTime, hit=null;
    for(var i=0;i<turns.length;i++){ if(parseFloat(turns[i].getAttribute("data-t0"))<=t) hit=turns[i]; else break; }
    turns.forEach(function(p){ p.classList.toggle("now",p===hit); });
  }
  document.addEventListener("click",function(e){
    var b=e.target.closest&&e.target.closest("[data-play]");
    if(b){ e.preventDefault(); play(b); return; }
    var p=e.target.closest&&e.target.closest(".reading.transcript p[data-t0]");
    if(p&&!e.target.closest("a")&&!(window.getSelection&&String(window.getSelection()).length)){
      var a=audio(); cur=null; stopAt=null;
      try{ a.currentTime=parseFloat(p.getAttribute("data-t0")); }catch(err){}
      var pr=a.play(); if(pr&&pr.catch) pr.catch(function(){});
    }
  });
  document.addEventListener("keydown",function(e){
    if(e.key===" "&&A&&!/INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target||{}).tagName||"")&&!A.paused){ e.preventDefault(); A.pause(); }
  });
})();
`;

// --- the interview model -------------------------------------------------------

const roleOf = (cb) => ((((cb && cb.ext) || {})[IV_EXT]) || {}).role || "";

/** The guide's codebooks: questions (closed, one code per question) and summary (open). */
export function guideBooks(model) {
  const qs = model.codebooks.find((cb) => roleOf(cb) === "questions") || null;
  const sum = model.codebooks.find((cb) => roleOf(cb) === "summary") || null;
  return { qs, sum, by: (sum && ((sum.ext || {})[IV_EXT] || {}).by) || "" };
}

/** Each interview's answers to each question: Map(code -> [{answer, brief, highlights, also}]) per source. */
export function answersByQuestion(model) {
  const { qs, sum } = guideBooks(model);
  const out = new Map();     // code -> [{s, answer, brief, highlights}]
  if (!qs) return out;
  const qCodes = (p) => p.codings.filter((c) => c.codebook_ref === qs.codebook_id).map((c) => c.code);
  const answers = model.passages.filter((p) => p.type === "x-answer" && p.status === "active");
  const within = (h, a) => h.span && a.span && h.source_id === a.source_id && h.span[0] >= a.span[0] && h.span[1] <= a.span[1];
  for (const a of answers) {
    const s = model.sourceById.get(a.source_id);
    if (!s) continue;
    const brief = sum ? (a.codings.find((c) => c.codebook_ref === sum.codebook_id) || {}).value || "" : "";
    const highlights = model.passages.filter((h) => h !== a && h.type === "quote" && h.status === "active" && within(h, a))
      .sort((x, y) => x.span[0] - y.span[0]);
    for (const code of qCodes(a)) {
      if (!out.has(code)) out.set(code, []);
      out.get(code).push({ s, answer: a, brief, highlights });
    }
  }
  // A passage coded with a question it isn't the answer to: "also said, while answering …".
  for (const p of model.passages) {
    if (p.type !== "quote" || p.status !== "active") continue;
    for (const code of qCodes(p)) {
      const list = out.get(code) || [];
      if (list.some((x) => within(p, x.answer))) continue;
      const host = answers.find((a) => within(p, a));
      if (!out.has(code)) out.set(code, []);
      out.get(code).push({ s: model.sourceById.get(p.source_id), answer: null, also: p,
        while: host ? qCodes(host) : [], brief: "", highlights: [p] });
    }
  }
  for (const list of out.values()) list.sort((x, y) => String(x.s.interview.date || "").localeCompare(String(y.s.interview.date || ""))
    || x.s.title.localeCompare(y.s.title) || ((x.answer || x.also).span || [0])[0] - ((y.answer || y.also).span || [0])[0]);
  return out;
}

function ivHead(s, base, { link = true, name: showName = true } = {}) {
  const iv = s.interview;
  const name = esc(iv.interviewee || s.title);
  return `<div class="iv-head">${!showName ? "" : link ? `<a class="name" href="${base}sources/${encodeURIComponent(s.slug)}.html">${name}</a>` : `<span class="name">${name}</span>`}
  ${iv.affiliation ? `<span class="muted">${esc(iv.affiliation)}</span>` : ""}
  ${iv.circle ? `<span class="circle c${attr(iv.circle)}" title="Circle">Circle ${esc(iv.circle)}</span>` : ""}
  <span class="muted">${iv.interviewer ? `Asked by ${esc(iv.interviewer)}` : ""}${iv.date ? ` · ${esc(niceDate(iv.date))}` : ""}</span></div>`;
}

function circleWords(model) {
  const names = ((guideBooks(model).qs || {}).ext || {})[IV_EXT] || {};
  return names.circles || {};
}

function filterBar(model, rows, noun) {
  const circles = [...new Set(rows.map((s) => s.interview.circle).filter(Boolean))].sort();
  const who = [...new Set(rows.map((s) => s.interview.interviewer).filter(Boolean))].sort();
  const words = circleWords(model);
  return `<div class="filters sans small">
  ${circles.length > 1 ? `<select data-filter="circle"><option value="">Every circle</option>${circles.map((c) =>
    `<option value="${attr(c)}">Circle ${esc(c)}${words[c] ? ` — ${esc(words[c])}` : ""}</option>`).join("")}</select>` : ""}
  ${who.length > 1 ? `<select data-filter="interviewer"><option value="">Every interviewer</option>${who.map((w) =>
    `<option value="${attr(w)}">${esc(w)}</option>`).join("")}</select>` : ""}
  <input type="search" data-q placeholder="Search names and words…" style="min-width:16rem">
  <span class="muted" data-count data-one="${attr(noun[0])}" data-many="${attr(noun[1])}"></span>
</div>`;
}

const rowAttrs = (s, extra = "") => ` data-row data-circle="${attr(s.interview.circle || "")}" data-interviewer="${attr(s.interview.interviewer || "")}"` +
  ` data-search="${attr([s.interview.interviewee, s.interview.affiliation, s.interview.interviewer, extra].join(" "))}"`;

/** One answer to one question, as a card. */
export function answerCard(x, model, base, by, qLabel) {
  const s = x.s, a = x.answer, src = s.audioHref ? base + s.audioHref : null;
  const hl = x.highlights.map((h) => `<li>${passagePlay(h, src)}<blockquote>“${speech(esc(h.quote))}”` +
    (x.also && x.while && x.while.length ? `<span class="also">Said while answering ${x.while.map((c) => esc(qLabel(c))).join(", ")}</span>` : "") +
    `</blockquote></li>`).join("");
  const whole = a && a.time && src ? playButton(src, Math.max(0, a.time.start - 0.4), a.time.end + 0.6,
    `Whole answer · ${clock(a.time.end - a.time.start)}`, "whole") : "";
  const target = a || x.also;
  return `<article class="answer"${rowAttrs(s, [x.brief, ...x.highlights.map((h) => h.quote)].join(" "))}>
${ivHead(s, base)}
${x.brief ? `<p class="brief"><span class="by" title="Written by ${attr(by || "a language model")} from the answer; not the interviewee's words">In brief · ${esc(by || "model")}</span>${esc(x.brief)}</p>` : ""}
${hl ? `<ul class="hl">${hl}</ul>` : ""}
<div class="acts">${whole}<a href="${base}sources/${encodeURIComponent(s.slug)}.html#text=${encodeURIComponent(target.id)}">Read it in the transcript${target.time ? ` at ${clock(target.time.start)}` : ""} →</a></div>
${a ? `<details><summary>The whole answer, as transcribed</summary><blockquote class="speech">${speech(esc(a.quote)).replace(/\n\n/g, "<br><br>")}</blockquote></details>` : ""}
</article>`;
}

/** questions/index.html: each question, how many answered it, and a grid of who answered what. */
const NO_INTERVIEWS = `<p class="muted">No interviews yet. Each one appears here once it has been transcribed and coded.</p>`;

export function questionsIndexBody(model, base) {
  const { qs } = guideBooks(model);
  const by = answersByQuestion(model);
  const ivs = model.sources.filter((s) => s.interview);
  const codes = (qs.codes || []).filter((c) => !c.deprecated);
  const has = (code, s) => (by.get(code) || []).some((x) => x.s === s && x.answer);
  return `<h1>Questions</h1>
<p class="lede">${plural(ivs.length, "interview", "interviews")}. Pick a question to read and hear every answer to it.</p>
<div class="wrap"><table>
<thead><tr><th></th><th>Question</th><th class="num">Answered in</th></tr></thead><tbody>
${codes.map((c) => `<tr><td class="muted">${esc(c.code.toUpperCase())}</td>
  <td><a href="${encodeURIComponent(c.code)}.html"><strong>${esc(c.label || c.code)}</strong></a><div class="small muted">${esc(c.definition || "")}</div></td>
  <td class="num">${new Set((by.get(c.code) || []).filter((x) => x.answer).map((x) => x.s.id)).size} of ${ivs.length}</td></tr>`).join("\n")}
</tbody></table></div>
<h2>Who answered what</h2>
${ivs.length ? `${filterBar(model, ivs, ["interview shown", "interviews shown"])}
<div class="wrap"><table class="qgrid"><thead><tr><th>Interview</th>${codes.map((c) => `<th title="${attr(c.label || c.code)}">${esc(c.code.toUpperCase())}</th>`).join("")}</tr></thead><tbody>
${ivs.map((s) => `<tr${rowAttrs(s)}><td>${ivHead(s, base)}</td>${codes.map((c) => `<td class="dot">${has(c.code, s)
  ? `<a href="${encodeURIComponent(c.code)}.html#iv=${encodeURIComponent(s.slug)}" title="${attr(`${s.interview.interviewee}: ${c.label || c.code}`)}">●</a>`
  : `<span title="Not asked, or no answer found">·</span>`}</td>`).join("")}</tr>`).join("\n")}
</tbody></table></div>` : NO_INTERVIEWS}`;
}

/** index.html for an interview corpus: what it holds, where to start, how to read it. */
export function interviewHomeBody(model) {
  const { qs, by } = guideBooks(model);
  const ivs = model.sources.filter((s) => s.interview);
  const nq = qs ? (qs.codes || []).filter((c) => !c.deprecated).length : 0;
  const answers = model.passages.filter((p) => p.type === "x-answer" && p.status === "active").length;
  const length = ivs.reduce((n, s) => n + (s.duration || 0), 0);
  const people = model.passages.some((p) => p.names.length);
  const tiles = [[ivs.length, "interviews", "sources/"], [nq, "questions", "questions/"], [answers, "answers", "questions/"]]
    .filter(([n], i) => n || i === 0);
  return `<h1>${esc(model.title)}</h1>
<p class="lede">${ivs.length ? `${plural(ivs.length, "interview", "interviews")}${length ? `, ${clock(length)} of recording` : ""}.` : "No interviews yet."}
${nq ? `Start with <a href="questions/">the questions</a>: each one has every answer to it, who gave it, a brief, and the key words to hear.` : ""}
Open <a href="sources/">an interview</a> to hear it whole${people ? `, or see <a href="people/">who was mentioned</a> and who was suggested to talk to` : ""}.</p>
<div class="grid cards">
${tiles.map(([n, u, href]) => `<a class="card tile" href="${href}"><span class="n">${n}</span><br><span class="u">${esc(u)}</span></a>`).join("\n")}
</div>
<h2>How to read this</h2>
<div class="card">
<p class="small"><strong>A transcript</strong> is a machine's hearing of the recording, checked against a second machine's
and cleaned up automatically, with every change logged. It can still mishear, so ▶ plays the words themselves.
<strong>A quotation</strong> is copied exactly from the transcript, and was checked against it character by character when
this site was built. <strong>A brief</strong> is ${by ? `${esc(by)}'s` : "a language model's"} summary of an answer, in its own
words, never the interviewee's. <strong>Which question an answer answers</strong> was judged by a language model from
what the interviewer asked: interviewers ask in their own order and their own words.</p>
</div>`;
}

/** questions/<code>.html: every answer to one question. */
export function questionBody(model, code, base) {
  const { qs, by: writer } = guideBooks(model);
  const all = answersByQuestion(model).get(code.code) || [];
  const ivs = model.sources.filter((s) => s.interview);
  const answered = new Set(all.map((x) => x.s.id));
  const notAsked = ivs.filter((s) => !answered.has(s.id));
  const g = (code.ext || {})[IV_EXT] || {};
  const qLabel = (c) => { const x = (qs.codes || []).find((y) => y.code === c); return x ? `${c.toUpperCase()} (${x.label || c})` : c; };
  const codesList = (qs.codes || []).filter((c) => !c.deprecated);
  const i = codesList.findIndex((c) => c.code === code.code);
  const prev = codesList[i - 1], next = codesList[i + 1];
  return `<p class="small muted"><a href="./">Questions</a> › ${esc(code.code.toUpperCase())}</p>
<h1>${esc(code.label || code.code)}</h1>
<p class="qtext">${esc(code.definition || "")}</p>
${(g.follow_ups || []).map((f) => `<p class="follow">Follow-up: ${esc(f)}</p>`).join("")}
<p class="small muted">${plural(new Set(all.filter((x) => x.answer).map((x) => x.s.id)).size, "interview answers", "interviews answer")} this question.
Quotations are the words as transcribed (checked against the transcript, not the recording); ▶ plays them.
${writer ? `A brief is ${esc(writer)}'s summary of the answer, never the interviewee's words.` : ""}</p>
${filterBar(model, [...new Set(all.map((x) => x.s))], ["answer shown", "answers shown"])}
${all.map((x) => answerCard(x, model, base, writer, qLabel)).join("\n") || `<p class="muted">No answers to this question yet.</p>`}
${notAsked.length ? `<p class="notasked">Not asked, or no answer found, in: ${notAsked.map((s) =>
  `<a href="${base}sources/${encodeURIComponent(s.slug)}.html">${esc(s.interview.interviewee || s.title)}</a>`).join(", ")}.</p>` : ""}
<p class="acts">${prev ? `<a href="${encodeURIComponent(prev.code)}.html">← ${esc(prev.label || prev.code)}</a>` : ""}
${next ? `<a href="${encodeURIComponent(next.code)}.html">${esc(next.label || next.code)} →</a>` : ""}</p>`;
}

/** sources/index.html for an interview corpus: a table of interviews. */
export function interviewsIndexBody(model, base) {
  const ivs = model.sources.filter((s) => s.interview);
  const { qs } = guideBooks(model);
  const by = qs ? answersByQuestion(model) : new Map();
  const nq = (s) => [...by.values()].filter((list) => list.some((x) => x.s === s && x.answer)).length;
  const others = model.sources.filter((s) => !s.interview);
  return `<h1>Interviews</h1>
<p class="lede">${plural(ivs.length, "interview", "interviews")}${ivs.some((s) => s.duration) ? `, ${clock(ivs.reduce((n, s) => n + (s.duration || 0), 0))} of recording` : ""}.</p>
${ivs.length ? `${filterBar(model, ivs, ["interview shown", "interviews shown"])}
<div class="wrap"><table><thead><tr><th>Interviewee</th><th>Circle</th><th>Asked by</th><th>Date</th><th class="num">Length</th>${qs ? `<th class="num">Questions answered</th>` : ""}</tr></thead><tbody>
${ivs.map((s) => `<tr${rowAttrs(s)}>
  <td><a href="${encodeURIComponent(s.slug)}.html"><strong>${esc(s.interview.interviewee || s.title)}</strong></a>${s.interview.affiliation ? `<div class="small muted">${esc(s.interview.affiliation)}</div>` : ""}</td>
  <td>${s.interview.circle ? `<span class="circle c${attr(s.interview.circle)}">${esc(s.interview.circle)}</span>` : ""}</td>
  <td>${esc(s.interview.interviewer || "")}</td><td>${esc(niceDate(s.interview.date))}</td>
  <td class="num">${s.duration ? clock(s.duration) : ""}</td>${qs ? `<td class="num">${nq(s)}</td>` : ""}</tr>`).join("\n")}
</tbody></table></div>` : NO_INTERVIEWS}
${others.length ? `<h2>Other sources</h2><ul>${others.map((s) => `<li><a href="${encodeURIComponent(s.slug)}.html">${esc(s.title)}</a></li>`).join("")}</ul>` : ""}`;
}

/** The top of an interview's page: who, the recording, and the answers by question. */
export function interviewTopHtml(model, s, base) {
  const iv = s.interview || {};
  const src = s.audioHref ? base + s.audioHref : null;
  const { qs, by: writer } = guideBooks(model);
  const qLabel = (c) => { const x = ((qs || {}).codes || []).find((y) => y.code === c); return x ? `${c.toUpperCase()} (${x.label || c})` : c; };
  const mine = [];
  if (qs) {
    for (const c of qs.codes || []) {
      for (const x of answersByQuestion(model).get(c.code) || []) if (x.s === s) mine.push({ c, x });
    }
  }
  const clean = iv.clean || {};
  const how = [iv.engines && iv.engines.primary ? `Transcribed by ${iv.engines.primary}` : "",
    iv.engines && iv.engines.second ? `checked word by word against ${iv.engines.second}` : "",
    clean.glossary_changes ? `${plural(clean.glossary_changes, "spelling", "spellings")} fixed from the glossary` : "",
    clean.model_changes ? `${plural(clean.model_changes, "disputed stretch", "disputed stretches")} settled by a language model` : ""]
    .filter(Boolean).join(", ");
  return `${ivHead(s, base, { link: false, name: false })}
${iv.hoped_perspective ? `<p class="small muted">Perspective we hoped to hear: ${esc(iv.hoped_perspective)}</p>` : ""}
${src ? `<div class="player"><audio id="upc-audio" controls preload="metadata" src="${attr(src)}"></audio>
<span class="small muted">Click any turn in the transcript below to hear it from there.${(iv.left_out || []).length ? " Stretches left out of the transcript are silent here too." : ""}</span></div>` : ""}
${how ? `<p class="small muted">${esc(how)}. Every change is logged with the recording's raw transcriptions.</p>` : ""}
${s.notesHref ? `<p class="small"><a href="${base}${s.notesHref}">The interviewer's notes form ↗</a></p>` : ""}
${mine.length ? `<h2>Answers by question</h2>${mine.map(({ c, x }) => `<h3 class="part"><a href="${base}questions/${encodeURIComponent(c.code)}.html">${esc(c.code.toUpperCase())} · ${esc(c.label || c.code)}</a></h3>
${answerCard(x, model, base, writer, qLabel).replace(/<div class="iv-head">[\s\S]*?<\/div>\n/, "")}`).join("\n")}` : ""}`;
}

/** Times for the transcript's paragraphs: a function (ps, pe) -> attributes for its <p>. */
export function paraTimes(rows) {
  const list = (rows || []).filter((r) => Number.isInteger(r.c0)).sort((a, b) => a.c0 - b.c0);
  return (ps, pe) => {
    const r = list.find((x) => x.c0 >= ps && x.c0 < pe) || list.find((x) => x.c0 <= ps && ps < x.c1);
    if (!r) return "";
    if (r.left_out) return ' class="gap"';
    return ` data-t0="${(+r.start).toFixed(2)}" title="Click to hear this from ${clock(r.start)}"`;
  };
}

export function audioFileName(rep) {
  return rep ? path.basename(rep.path) : "";
}

const KIND_TITLE = { person: "People", place: "Places", org: "Organizations", program: "Programs", work: "Works" };

/** people/index.html: who was suggested to talk to, then every name heard, by kind. */
export function peopleBody(model, base) {
  const byName = new Map();
  for (const p of model.passages) {
    if (p.status !== "active") continue;
    for (const n of p.names) {
      const key = n.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, { name: n.name, kind: n.kind || "person", mentions: [], referral: [] });
      const rec = byName.get(key);
      const s = model.sourceById.get(p.source_id);
      if (!s) continue;
      rec.mentions.push({ s, p });
      if (n.referral) rec.referral.push({ s, p });
    }
  }
  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  // A name's passage is the name; the words around it come from the checked transcript (p.cx).
  const around = (p) => {
    if (!p.cx) return speech(esc(p.quote));
    const [t, a, b] = p.cx;
    const pre = t.slice(Math.max(0, a - 140), a), post = t.slice(b, b + 160);
    return (a > 140 ? "…" : "") + speech(esc(pre.replace(/^\S*\s/, a > 140 ? "" : "$&"))) + `<mark>${esc(t.slice(a, b))}</mark>` +
      speech(esc(post)) + (b + 160 < t.length ? "…" : "");
  };
  const mention = ({ s, p }) => `<li>${passagePlay(p, s.audioHref ? base + s.audioHref : null, { around: true })}<blockquote>${around(p)}` +
    `<span class="also"><a href="${base}sources/${encodeURIComponent(s.slug)}.html#text=${encodeURIComponent(p.id)}">${esc((s.interview || {}).interviewee || s.title)}</a></span></blockquote></li>`;
  const refs = all.filter((r) => r.referral.length);
  const groups = Object.keys(KIND_TITLE).map((k) => [k, all.filter((r) => r.kind === k)]).filter(([, l]) => l.length);
  return `<h1>People and places</h1>
<p class="lede">Every name heard in the interviews, where it was first said in each, and who the interviewees suggested talking to.</p>
<p class="small muted">Found and spelled by a language model from the transcripts; each mention is the transcript's own words, so a
misheard name shows as it was heard. Check a spelling before using it.</p>
${refs.length ? `<h2>Suggested to talk to (${refs.length})</h2>
${refs.map((r) => `<article class="answer"><div class="iv-head"><span class="name">${esc(r.name)}</span>
<span class="muted">suggested by ${[...new Set(r.referral.map((m) => (m.s.interview || {}).interviewee || m.s.title))].map(esc).join(", ")}</span></div>
<ul class="hl">${r.referral.map(mention).join("")}</ul></article>`).join("\n")}` : ""}
${groups.map(([k, list]) => `<h2>${esc(KIND_TITLE[k])} (${list.length})</h2>
${list.map((r) => `<details class="card"><summary><strong>${esc(r.name)}</strong> <span class="small muted">· ${plural(new Set(r.mentions.map((m) => m.s.id)).size, "interview", "interviews")}</span></summary>
<ul class="hl">${r.mentions.map(mention).join("")}</ul></details>`).join("\n")}`).join("\n")}`;
}
