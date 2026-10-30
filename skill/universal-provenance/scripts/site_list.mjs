/**
 * The annotated list page of a folder site (`upc export --format site --list <json>`).
 *
 * The list's spreadsheet as a page to read: filters with live counts, a year chart, a choice of
 * columns, a row that opens into the whole entry, and the view as a download. The JSON comes from
 * upc-corpus's `sources_table.py --json`; this file joins each row to what the site holds of the
 * study (its PDF, its reading text), so the links never depend on where the site is hosted.
 * Plain scripts and no fetch, so the page also works from `file://`.
 */

import path from "node:path";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** What a row links to for its full text: the PDF here, else the text kept on its page, else the web. */
function fullText(model, s, r, page) {
  if (s && model.filesDir && s.pdfRep && !s.pdfOff)
    return { href: `${model.filesDir}/${encodeURIComponent(path.basename(s.pdfRep.path))}`, kind: "PDF" };
  if (s && s.xmlRep) return { href: `${page}#reading`, kind: "Read here" };
  return r.url ? { href: r.url, kind: "Web page" } : { href: `${page}#reading`, kind: "Read here" };
}

export function listPayload(model) {
  const L = model.list;
  return {
    title: L.title, schemes: L.schemes, fields: L.fields, facets: L.facets || [], downloads: L.downloads || [],
    rows: L.rows.map(({ sid, slug, ...r }) => {
      const page = `sources/${encodeURIComponent(slug)}.html`;
      return { ...r, by: !!r.by, page, full: fullText(model, model.sourceById.get(sid), r, page) };
    }),
  };
}

const downloadLinks = (L) => L.downloads.map((d) =>
  `<a class="dlbtn" href="${encodeURI(d.file)}" download>${esc(d.label)}</a>`).join(" ");

/** The band on the home page: the list, and its files one click away. */
export function listBandHtml(model) {
  const L = model.list;
  if (!L) return "";
  return `<section class="card listband"><div><h2>${esc(L.title)}</h2>
<p class="small muted">${L.rows.length} studies, each with its annotation.</p></div>
<div class="listband-go"><a class="dlbtn main" href="annotated-list.html">Browse and filter</a>
${L.downloads.length ? `<span class="small muted">Download</span> ${downloadLinks(L)}` : ""}</div></section>`;
}

export function listBody(model) {
  const L = model.list;
  return `<h1>${esc(L.title)}</h1>
<p class="lede">The ${L.rows.length} studies, each with its annotation. Filter by what a study covers, choose your columns,
and open a row to read the whole entry. The annotations are written by a model${
  model.about ? `: <a href="methods.html">how</a>` : ""}.${L.downloads.length ? ` Download the whole list: ${
  L.downloads.map((d) => `<a href="${encodeURI(d.file)}" download>${esc(d.label)}</a>`).join(", ")}.` : ""}</p>
<div class="al" data-list></div>
<noscript><p class="banner">This page builds its table as you filter, so it needs JavaScript. The same entries are in the
downloads above, and each study has its own page under <a href="sources/">Sources</a>.</p></noscript>`;
}

