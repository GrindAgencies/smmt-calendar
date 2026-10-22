// The Nexus app shell. No backticks and no dollar-brace inside this string.
export const SHELL = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<title>Nexus</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Nexus">
<meta name="theme-color" content="#14110E">
<link rel="manifest" href="__BASE__?manifest=1">
<link rel="apple-touch-icon" href="__BASE__?icon=apple">
<link rel="icon" href="__BASE__?icon=192">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Saira+Condensed:wght@400;500;600;700&display=swap">
<style>
:root{
  --ground:#14110E; --surface:#1D1915; --surface-2:#241F1A; --raise:#2B251E;
  --ink:#F4EFE5; --body:#DCD5C9; --muted:#9C9284; --faint:#786F62;
  --rule:#332C24; --rule-soft:#2A241E;
  --brass:#D9AE3F; --brass-dim:#8A6E24; --brass-wash:#2A2214;
  --oxblood:#C1524A; --oxblood-wash:#2E1917;
  --moss:#7FA98A; --moss-wash:#18251C;
  --amber:#C9962F; --amber-wash:#2A2113;
  --shadow:0 1px 2px rgba(0,0,0,.5), 0 12px 30px -18px rgba(0,0,0,1);
  --tab-h:58px;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --ground:#EAE8E1; --surface:#F7F5F0; --surface-2:#F0EDE5; --raise:#E6E2D8;
    --ink:#191512; --body:#332C25; --muted:#6E675C; --faint:#8C8478;
    --rule:#D2CDC1; --rule-soft:#DFDACE;
    --brass:#8A6710; --brass-dim:#C9A94E; --brass-wash:#F1E7CA;
    --oxblood:#8E2B26; --oxblood-wash:#F3E0DD;
    --moss:#3F6349; --moss-wash:#DFE9E0;
    --amber:#8A5D12; --amber-wash:#F3E6CD;
    --shadow:0 1px 2px rgba(25,21,18,.06), 0 10px 26px -18px rgba(25,21,18,.5);
  }
}
:root[data-theme="light"]{
  --ground:#EAE8E1; --surface:#F7F5F0; --surface-2:#F0EDE5; --raise:#E6E2D8;
  --ink:#191512; --body:#332C25; --muted:#6E675C; --faint:#8C8478;
  --rule:#D2CDC1; --rule-soft:#DFDACE;
  --brass:#8A6710; --brass-dim:#C9A94E; --brass-wash:#F1E7CA;
  --oxblood:#8E2B26; --oxblood-wash:#F3E0DD;
  --moss:#3F6349; --moss-wash:#DFE9E0;
  --amber:#8A5D12; --amber-wash:#F3E6CD;
  --shadow:0 1px 2px rgba(25,21,18,.06), 0 10px 26px -18px rgba(25,21,18,.5);
}

*{box-sizing:border-box; -webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{
  margin:0; background:var(--ground); color:var(--body);
  font-family:"Newsreader",Georgia,serif; font-size:16px; line-height:1.5;
  -webkit-font-smoothing:antialiased; overscroll-behavior-y:none;
}
button,input,textarea,select{font:inherit; color:inherit}
.lab{font-family:"Saira Condensed",system-ui,sans-serif; font-weight:600;
     text-transform:uppercase; letter-spacing:.14em; font-size:10.5px; color:var(--faint)}
.num{font-family:"Saira Condensed",system-ui,sans-serif; font-weight:700; font-variant-numeric:tabular-nums}
.mono-name{font-family:"Archivo Black",system-ui,sans-serif; font-weight:400; letter-spacing:-.01em}

/* ---------- frame ---------- */
#app{display:flex; flex-direction:column; height:100dvh; max-width:900px; margin:0 auto;
     border-left:1px solid var(--rule); border-right:1px solid var(--rule)}
@media (max-width:900px){#app{border:0}}

#topbar{
  flex:0 0 auto; padding:calc(env(safe-area-inset-top) + 12px) 16px 10px;
  background:var(--ground); border-bottom:1px solid var(--rule);
  display:flex; align-items:center; gap:12px;
}
#topbar .mark{width:26px; height:26px; flex:0 0 auto; border:1.5px solid var(--brass); border-radius:6px;
  display:grid; place-items:center; color:var(--brass); font-family:"Archivo Black",sans-serif; font-size:13px}
#topbar h1{margin:0; font-family:"Archivo Black",sans-serif; font-weight:400; font-size:17px; color:var(--ink); letter-spacing:-.01em}
#topbar .sub{margin-left:auto; text-align:right}
#pulse{display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--moss); margin-right:6px;
       animation:beat 2.6s ease-in-out infinite}
@keyframes beat{0%,100%{opacity:.35} 50%{opacity:1}}
#topbar button.ghost{background:none; border:0; color:var(--faint); padding:6px; cursor:pointer}
#topbar button.ghost:active{color:var(--brass)}

main{flex:1 1 auto; overflow-y:auto; -webkit-overflow-scrolling:touch; overscroll-behavior:contain}
.view{display:none; padding:14px 16px calc(24px + env(safe-area-inset-bottom))}
.view.on{display:block}

#tabs{
  flex:0 0 auto; display:grid; grid-template-columns:repeat(5,1fr);
  border-top:1px solid var(--rule); background:var(--surface);
  padding-bottom:env(safe-area-inset-bottom);
}
#tabs button{
  background:none; border:0; padding:9px 2px 8px; cursor:pointer; color:var(--faint);
  display:flex; flex-direction:column; align-items:center; gap:3px;
  font-family:"Saira Condensed",sans-serif; font-weight:600; font-size:10px;
  text-transform:uppercase; letter-spacing:.1em; min-height:var(--tab-h);
}
#tabs button svg{width:21px; height:21px; stroke:currentColor; fill:none; stroke-width:1.7;
  stroke-linecap:round; stroke-linejoin:round}
