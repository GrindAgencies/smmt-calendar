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
    return '<a class="' + cls + on + '" href="' + item[1] + '">' + svg(item[2]) +
           '<span class="lbl">' + item[0] + '</span></a>';
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
        '.tb-toggle,.menu{display:none!important;}' +
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
    else document.body.appendChild(b);
  }

  function start() {
    css(); scrim(); build(false);
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
