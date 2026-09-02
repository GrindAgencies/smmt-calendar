/* ==========================================================================
   THEME BOOTSTRAP  (2026-09-01)
   --------------------------------------------------------------------------
   Six pages never read the saved theme, so choosing dark on Home and opening
   My Tracker or Resources flipped you back to white. Applied here, before
   anything renders, so every screen honours the same choice.
   ========================================================================== */
(function () {
  try {
    var t = localStorage.getItem('gfi_theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) {}
})();

/* ============================================================
   The Standard — Notification bell (shared across all pages)
   Emulates the Agency Pulse notification center.
   Reads the logged-in user from tsfg_name / tsfg_code,
   polls notify-api, and shows a bell + unread badge + dropdown
   in the top-right of whatever top bar the page uses.
   ============================================================ */
(function () {
  var API = 'https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/notify-api';
  var NAME = '', CODE = '';
  try { NAME = localStorage.getItem('tsfg_name') || ''; CODE = localStorage.getItem('tsfg_code') || ''; } catch (e) {}
  if (!NAME && !CODE) return; // not logged in — no bell

  var POLL_MS = 60000;
  var items = [], unread = 0, open = false, timer = null;

  function isDark() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor;
      var m = bg && bg.match(/\d+/g);
      if (!m) return true;
      var lum = 0.299 * (+m[0]) + 0.587 * (+m[1]) + 0.114 * (+m[2]);
      return lum < 128;
    } catch (e) { return true; }
  }
  function esc(s){return (s==null?'':String(s)).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function ago(iso){
    var t = new Date(iso).getTime(); if(!t) return '';
    var s = Math.max(0,(Date.now()-t)/1000);
    if (s<60) return 'just now';
    if (s<3600) return Math.floor(s/60)+'m ago';
    if (s<86400) return Math.floor(s/3600)+'h ago';
    if (s<604800) return Math.floor(s/86400)+'d ago';
    return new Date(iso).toLocaleDateString();
  }
  var ICON = { mention:'💬', sale:'✅', recruit:'🎉', training:'📅' };

  function post(action, extra){
    var body = Object.assign({ action:action, name:NAME, code:CODE }, extra||{});
    return fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json();}).catch(function(){return {};});
  }

  function injectStyles(){
    if (document.getElementById('ntf-css')) return;
    var dark = isDark();
    var panelBg = dark ? '#1c1c22' : '#ffffff';
    var panelLine = dark ? 'rgba(255,255,255,.09)' : '#ececf0';
    var ink = dark ? '#f2f2f5' : '#1d1d1f';
    var muted = dark ? '#9a9aa2' : '#6e6e73';
    var rowUnread = dark ? 'rgba(91,108,255,.14)' : 'rgba(91,108,255,.07)';
    var hover = dark ? 'rgba(255,255,255,.05)' : '#f5f5f7';
    var css = ''
      + '.ntf-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:11px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;flex:0 0 auto;transition:.15s;-webkit-appearance:none;}'
      + '.ntf-btn:hover{background:'+hover+';}'
      + '.ntf-btn svg{width:20px;height:20px;}'
      + '.ntf-dot{position:absolute;top:5px;right:5px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#ff3b30;color:#fff;font:700 10px/17px Inter,-apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px '+(dark?'#1c1c22':'#fff')+';}'
      + '.ntf-panel{position:fixed;z-index:99999;width:360px;max-width:calc(100vw - 24px);max-height:70vh;overflow:hidden;display:flex;flex-direction:column;background:'+panelBg+';color:'+ink+';border:1px solid '+panelLine+';border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.28);opacity:0;transform:translateY(-6px);pointer-events:none;transition:opacity .16s,transform .16s;font-family:Inter,-apple-system,system-ui,sans-serif;}'
      + '.ntf-panel.on{opacity:1;transform:none;pointer-events:auto;}'
      + '.ntf-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid '+panelLine+';}'
      + '.ntf-head b{font-size:15px;font-weight:800;letter-spacing:-.01em;}'
      + '.ntf-mark{background:none;border:none;color:#5b6cff;font:600 12.5px Inter,system-ui,sans-serif;cursor:pointer;padding:4px 6px;border-radius:8px;}'
      + '.ntf-mark:hover{background:'+hover+';}'
      + '.ntf-list{overflow-y:auto;}'
      + '.ntf-item{display:flex;gap:11px;align-items:flex-start;padding:12px 16px;border-bottom:1px solid '+panelLine+';cursor:pointer;transition:.12s;}'
      + '.ntf-item:hover{background:'+hover+';}'
      + '.ntf-item.unread{background:'+rowUnread+';}'
      + '.ntf-ic{font-size:17px;line-height:1.2;flex:0 0 auto;}'
      + '.ntf-tx{min-width:0;flex:1;}'
      + '.ntf-tt{font-size:13.5px;font-weight:700;letter-spacing:-.01em;}'
      + '.ntf-bd{font-size:12.5px;color:'+muted+';margin-top:2px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}'
      + '.ntf-tm{font-size:11px;color:'+muted+';margin-top:3px;}'
      + '.ntf-udot{width:8px;height:8px;border-radius:50%;background:#5b6cff;flex:0 0 auto;margin-top:5px;}'
      + '.ntf-empty{padding:34px 16px;text-align:center;color:'+muted+';font-size:13px;}'
      + '.ntf-scrim{position:fixed;inset:0;z-index:99998;background:transparent;display:none;}'
      + '.ntf-scrim.on{display:block;}';
    var st = document.createElement('style'); st.id='ntf-css'; st.textContent=css; document.head.appendChild(st);
  }

  var btn, panel, scrim, listEl, dotEl;

  function build(){
    injectStyles();
    btn = document.createElement('button');
    btn.className='ntf-btn'; btn.type='button'; btn.setAttribute('aria-label','Notifications');
    btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
    dotEl = document.createElement('span'); dotEl.className='ntf-dot'; dotEl.style.display='none'; btn.appendChild(dotEl);

    scrim = document.createElement('div'); scrim.className='ntf-scrim';
    panel = document.createElement('div'); panel.className='ntf-panel';
    panel.innerHTML = '<div class="ntf-head"><b>Notifications</b><button class="ntf-mark" type="button">Mark all read</button></div><div class="ntf-list"></div>';
    listEl = panel.querySelector('.ntf-list');
    document.body.appendChild(scrim); document.body.appendChild(panel);

    btn.addEventListener('click', function(e){ e.stopPropagation(); toggle(); });
    scrim.addEventListener('click', function(){ toggle(false); });
    panel.querySelector('.ntf-mark').addEventListener('click', markAll);
    window.addEventListener('resize', function(){ if(open) place(); });

    // place the bell into the page top bar (or fixed fallback)
    var bar = document.querySelector('.tsfg-top, .top, .topbar, .ftop');
    if (bar) { btn.style.marginLeft='auto'; bar.appendChild(btn); }
    else { btn.style.position='fixed'; btn.style.top='11px'; btn.style.right='16px'; btn.style.zIndex='99997'; document.body.appendChild(btn); }
  }

  function place(){
    var r = btn.getBoundingClientRect();
    var w = Math.min(360, window.innerWidth-24);
    var right = Math.max(12, window.innerWidth - r.right);
    panel.style.right = right + 'px';
    panel.style.left = 'auto';
    panel.style.top = (r.bottom + 8) + 'px';
    panel.style.width = w + 'px';
  }
  function toggle(force){
    open = (force===undefined) ? !open : force;
    if (open){ place(); panel.classList.add('on'); scrim.classList.add('on'); refresh(); }
    else { panel.classList.remove('on'); scrim.classList.remove('on'); }
  }

  function render(){
    dotEl.textContent = unread>99?'99+':String(unread);
    dotEl.style.display = unread>0 ? 'block' : 'none';
    if (!items.length){ listEl.innerHTML='<div class="ntf-empty">You’re all caught up.</div>'; return; }
    listEl.innerHTML = items.map(function(n){
      var un = !n.read_at;
      return '<div class="ntf-item'+(un?' unread':'')+'" data-id="'+n.id+'" data-link="'+esc(n.link||'')+'">'
        + '<span class="ntf-ic">'+(ICON[n.type]||'🔔')+'</span>'
        + '<div class="ntf-tx"><div class="ntf-tt">'+esc(n.title)+'</div>'
        + (n.body?'<div class="ntf-bd">'+esc(n.body)+'</div>':'')
        + '<div class="ntf-tm">'+ago(n.created_at)+'</div></div>'
        + (un?'<span class="ntf-udot"></span>':'') + '</div>';
    }).join('');
    Array.prototype.forEach.call(listEl.querySelectorAll('.ntf-item'), function(el){
      el.addEventListener('click', function(){ onOpen(el.getAttribute('data-id'), el.getAttribute('data-link')); });
    });
  }

  function onOpen(id, link){
    var n = items.filter(function(x){return String(x.id)===String(id);})[0];
    if (n && !n.read_at){ n.read_at = new Date().toISOString(); unread=Math.max(0,unread-1); render(); post('read',{id:Number(id)}); }
    if (link) { location.href = link; }
  }
  function markAll(){
    items.forEach(function(n){ n.read_at = n.read_at || new Date().toISOString(); });
    unread = 0; render(); post('readall');
  }
  function refresh(){
    post('list').then(function(r){
      if (r && r.items){ items = r.items; unread = r.unread||0; render(); }
    });
  }

  function start(){
    build(); refresh();
    timer = setInterval(function(){ if(!open && !document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', function(){ if(!document.hidden) refresh(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ===== PWA install support (added 2026-07-18) =====
   One place wires "Add to Home Screen" for every page that loads notif.js.
   Injects the manifest + Apple meta tags and registers the service worker. */
(function(){
  try{
    var head=document.head||document.getElementsByTagName('head')[0]; if(!head)return;
    function meta(n,c){ if(!document.querySelector('meta[name="'+n+'"]')){var m=document.createElement('meta');m.name=n;m.content=c;head.appendChild(m);} }
    function link(rel,href){ if(!document.querySelector('link[rel="'+rel+'"]')){var l=document.createElement('link');l.rel=rel;l.href=href;head.appendChild(l);} }
    link('manifest','manifest.json');
    link('apple-touch-icon','apple-touch-icon.png');
    meta('theme-color','#0b0f1a');
    meta('apple-mobile-web-app-capable','yes');
    meta('apple-mobile-web-app-status-bar-style','black-translucent');
    meta('apple-mobile-web-app-title','The Standard');
    if('serviceWorker' in navigator){
      window.addEventListener('load',function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); });
    }
  }catch(e){}
})();

/* ===== Install prompt — "Add to Home Screen" (added 2026-07-30) =====
   A tasteful, dismissible banner that makes the PWA installable on Android
   (native beforeinstallprompt) and iOS Safari (Share → Add to Home Screen).
   Skipped inside the native app, when already installed, or if recently dismissed. */
(function(){
  try{
    var C=window.Capacitor; if(C&&C.isNativePlatform&&C.isNativePlatform())return;
    var standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true;
    if(standalone)return;
    var KEY='tsfg_install_snooze';
    try{ if(Date.now()-(+localStorage.getItem(KEY)||0) < 1000*60*60*24*14) return; }catch(e){}
    var isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
    var deferred=null;
    function snooze(el){try{localStorage.setItem(KEY,String(Date.now()));}catch(e){}if(el)el.remove();}
    function show(){
      if(document.getElementById('tsfgInstall')||!document.body)return;
      if(!document.getElementById('tsfgInstCss')){var s=document.createElement('style');s.id='tsfgInstCss';
        s.textContent='#tsfgInstall{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 12px);z-index:2147482000;display:flex;align-items:center;gap:12px;max-width:520px;margin:0 auto;background:#12151f;color:#f5f6fa;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:12px 14px;box-shadow:0 14px 36px rgba(0,0,0,.5);font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,system-ui,sans-serif;animation:tsfgUp .3s ease}@keyframes tsfgUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}#tsfgInstall img{width:40px;height:40px;border-radius:11px;flex:0 0 auto}#tsfgInstall .it{flex:1;min-width:0;line-height:1.3}#tsfgInstall .it b{font-size:14px;font-weight:800;display:block}#tsfgInstall .it span{font-size:12px;color:#aab0c0}#tsfgInstall .ib{border:none;background:#5b6cff;color:#fff;font-weight:800;font-size:13px;padding:9px 15px;border-radius:11px;cursor:pointer;white-space:nowrap}#tsfgInstall .ix{border:none;background:none;color:#8a90a0;font-size:22px;cursor:pointer;padding:0 4px;line-height:1}';
        document.head.appendChild(s);}
      var d=document.createElement('div');d.id='tsfgInstall';
      var msg=isIOS?'<b>Install The Standard</b><span>Tap <b style="display:inline">Share ⬆</b>, then “Add to Home Screen”.</span>':'<b>Install The Standard</b><span>Add the full-screen app to your home screen.</span>';
      d.innerHTML='<img src="apple-touch-icon.png" alt=""><div class="it">'+msg+'</div>'+(isIOS?'':'<button class="ib" id="tsfgInstBtn">Install</button>')+'<button class="ix" id="tsfgInstX" aria-label="Dismiss">×</button>';
      document.body.appendChild(d);
      var x=document.getElementById('tsfgInstX'); if(x)x.onclick=function(){snooze(d);};
      var b=document.getElementById('tsfgInstBtn'); if(b)b.onclick=function(){ if(!deferred)return; deferred.prompt(); (deferred.userChoice||Promise.resolve()).finally(function(){snooze(d);deferred=null;}); };
    }
    window.addEventListener('beforeinstallprompt',function(e){ e.preventDefault(); deferred=e; setTimeout(show,1400); });
    if(isIOS) setTimeout(function(){ if(!standalone) show(); },1800);
  }catch(e){}
})();

/* ===== Native app push registration (added 2026-07-24) =====
   When the site runs INSIDE the Capacitor iOS/Android app, register the device
   for push and store its token in Supabase (device_tokens). No-op in a browser.
   Actual push SENDING is phase 2 — needs the Apple .p8 push key. */
(function(){
  try{
    var C = window.Capacitor;
    if(!C || !C.isNativePlatform || !C.isNativePlatform()) return;      // browser => skip
    var Push = C.Plugins && C.Plugins.PushNotifications;
    if(!Push) return;

    var lastToken='';
    function saveToken(token){
      try{
        if(token) lastToken=token;
        if(!lastToken) return;
        var code = localStorage.getItem('tsfg_code') || '';
        var name = localStorage.getItem('tsfg_name') || '';
        fetch('https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/push-register', {
          method:'POST', headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ action:'register', token:lastToken,
                                 platform:(C.getPlatform&&C.getPlatform())||'ios',
                                 agent_code:code, agent_name:name })
        }).catch(function(){});
      }catch(e){}
    }
    // if the device registered before sign-in, re-attach the agency code once it's set
    window.__pushReattach = function(){ if(lastToken) saveToken(lastToken); };

    Push.addListener('registration', function(t){ if(t&&t.value) saveToken(t.value); });
    Push.addListener('registrationError', function(){});
    Push.checkPermissions().then(function(p){
      if(p.receive === 'granted'){ Push.register(); }
      else { Push.requestPermissions().then(function(r){ if(r.receive==='granted') Push.register(); }); }
    }).catch(function(){});
  }catch(e){}
})();

/* ==========================================================================
   UNIFIED NAVIGATION  (2026-08-29)
   --------------------------------------------------------------------------
   The app had grown three separate sidebar implementations with eleven links
   each, and every agent could see the Ops Dashboard. This rewrites whichever
   sidebar a page happens to use down to five primary destinations, hides the
   rest behind "More", and shows Operations only to Operations.

   It runs on every page because notif.js already does. Pages keep their own
   CSS — we reuse each pattern's own link class so nothing needs restyling.
   ========================================================================== */
(function () {
  var OPS_CODE = /^000[0-5]$/;           // 0000 master + 0001-0005 per-baseshop

  function code(){ try { return (localStorage.getItem('tsfg_code')||'').trim(); } catch(e){ return ''; } }
  function isOps(){ return OPS_CODE.test(code()); }

  var I = {
    home:     'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    chat:     'M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z',
    dollar:   'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    check:    'M20 6 9 17l-5-5',
    book:     'M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2zM9 3v18',
    chart:    'M3 3v18h18M7 13v4M12 8v9M17 11v6',
    calendar: 'M3 4.5h18v16H3zM3 9h18M8 3v3M16 3v3',
    pfr:      'M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2M9 12h6M9 16h6M9 8h6',
    users:    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    team:     'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    tree:     'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-2h12v2',
    more:     'M6 9l6 6 6-6'
  };

  /* The five that matter day to day. */
  var PRIMARY = [
    ['Home',         'index.html',       I.home],
    ['Team Hub',     'teamhub.html',     I.chat],
    ['Scheduler',    'calendar.html',    I.calendar],
    ['New Business', 'newbusiness.html', I.dollar],
    ['My Tracker',   'checklist.html',   I.check],
    ['Resources',    'resources.html',   I.book]
  ];

  /* Still live, still reachable — just not competing for attention. */
  var SECONDARY = [
    ['PFR Builder',    'pfr.html',       I.pfr],
    ['Marketing Plan', 'marketing.html', I.users],
    ['My Team',        'team.html',      I.team],
    ['Org Chart',      'org.html',       I.tree]
  ];

  function here(){
    var p = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    return p === '' ? 'index.html' : p;
  }

  function svg(d){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
           'stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
  }

  function link(item, cls, current){
    var on = (item[1].toLowerCase() === current) ? ' on' : '';
    /* title carries the name when the sidebar is collapsed to an icon rail. */
    return '<a class="' + cls + on + '" href="' + item[1] + '" title="' + item[0] + '">' +
           svg(item[2]) + '<span class="lbl">' + item[0] + '</span></a>';
  }

  function css(){
    if (document.getElementById('tsfg-nav-css')) return;
    var s = document.createElement('style'); s.id = 'tsfg-nav-css';
    s.textContent =
      '.tsfg-navsec{font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;' +
        'opacity:.55;padding:14px 12px 6px;}' +
      '.tsfg-more{border:0;background:none;font:inherit;color:inherit;cursor:pointer;width:100%;' +
        'display:flex;align-items:center;gap:10px;padding:14px 12px 6px;font-size:10.5px;font-weight:800;' +
        'letter-spacing:.07em;text-transform:uppercase;opacity:.55;}' +
      '.tsfg-more svg{width:14px;height:14px;transition:transform .18s ease;margin-left:auto;}' +
      '.tsfg-more[aria-expanded="true"] svg{transform:rotate(180deg);}' +
      '.tsfg-more:hover{opacity:.9;}' +
      '.tsfg-more:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:6px;}' +
      '.tsfg-morewrap[hidden]{display:none!important;}' +
      '.tsfg-lang{display:flex;gap:6px;padding:2px 10px 4px;}' +
      '.tsfg-lang button{flex:1;min-height:38px;border:1px solid var(--line-2,var(--line2,#e3e3e8));' +
        'background:transparent;color:inherit;border-radius:10px;font:800 13px/1 inherit;cursor:pointer;}' +
      /* roomier taps on phones — the old links were tight for thumbs */
      '@media(max-width:860px){.sidebar a.side-link,.tsfg-side a.side-link,aside.side a.slink{' +
        'padding-top:11px!important;padding-bottom:11px!important;}}';
    document.head.appendChild(s);
  }

  var busy = false;

  function apply(){
    if (busy) return;
    var nav = document.querySelector('.sidebar, .tsfg-side, aside.side#side');
    if (!nav) return;

    /* Reuse whatever link class this page already styles. */
    var cls = nav.querySelector('a.slink') ? 'slink'
            : (nav.querySelector('a.side-link') ? 'side-link' : 'side-link');
    if (nav.matches('aside.side#side')) cls = 'slink';

    var current = here();
    var foot = nav.querySelector('.side-foot, .tsfg-foot, .sfoot');

    busy = true;
    try {
      /* Drop the old link list and section headings; keep brand + footer. */
      nav.querySelectorAll('a.side-link, a.slink, .side-sec, .tsfg-navsec, .tsfg-more, .tsfg-morewrap')
         .forEach(function(el){ if (!foot || !foot.contains(el)) el.remove(); });

      var html = '';
      if (isOps()) {
        html += '<div class="tsfg-navsec">Operations</div>' +
                link(['Operations Dashboard','ops.html',I.chart], cls, current);
        html += '<div class="tsfg-navsec">Agency</div>';
      }
      PRIMARY.forEach(function(it){ html += link(it, cls, current); });

      var inMore = SECONDARY.some(function(it){ return it[1].toLowerCase() === current; });
      html += '<button type="button" class="tsfg-more" aria-expanded="' + (inMore ? 'true' : 'false') +
              '" aria-controls="tsfgMore"><span>More</span>' + svg(I.more) + '</button>' +
              '<div class="tsfg-morewrap" id="tsfgMore"' + (inMore ? '' : ' hidden') + '>' +
              SECONDARY.map(function(it){ return link(it, cls, current); }).join('') + '</div>';

      /* Language belongs in the menu, not floating over the page. i18n.js
         suppresses its floating pill whenever a visible [data-lang-btn] exists,
         so putting it here removes the pill from every screen at once. */
      html += '<div class="tsfg-navsec">Language</div>' +
              '<div class="tsfg-lang" data-no-i18n>' +
              '<button type="button" data-lang-btn="en" onclick="tsfgSetLang(\'en\')">English</button>' +
              '<button type="button" data-lang-btn="es" onclick="tsfgSetLang(\'es\')">Espa\u00f1ol</button>' +
              '</div>';

      var frag = document.createElement('div');
      frag.innerHTML = html;
      var nodes = Array.prototype.slice.call(frag.childNodes);
      nodes.forEach(function(n){ foot ? nav.insertBefore(n, foot) : nav.appendChild(n); });

      var btn = nav.querySelector('.tsfg-more');
      if (btn) btn.addEventListener('click', function(){
        var w = document.getElementById('tsfgMore');
        var openNow = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', openNow ? 'false' : 'true');
        if (w) w.hidden = openNow;
      });
    } finally { busy = false; }
  }

  /* Some pages build their sidebar in JS after load, so re-apply if it changes. */
  function watch(){
    var nav = document.querySelector('.sidebar, .tsfg-side, aside.side#side');
    if (!nav || !window.MutationObserver) return;
    new MutationObserver(function(){
      if (busy) return;
      if (!nav.querySelector('.tsfg-more')) apply();
    }).observe(nav, { childList: true });
  }

  /* Operations signs in and lands on Operations — once, so they can still
     browse back to the agent home without being bounced. */
  function routeOps(){
    if (!isOps()) return;
    var p = here();
    if (p !== 'index.html') return;
    try {
      if (sessionStorage.getItem('tsfg_ops_routed')) return;
      sessionStorage.setItem('tsfg_ops_routed', '1');
    } catch (e) { return; }
    location.replace('ops.html');
  }

  function start(){ css(); apply(); watch(); routeOps(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ==========================================================================
   APP FEEL  (2026-08-29)
   --------------------------------------------------------------------------
   "the blank bubble is hard to click on and confusing... make it more of an
   APP experience where everything is larger and clickable and friendly."

   - One unmistakable 3-line MENU button on every page, 44px tall (Apple's
     minimum target), placed in the page's header or floated when it has none.
   - This module OWNS the open/closed state via a single body class and its own
     scrim. The four sidebar patterns each opened differently and their rules
     did not always win; depending on them made the drawer unreliable. One
     class, one !important rule, predictable everywhere.
   - Comfortable tap targets throughout on phones. Desktop is untouched.
   ========================================================================== */
(function () {
  var PHONE = 860;
  var OPEN = 'tsfg-navopen';
  var PANEL = '.sidebar, .tsfg-side, aside.side';

  var BURGER = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" ' +
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M4 7h16M4 12h16M4 17h16"/></svg>';

  function isOpen(){ return document.body.classList.contains(OPEN); }
  function setOpen(on) {
    document.body.classList.toggle(OPEN, !!on);
    var b = document.querySelector('.tsfg-menu');
    if (b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
    /* keep each page's own class in step so its scrim/animation agree */
    var app = document.getElementById('app');
    if (app && document.querySelector('.sidebar')) app.classList.toggle('drawer', !!on);
    else if (document.querySelector('.tsfg-side')) document.body.classList.toggle('tsfg-drawer', !!on);
    else document.body.classList.toggle('drawer', !!on);
  }
  window.tsfgToggleNav = function(){ setOpen(!isOpen()); };

  function css() {
    if (document.getElementById('tsfg-app-css')) return;
    var s = document.createElement('style'); s.id = 'tsfg-app-css';
    s.textContent =
      '.tsfg-menu{display:none;align-items:center;gap:7px;height:44px;padding:0 14px 0 11px;' +
        'border-radius:12px;border:1px solid var(--line-2,var(--line2,#e3e3e8));' +
        'background:var(--panel,#fff);color:var(--ink,#111);font:800 13.5px/1 inherit;' +
        'cursor:pointer;flex:0 0 auto;-webkit-tap-highlight-color:transparent;}' +
      '.tsfg-menu:active{transform:scale(.96);}' +
      '.tsfg-menu.float{position:fixed;left:12px;z-index:1002;' +
        'top:calc(10px + env(safe-area-inset-top));box-shadow:0 4px 16px rgba(0,0,0,.18);}' +
      '#tsfgScrim{position:fixed;inset:0;background:rgba(0,0,0,.44);z-index:1000;display:none;}' +
      '@media(max-width:' + PHONE + 'px){' +
        '.tsfg-menu{display:inline-flex;}' +
        /* our button replaces the bare icon ones */
        '.tb-toggle,.menu,[onclick*="tsfgToggle"],[onclick*="toggleSidebar"]{display:none!important;}' +
        /* we own open/closed */
        '.sidebar,.tsfg-side,aside.side{width:min(86vw,300px)!important;z-index:1001!important;}' +
        'body.' + OPEN + ' .sidebar,body.' + OPEN + ' .tsfg-side,body.' + OPEN + ' aside.side{' +
          'transform:none!important;}' +
        'body.' + OPEN + ' #tsfgScrim{display:block;}' +
        'body.' + OPEN + '{overflow:hidden;}' +
        /* the floating button would sit on top of the open panel */
        'body.' + OPEN + ' .tsfg-menu.float{opacity:0;pointer-events:none;}' +
        /* app-feel: everything tappable is at least 44px */
        '.sidebar a.side-link,.tsfg-side a.side-link,aside.side a.slink{' +
          'min-height:50px;font-size:15px;border-radius:12px;}' +
        '.sidebar a.side-link svg,.tsfg-side a.side-link svg,aside.side a.slink svg{width:21px;height:21px;}' +
        '.tb-ic,.tsfg-ic,.tic{min-width:44px;min-height:44px;border-radius:12px;}' +
        '.tb-ic svg,.tsfg-ic svg,.tic svg{width:19px;height:19px;}' +
        '.tsfg-more{min-height:44px;}' +
        '.tsfg-morewrap a{min-height:48px;}' +
      '}';
    document.head.appendChild(s);
  }

  function scrim() {
    if (document.getElementById('tsfgScrim') || !document.body) return;
    var el = document.createElement('div');
    el.id = 'tsfgScrim';
    el.addEventListener('click', function(){ setOpen(false); });
    document.body.appendChild(el);
  }

  function build(allowFloat) {
    if (document.querySelector('.tsfg-menu')) return;
    if (!document.querySelector(PANEL) || !document.body) return;

    /* querySelector returns document order, not selector order, and
       offsetParent is null for position:fixed headers — so walk the
       candidates and measure the box. */
    var bar = null, cands = document.querySelectorAll('.topbar, .tsfg-top, .top, .ftop, header');
    for (var i = 0; i < cands.length; i++) {
      var r = cands[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { bar = cands[i]; break; }
    }
    if (!bar && !allowFloat) return;   // header may still be booting

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tsfg-menu' + (bar ? '' : ' float');
    b.setAttribute('aria-label', 'Menu');
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = BURGER + '<span>Menu</span>';
    b.addEventListener('click', function (e) { e.preventDefault(); setOpen(!isOpen()); });

    if (bar) bar.insertBefore(b, bar.firstChild);
    else { document.body.appendChild(b); document.body.classList.add('tsfg-floatmenu'); }
  }

  /* Pages with no sidebar (Profile, Privacy) never received the in-menu
     language control, so i18n.js kept showing its floating pill — which lands
     on whatever is beneath it, e.g. the State of residence field on Profile.
     Give those pages a compact control in their header instead. */
  function langInHeader() {
    if (document.querySelector('.tsfg-lang, [data-lang-btn]')) return;   // already has one
    if (document.querySelector(PANEL)) return;                           // has a menu; handled there
    if (typeof window.tsfgSetLang !== 'function') return;
    var bar = null, cands = document.querySelectorAll('.topbar, .tsfg-top, .top, .ftop, header');
    for (var i = 0; i < cands.length; i++) {
      var r = cands[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { bar = cands[i]; break; }
    }
    if (!bar) return;
    var wrap = document.createElement('div');
    wrap.className = 'tsfg-lang hdr';
    wrap.setAttribute('data-no-i18n', '');
    wrap.innerHTML = '<button type="button" data-lang-btn="en">EN</button>' +
                     '<button type="button" data-lang-btn="es">ES</button>';
    wrap.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { window.tsfgSetLang(b.getAttribute('data-lang-btn')); });
    });
    bar.appendChild(wrap);
  }

  function start() {
    css(); scrim(); build(false); langInHeader();
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });
    if (document.querySelector('.tsfg-menu')) return;
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      /* ~2s for a header to appear (Team Hub reveals its own after sign-in);
         after that, float — PFR genuinely has no header to attach to. */
      build(tries > 5);
      langInHeader();
      if (document.querySelector('.tsfg-menu') || tries > 20) clearInterval(t);
    }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ==========================================================================
   DATA BRAIN  (2026-08-30)
   --------------------------------------------------------------------------
   Nothing recorded that a person had actually used the platform — no login
   write, no page record — so "who is active" could not be answered and 45 of
   96 agents had no activity signal at all. Every screen open is now recorded,
   which gives the dormancy sweep something true to read and builds the usage
   history the assistant learns from.

   Fire-and-forget: tracking must never slow a page down or break one.
   ========================================================================== */
window.tsfgTrack = function (kind, detail) {
  try {
    var code = localStorage.getItem('tsfg_code') || '';
    if (!code) return;                       // signed out — nothing to attribute
    var page = (location.pathname.split('/').pop() || 'index.html');
    fetch('https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/brain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'track', code: code,
        name: localStorage.getItem('tsfg_name') || '',
        kind: kind || 'page', page: page, detail: detail || {}
      }),
      keepalive: true
    }).catch(function () {});
  } catch (e) {}
};

(function () {
  function start() {
    try {
      if (!localStorage.getItem('tsfg_code')) return;
      /* One login per browser session, a page event per screen. */
      var first = false;
      try {
        if (!sessionStorage.getItem('tsfg_session_started')) {
          sessionStorage.setItem('tsfg_session_started', '1');
          first = true;
        }
      } catch (e) {}
      window.tsfgTrack(first ? 'login' : 'page');
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ==========================================================================
   ASK  (2026-08-30)
   --------------------------------------------------------------------------
   An assistant on every screen, for every agent — not just Ops, and not only
   inside Team Hub. It knows the whole product and answers with the exact
   screen and button. Every question, answer and thumbs rating goes to the
   Data Brain so we learn what people actually get stuck on.
   ========================================================================== */
(function () {
  var API = 'https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/assist';
  var lastQ = '', lastA = '';

  function code(){ try { return localStorage.getItem('tsfg_code') || ''; } catch (e) { return ''; } }
  function page(){ return location.pathname.split('/').pop() || 'index.html'; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function css() {
    if (document.getElementById('tsfg-ask-css')) return;
    var s = document.createElement('style'); s.id = 'tsfg-ask-css';
    s.textContent =
      '#askFab{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:1200;' +
        'display:flex;align-items:center;gap:8px;height:48px;padding:0 18px 0 15px;border:none;border-radius:999px;' +
        'background:#1c2440;color:#fff;font:800 14px/1 -apple-system,system-ui,sans-serif;cursor:pointer;' +
        'box-shadow:0 6px 22px rgba(0,0,0,.28);-webkit-tap-highlight-color:transparent;}' +
      '#askFab:active{transform:scale(.96);}' +
      /* Floating controls get their own space rather than covering content. */
      'body.tsfg-hasfab{padding-bottom:78px;}' +
      'body.tsfg-floatmenu{padding-top:66px;}' +
      '.tsfg-lang.hdr{display:flex;gap:3px;padding:0;flex:0 0 auto;margin-left:6px;}' +
      '.tsfg-lang.hdr button{min-height:34px;min-width:34px;padding:0 8px;border-radius:9px;' +
        'border:1px solid var(--line-2,var(--line2,#e3e3e8));background:transparent;color:inherit;' +
        'font:800 11.5px/1 inherit;cursor:pointer;}' +
      '#askScrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1201;display:none;}' +
      '#askScrim.on{display:block;}' +
      '#askPanel{position:fixed;left:50%;transform:translateX(-50%);bottom:0;width:min(560px,100%);' +
        'z-index:1202;background:var(--panel,#fff);color:var(--ink,#111);border-radius:20px 20px 0 0;' +
        'box-shadow:0 -8px 40px rgba(0,0,0,.3);display:none;flex-direction:column;max-height:min(84vh,680px);' +
        'padding-bottom:env(safe-area-inset-bottom);}' +
      '#askPanel.on{display:flex;}' +
      '.ask-h{display:flex;align-items:center;gap:10px;padding:16px 18px 10px;}' +
      '.ask-h b{font-size:16px;letter-spacing:-.01em;white-space:nowrap;}' +
      '.ask-h .sub{font-size:12.5px;opacity:.6;font-weight:600;}' +
      '.ask-x{margin-left:auto;border:none;background:none;font-size:22px;line-height:1;cursor:pointer;' +
        'color:inherit;opacity:.5;min-width:40px;min-height:40px;}' +
      '.ask-body{flex:1;overflow-y:auto;padding:4px 18px 8px;font-size:14.5px;line-height:1.55;}' +
      '.ask-a{white-space:pre-wrap;}' +
      '.ask-a b{font-weight:800;}' +
      '.ask-hint{opacity:.6;font-size:13.5px;}' +
      '.ask-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px;}' +
      '.ask-chip{border:1px solid var(--line-2,var(--line2,#e3e3e8));background:transparent;color:inherit;' +
        'border-radius:999px;padding:8px 13px;font:600 13px/1 inherit;cursor:pointer;}' +
      '.ask-rate{display:flex;gap:8px;align-items:center;margin-top:14px;font-size:12.5px;opacity:.75;}' +
      '.ask-rate button{border:1px solid var(--line-2,var(--line2,#e3e3e8));background:transparent;' +
        'border-radius:9px;min-width:38px;min-height:34px;cursor:pointer;font-size:15px;color:inherit;}' +
      '.ask-form{display:flex;gap:8px;padding:10px 14px 14px;border-top:1px solid var(--line,#eee);}' +
      '.ask-form input{flex:1;min-width:0;height:46px;border-radius:12px;padding:0 14px;font:500 15px/1 inherit;' +
        'border:1px solid var(--line-2,var(--line2,#e3e3e8));background:var(--bg,#fafafa);color:inherit;}' +
      '.ask-form button{flex:0 0 auto;height:46px;padding:0 18px;border:none;border-radius:12px;' +
        'background:#1c2440;color:#fff;font:800 14px/1 inherit;cursor:pointer;}' +
      '@media(max-width:520px){#askFab span.lbl{display:none;}#askFab{padding:0;width:52px;height:52px;justify-content:center;}' +
        '.ask-h .sub{display:none;}}';
    document.head.appendChild(s);
  }

  function fmt(t) {
    return esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  }

  function open(on) {
    document.getElementById('askPanel').classList.toggle('on', on);
    document.getElementById('askScrim').classList.toggle('on', on);
    if (on) setTimeout(function () { var i = document.getElementById('askIn'); if (i) i.focus(); }, 60);
  }

  function rate(r) {
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'feedback', code: code(),
        name: (function(){try{return localStorage.getItem('tsfg_name')||'';}catch(e){return '';}})(),
        page: page(), rating: r, q: lastQ, a: lastA }) }).catch(function () {});
    var el = document.querySelector('.ask-rate');
    if (el) el.innerHTML = '<span>Thanks — that helps us improve this.</span>';
  }

  function send(q) {
    q = (q || '').trim();
    if (!q) return;
    lastQ = q;
    var body = document.getElementById('askBody');
    body.innerHTML = '<div class="ask-hint">Thinking…</div>';
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code(),
        name: (function(){try{return localStorage.getItem('tsfg_name')||'';}catch(e){return '';}})(),
        page: page(), q: q }) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        lastA = r.answer || '';
        body.innerHTML = '<div class="ask-a">' + fmt(lastA) + '</div>' +
          '<div class="ask-rate"><span>Was this helpful?</span>' +
          '<button type="button" data-r="up" aria-label="Helpful">👍</button>' +
          '<button type="button" data-r="down" aria-label="Not helpful">👎</button></div>';
        body.querySelectorAll('.ask-rate button').forEach(function (b) {
          b.addEventListener('click', function () { rate(b.getAttribute('data-r')); });
        });
        body.scrollTop = 0;
      })
      .catch(function () {
        body.innerHTML = '<div class="ask-hint">Couldn\'t reach the assistant. For anything urgent, Operations is on 858-433-4429.</div>';
      });
  }

  var STARTERS = ['How do I log a sale?', 'How do I book a field trainer?',
                  'Where do I set my monthly goal?', 'When is the morning huddle?'];

  function build() {
    if (document.getElementById('askFab') || !document.body) return;
    if (!code()) return;                       // signed out — nothing to ask about

    var fab = document.createElement('button');
    fab.id = 'askFab'; fab.type = 'button'; fab.setAttribute('aria-label', 'Ask a question');
    fab.innerHTML = '<span aria-hidden="true">💬</span><span class="lbl">Ask</span>';

    var scrim = document.createElement('div'); scrim.id = 'askScrim';

    var panel = document.createElement('div');
    panel.id = 'askPanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Ask');
    panel.innerHTML =
      '<div class="ask-h"><b>Ask anything</b><span class="sub">about the app or your business</span>' +
      '<button class="ask-x" type="button" aria-label="Close">×</button></div>' +
      '<div class="ask-body" id="askBody"><div class="ask-hint">Ask me how anything works — I know every screen.</div>' +
      '<div class="ask-chips">' + STARTERS.map(function (s) {
        return '<button class="ask-chip" type="button">' + esc(s) + '</button>'; }).join('') + '</div></div>' +
      '<form class="ask-form"><input id="askIn" type="text" autocomplete="off" ' +
      'placeholder="Type your question…"><button type="submit">Ask</button></form>';

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    document.body.appendChild(fab);
    document.body.classList.add('tsfg-hasfab');

    fab.addEventListener('click', function () { open(true); });
    scrim.addEventListener('click', function () { open(false); });
    panel.querySelector('.ask-x').addEventListener('click', function () { open(false); });
    panel.querySelector('.ask-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var i = document.getElementById('askIn');
      send(i.value); i.value = '';
    });
    panel.querySelectorAll('.ask-chip').forEach(function (b) {
      b.addEventListener('click', function () { send(b.textContent); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('on')) open(false);
    });
  }

  function start() { css(); build(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ==========================================================================
   FIRST-RUN TOUR  (2026-08-30)
   --------------------------------------------------------------------------
   A new agent's first screen is all zeros with nothing explaining what the app
   is for. This walks them through it once, anchored to the real controls.

   Two things the first version got wrong, both fixed here:

   1. Nothing blocked the page underneath. The dimming was only a box-shadow on
      a pointer-events:none element, so a tap "outside" hit whatever was under
      it — opening the menu or navigating away while the tour was still up. A
      real veil now swallows every interaction except the card's own buttons.

   2. The spotlight was positioned once per step. Any scroll, reflow or late-
      loading dashboard content left it framing empty space. It now tracks its
      target every frame while the tour is open, so it stays locked on.
   ========================================================================== */
(function () {
  var KEY = 'tsfg_tour_done';
  var i = 0, steps = [], veil = null, box = null, tip = null, raf = 0, target = null;

  function code(){ try { return localStorage.getItem('tsfg_code') || ''; } catch (e) { return ''; } }
  function firstName(){
    try { return (localStorage.getItem('tsfg_name') || '').trim().split(/\s+/)[0] || ''; } catch (e) { return ''; }
  }
  function done(){ try { return localStorage.getItem(KEY) === code(); } catch (e) { return true; } }
  function markDone(){ try { localStorage.setItem(KEY, code()); } catch (e) {} }

  function find(sel, text) {
    if (sel) { var el = document.querySelector(sel); if (el && el.getBoundingClientRect().width > 0) return el; }
    if (text) {
      var all = document.querySelectorAll('h2,h3,.sec-h,.lb-title');
      for (var j = 0; j < all.length; j++) {
        if (all[j].textContent && all[j].textContent.toLowerCase().indexOf(text) >= 0) return all[j];
      }
    }
    return null;
  }

  function STEPS() {
    var n = firstName();
    return [
      { title: (n ? ('Welcome, ' + n + '.') : 'Welcome.'),
        body: "This is The Standard — everything you need to build your business in one place. Ninety seconds and I'll show you around." },
      { sel: '.tsfg-menu', title: 'Everything lives behind Menu',
        body: 'Team Hub, Scheduler, New Business, My Tracker and Resources. Tap Menu any time to move around.' },
      { sel: '.snap', text: "today's snapshot", title: 'Your month, at a glance',
        body: "Four numbers that matter: new partners, premium submitted, field trainings and families helped. Tap the pencil on any card to set your own goal." },
      { sel: '.ctx', title: 'Personal, or the whole team',
        body: 'Switch between your own numbers, your team, your baseshop and the full hierarchy.' },
      { text: 'leaderboard', title: 'Where you stand',
        body: 'The leaderboard updates live as business is written. It is the fastest way to see who is moving.' },
      { sel: '#askFab', title: 'Stuck? Just ask.',
        body: "I'm here on every screen. Ask me anything — how to log a sale, when the huddle is, where a setting lives. I'll point you straight to it." },
      { title: 'Your first three steps',
        body: "1. Say hello in Team Hub.\n2. Book a field training on the Scheduler.\n3. Add your warm market to the Marketing Plan.\n\nDo those and you're properly started." }
    ];
  }

  function css() {
    if (document.getElementById('tsfg-tour-css')) return;
    var s = document.createElement('style'); s.id = 'tsfg-tour-css';
    s.textContent =
      /* The veil is what actually blocks the app. It is transparent; the dimming
         comes from the spotlight's outer shadow so the cut-out still reads. */
      '#tourVeil{position:fixed;inset:0;z-index:1999;background:transparent;' +
        '-webkit-tap-highlight-color:transparent;touch-action:none;}' +
      '#tourBox{position:fixed;z-index:2000;border-radius:14px;pointer-events:none;' +
        'box-shadow:0 0 0 4px rgba(91,108,255,.95),0 0 0 9999px rgba(8,10,20,.66);}' +
      '#tourBox.flat{box-shadow:0 0 0 9999px rgba(8,10,20,.66);}' +
      '#tourTip{position:fixed;z-index:2001;width:min(430px,calc(100vw - 24px));' +
        'max-height:min(70vh,520px);overflow-y:auto;-webkit-overflow-scrolling:touch;' +
        'background:var(--panel,#fff);color:var(--ink,#111);border-radius:18px;padding:17px 17px 13px;' +
        'box-shadow:0 18px 50px rgba(0,0,0,.36);font:400 14.5px/1.55 -apple-system,system-ui,sans-serif;}' +
      '#tourTip h4{margin:0 0 6px;font-size:17px;font-weight:800;letter-spacing:-.01em;}' +
      '#tourTip p{margin:0;white-space:pre-line;color:var(--ink-2,#555);}' +
      '.tour-f{display:flex;align-items:center;gap:10px;margin-top:15px;}' +
      '.tour-dots{display:flex;gap:5px;flex:1;min-width:0;}' +
      '.tour-dots i{width:6px;height:6px;border-radius:50%;background:var(--line-2,#ddd);flex:0 0 auto;}' +
      '.tour-dots i.on{background:#5b6cff;}' +
      '.tour-b{border:none;border-radius:11px;padding:0 16px;height:42px;font:800 14px/1 inherit;' +
        'cursor:pointer;flex:0 0 auto;}' +
      '.tour-b.next{background:#1c2440;color:#fff;}' +
      '.tour-b.skip{background:transparent;color:var(--ink-2,#666);padding:0 10px;}';
    document.head.appendChild(s);
  }

  /* Runs every frame while the tour is open, so the spotlight stays locked to
     its target through smooth scrolling, reflow and late-loading content. */
  function place() {
    if (!tip) return;
    var vw = window.innerWidth, vh = window.innerHeight, pad = 6, gap = 12, edge = 12;

    if (!target || !target.getClientRects().length) {
      box.className = 'flat';
      box.style.top = '-9999px'; box.style.left = '-9999px';
      box.style.width = '0px'; box.style.height = '0px';
      tip.style.left = Math.round((vw - tip.offsetWidth) / 2) + 'px';
      tip.style.top = Math.round(Math.max(edge, (vh - tip.offsetHeight) / 2)) + 'px';
      return;
    }

    box.className = '';
    var r = target.getBoundingClientRect();
    box.style.top = (r.top - pad) + 'px';
    box.style.left = (r.left - pad) + 'px';
    box.style.width = (r.width + pad * 2) + 'px';
    box.style.height = (r.height + pad * 2) + 'px';

    /* Prefer below, fall back above, and if neither fits, centre — then clamp
       to the viewport so it can never hang off a small screen. */
    var h = tip.offsetHeight, top;
    if (vh - r.bottom > h + gap + edge) top = r.bottom + gap;
    else if (r.top > h + gap + edge) top = r.top - h - gap;
    else top = (vh - h) / 2;
    top = Math.max(edge, Math.min(top, vh - h - edge));

    var w = tip.offsetWidth;
    var left = r.left + r.width / 2 - w / 2;
    left = Math.max(edge, Math.min(left, vw - w - edge));

    tip.style.top = Math.round(top) + 'px';
    tip.style.left = Math.round(left) + 'px';
  }

  /* A permanent rAF loop forced a synchronous layout every frame and locked the
     renderer up. Instead: reposition on the events that can actually move the
     target, plus a short burst after each step to cover the smooth scroll. */
  var burstUntil = 0;
  function burst(ms) {
    burstUntil = Date.now() + (ms || 900);
    if (raf) return;
    (function loop() {
      place();
      raf = (Date.now() < burstUntil) ? requestAnimationFrame(loop) : 0;
    })();
  }
  function onMove(){ place(); }

  function render() {
    var st = steps[i];
    target = (st.sel || st.text) ? find(st.sel, st.text) : null;
    if (target) { try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }

    tip.innerHTML =
      '<h4></h4><p></p>' +
      '<div class="tour-f"><div class="tour-dots">' +
        steps.map(function (_, j) { return '<i class="' + (j === i ? 'on' : '') + '"></i>'; }).join('') +
      '</div>' +
      (i === steps.length - 1 ? '' : '<button class="tour-b skip" type="button">Skip</button>') +
      '<button class="tour-b next" type="button">' + (i === steps.length - 1 ? "Let's go" : 'Next') + '</button></div>';
    tip.querySelector('h4').textContent = st.title;
    tip.querySelector('p').textContent = st.body;
    tip.querySelector('.next').addEventListener('click', function (e) { e.stopPropagation(); next(); });
    var sk = tip.querySelector('.skip');
    if (sk) sk.addEventListener('click', function (e) { e.stopPropagation(); finish('skipped'); });

    place();
    burst(1100);                       // covers the smooth scroll into view
    if (window.tsfgTrack) window.tsfgTrack('action', { tour: 'step', step: i + 1, of: steps.length });
  }

  function next() { i++; if (i >= steps.length) finish('completed'); else render(); }

  function finish(how) {
    markDone();
    if (raf) cancelAnimationFrame(raf); raf = 0; burstUntil = 0;
    window.removeEventListener('scroll', onMove, true);
    window.removeEventListener('resize', onMove);
    [veil, box, tip].forEach(function (el) { if (el && el.parentNode) el.remove(); });
    veil = box = tip = target = null;
    if (window.tsfgTrack) window.tsfgTrack('action', { tour: how, steps: i });
  }

  function begin() {
    css();
    steps = STEPS(); i = 0;

    veil = document.createElement('div'); veil.id = 'tourVeil';
    /* Swallow everything. Without this a tap "outside" hit the app underneath
       and left the tour running over a page that had already navigated. */
    ['click', 'mousedown', 'touchstart', 'pointerdown'].forEach(function (ev) {
      veil.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); }, true);
    });

    box = document.createElement('div'); box.id = 'tourBox';
    tip = document.createElement('div'); tip.id = 'tourTip';
    tip.setAttribute('role', 'dialog'); tip.setAttribute('aria-modal', 'true');

    document.body.appendChild(veil);
    document.body.appendChild(box);
    document.body.appendChild(tip);

    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    render();
    if (window.tsfgTrack) window.tsfgTrack('action', { tour: 'started' });
  }
  window.tsfgStartTour = function () { try { localStorage.removeItem(KEY); } catch (e) {} if (!tip) begin(); };

  /* Only genuinely new enrolments get the tour. Everyone already on the
     platform has found their way around, and a walkthrough appearing on a
     familiar app reads as a bug. Change ONBOARDED_FROM to move the line.
     All 129 accounts existing on 2026-08-31 predate this, so none of them
     will ever see it. */
  var ONBOARDED_FROM = Date.parse('2026-08-31T00:00:00Z');
  var TRACKER = 'https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/tracker-api';

  function isNewEnrolment(cb) {
    var c = code();
    if (!c) return cb(false);
    fetch(TRACKER, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'load', code: c })
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        var created = r && r.agent && r.agent.created_at;
        /* Fail closed: if we cannot establish that this is a new account, do
           not show the tour. Better a new agent misses it than an established
           one gets ambushed by it. */
        if (!created) return cb(false);
        var t = Date.parse(created);
        cb(!isNaN(t) && t >= ONBOARDED_FROM);
      })
      .catch(function () { cb(false); });
  }

  function start() {
    var p = location.pathname.split('/').pop() || 'index.html';
    if (p !== 'index.html' && p !== '') return;
    if (!code() || done()) return;
    isNewEnrolment(function (ok) {
      if (!ok) { markDone(); return; }   // never ask again for this person
      setTimeout(function () { if (document.querySelector('.snap, .tsfg-menu')) begin(); }, 2200);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ==========================================================================
   SIDEBAR RAIL + SIDEBAR DARK CHROME  (2026-09-01)
   --------------------------------------------------------------------------
   Two things were broken here.

   1. Retraction. Home could collapse its sidebar to a 76px icon rail, but the
      unified-nav rewrite added elements Home had never styled for that state
      ("More", the section headings, the language buttons), so the rail spilled
      and looked broken. The seven .tsfg-side pages never had retraction at all
      — their tsfgToggle() returns early above 860px, so on a desktop the menu
      button did nothing. Retraction now lives here, once, for both patterns.

      The .tsfg-side pages drive width, body padding and the topbar offset from
      a single --tsfg-side variable, so re-pointing that one value collapses the
      whole layout in step. Home keeps its own .collapsed class so its existing
      grid transition still runs. The choice is remembered in 'gfi_side' — the
      key Home already used — so it carries across every page.

   2. Dark chrome. Those pages paint the sidebar and topbar with literal light
      hexes (#fff, #ececf0, #6e6e73), which no variable override can reach. The
      dark fix set --tsfg-side to a COLOUR to try to darken the sidebar, but
      that variable is its WIDTH: in dark mode the width, the body padding and
      the topbar offset all became invalid and the layout fell apart. The bad
      declaration is gone from those pages; the real dark values are below.
   ========================================================================== */
(function () {
  var PHONE = 860;
  var RAIL  = 'tsfg-rail';
  var KEY   = 'gfi_side';
  var SIDE  = '.tsfg-side';
  var ASIDE = 'aside.side#side';        /* Scheduler, Team Hub, New Business, PFR */

  function wide(){ return window.innerWidth > PHONE; }
  function saved(){ try { return localStorage.getItem(KEY) === '1'; } catch(e){ return false; } }
  function remember(on){ try { localStorage.setItem(KEY, on ? '1' : '0'); } catch(e){} }

  function css() {
    if (document.getElementById('tsfg-rail-css')) return;
    var s = document.createElement('style'); s.id = 'tsfg-rail-css';
    s.textContent =
      /* ---------- self-correcting layout default ----------
         --tsfg-side is the sidebar WIDTH. On several pages it had been declared
         inside the light-theme-only block, so switching to dark left it
         undefined and width / body padding / topbar offset all became invalid —
         the page appeared to fall apart. The pages are fixed, but this floor
         means a page can never lose the value again: :root is weaker than the
         pages' own html:not([data-theme="dark"]) rule, so it only fills a gap,
         and body.tsfg-rail below still overrides it when the rail is on. */
      ':root{--tsfg-side:248px;}' +
      /* ---------- the rail (desktop only) ---------- */
      '@media(min-width:' + (PHONE + 1) + 'px){' +
        SIDE + '{transition:width .22s cubic-bezier(.2,.8,.2,1);}' +
        '.tsfg-top{transition:left .22s cubic-bezier(.2,.8,.2,1);}' +
        'body.' + RAIL + '{--tsfg-side:76px;}' +
        'body.' + RAIL + ' ' + SIDE + '{padding-left:8px;padding-right:8px;overflow-x:hidden;}' +
        'body.' + RAIL + ' .tsfg-brand{justify-content:center;padding-left:0;padding-right:0;}' +
        'body.' + RAIL + ' .tsfg-brand .bn{display:none;}' +
        'body.' + RAIL + ' ' + SIDE + ' .side-link{justify-content:center;padding-left:0;padding-right:0;}' +
        'body.' + RAIL + ' ' + SIDE + ' .side-link .lbl{display:none;}' +
        /* Scheduler / Team Hub / New Business drive their layout from --side. */
        'body.' + RAIL + '{--side:76px;}' +
        'aside.side{transition:width .22s cubic-bezier(.2,.8,.2,1);}' +
        'body.' + RAIL + ' aside.side{padding-left:8px;padding-right:8px;overflow-x:hidden;}' +
        'body.' + RAIL + ' aside.side .slink{justify-content:center;padding-left:0;padding-right:0;}' +
        'body.' + RAIL + ' aside.side .slink .lbl{display:none;}' +
        'body.' + RAIL + ' aside.side .brand .bn{display:none;}' +
        'body.' + RAIL + ' aside.side .brand{justify-content:center;}' +
        /* PFR hardcodes 248px instead of using a variable, so it needs telling. */
        'body.' + RAIL + '.tsfg-fixedside{padding-left:76px!important;}' +
        'body.' + RAIL + '.tsfg-fixedside aside.side{width:76px!important;}' +
      '}' +
      /* elements the unified nav injects — collapse them in BOTH patterns */
      '@media(min-width:' + (PHONE + 1) + 'px){' +
        'body.' + RAIL + ' .tsfg-navsec,#app.collapsed .tsfg-navsec{display:none;}' +
        /* The language buttons must stay VISIBLE, just narrow. i18n.js only
           suppresses its floating pill while a visible [data-lang-btn] exists,
           so display:none here brought the pill back over the page content. */
        'body.' + RAIL + ' .tsfg-lang,#app.collapsed .tsfg-lang{flex-direction:column;gap:4px;padding:2px 4px 6px;}' +
        'body.' + RAIL + ' .tsfg-lang button,#app.collapsed .tsfg-lang button{font-size:0;min-height:30px;}' +
        'body.' + RAIL + ' .tsfg-lang button[data-lang-btn="en"]::after,' +
        '#app.collapsed .tsfg-lang button[data-lang-btn="en"]::after{content:"EN";font-size:11px;font-weight:800;}' +
        'body.' + RAIL + ' .tsfg-lang button[data-lang-btn="es"]::after,' +
        '#app.collapsed .tsfg-lang button[data-lang-btn="es"]::after{content:"ES";font-size:11px;font-weight:800;}' +
        'body.' + RAIL + ' .tsfg-more span,#app.collapsed .tsfg-more span{display:none;}' +
        'body.' + RAIL + ' .tsfg-more,#app.collapsed .tsfg-more{justify-content:center;padding-left:0;padding-right:0;}' +
        'body.' + RAIL + ' .tsfg-more svg,#app.collapsed .tsfg-more svg{margin-left:0;}' +
        '#app.collapsed .tsfg-morewrap .side-link{justify-content:center;}' +
      '}' +
      /* ---------- dark chrome for the .tsfg-side pages ---------- */
      ':root[data-theme="dark"] ' + SIDE + '{background:#131315!important;border-right-color:#2e2e33!important;}' +
      ':root[data-theme="dark"] .tsfg-brand{color:#f5f5f7!important;}' +
      ':root[data-theme="dark"] ' + SIDE + ' .side-link{color:#a1a1a8!important;}' +
      ':root[data-theme="dark"] ' + SIDE + ' .side-link:hover{background:#1e1e22!important;color:#f5f5f7!important;}' +
      ':root[data-theme="dark"] ' + SIDE + ' .side-link.on{background:rgba(124,139,255,.16)!important;color:#7c8bff!important;}' +
      ':root[data-theme="dark"] .tsfg-foot{border-top-color:#2e2e33!important;}' +
      ':root[data-theme="dark"] .tsfg-top{background:rgba(19,19,21,.82)!important;border-bottom-color:#2e2e33!important;}' +
      ':root[data-theme="dark"] .tsfg-title{color:#f5f5f7!important;}' +
      ':root[data-theme="dark"] .tsfg-ic{background:#1e1e22!important;border-color:#2e2e33!important;color:#a1a1a8!important;}' +
      ':root[data-theme="dark"] .tsfg-ic:hover{color:#f5f5f7!important;}' +
      ':root[data-theme="dark"] .tsfg-lang button{border-color:#2e2e33!important;color:#f5f5f7!important;}';
    document.head.appendChild(s);
  }

  function isRail(){ return document.body.classList.contains(RAIL); }

  function setRail(on) {
    if (!document.body) return;
    document.body.classList.toggle(RAIL, !!on);
    var app = document.getElementById('app');
    if (app) app.classList.toggle('collapsed', !!on);   // Home's own grid transition
    remember(!!on);
  }

  /* The one control. Phones still get the drawer; desktops get the rail. */
  window.tsfgRail = function () {
    if (!wide()) {
      if (typeof window.tsfgToggleNav === 'function') window.tsfgToggleNav();
      return;
    }
    setRail(!isRail());
  };

  function start() {
    if (!document.querySelector(SIDE) && !document.querySelector(ASIDE) &&
        !document.getElementById('app')) return;
    css();

    /* PFR writes the sidebar width as a literal rather than a variable, so the
       variable swap cannot reach it; mark it and the CSS above handles it. */
    if (document.querySelector(ASIDE) &&
        !getComputedStyle(document.documentElement).getPropertyValue('--side').trim()) {
      document.body.classList.add('tsfg-fixedside');
    }

    /* These pages call drawer(true) straight from the button's onclick, so
       there is no toggle function to replace. Intercept in the capture phase —
       that runs before the inline handler — and rail instead on a desktop. */
    if (document.querySelector(ASIDE)) {
      document.addEventListener('click', function (e) {
        if (!wide() || !e.target || !e.target.closest) return;
        var b = e.target.closest('[onclick*="drawer(true)"],[onclick*="drawer()"]');
        if (!b) return;
        e.preventDefault(); e.stopPropagation();
        setRail(!isRail());
      }, true);
    }

    /* Home already had a working collapse, but it flips only #app.collapsed.
       This module also sets body.tsfg-rail, and the injected "More"/language
       controls hide off that class — so left alone, Home's own button would
       expand the sidebar while those stayed hidden. Route Home's button
       through setRail() as well so the two classes can never drift apart. */
    if (document.getElementById('app') && document.querySelector('.sidebar')) {
      window.toggleSidebar = function () {
        var a = document.getElementById('app');
        if (!wide()) { if (a) a.classList.toggle('drawer'); return; }
        setRail(!isRail());
      };
    }

    /* Take over the per-page menu buttons. Their own tsfgToggle() bails out
       above 860px, which is exactly why retraction appeared to be gone; the
       declaration is hoisted at parse time, so reassigning here wins. */
    if (document.querySelector(SIDE)) {
      window.tsfgToggle = function () {
        if (!wide()) {
          if (typeof window.tsfgDrawer === 'function') {
            window.tsfgDrawer(!document.body.classList.contains('tsfg-drawer'));
          } else if (typeof window.tsfgToggleNav === 'function') {
            window.tsfgToggleNav();
          }
          return;
        }
        setRail(!isRail());
      };
    }

    if (wide() && saved()) setRail(true);

    /* Dropping to phone width hands control back to the drawer. */
    var last = wide();
    window.addEventListener('resize', function () {
      var now = wide();
      if (now === last) return;
      last = now;
      if (!now) document.body.classList.remove(RAIL);
      else if (saved()) setRail(true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ==========================================================================
   BASESHOP BRANDING  (2026-09-02)
   --------------------------------------------------------------------------
   Every baseshop is its own operating space inside one platform. The EMD who
   owns it picks the colour, logo and name their team sees; this applies that
   choice on every screen the moment the page loads.

   Only presentation lives here. Who reports to whom is not an EMD's to change —
   that is Operations and Eli Cox (org-api v4) — so nothing in this module
   touches the hierarchy.

   The brand is cached in sessionStorage so the colour does not flicker in on
   every navigation; a change by the EMD shows up on the next fresh session.
   ========================================================================== */
(function () {
  var API = 'https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/base-brand';
  var KEY = 'tsfg_brand_v1';

  function code(){ try { return (localStorage.getItem('tsfg_code')||'').trim(); } catch(e){ return ''; } }

  function apply(brand){
    if (!brand) return;
    var r = document.documentElement;
    if (brand.accent && /^#[0-9a-f]{6}$/i.test(brand.accent)) {
      // every accent name in use across the pages, so one setting covers them all
      ['--accent','--tsfg-accent','--brand'].forEach(function(v){ r.style.setProperty(v, brand.accent); });
      if (brand.accent_soft) ['--accent-soft','--accent-soft-2'].forEach(function(v){ r.style.setProperty(v, brand.accent_soft); });
    }
    if (brand.display_name) {
      document.querySelectorAll('[data-brand-name]').forEach(function(el){ el.textContent = brand.display_name; });
    }
    if (brand.logo_url) {
      document.querySelectorAll('.side-brand img, .tsfg-brand img, .brand img').forEach(function(img){
        img.src = brand.logo_url; img.style.visibility = 'visible';
      });
    }
    try { r.setAttribute('data-baseshop', (brand.baseshop||'').toLowerCase()); } catch(e){}
  }

  function start(){
    var c = code(); if (!c) return;
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(KEY)||'null'); } catch(e){}
    if (cached && cached.code === c) { apply(cached.brand); return; }
    fetch(API, { method:'POST', headers:{'Content-Type':'application/json'},
                 body: JSON.stringify({ action:'get', code:c }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.ok || !d.brand) return;
        try { sessionStorage.setItem(KEY, JSON.stringify({ code:c, brand:d.brand })); } catch(e){}
        apply(d.brand);
      })
      .catch(function(){ /* branding is a nicety — never block a page on it */ });
  }

  /* The EMD's own settings screen calls this after saving, so they see the
     change immediately rather than being told to sign out and back in. */
  window.tsfgBrandRefresh = function(){
    try { sessionStorage.removeItem(KEY); } catch(e){}
    start();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