export const LIST_CSS = String.raw`
:root{--maxw:min(1560px,96vw)}
main{padding-bottom:2rem}
p.lede{max-width:82ch}
.al{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.9rem;--gap:.9rem}
.al button{font:inherit;color:inherit;cursor:pointer}
.al a{color:var(--accent)}
.albtn{display:inline-flex;align-items:center;gap:.35rem;background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:.42rem .7rem;line-height:1.2;white-space:nowrap}
.al button.albtn:hover,.pick summary:hover{border-color:var(--accent)}
.altop{display:flex;flex-wrap:wrap;gap:.55rem;align-items:center;margin:.2rem 0 .7rem}
.alsearch{flex:1 1 260px;min-width:0}
.alsearch input{width:100%;font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.46rem .7rem}
.alsearch input:focus,.al button:focus-visible,.al a:focus-visible,.pick summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.fbtn{display:none}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;background:var(--panel);padding:.42rem .7rem}
.seg button[aria-pressed="true"]{background:var(--accent-soft);color:var(--ink);font-weight:600}
.pick{position:relative}
.pick summary{list-style:none;cursor:pointer}
.pick summary::-webkit-details-marker{display:none}
.pick .pop{position:absolute;right:0;z-index:6;margin-top:.35rem;width:min(330px,88vw);max-height:min(70vh,560px);overflow:auto;
  background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.75rem .85rem;box-shadow:0 10px 30px rgba(0,0,0,.16)}
.pick h4{margin:.7rem 0 .25rem;font-size:.74rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-weight:600}
.pick h4:first-of-type{margin-top:.2rem}
.pick label{display:flex;gap:.45rem;align-items:baseline;padding:.16rem 0;cursor:pointer}
.pick .acts{display:flex;gap:.45rem;margin-top:.7rem}
.alstat{display:flex;flex-wrap:wrap;gap:.4rem .5rem;align-items:center;margin:0 0 .7rem;min-height:1.7rem}
.alcount b{font-size:1.05rem}
.ach{display:inline-flex;gap:.35rem;align-items:center;background:var(--accent-soft);border:1px solid var(--accent);border-radius:999px;padding:.08rem .6rem;font-size:.82rem}
.ach i{font-style:normal;color:var(--muted)}
.clear{background:none;border:0;padding:.1rem .3rem;color:var(--accent);text-decoration:underline}
.algrid{display:grid;grid-template-columns:272px minmax(0,1fr);gap:var(--gap);align-items:start}
.alside{position:sticky;top:calc(var(--top,3.2rem) + .6rem);max-height:calc(100vh - var(--top,3.2rem) - 1.2rem);overflow:auto;
  background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.75rem .8rem}
.fclose{display:none}
.fg{padding:.5rem 0;border-top:1px solid var(--line)}
.fclose + .fg{border-top:0;padding-top:.1rem}
.fh{display:flex;align-items:center;gap:.4rem;width:100%}
.fh .ft{flex:1;display:flex;gap:.4rem;align-items:center;background:none;border:0;padding:.14rem 0;font-weight:600;text-align:left}
.fh .ft::before{content:"▾";color:var(--muted);font-size:.72rem;width:.8rem}
.fg.fold .fh .ft::before{content:"▸"}
.fh .ft.noc::before{content:none}
.fmode{background:none;border:1px solid var(--line);border-radius:999px;padding:.02rem .5rem;font-size:.74rem;color:var(--muted)}
.fv{position:relative;display:flex;width:100%;gap:.5rem;align-items:baseline;justify-content:space-between;background:none;border:0;border-radius:6px;
  padding:.2rem .4rem .38rem;margin-top:1px;text-align:left;overflow:hidden}
.fv .bar{position:absolute;left:.4rem;bottom:.1rem;height:3px;max-width:calc(100% - .8rem);background:var(--accent);opacity:.72;border-radius:2px;transition:width .18s ease}
.fv .l,.fv .c{position:relative}
.fv .c{color:var(--muted);font-variant-numeric:tabular-nums}
.fv:hover{background:var(--accent-soft)}
.fv.on{background:var(--accent-soft);box-shadow:inset 0 0 0 1.5px var(--accent)}
.fv.on .l{font-weight:600}
.fv.on .l::before{content:"✓ ";color:var(--accent)}
.fv.none{opacity:.45}
.yh{display:flex;align-items:flex-end;gap:2px;height:74px;margin:.45rem 0 .15rem;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.y{position:relative;flex:1;min-width:0;height:100%;background:none;border:0;padding:0;border-radius:3px 3px 0 0}
.y .a,.y .m{position:absolute;left:0;right:0;bottom:0;border-radius:3px 3px 0 0}
.y .a{background:var(--line)}
.y .m{background:var(--accent);transition:height .18s ease}
.y.off .m{opacity:.3}
.y:hover .a{background:var(--muted)}
.yax{display:flex;justify-content:space-between;color:var(--muted);font-size:.74rem;font-variant-numeric:tabular-nums}
.yline{min-height:1.2rem;font-size:.78rem;color:var(--muted);margin-top:.15rem}
.res{min-width:0}
.tw{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:auto;
  max-height:calc(100vh - var(--top,3.2rem) - 1.2rem)}
.al table{border-collapse:separate;border-spacing:0;font-size:inherit;width:100%}
.al thead th{position:sticky;top:0;z-index:2;background:var(--panel);box-shadow:inset 0 -1px 0 var(--line);padding:0;text-align:left;vertical-align:bottom;white-space:nowrap}
.al thead th button{display:flex;gap:.3rem;align-items:center;width:100%;background:none;border:0;padding:.55rem .7rem;font-weight:600}
.al thead th.nosort button{cursor:default}
.al thead .ar{color:var(--accent);font-size:.72rem;min-width:.7rem}
.al td{padding:.6rem .7rem;border-bottom:1px solid var(--line);vertical-align:top;line-height:1.42}
.al tr.r:hover td{background:color-mix(in srgb,var(--accent-soft) 45%,transparent)}
.al tr.r.isopen td{background:var(--accent-soft);border-bottom-color:transparent}
.c-num{white-space:nowrap;font-variant-numeric:tabular-nums}
.c-title{min-width:17rem}
.c-text{min-width:21rem}
.c-tags{min-width:13rem}
.t{display:block;width:100%;text-align:left;background:none;border:0;padding:0}
.t b{font-weight:600}
.t .sub{display:block;margin-top:.12rem;color:var(--muted);font-size:.8rem;font-weight:400}
.t b::before{content:"▸ ";color:var(--muted);font-weight:400}
.isopen .t b::before{content:"▾ "}
.ftl{white-space:nowrap}
.ftl.ext::after{content:" ↗";font-size:.8em}
.tag{display:inline-block;background:var(--chip);color:var(--chip-ink);border:1px solid transparent;border-radius:999px;padding:.03rem .5rem;
  margin:0 .2rem .2rem 0;font-size:.79rem;line-height:1.4;text-align:left}
.tag:hover{border-color:var(--accent)}
.tag.on{background:var(--accent-soft);border-color:var(--accent);color:var(--ink);font-weight:600}
.note{display:block;color:var(--muted);font-size:.82rem;margin-top:.1rem}
.pm{display:inline-block;margin-left:.16rem;font-size:.66rem;line-height:1;vertical-align:super;text-decoration:none;font-variant-numeric:tabular-nums}
.pm:hover{text-decoration:underline}
.al mark{background:var(--mark);color:inherit;border-radius:2px}
tr.more>td{background:var(--bg);padding:0}
.det{position:sticky;left:0;box-sizing:border-box;width:var(--tw,100%);padding:.9rem 1rem 1rem}
.det .cite{margin:0 0 .6rem;max-width:90ch}
.det .links{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 .8rem}
.det .links a{text-decoration:none;color:inherit}
.detgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.7fr);gap:.4rem 1.6rem}
.det h4{margin:0 0 .3rem;font-size:.74rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-weight:600}
.det dl{margin:0}
.det dt{font-weight:600;margin-top:.5rem}
.det dt:first-child{margin-top:0}
.det dd{margin:.08rem 0 0}
.det blockquote{margin:.35rem 0 0;padding:.05rem 0 .05rem .7rem;border-left:3px solid var(--accent);font-family:Georgia,serif;font-size:.92rem}
.det .place{display:block;font-family:ui-sans-serif,system-ui,sans-serif;color:var(--muted);font-size:.78rem}
.det .who{margin:.75rem 0 0;color:var(--muted);font-size:.8rem}
.alnone{padding:2rem 1rem;text-align:center;color:var(--muted)}
.al.cardy .det{position:static;width:auto}
.al.cardy .tw{background:none;border:0;overflow:visible;max-height:none;border-radius:0}
.al.cardy thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.al.cardy tbody{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));gap:.7rem;align-items:start}
.al.cardy tr.r{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.3rem 0}
.al.cardy tr.r td{display:block;border:0;min-width:0;padding:.28rem .85rem;background:none}
.al.cardy tr.r.isopen{outline:2px solid var(--accent)}
.al.cardy td[data-label]::before{content:attr(data-label);display:block;color:var(--muted);font-size:.72rem;letter-spacing:.03em;text-transform:uppercase}
.al.cardy tr.more{display:block;grid-column:1/-1}
.al.cardy tr.more>td{display:block;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.al.cardy tr.alempty{display:block;grid-column:1/-1}
.al.cardy tr.alempty td{display:block;border:0}
@media (max-width:820px){
  .algrid{grid-template-columns:minmax(0,1fr)}
  .fbtn{display:inline-flex}
  .seg{display:none}
  header.top{position:static}
  .alsearch{flex-basis:100%}
  .alside{display:none;position:fixed;inset:0;z-index:30;max-height:none;border-radius:0;border:0;padding:1rem 16px 2rem}
  .al.fopen .alside{display:block}
  .fclose{display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;position:sticky;top:-1rem;background:var(--panel);padding:.5rem 0}
  .detgrid{grid-template-columns:minmax(0,1fr)}
  .pick .pop{position:fixed;left:16px;right:16px;top:auto;width:auto}
}
`;