#tabs button[aria-selected="true"]{color:var(--brass)}
#tabs button .dot{position:absolute; margin:-3px 0 0 15px; width:6px; height:6px; border-radius:50%; background:var(--oxblood)}

/* ---------- panels ---------- */
.panel{background:var(--surface); border:1px solid var(--rule); border-radius:10px;
       margin-bottom:12px; overflow:hidden; box-shadow:var(--shadow)}
.panel > header{display:flex; align-items:center; gap:10px; padding:11px 14px 9px;
  border-bottom:1px solid var(--rule-soft); background:var(--surface-2)}
.panel > header h2{margin:0; font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:11.5px;
  text-transform:uppercase; letter-spacing:.15em; color:var(--brass)}
.panel > header .right{margin-left:auto}
.panel .pad{padding:12px 14px}
.empty{padding:16px 14px; color:var(--faint); font-size:14.5px}

/* greeting */
#hello{padding:2px 2px 14px}
#hello h2{margin:0; font-family:"Archivo Black",sans-serif; font-weight:400;
  font-size:clamp(23px,6.4vw,31px); line-height:1.08; color:var(--ink); letter-spacing:-.02em}
#hello p{margin:7px 0 0; color:var(--muted); font-size:15.5px; max-width:52ch}

/* ask bar */
#askbar{display:flex; gap:8px; margin-bottom:14px}
#askbar input{flex:1; padding:13px 14px; border-radius:9px; border:1px solid var(--rule);
  background:var(--surface); color:var(--ink); font-size:16px}
#askbar input::placeholder{color:var(--faint)}
#askbar input:focus{outline:2px solid var(--brass); outline-offset:1px; border-color:transparent}
#askbar button{padding:0 16px; border-radius:9px; border:1px solid var(--brass);
  background:var(--brass-wash); color:var(--brass); cursor:pointer;
  font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:12px;
  text-transform:uppercase; letter-spacing:.12em}
#askbar button:active{background:var(--brass); color:var(--ground)}

/* stat row */
.stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(78px,1fr))}
.stat{padding:11px 12px; border-right:1px solid var(--rule-soft); border-bottom:1px solid var(--rule-soft)}
.stat b{display:block; font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:22px;
  color:var(--ink); line-height:1; font-variant-numeric:tabular-nums; margin-bottom:3px}
.stat.bad b{color:var(--oxblood)} .stat.good b{color:var(--moss)} .stat.warn b{color:var(--amber)}

/* task rows */
.rows{display:flex; flex-direction:column}
.row{display:flex; gap:11px; align-items:flex-start; padding:11px 14px; border-bottom:1px solid var(--rule-soft)}
.row:last-child{border-bottom:0}
.tick{flex:0 0 auto; width:22px; height:22px; margin-top:1px; border-radius:6px; cursor:pointer;
  border:1.5px solid var(--brass-dim); background:transparent; display:grid; place-items:center; padding:0}
.tick:active{background:var(--brass-wash)}
.tick svg{width:13px; height:13px; stroke:var(--brass); fill:none; stroke-width:2.6; opacity:0}
.row.done .tick{background:var(--brass); border-color:var(--brass)}
.row.done .tick svg{stroke:var(--ground); opacity:1}
.row.done .rtext{text-decoration:line-through; color:var(--faint)}
.rbody{flex:1; min-width:0}
.rtext{font-size:15px; line-height:1.42; color:var(--body); word-wrap:break-word}
.rmeta{margin-top:3px; display:flex; flex-wrap:wrap; gap:4px 9px; align-items:center}
.tag{font-family:"Saira Condensed",sans-serif; font-weight:600; font-size:10px;
  text-transform:uppercase; letter-spacing:.1em; padding:2px 6px; border-radius:3px;
  background:var(--raise); color:var(--muted)}
.tag.grind{background:var(--brass-wash); color:var(--brass)}
.tag.jbc{background:var(--moss-wash); color:var(--moss)}
.tag.powerpipeline{background:var(--amber-wash); color:var(--amber)}
.tag.personal{background:var(--oxblood-wash); color:var(--oxblood)}
.tag.late{background:var(--oxblood-wash); color:var(--oxblood)}

/* buckets */
.bgrid{display:grid; grid-template-columns:repeat(2,1fr); gap:10px}
.btile{background:var(--surface); border:1px solid var(--rule); border-left:3px solid var(--brass);
  border-radius:9px; padding:12px 13px; cursor:pointer; text-align:left; box-shadow:var(--shadow)}
.btile.jbc{border-left-color:var(--moss)} .btile.powerpipeline{border-left-color:var(--amber)}
.btile.personal{border-left-color:var(--oxblood)}
.btile h3{margin:0 0 7px; font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:11.5px;
  text-transform:uppercase; letter-spacing:.12em; color:var(--ink)}
.btile .bnums{display:flex; gap:14px; align-items:baseline}
.btile .bnums span{display:flex; flex-direction:column; gap:1px}
.btile .bnums b{font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:19px;
  color:var(--ink); font-variant-numeric:tabular-nums; line-height:1}
.btile .bnums b.late{color:var(--oxblood)}

/* metrics */
.mrow{display:flex; align-items:baseline; gap:10px; padding:10px 14px; border-bottom:1px solid var(--rule-soft)}
.mrow:last-child{border-bottom:0}
.mrow .mname{flex:1; font-size:14.5px; color:var(--body)}
.mrow .mval{font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:17px;
  color:var(--ink); font-variant-numeric:tabular-nums}
.trend{font-family:"Saira Condensed",sans-serif; font-size:12px; font-weight:700; width:16px; text-align:center}
.trend.up{color:var(--moss)} .trend.down{color:var(--oxblood)} .trend.flat{color:var(--faint)}
.asof{font-size:11px; color:var(--faint); font-family:"Saira Condensed",sans-serif; letter-spacing:.06em}

/* people */
.pcard{background:var(--surface); border:1px solid var(--rule); border-radius:9px; margin-bottom:10px;
  overflow:hidden; box-shadow:var(--shadow)}
