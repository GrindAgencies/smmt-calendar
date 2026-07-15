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

  var POLL_MS = 45000;
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
    timer = setInterval(function(){ if(!open) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', function(){ if(!document.hidden) refresh(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
