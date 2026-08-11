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

    function saveToken(token){
      try{
        var base = (window.SUPABASE_URL || 'https://bmfqxtocxkjhsgfnndlo.supabase.co');
        var key  = window.SUPABASE_KEY; if(!key) return;
        var code = localStorage.getItem('tsfg_code') || null;
        var name = localStorage.getItem('tsfg_name') || null;
        fetch(base + '/rest/v1/device_tokens?on_conflict=token', {
          method:'POST',
          headers:{ 'apikey':key, 'Authorization':'Bearer '+key,
                    'Content-Type':'application/json',
                    'Prefer':'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ token:token, platform:(C.getPlatform&&C.getPlatform())||'ios',
                                 agent_code:code, agent_name:name, last_seen:new Date().toISOString() })
        }).catch(function(){});
      }catch(e){}
    }

    Push.addListener('registration', function(t){ if(t&&t.value) saveToken(t.value); });
    Push.addListener('registrationError', function(){});
    Push.checkPermissions().then(function(p){
      if(p.receive === 'granted'){ Push.register(); }
      else { Push.requestPermissions().then(function(r){ if(r.receive==='granted') Push.register(); }); }
    }).catch(function(){});
  }catch(e){}
})();