.pcard .ptop{padding:11px 13px 9px; background:var(--surface-2); border-bottom:1px solid var(--rule-soft)}
.pcard .pname{font-family:"Archivo Black",sans-serif; font-weight:400; font-size:17px;
  color:var(--ink); margin:3px 0 0; letter-spacing:-.01em}
.pcard .pkind{display:flex; justify-content:space-between; gap:10px}
.pcard .pbody{padding:11px 13px; display:flex; flex-direction:column; gap:9px}
.pcard .pfield span{display:block; font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:9.5px;
  text-transform:uppercase; letter-spacing:.15em; color:var(--brass); margin-bottom:2px}
.pcard .pfield p{margin:0; font-size:14.5px; line-height:1.45}
.chips{display:flex; flex-wrap:wrap; gap:5px}
.chip{font-family:"Saira Condensed",sans-serif; font-weight:600; font-size:11px; letter-spacing:.05em;
  text-transform:uppercase; background:var(--raise); border:1px solid var(--rule-soft);
  color:var(--muted); padding:3px 7px; border-radius:3px}
.ask{background:var(--brass-wash); border-top:1px solid var(--rule-soft); padding:10px 13px}
.ask span{display:block; font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:9.5px;
  text-transform:uppercase; letter-spacing:.16em; color:var(--brass); margin-bottom:2px}
.ask p{margin:0; font-size:14.5px; line-height:1.4; color:var(--ink)}

/* search */
.search{position:sticky; top:0; z-index:5; background:var(--ground); padding:0 0 11px}
.search input{width:100%; padding:12px 14px; border-radius:9px; border:1px solid var(--rule);
  background:var(--surface); color:var(--ink); font-size:16px}
.search input:focus{outline:2px solid var(--brass); outline-offset:1px; border-color:transparent}
.filters{display:flex; gap:6px; overflow-x:auto; padding:9px 0 2px; scrollbar-width:none}
.filters::-webkit-scrollbar{display:none}
.fchip{white-space:nowrap; font-family:"Saira Condensed",sans-serif; font-weight:600; font-size:11.5px;
  text-transform:uppercase; letter-spacing:.1em; padding:6px 11px; border-radius:20px;
  border:1px solid var(--rule); background:transparent; color:var(--muted); cursor:pointer}
.fchip[aria-pressed="true"]{background:var(--ink); border-color:var(--ink); color:var(--ground)}

/* chat */
#v-nexus{display:none; flex-direction:column; height:100%; padding:0}
#v-nexus.on{display:flex}
#msgs{flex:1 1 auto; overflow-y:auto; padding:16px 16px 8px; display:flex; flex-direction:column; gap:14px}
.msg{max-width:88%; font-size:15.5px; line-height:1.55; white-space:pre-wrap; word-wrap:break-word}
.msg.me{align-self:flex-end; background:var(--brass-wash); border:1px solid var(--brass-dim);
  color:var(--ink); padding:10px 13px; border-radius:14px 14px 3px 14px}
.msg.her{align-self:flex-start; color:var(--body)}
.msg.her::before{content:"NEXUS"; display:block; font-family:"Saira Condensed",sans-serif;
  font-weight:700; font-size:9.5px; letter-spacing:.18em; color:var(--brass); margin-bottom:5px}
.thinking{align-self:flex-start; color:var(--faint); font-family:"Saira Condensed",sans-serif;
  font-size:12px; letter-spacing:.14em; text-transform:uppercase}
.thinking i{animation:beat 1.3s ease-in-out infinite; font-style:normal}
#composer{flex:0 0 auto; display:flex; gap:8px; padding:10px 14px calc(10px + env(safe-area-inset-bottom));
  border-top:1px solid var(--rule); background:var(--surface)}
#composer textarea{flex:1; resize:none; max-height:120px; padding:11px 13px; border-radius:10px;
  border:1px solid var(--rule); background:var(--ground); color:var(--ink); font-size:16px; line-height:1.4}
#composer textarea:focus{outline:2px solid var(--brass); outline-offset:1px; border-color:transparent}
#composer button{flex:0 0 auto; width:46px; border-radius:10px; border:1px solid var(--brass);
  background:var(--brass-wash); color:var(--brass); cursor:pointer; display:grid; place-items:center}
#composer button svg{width:19px; height:19px; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round}
#composer button:active{background:var(--brass); color:var(--ground)}

/* notes */
.note{background:var(--surface); border:1px solid var(--rule); border-radius:9px; padding:12px 13px;
  margin-bottom:10px; cursor:pointer; box-shadow:var(--shadow)}
.note h3{margin:0 0 4px; font-size:15.5px; color:var(--ink); font-family:"Newsreader",serif; font-weight:500}
.note p{margin:0; font-size:14px; color:var(--muted); display:-webkit-box; -webkit-line-clamp:3;
  -webkit-box-orient:vertical; overflow:hidden}
#noteedit{position:fixed; inset:0; background:var(--ground); z-index:50; display:none; flex-direction:column}
#noteedit.on{display:flex}
#noteedit header{display:flex; gap:10px; align-items:center; padding:calc(env(safe-area-inset-top) + 12px) 14px 10px;
  border-bottom:1px solid var(--rule)}
#noteedit input{flex:1; background:none; border:0; font-size:19px; color:var(--ink); font-family:"Newsreader",serif}
#noteedit input:focus{outline:none}
#noteedit textarea{flex:1; border:0; background:none; padding:14px; font-size:16px; line-height:1.6;
  color:var(--body); resize:none; font-family:"Newsreader",serif}
#noteedit textarea:focus{outline:none}
#noteedit button{background:none; border:0; color:var(--brass); cursor:pointer;
  font-family:"Saira Condensed",sans-serif; font-weight:700; font-size:12px;
  text-transform:uppercase; letter-spacing:.12em; padding:6px 4px}