// No backticks or dollar-braces below: this is a template literal.
export const LIST_JS = String.raw`
(function(){
  var D=window.__UPCL_DATA, root=document.querySelector("[data-list]");
  if(!D||!root) return;
  function E(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
  function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""); }
  var LAST=/^(not reported|unstated|neither|none directly|other|elsewhere or unstated)$/i;
  var GROUPS=["The study","Tags","The annotation"];
  var textCol=null;

  // --- the columns and the filters, from the data ---------------------------
  function shortBy(r){
    var a=String(r.authors||""), two=a.split(", & ");
    if(/;/.test(a)) return a.length>60?a.slice(0,a.indexOf(";"))+" et al.":a;
    if(/et al/.test(a)) return a.split(",")[0]+" et al.";
    if(two.length<2) return a.split(",")[0];
    return two[0].split(", ").length<=2?two[0].split(",")[0]+" & "+two[1].split(",")[0]:a.split(",")[0]+" et al.";
  }
  // A model's sentence keeps its links to the passages it rests on, as small numbers in place.
  var MARK=/\s*\[(ext-[0-9a-f]+)\]/;
  function strip(s){ return String(s==null?"":s).split(new RegExp(MARK.source,"g")).filter(function(x,i){ return i%2===0; }).join("").trim(); }
  function cited(s,r){
    var n=0;
    return String(s==null?"":s).split(new RegExp(MARK.source,"g")).map(function(p,i){
      return i%2?'<a class="pm" href="'+E(r.page)+"#ex="+E(p)+'" title="Read the passage this rests on">'+(++n)+"</a>":hi(p);
    }).join("");
  }
  var COLS=[
    {id:"no",label:"No.",group:"The study",num:true,sort:function(r){ return r.no; },plain:function(r){ return r.no; }},
    {id:"title",label:"Title",group:"The study",cls:"c-title",sort:function(r){ return r.title.toLowerCase(); },plain:function(r){ return r.title; }},
    {id:"year",label:"Year",group:"The study",num:true,sort:function(r){ return r._y||0; },plain:function(r){ return r.year||"n.d."; }},
    {id:"full",label:"Full text",group:"The study",sort:function(r){ return r.full.kind; },plain:function(r){ return r.full.href; }},
    {id:"authors",label:"Authors",group:"The study",cls:"c-tags",sort:function(r){ return String(r.authors).toLowerCase(); },plain:function(r){ return r.authors; }},
    {id:"venue",label:"Venue",group:"The study",cls:"c-tags",sort:function(r){ return String(r.venue).toLowerCase(); },plain:function(r){ return r.venue; }},
    {id:"page",label:"Study page",group:"The study",plain:function(r){ return r.page; }}
  ];
  var FACETS=[];
  function addTags(label,get,note){
    var id=slug(label);
    COLS.push({id:id,label:label,group:note===undefined?"Tags":"The annotation",cls:"c-tags",tags:get,note:note,
      sort:function(r){ return (get(r)[0]||"~").toLowerCase(); },
      plain:function(r){ return get(r).join("; ")+(note&&note(r)?" — "+strip(note(r)):""); }});
    FACETS.push({id:id,label:label,get:get});
  }
  (D.schemes||[]).forEach(function(h){ addTags(h,function(r){ return r.schemes[h]||[]; }); });
  (D.fields||[]).forEach(function(f){
    var g=function(r){ return r.fields[f.key]||{}; };
    if(f.kind==="code"){ addTags(f.label,function(r){ return g(r).codes||[]; },function(r){ return g(r).note||""; }); return; }
    var id=slug(f.label);
    if(!textCol) textCol=id;
    COLS.push({id:id,label:f.label,group:"The annotation",cls:"c-text",text:function(r){ return g(r).text||""; },plain:function(r){ return strip(g(r).text); }});
  });
  var byId={}; COLS.forEach(function(c){ byId[c.id]=c; });
  var DEFAULT=["title","year","full"].concat(textCol?[textCol]:[]);
  FACETS.sort(function(a,b){
    var x=D.facets.indexOf(a.label), y=D.facets.indexOf(b.label);
    return (x<0?99:x)-(y<0?99:y);
  });

  D.rows.forEach(function(r){
    r._y=/^\d{4}$/.test(r.year)?+r.year:0;
    r._v={}; var h=[r.title,r.authors,r.venue,r.year];
    FACETS.forEach(function(f){ r._v[f.id]=f.get(r); h=h.concat(r._v[f.id]); });
    COLS.forEach(function(c){ if(c.text) h.push(strip(c.text(r))); if(c.note) h.push(strip(c.note(r))); });
    r._h=h.join(" ").toLowerCase();
  });
  FACETS.forEach(function(f){
    var n={}; D.rows.forEach(function(r){ r._v[f.id].forEach(function(v){ n[v]=(n[v]||0)+1; }); });
    f.vals=Object.keys(n).sort(function(a,b){ return (LAST.test(a)-LAST.test(b))||(n[b]-n[a]); });
    f.max=Math.max.apply(null,f.vals.map(function(v){ return n[v]; }).concat(1));
    f.multi=D.rows.some(function(r){ return r._v[f.id].length>1; });
  });
  var YS=D.rows.map(function(r){ return r._y; }).filter(Boolean);
  var Y0=Math.min.apply(null,YS), Y1=Math.max.apply(null,YS), YEARS=[];
  for(var yy=Y0;yy<=Y1;yy++) YEARS.push(yy);
  var YHINT="Drag across years, or tap one. Pale bars: all studies."+(YS.length<D.rows.length?" "+(D.rows.length-YS.length)+" have no year.":"");
  var yAll={}; YS.forEach(function(y){ yAll[y]=(yAll[y]||0)+1; });
  var yMax=Math.max.apply(null,YEARS.map(function(y){ return yAll[y]||0; }).concat(1));

  // --- state, kept in the address so a view can be shared ---------------------
  var S={q:"",sel:{},mode:{},y:null,cols:DEFAULT.slice(),sort:null,view:"table",open:{},fold:{}};
  var KEY="upc-list-columns";
  try{
    var saved=JSON.parse(localStorage.getItem(KEY)||"null");
    if(saved&&saved.every(function(c){ return byId[c]; })) S.cols=saved;
  }catch(e){}
  (function(){
    var p=new URLSearchParams(location.hash.replace(/^#/,""));
    if(p.get("q")) S.q=p.get("q");
    if(p.get("c")){ var c=p.get("c").split(",").filter(function(x){ return byId[x]; }); if(c.length) S.cols=c; }
    if(p.get("y")){ var m=p.get("y").match(/^(\d{4})-(\d{4})$/); if(m) S.y=[+m[1],+m[2]]; }
    if(p.get("s")){ var q=p.get("s").split("."); if(byId[q[0]]) S.sort={id:q[0],dir:q[1]==="d"?-1:1}; }
    if(p.get("v")==="cards") S.view="cards";
    FACETS.forEach(function(f){
      var v=p.get("f."+f.id);
      if(v){ S.sel[f.id]=v.split("|").filter(function(x){ return f.vals.indexOf(x)>=0; }); if(!S.sel[f.id].length) delete S.sel[f.id]; }
      if(p.get("m."+f.id)==="all") S.mode[f.id]="all";
    });
  })();
  function writeHash(){
    var p=new URLSearchParams();
    if(S.q) p.set("q",S.q);
    FACETS.forEach(function(f){
      if(S.sel[f.id]) p.set("f."+f.id,S.sel[f.id].join("|"));
      if(S.mode[f.id]==="all"&&S.sel[f.id]) p.set("m."+f.id,"all");
    });
    if(S.y) p.set("y",S.y[0]+"-"+S.y[1]);
    if(S.cols.join()!==DEFAULT.join()) p.set("c",S.cols.join(","));
    if(S.sort) p.set("s",S.sort.id+"."+(S.sort.dir<0?"d":"a"));
    if(S.view==="cards") p.set("v","cards");
    var h=p.toString();
    try{ history.replaceState(null,"",h?"#"+h:location.pathname+location.search); }catch(e){}
  }

  // --- filtering --------------------------------------------------------------
  function terms(){ return S.q.toLowerCase().split(/\s+/).filter(Boolean); }
  function pass(r,skip,T){
    for(var i=0;i<T.length;i++) if(r._h.indexOf(T[i])<0) return false;
    if(skip!=="year"&&S.y&&(!r._y||r._y<S.y[0]||r._y>S.y[1])) return false;
    for(var k in S.sel){
      if(k===skip) continue;
      var sel=S.sel[k], vals=r._v[k], hit=S.mode[k]==="all"
        ?sel.every(function(v){ return vals.indexOf(v)>=0; })
        :sel.some(function(v){ return vals.indexOf(v)>=0; });
      if(!hit) return false;
    }
    return true;
  }
  function matching(){
    var T=terms(), out=D.rows.filter(function(r){ return pass(r,null,T); });
    if(S.sort){
      var c=byId[S.sort.id], d=S.sort.dir;
      out=out.slice().sort(function(a,b){
        var x=c.sort(a), y=c.sort(b);
        return ((x<y?-1:x>y?1:0)*d)||(a.no-b.no);
      });
    }
    return out;
  }

  // --- rendering --------------------------------------------------------------
  function hi(s){
    var T=terms();
    if(!T.length) return E(s);
    var re=new RegExp("("+T.map(function(t){ return t.replace(/[.*+?^|()[\]{}\\$]/g,"\\$&"); }).join("|")+")","ig");
    return String(s==null?"":s).split(re).map(function(p,i){ return i%2?"<mark>"+E(p)+"</mark>":E(p); }).join("");
  }
  function tagHtml(fid,v){
    var on=(S.sel[fid]||[]).indexOf(v)>=0;
    return '<button class="tag'+(on?" on":"")+'" data-act="f" data-f="'+E(fid)+'" data-v="'+E(v)+'" aria-pressed="'+on+'" title="Filter by this">'+hi(v)+"</button>";
  }
  function fullHtml(r){
    var ext=/^https?:/.test(r.full.href);
    return '<a class="ftl'+(ext?" ext":"")+'" href="'+E(r.full.href)+'" target="_blank" rel="noopener">'+E(r.full.kind)+"</a>";
  }
  function cellHtml(c,r){
    if(c.id==="title"){
      var who=shortBy(r), v=String(r.venue||""), same=String(r.authors||"").toLowerCase().indexOf(v.toLowerCase())>=0;
      var by=[who,same?"":v].filter(Boolean).join(" · ");
      return '<button class="t" data-act="open" data-n="'+r.no+'" aria-expanded="'+!!S.open[r.no]+'"><b>'+hi(r.title)+'</b><span class="sub">'+hi(by)+"</span></button>";
    }
    if(c.id==="year") return E(r.year||"n.d.");
    if(c.id==="no") return E(r.no);
    if(c.id==="full") return fullHtml(r);
    if(c.id==="page") return '<a href="'+E(r.page)+'">Open</a>';
    if(c.tags) return c.tags(r).map(function(v){ return tagHtml(c.id,v); }).join("")+(c.note&&c.note(r)?'<span class="note">'+cited(c.note(r),r)+"</span>":"");
    if(c.text) return cited(c.text(r),r);
    return hi(c.plain(r));
  }
  function detailHtml(r){
    var links=['<a class="albtn" href="'+E(r.full.href)+'" target="_blank" rel="noopener">'+E(r.full.kind)+'</a>','<a class="albtn" href="'+E(r.page)+'">Study page</a>'];
    if(r.doi) links.push('<a class="albtn" href="https://doi.org/'+E(r.doi)+'" target="_blank" rel="noopener">DOI</a>');
    var tags=COLS.filter(function(c){ return c.group==="Tags"; }).map(function(c){
      return "<dt>"+E(c.label)+"</dt><dd>"+(c.tags(r).map(function(v){ return tagHtml(c.id,v); }).join("")||"—")+"</dd>";
    }).join("");
    var ann=(D.fields||[]).map(function(f){
      var x=r.fields[f.key]||{}, c=byId[slug(f.label)], h;
      h=f.kind==="code"?(x.codes||[]).map(function(v){ return tagHtml(c.id,v); }).join("")+(x.note?'<span class="note">'+cited(x.note,r)+"</span>":""):cited(x.text,r);
      if(x.quote) h+="<blockquote>“"+hi(x.quote.text)+"”"+(x.quote.place?'<span class="place">'+E(x.quote.place)+"</span>":"")+"</blockquote>";
      return "<dt>"+E(f.label)+"</dt><dd>"+h+"</dd>";
    }).join("");
    return '<div class="det"><p class="cite">'+hi(r.citation)+'</p><p class="links">'+links.join("")+'</p><div class="detgrid"><div><h4>Tags</h4><dl>'+tags+
      "</dl></div><div><h4>Annotation</h4><dl>"+ann+"</dl>"+
      (r.by?'<p class="who">Written by a model. Quotations are checked against the paper; the rest is the model’s reading.</p>':"")+"</div></div></div>";
  }
  function renderTable(rows,keepRow){
    var cols=S.cols.map(function(id){ return byId[id]; });
    var head=cols.map(function(c){
      var s=S.sort&&S.sort.id===c.id, can=!!c.sort;
      return '<th scope="col" class="'+(can?"":"nosort")+'"'+(s?' aria-sort="'+(S.sort.dir<0?"descending":"ascending")+'"':"")+'>'+
        '<button data-act="sort" data-c="'+c.id+'"'+(can?"":" disabled")+'>'+E(c.label)+'<span class="ar">'+(s?(S.sort.dir<0?"▼":"▲"):"")+"</span></button></th>";
    }).join("");
    var body=rows.map(function(r){
      var open=S.open[r.no];
      return '<tr class="r'+(open?" isopen":"")+'">'+cols.map(function(c){
        return '<td class="'+(c.num?"c-num ":"")+(c.cls||"")+'"'+(c.id==="title"?"":' data-label="'+E(c.label)+'"')+">"+cellHtml(c,r)+"</td>";
      }).join("")+"</tr>"+(open?'<tr class="more"><td colspan="'+cols.length+'">'+detailHtml(r)+"</td></tr>":"");
    }).join("");
    if(!rows.length) body='<tr class="alempty"><td colspan="'+cols.length+'"><div class="alnone">No study matches these filters. <button class="clear" data-act="clear">Clear them</button></div></td></tr>';
    var top=els.tw.scrollTop, left=els.tw.scrollLeft;
    els.tw.innerHTML="<table><thead><tr>"+head+"</tr></thead><tbody>"+body+"</tbody></table>";
    els.tw.scrollTop=keepRow?top:0; els.tw.scrollLeft=left;
    root.style.setProperty("--tw",els.tw.clientWidth+"px");
  }
  function renderSide(){
    var T=terms(), h='<div class="fclose"><strong>Filters</strong><button class="albtn" data-act="filters">Show '+count.n+" studies</button></div>";
    // The year chart: pale for all studies, solid for those matching the other filters.
    var yNow={}; D.rows.forEach(function(r){ if(r._y&&pass(r,"year",T)) yNow[r._y]=(yNow[r._y]||0)+1; });
    h+='<div class="fg"><div class="fh"><span class="ft noc">Year</span>'+(S.y?'<button class="fmode" data-act="year-clear">clear</button>':"")+"</div>";
    h+='<div class="yh" data-yh>'+YEARS.map(function(y){
      var all=yAll[y]||0, now=yNow[y]||0, inr=!S.y||(y>=S.y[0]&&y<=S.y[1]);
      return '<button class="y'+(inr?"":" off")+'" data-y="'+y+'" aria-label="'+y+": "+now+" of "+all+' studies" aria-pressed="'+!!(S.y&&inr)+'">'+
        '<span class="a" style="height:'+(100*all/yMax)+'%"></span><span class="m" style="height:'+(100*now/yMax)+'%"></span></button>';
    }).join("")+"</div>";
    h+='<div class="yax"><span>'+Y0+"</span><span>"+Y1+'</span></div><div class="yline" data-yl>'+YHINT+"</div></div>";
    FACETS.forEach(function(f){
      var n={}; D.rows.forEach(function(r){ if(pass(r,f.id,T)) r._v[f.id].forEach(function(v){ n[v]=(n[v]||0)+1; }); });
      var sel=S.sel[f.id]||[], fold=S.fold[f.id];
      h+='<div class="fg'+(fold?" fold":"")+'"><div class="fh"><button class="ft" data-act="fold" data-f="'+f.id+'" aria-expanded="'+!fold+'">'+E(f.label)+"</button>"+
        (f.multi&&sel.length>1?'<button class="fmode" data-act="mode" data-f="'+f.id+'" title="Match any of these, or all of them">'+(S.mode[f.id]==="all"?"all of these":"any of these")+"</button>":"")+"</div>";
      if(!fold) h+=f.vals.map(function(v){
        var c=n[v]||0, on=sel.indexOf(v)>=0;
        return '<button class="fv'+(on?" on":"")+(c?"":" none")+'" data-act="f" data-f="'+f.id+'" data-v="'+E(v)+'" aria-pressed="'+on+'">'+
          '<span class="bar" style="width:'+(100*c/f.max)+'%"></span><span class="l">'+E(v)+'</span><span class="c">'+c+"</span></button>";
      }).join("");
      h+="</div>";
    });
    var top=els.side.scrollTop;
    els.side.innerHTML=h;
    els.side.scrollTop=top;
  }
  function renderStat(n){
    var a=[];
    FACETS.forEach(function(f){ (S.sel[f.id]||[]).forEach(function(v){
      a.push('<button class="ach" data-act="f" data-f="'+f.id+'" data-v="'+E(v)+'" title="Remove this filter"><i>'+E(f.label)+"</i> "+E(v)+" ×</button>");
    }); });
    if(S.y) a.push('<button class="ach" data-act="year-clear"><i>Year</i> '+(S.y[0]===S.y[1]?S.y[0]:S.y[0]+"–"+S.y[1])+" ×</button>");
    els.stat.innerHTML='<span class="alcount" aria-live="polite"><b>'+n+"</b> of "+D.rows.length+" studies</span>"+a.join("")+
      (a.length||S.q?'<button class="clear" data-act="clear">Clear all</button>':"");
    var on=Object.keys(S.sel).length+(S.y?1:0);
    els.fbtn.textContent=on?"Filters ("+on+")":"Filters";
  }
  function renderPick(){
    els.pickn.textContent=S.cols.length;
    els.pop.querySelectorAll("input").forEach(function(i){ i.checked=S.cols.indexOf(i.value)>=0; });
  }
  var count={n:0};
  function render(keep,keepRow){
    var rows=matching();
    count.n=rows.length;
    root.classList.toggle("cardy",S.view==="cards"||narrow.matches);
    renderStat(rows.length);
    renderSide();
    renderTable(rows,keepRow);
    root.querySelectorAll(".seg button").forEach(function(b){ b.setAttribute("aria-pressed",b.dataset.v===S.view); });
    renderPick();
    writeHash();
    if(keep){ // A rebuilt control keeps the keyboard's place.
      var el=root.querySelector(keep);
      if(el) el.focus({preventScroll:true});
    }
  }

  // --- the frame --------------------------------------------------------------
  var groups=GROUPS.map(function(g){
    return "<h4>"+g+"</h4>"+COLS.filter(function(c){ return c.group===g; }).map(function(c){
      return '<label><input type="checkbox" value="'+c.id+'"> '+E(c.label)+"</label>";
    }).join("");
  }).join("");
  root.innerHTML='<div class="altop"><div class="alsearch"><input type="search" placeholder="Search titles, authors and annotations" aria-label="Search the list"></div>'+
    '<button class="albtn fbtn" data-act="filters">Filters</button>'+
    '<details class="pick"><summary class="albtn">Columns <b data-pickn></b></summary><div class="pop">'+groups+
    '<div class="acts"><button class="albtn" data-act="cols-default">Default</button><button class="albtn" data-act="cols-all">All</button></div></div></details>'+
    '<div class="seg" role="group" aria-label="View"><button data-act="view" data-v="table">Table</button><button data-act="view" data-v="cards">Cards</button></div>'+
    '<button class="albtn" data-act="csv" title="The studies and columns you see, as a CSV file">Download this view</button></div>'+
    '<div class="alstat"></div><div class="algrid"><aside class="alside" aria-label="Filters"></aside><section class="res"><div class="tw"></div></section></div>';
  var els={side:root.querySelector(".alside"),tw:root.querySelector(".tw"),stat:root.querySelector(".alstat"),
    pop:root.querySelector(".pop"),pickn:root.querySelector("[data-pickn]"),fbtn:root.querySelector(".fbtn"),q:root.querySelector("input[type=search]")};
  var narrow=window.matchMedia("(max-width:820px)");
  els.q.value=S.q;
  function setTop(){
    var h=document.querySelector("header.top");
    if(h) root.style.setProperty("--top",h.offsetHeight+"px");
  }
  setTop();
  window.addEventListener("resize",function(){ setTop(); render(null,true); });

  function saveCols(){ try{ localStorage.setItem(KEY,JSON.stringify(S.cols)); }catch(e){} }
  function toggle(f,v){
    var a=S.sel[f]||[], i=a.indexOf(v);
    if(i>=0) a.splice(i,1); else a.push(v);
    if(a.length) S.sel[f]=a; else delete S.sel[f];
  }
  function csv(){
    var rows=matching(), cols=S.cols.map(function(id){ return byId[id]; });
    var cell=function(x){
      var s=String(x==null?"":x);
      if(/^[=+\-@]/.test(s)) s="'"+s;
      return '"'+s.replace(/"/g,'""')+'"';
    };
    var lines=[cols.map(function(c){ return cell(c.label); }).join(",")].concat(rows.map(function(r){
      return cols.map(function(c){ return cell(c.plain(r)); }).join(",");
    }));
    var a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob(["﻿"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"}));
    a.download=slug(D.title)+"-view.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); },1000);
  }
  root.addEventListener("click",function(e){
    var b=e.target.closest("[data-act]");
    if(!b) return;
    var act=b.dataset.act, f=b.dataset.f, v=b.dataset.v;
    if(act==="f"){
      toggle(f,v);
      var inSide=b.classList.contains("fv");
      render(inSide?'.fv[data-f="'+f+'"][data-v="'+v.replace(/"/g,'\\"')+'"]':null);
    }
    else if(act==="fold"){ S.fold[f]=!S.fold[f]; render('.ft[data-f="'+f+'"]'); }
    else if(act==="mode"){ S.mode[f]=S.mode[f]==="all"?"any":"all"; render('.fmode[data-f="'+f+'"]'); }
    else if(act==="year-clear"){ S.y=null; render(); }
    else if(act==="clear"){ S.sel={}; S.y=null; S.q=""; els.q.value=""; render(); }
    else if(act==="open"){ S.open[b.dataset.n]=!S.open[b.dataset.n]; render('.t[data-n="'+b.dataset.n+'"]',true); }
    else if(act==="sort"){
      var id=b.dataset.c;
      if(!byId[id].sort) return;
      S.sort=!S.sort||S.sort.id!==id?{id:id,dir:byId[id].num?-1:1}:S.sort.dir===(byId[id].num?-1:1)?{id:id,dir:-S.sort.dir}:null;
      render('[data-act="sort"][data-c="'+id+'"]');
    }
    else if(act==="view"){ S.view=v; render(); }
    else if(act==="filters"){ root.classList.toggle("fopen"); }
    else if(act==="csv") csv();
    else if(act==="cols-default"){ S.cols=DEFAULT.slice(); saveCols(); render(); }
    else if(act==="cols-all"){ S.cols=COLS.map(function(c){ return c.id; }); saveCols(); render(); }
  });
  els.pop.addEventListener("change",function(e){
    var id=e.target.value, order=COLS.map(function(c){ return c.id; });
    if(e.target.checked) S.cols=S.cols.concat(id).sort(function(a,b){ return order.indexOf(a)-order.indexOf(b); });
    else if(S.cols.length>1) S.cols=S.cols.filter(function(x){ return x!==id; });
    saveCols(); render();
  });
  document.addEventListener("click",function(e){
    var p=root.querySelector(".pick");
    if(p&&p.open&&!p.contains(e.target)) p.open=false;
  });
  var wait;
  els.q.addEventListener("input",function(){
    clearTimeout(wait);
    wait=setTimeout(function(){ S.q=els.q.value.trim(); render(); },130);
  });

  // The year chart: a tap takes one year, a drag a range; a tap on the only year chosen clears it.
  var drag=null;
  function yearAt(e){
    var el=document.elementFromPoint(e.clientX,e.clientY), b=el&&el.closest(".y");
    return b?+b.dataset.y:null;
  }
  function showRange(a,b){
    var lo=Math.min(a,b), hi2=Math.max(a,b);
    els.side.querySelectorAll(".y").forEach(function(x){ x.classList.toggle("off",+x.dataset.y<lo||+x.dataset.y>hi2); });
    var l=els.side.querySelector("[data-yl]");
    if(l) l.textContent=lo===hi2?String(lo):lo+"–"+hi2;
  }
  els.side.addEventListener("pointerdown",function(e){
    var b=e.target.closest(".y");
    if(!b) return;
    drag={from:+b.dataset.y,to:+b.dataset.y};
    showRange(drag.from,drag.to);
    e.preventDefault();
  });
  document.addEventListener("pointermove",function(e){
    if(!drag) return;
    var y=yearAt(e);
    if(y){ drag.to=y; showRange(drag.from,drag.to); }
  });
  document.addEventListener("pointerup",function(){
    if(!drag) return;
    var lo=Math.min(drag.from,drag.to), hi2=Math.max(drag.from,drag.to);
    S.y=S.y&&S.y[0]===lo&&S.y[1]===hi2?null:[lo,hi2];
    drag=null;
    render();
  });
  els.side.addEventListener("keydown",function(e){
    var b=e.target.closest&&e.target.closest(".y");
    if(!b||(e.key!=="Enter"&&e.key!==" ")) return;
    e.preventDefault();
    var y=+b.dataset.y;
    S.y=S.y&&S.y[0]===y&&S.y[1]===y?null:[y,y];
    render('.y[data-y="'+y+'"]');
  });
  els.side.addEventListener("mouseover",function(e){
    var b=e.target.closest(".y"), l=els.side.querySelector("[data-yl]");
    if(b&&l&&!drag) l.textContent=b.getAttribute("aria-label");
  });
  render();
})();
`;