/* lock */
#lock{position:fixed; inset:0; background:var(--ground); display:none; place-items:center; z-index:80; padding:24px}
#lock.on{display:grid}
#lock .box{max-width:340px; text-align:center}
#lock h2{font-family:"Archivo Black",sans-serif; font-weight:400; font-size:26px; color:var(--ink); margin:0 0 8px}
#lock p{color:var(--muted); font-size:15px; margin:0 0 18px}
#lock input{width:100%; padding:12px 14px; border-radius:9px; border:1px solid var(--rule);
  background:var(--surface); color:var(--ink); font-size:16px; text-align:center; margin-bottom:10px}
#lock button{width:100%; padding:12px; border-radius:9px; border:1px solid var(--brass);
  background:var(--brass-wash); color:var(--brass); cursor:pointer;
  font-family:"Saira Condensed",sans-serif; font-weight:700; text-transform:uppercase; letter-spacing:.12em}

#toast{position:fixed; left:50%; bottom:calc(var(--tab-h) + 18px + env(safe-area-inset-bottom));
  transform:translateX(-50%) translateY(14px); background:var(--raise); color:var(--ink);
  border:1px solid var(--rule); border-radius:8px; padding:9px 15px; font-size:14px;
  opacity:0; pointer-events:none; transition:opacity .2s, transform .2s; z-index:70; max-width:88vw}
#toast.on{opacity:1; transform:translateX(-50%) translateY(0)}
@media (prefers-reduced-motion:reduce){*{animation:none !important; transition:none !important}}
</style>
</head>
<body>

<div id="app">
  <header id="topbar">
    <div class="mark">N</div>
    <h1>Nexus</h1>
    <div class="sub"><span class="lab"><span id="pulse"></span><span id="stamp">—</span></span></div>
    <button class="ghost" id="refresh" aria-label="Refresh">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>
    </button>
  </header>

  <main>
    <section class="view on" id="v-bridge">
      <div id="hello"><h2 id="greet">Good morning.</h2><p id="readout">Waking up…</p></div>
      <form id="askbar" autocomplete="off">
        <input id="ask" placeholder="Ask Nexus anything…" enterkeyhint="send">
        <button type="submit">Ask</button>
      </form>
      <div id="bridge"></div>
    </section>

    <section class="view" id="v-book">
      <div class="search">
        <input id="bq" placeholder="Who do I know who can…" enterkeyhint="search">
        <div class="filters" id="bfilters"></div>
      </div>
      <div id="bookout"></div>
    </section>

    <section class="view" id="v-plate">
      <div class="search"><div class="filters" id="pfilters"></div></div>
      <div id="plateout"></div>
    </section>

    <section class="view" id="v-notes">
      <div class="search"><input id="nq" placeholder="Search notes…"></div>
      <div id="notesout"></div>
    </section>

    <section class="view" id="v-nexus">
      <div id="msgs"></div>
      <form id="composer">
        <textarea id="cin" rows="1" placeholder="Talk to Nexus…" enterkeyhint="send"></textarea>
        <button type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24"><path d="M4 12h15"/><path d="M13 6l6 6-6 6"/></svg>
        </button>
      </form>
    </section>
  </main>

  <nav id="tabs">
    <button data-v="bridge" aria-selected="true">
      <svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>Bridge</button>
    <button data-v="book" aria-selected="false">
      <svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z"/><path d="M8 7h7M8 11h7"/></svg>Book</button>
    <button data-v="plate" aria-selected="false">
      <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="4" cy="6" r="0.6"/></svg>Plate</button>
    <button data-v="notes" aria-selected="false">
      <svg viewBox="0 0 24 24"><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>Notes</button>
    <button data-v="nexus" aria-selected="false">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9 15V9l6 6V9"/></svg>Nexus</button>
  </nav>
</div>

<div id="noteedit">
  <header>
    <button id="nback">Back</button>
    <input id="ntitle" placeholder="Title">
    <button id="nsave">Save</button>
  </header>
  <textarea id="nbody" placeholder="Write it down. Nexus reads these."></textarea>
</div>

<div id="lock"><div class="box">
  <h2>Nexus</h2>
  <p>This line is private. Paste the key Christopher was given.</p>
  <input id="lockkey" type="password" placeholder="key" autocomplete="off">
  <button id="lockgo">Unlock</button>
</div></div>

<div id="toast"></div>

<script>
(function(){
"use strict";
var BASE = "__BASE__";
var KEY = null;
try { KEY = localStorage.getItem("nexus.k"); } catch(e) {}

// first open carries the key in the URL — take it, store it, then scrub the address bar
(function(){
  var m = location.search.match(/[?&]k=([^&]+)/);
  if (m) {
    KEY = decodeURIComponent(m[1]);
    try { localStorage.setItem("nexus.k", KEY); } catch(e) {}
    history.replaceState(null, "", BASE);
  }
})();

var HOME = null, BOOK = null, PLATE = null, NOTES = null;
var bucketFilter = "all", plateFilter = "all", bq = "", nq = "";
var $ = function(id){ return document.getElementById(id); };
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
  return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
function toast(t){ var e=$("toast"); e.textContent=t; e.classList.add("on");
  clearTimeout(e._t); e._t=setTimeout(function(){ e.classList.remove("on"); }, 2400); }

function api(name, body){
  return fetch(BASE + "?api=" + name, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":"Bearer " + (KEY||"") },
    body: JSON.stringify(body || {})
  }).then(function(r){
    if (r.status === 401) { $("lock").classList.add("on"); throw new Error("locked"); }
    return r.json();
  });
}

// ---------- helpers ----------
var BNAME = { grind:"GRIND Agencies", jbc:"JBC Management", powerpipeline:"PowerPipeline", personal:"Personal" };
function bucketKey(name){
  for (var k in BNAME) if (BNAME[k] === name) return k;
  return (name||"unsorted").toLowerCase().replace(/[^a-z]/g,"");
}
function todayISO(){
  var d = new Date(new Date().toLocaleString("en-US",{timeZone:"America/Los_Angeles"}));
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function niceDate(s){
  if(!s) return "";
  var d = new Date(String(s).length <= 10 ? s + "T12:00:00" : s);
  if (isNaN(d)) return String(s).slice(0,10);
  return d.toLocaleDateString("en-US",{weekday:"short", month:"short", day:"numeric"});
}
function niceTime(s){
  var d = new Date(s); if (isNaN(d)) return "";
  return d.toLocaleString("en-US",{weekday:"short", hour:"numeric", minute:"2-digit"});
}

// ---------- tabs ----------
var tabs = $("tabs").querySelectorAll("button");
function show(v){
  Array.prototype.forEach.call(tabs, function(b){ b.setAttribute("aria-selected", b.dataset.v===v ? "true":"false"); });
  ["bridge","book","plate","notes","nexus"].forEach(function(n){
    $("v-"+n).classList.toggle("on", n===v);
  });
  if (v==="book"  && !BOOK)  loadBook();
  if (v==="plate" && !PLATE) loadPlate();
  if (v==="notes" && !NOTES) loadNotes();
  if (v==="nexus") { loadHistory(); setTimeout(function(){ $("cin").focus(); }, 60); }
  try { localStorage.setItem("nexus.tab", v); } catch(e){}
}
Array.prototype.forEach.call(tabs, function(b){ b.addEventListener("click", function(){ show(b.dataset.v); }); });

// ---------- bridge ----------
function greeting(){
  var h = new Date(new Date().toLocaleString("en-US",{timeZone:"America/Los_Angeles"})).getHours();
  if (h < 5)  return "Still up.";
  if (h < 12) return "Good morning.";
  if (h < 17) return "Afternoon.";
  if (h < 22) return "Evening.";
  return "Late one.";
}

function loadHome(){
  return api("home").then(function(h){
    HOME = h; renderBridge();
    $("stamp").textContent = niceTime(h.now) || "live";
  }).catch(function(e){ if (e.message !== "locked") toast("Could not reach Nexus."); });
}

function readout(h){
  var due = (h.due_today||[]).length, late = 0, t = todayISO();
  (h.due_today||[]).forEach(function(x){ if (x.deadline && x.deadline < t) late++; });
  var soon = (h.meetings_soon||[]).length;
  var bits = [];
  if (due) bits.push(due + (due===1?" thing":" things") + " due" + (late? ", " + late + " already late" : ""));
  if (soon) bits.push(soon + (soon===1?" meeting":" meetings") + " inside three days");
  var owed = (h.meetings_soon||[]).reduce(function(n,m){ return n + (m.i_owe||0); }, 0);
  if (owed) bits.push("you owe them " + owed);
  if (!bits.length) return "Nothing is due and nobody is waiting. Rare. Use it.";
  return bits.join(" · ") + ".";
}

function taskRow(t){
  var late = t.deadline && t.deadline < todayISO();
  return '<div class="row" data-id="' + esc(t.id) + '">' +
    '<button class="tick" aria-label="Complete"><svg viewBox="0 0 24 24"><path d="M4 12l6 6L20 6"/></svg></button>' +
    '<div class="rbody"><div class="rtext">' + esc(t.objective) + '</div><div class="rmeta">' +
      (t.entity ? '<span class="tag ' + esc(t.entity) + '">' + esc(BNAME[t.entity]||t.entity) + '</span>' : '') +
      (t.deadline ? '<span class="tag' + (late?' late':'') + '">' + (late?'was ':'') + niceDate(t.deadline) + '</span>' : '') +
      (t.next_action ? '<span class="asof">' + esc(t.next_action) + '</span>' : '') +
    '</div></div></div>';
}

function renderBridge(){
  var h = HOME; if (!h) return;
  $("greet").textContent = greeting();
  $("readout").textContent = readout(h);

  var out = "";
  var t = todayISO();
  var lateN = (h.due_today||[]).filter(function(x){ return x.deadline && x.deadline < t; }).length;

  // scoreboard
  out += '<div class="panel"><div class="stats">' +
    '<div class="stat' + (lateN?' bad':'') + '"><b>' + lateN + '</b><span class="lab">Late</span></div>' +
    '<div class="stat"><b>' + (h.due_today||[]).length + '</b><span class="lab">Due</span></div>' +
    '<div class="stat"><b>' + (h.week||0) + '</b><span class="lab">This week</span></div>' +
    '<div class="stat good"><b>' + (h.done_today||0) + '</b><span class="lab">Closed today</span></div>' +
    '</div></div>';

  // needle
  var needle = h.needle;
  if (needle && needle.length) {
    out += '<div class="panel"><header><h2>Today’s needle</h2></header><div class="rows">';
    (Array.isArray(needle)?needle:[]).forEach(function(n){
      out += '<div class="row"><div class="rbody"><div class="rtext">' + esc(typeof n === "string" ? n : (n.text||JSON.stringify(n))) + '</div></div></div>';
    });
    out += '</div></div>';
  }

  // coming up
  if ((h.meetings_soon||[]).length) {
    out += '<div class="panel"><header><h2>Coming up</h2></header><div class="rows">';
    h.meetings_soon.forEach(function(m){
      out += '<div class="row"><div class="rbody"><div class="rtext">' + esc(m.name) + '</div><div class="rmeta">' +
        '<span class="tag ' + bucketKey(m.bucket) + '">' + esc(m.bucket) + '</span>' +
        '<span class="tag">' + esc(niceTime(m.when)) + '</span>' +
        (m.i_owe ? '<span class="tag late">you owe ' + m.i_owe + '</span>' : '') +
        (m.they_owe ? '<span class="asof">waiting on them: ' + m.they_owe + '</span>' : '') +
      '</div></div></div>';
    });
    out += '</div></div>';
  }

  // on the plate
  out += '<div class="panel"><header><h2>On the plate</h2><span class="right lab">' +
    (h.due_today||[]).length + '</span></header>';
  if ((h.due_today||[]).length) {
    out += '<div class="rows" data-tasks>' + h.due_today.slice(0,12).map(taskRow).join("") + '</div>';
    if (h.due_today.length > 12) out += '<div class="empty">and ' + (h.due_today.length-12) + ' more on the Plate tab</div>';
  } else out += '<div class="empty">Nothing due. Nothing overdue.</div>';
  out += '</div>';

  // buckets
  out += '<div class="panel"><header><h2>The four buckets</h2></header><div class="pad"><div class="bgrid">';
  (h.buckets||[]).forEach(function(b){
    var k = b.entity;
    out += '<button class="btile ' + esc(k) + '" data-bucket="' + esc(k) + '"><h3>' + esc(b.bucket) + '</h3>' +
      '<div class="bnums">' +
        '<span><b>' + b.open_tasks + '</b><span class="lab">Open</span></span>' +
        '<span><b class="' + (b.overdue?'late':'') + '">' + b.overdue + '</b><span class="lab">Late</span></span>' +
        '<span><b>' + b.due_this_week + '</b><span class="lab">7 days</span></span>' +
      '</div></button>';
  });
  out += '</div></div></div>';

  // who needs follow-up
  if ((h.follow_up||[]).length) {
    out += '<div class="panel"><header><h2>Going cold</h2></header><div class="rows">';
    h.follow_up.forEach(function(p){
      out += '<div class="row"><div class="rbody"><div class="rtext">' + esc(p.name) + '</div><div class="rmeta">' +
        '<span class="tag ' + bucketKey(p.bucket) + '">' + esc(p.bucket) + '</span>' +
        '<span class="tag' + (p.flag==="promise overdue"?' late':'') + '">' + esc(p.flag) + '</span>' +
        (p.days_silent!=null ? '<span class="asof">' + p.days_silent + 'd silent</span>' : '') +
      '</div></div></div>';
    });
    out += '</div></div>';
  }

  // life
  var lifeOpen = h.life_open||[], lifeFacts = h.life||[];
  out += '<div class="panel"><header><h2>Life</h2></header>';
  if (lifeOpen.length) out += '<div class="rows" data-tasks>' + lifeOpen.map(taskRow).join("") + '</div>';
  if (lifeFacts.length) {
    out += '<div class="pad">' + lifeFacts.map(function(f){
      return '<div class="pfield" style="margin-bottom:8px"><span>' + esc(f.topic) + '</span><p>' + esc(f.fact) + '</p></div>';
    }).join("") + '</div>';
  }
  if (!lifeOpen.length && !lifeFacts.length)
    out += '<div class="empty">Nothing here yet. Tell Nexus about your life and she will start holding it.</div>';
  out += '</div>';

  // metrics
  var mets = (h.metrics||[]).filter(function(m){ return m.value != null; });
  if (mets.length) {
    out += '<div class="panel"><header><h2>Live numbers</h2></header>';
    mets.forEach(function(m){
      var tr = "flat", ch = "→";
      if (m.prev != null && m.value != null) {
        if (+m.value > +m.prev) { tr = m.direction === "down" ? "down":"up"; ch = "▲"; }
        else if (+m.value < +m.prev) { tr = m.direction === "down" ? "up":"down"; ch = "▼"; }
      }
      out += '<div class="mrow"><span class="trend ' + tr + '">' + ch + '</span>' +
        '<span class="mname">' + esc(m.label) + '</span>' +
        '<span class="mval">' + esc(m.value) + (m.unit==="pct"?"%":"") + '</span>' +
        '<span class="asof">' + (m.as_of ? String(m.as_of).slice(0,10) : "") + '</span></div>';
    });
    out += '</div>';
  }

  // unread texts
  if ((h.threads||[]).length) {
    out += '<div class="panel"><header><h2>Texts she has not read</h2></header><div class="rows">';
    h.threads.forEach(function(x){
      out += '<div class="row"><div class="rbody"><div class="rtext">' + esc(x.who) + '</div><div class="rmeta">' +
        '<span class="tag">' + x.unread + ' unread</span>' +
        (x.last_from_me ? '<span class="asof">you spoke last</span>' : '<span class="tag late">they spoke last</span>') +
      '</div></div></div>';
    });
    out += '</div></div>';
  }

  // book + what she did
  var bk = h.book || {};
  out += '<div class="panel"><header><h2>The Black Book</h2></header><div class="stats">' +
    '<div class="stat"><b>' + (bk.people||0) + '</b><span class="lab">People</span></div>' +
    '<div class="stat"><b>' + (bk.capabilities||0) + '</b><span class="lab">Can do</span></div>' +
    '<div class="stat warn"><b>' + (bk.stubs||0) + '</b><span class="lab">Thin cards</span></div>' +
    '<div class="stat warn"><b>' + (bk.needs_eye||0) + '</b><span class="lab">Needs your eye</span></div>' +
    '</div></div>';

  if ((h.log||[]).length) {
    out += '<div class="panel"><header><h2>What Nexus did</h2></header><div class="rows">';
    h.log.forEach(function(a){
      out += '<div class="row"><div class="rbody"><div class="rtext" style="font-size:14px">' + esc(a.action) + '</div>' +
        '<div class="rmeta"><span class="asof">' + esc(niceTime(a.ts)) + '</span></div></div></div>';
    });
    out += '</div></div>';
  }

  $("bridge").innerHTML = out;
}

// complete a task from any list
document.addEventListener("click", function(e){
  var tick = e.target.closest && e.target.closest(".tick");
  if (!tick) return;
  var row = tick.closest(".row"), id = row && row.dataset.id;
  if (!id) return;
  var undo = row.classList.contains("done");
  row.classList.toggle("done");
  api("task", { id:id, action: undo ? "reopen" : "done" }).then(function(r){
    if (r && r.error) { row.classList.toggle("done"); toast("Did not save: " + r.error); return; }
    toast(undo ? "Reopened." : "Closed — clears from Reminders at the next sync.");
    if (!undo) setTimeout(function(){ row.style.display = "none"; }, 900);
    loadHome();
  }).catch(function(){ row.classList.toggle("done"); });
});

// bucket tile jumps to a filtered plate
document.addEventListener("click", function(e){
  var t = e.target.closest && e.target.closest(".btile");
  if (!t) return;
  plateFilter = t.dataset.bucket; show("plate");
  if (!PLATE) loadPlate(); else renderPlate();
});

// ---------- book ----------
function loadBook(){
  $("bookout").innerHTML = '<div class="empty">Opening the book…</div>';
  return api("book").then(function(d){
    BOOK = d;
    var seen = [];
    d.people.forEach(function(p){ if (seen.indexOf(p.bucket)<0) seen.push(p.bucket); });
    $("bfilters").innerHTML = ['<button class="fchip" data-b="all" aria-pressed="true">All ' + d.people.length + '</button>']
      .concat(seen.map(function(b){
        var n = d.people.filter(function(p){ return p.bucket===b; }).length;
        return '<button class="fchip" data-b="' + esc(b) + '" aria-pressed="false">' + esc(b) + " " + n + '</button>';
      })).join("");
    d.people.forEach(function(p){
      p._hay = [p.name,p.kind,p.bucket,p.company,p.role,p.city,p.industry,p.headline,p.superpower,
                p.controls,p.value_to_me,p.value_to_them,p.the_ask,p.interests,
                (p.offers_full||[]).join(" "), (p.needs_full||[]).join(" ")]
               .filter(Boolean).join(" ").toLowerCase();
      p._lev = (p.relationship_strength||0)*2 + (p.offers_full||[]).length;
    });
    renderBook();
  });
}
$("bfilters").addEventListener("click", function(e){
  var b = e.target.closest(".fchip"); if (!b) return;
  bucketFilter = b.dataset.b; renderBook();
});
$("bq").addEventListener("input", function(){ bq = $("bq").value.trim().toLowerCase(); renderBook(); });

function personCard(p){
  var meta = [p.company, p.role, p.city].filter(Boolean).join("  ·  ");
  return '<article class="pcard"><div class="ptop">' +
    '<div class="pkind"><span class="lab" style="color:var(--brass)">' + esc(p.kind) + '</span>' +
    '<span class="lab">' + esc(p.bucket) + '</span></div>' +
    '<h3 class="pname">' + esc(p.name) + '</h3>' +
    (meta ? '<div class="lab" style="margin-top:4px;letter-spacing:.04em;text-transform:none;font-size:12.5px">' + esc(meta) + '</div>' : '') +
    '</div><div class="pbody">' +
    (p.headline ? '<p style="margin:0;font-size:15px">' + esc(p.headline) + '</p>' : '') +
    (p.value_to_me ? '<div class="pfield"><span>Value to you</span><p>' + esc(p.value_to_me) + '</p></div>' : '') +
    (p.controls ? '<div class="pfield"><span>Controls</span><p>' + esc(p.controls) + '</p></div>' : '') +
    ((p.offers_full||[]).length ? '<div class="chips">' + p.offers_full.slice(0,8).map(function(l){
        return '<span class="chip">' + esc(l) + '</span>'; }).join("") + '</div>' : '') +
    '<div class="rmeta"><span class="asof">strength ' + (p.relationship_strength||"?") + '/5 · trust ' +
      (p.trust||"?") + '/5 · ' + (p.days_silent!=null?p.days_silent+'d silent':'no contact logged') +
      ' · you owe ' + (p.i_owe||0) + '</span></div>' +
    '</div>' +
    (p.the_ask ? '<div class="ask"><span>The ask</span><p>' + esc(p.the_ask) + '</p></div>' : '') +
    '</article>';
}
function renderBook(){
  if (!BOOK) return;
  Array.prototype.forEach.call($("bfilters").querySelectorAll(".fchip"), function(c){
    c.setAttribute("aria-pressed", c.dataset.b===bucketFilter ? "true":"false"); });
  var rows = BOOK.people.filter(function(p){
    if (bucketFilter!=="all" && p.bucket!==bucketFilter) return false;
    if (bq && p._hay.indexOf(bq)<0) return false;
    return true;
  }).sort(function(a,b){ return b._lev-a._lev || a.name.localeCompare(b.name); });
  $("bookout").innerHTML = rows.length
    ? '<div class="lab" style="padding:2px 0 10px">' + rows.length + ' people</div>' + rows.map(personCard).join("")
    : '<div class="empty">Nobody on file fits that. Ask Nexus — she may know someone you have not told her about.</div>';
}

// ---------- plate ----------
function loadPlate(){
  $("plateout").innerHTML = '<div class="empty">Pulling your plate…</div>';
  return api("plate").then(function(d){ PLATE = d; renderPlate(); });
}
function renderPlate(){
  if (!PLATE) return;
  var ks = ["all","grind","jbc","powerpipeline","personal"];
  $("pfilters").innerHTML = ks.map(function(k){
    var n = k==="all" ? PLATE.open.length : PLATE.open.filter(function(t){ return t.entity===k; }).length;
    return '<button class="fchip" data-p="' + k + '" aria-pressed="' + (k===plateFilter) + '">' +
      (k==="all"?"All":BNAME[k]) + " " + n + '</button>';
  }).join("");
  var t = todayISO();
  var rows = PLATE.open.filter(function(x){ return plateFilter==="all" || x.entity===plateFilter; });
  var late = rows.filter(function(x){ return x.deadline && x.deadline < t; });
  var today = rows.filter(function(x){ return x.deadline === t; });
  var soon = rows.filter(function(x){ return x.deadline && x.deadline > t; });
  var undated = rows.filter(function(x){ return !x.deadline; });
  var confirm = rows.filter(function(x){ return x.status === "deferred"; });
  function block(title, list, cls){
    if (!list.length) return "";
    return '<div class="panel"><header><h2>' + title + '</h2><span class="right lab">' + list.length +
      '</span></header><div class="rows">' + list.slice(0,80).map(taskRow).join("") + '</div></div>';
  }
  $("plateout").innerHTML =
    block("Overdue", late.filter(function(x){return x.status!=="deferred";})) +
    block("Today", today.filter(function(x){return x.status!=="deferred";})) +
    block("Ahead", soon.filter(function(x){return x.status!=="deferred";})) +
    block("No date", undated.filter(function(x){return x.status!=="deferred";})) +
    block("Waiting on your confirm — done, or still owed?", confirm) +
    (rows.length ? "" : '<div class="empty">Clear.</div>');
}
$("pfilters").addEventListener("click", function(e){
  var b = e.target.closest(".fchip"); if (!b) return;
  plateFilter = b.dataset.p; renderPlate();
});

// ---------- notes ----------
var editing = null;
function loadNotes(){
  return api("notes", { q: nq }).then(function(d){ NOTES = d.notes||[]; renderNotes(); });
}
function renderNotes(){
  var out = '<button class="fchip" id="newnote" style="margin:0 0 12px">+ New note</button>';
  out += (NOTES||[]).map(function(n){
    return '<div class="note" data-id="' + esc(n.id) + '">' +
      '<h3>' + esc(n.title || "Untitled") + '</h3>' +
      '<p>' + esc((n.body||"").slice(0,220)) + '</p>' +
      '<div class="rmeta" style="margin-top:7px">' +
        (n.entity ? '<span class="tag ' + esc(n.entity) + '">' + esc(BNAME[n.entity]||n.entity) + '</span>' : '') +
        '<span class="asof">' + esc(niceTime(n.updated_at)) + '</span></div></div>';
  }).join("");
  $("notesout").innerHTML = out || '<div class="empty">No notes yet.</div>';
}
$("nq").addEventListener("input", function(){ nq = $("nq").value.trim(); clearTimeout(window._nt);
  window._nt = setTimeout(loadNotes, 250); });
$("notesout").addEventListener("click", function(e){
  if (e.target.id === "newnote") { openNote({ id:null, title:"", body:"" }); return; }
  var n = e.target.closest(".note"); if (!n) return;
  var found = (NOTES||[]).filter(function(x){ return x.id === n.dataset.id; })[0];
  if (found) openNote(found);
});
function openNote(n){
  editing = n;
  $("ntitle").value = n.title || "";
  $("nbody").value = n.body || "";
  $("noteedit").classList.add("on");
  setTimeout(function(){ (n.id ? $("nbody") : $("ntitle")).focus(); }, 60);
}
$("nback").addEventListener("click", function(){ $("noteedit").classList.remove("on"); });
$("nsave").addEventListener("click", function(){
  var body = { title: $("ntitle").value, body: $("nbody").value };
  if (editing && editing.id) body.id = editing.id;
  api("note", body).then(function(){ $("noteedit").classList.remove("on"); toast("Saved."); loadNotes(); loadHome(); });
});

// ---------- chat ----------
var chatLoaded = false;
function bubble(role, text){
  var d = document.createElement("div");
  d.className = "msg " + (role === "user" ? "me" : "her");
  d.textContent = text;
  $("msgs").appendChild(d);
  $("msgs").scrollTop = $("msgs").scrollHeight;
  return d;
}
function loadHistory(){
  if (chatLoaded) return;
  chatLoaded = true;
  api("history").then(function(d){
    $("msgs").innerHTML = "";
    var ms = (d.messages||[]).filter(function(m){ return m.content && m.content.trim(); });
    if (!ms.length) bubble("assistant", "I'm here. Ask me what's due, who you owe, who you know that can do something — or just tell me what happened today and I'll file it.");
    else ms.forEach(function(m){ bubble(m.role, m.content); });
  });
}
function send(text){
  if (!text.trim()) return;
  show("nexus"); loadHistory();
  bubble("user", text);
  var th = document.createElement("div");
  th.className = "thinking"; th.innerHTML = "<i>Nexus is thinking…</i>";
  $("msgs").appendChild(th); $("msgs").scrollTop = $("msgs").scrollHeight;
  api("chat", { text: text }).then(function(r){
    th.remove(); bubble("assistant", r.reply || "No reply.");
    loadHome(); PLATE = null; BOOK = null;
  }).catch(function(){ th.remove(); bubble("assistant", "I could not reach the brain just then. Try again."); });
}
$("composer").addEventListener("submit", function(e){
  e.preventDefault();
  var v = $("cin").value; $("cin").value = ""; $("cin").style.height = "auto"; send(v);
});
$("cin").addEventListener("input", function(){
  this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 120) + "px";
});
$("cin").addEventListener("keydown", function(e){
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});
$("askbar").addEventListener("submit", function(e){
  e.preventDefault(); var v = $("ask").value; $("ask").value = ""; send(v);
});

// ---------- lock ----------
$("lockgo").addEventListener("click", function(){
  KEY = $("lockkey").value.trim();
  try { localStorage.setItem("nexus.k", KEY); } catch(e){}
  $("lock").classList.remove("on");
  boot();
});
$("lockkey").addEventListener("keydown", function(e){ if (e.key === "Enter") $("lockgo").click(); });

// ---------- boot ----------
$("refresh").addEventListener("click", function(){
  BOOK = null; PLATE = null; NOTES = null; chatLoaded = false;
  loadHome().then(function(){ toast("Refreshed."); });
});
function boot(){
  if (!KEY) { $("lock").classList.add("on"); return; }
  loadHome();
  var last = null;
  try { last = localStorage.getItem("nexus.tab"); } catch(e){}
  if (last && last !== "bridge") show(last);
}
document.addEventListener("visibilitychange", function(){ if (!document.hidden && KEY) loadHome(); });
setInterval(function(){ if (!document.hidden && KEY && $("v-bridge").classList.contains("on")) loadHome(); }, 90000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(BASE + "?sw=1").catch(function(){});
}
boot();
})();
</script>
</body>
</html>`;
