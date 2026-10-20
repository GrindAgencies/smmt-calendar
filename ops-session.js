/* ops-session.js — the Operations sign-in helper.
   Kept out of notif.js on purpose: ops.html does not load notif.js (it has its own
   chrome), and pulling that whole module in just for this would rewrite its nav. */
/* ==========================================================================
   OPERATIONS SESSION  (2026-09-05)
   --------------------------------------------------------------------------
   Admin calls used to carry the literal string "2026", which shipped inside
   ops.html and newbusiness.html for anyone to read. Authority now belongs to a
   person who signed in: a 6-digit PIN (bcrypt, in Postgres) mints an 8-hour
   session, and the edge functions validate that session instead of a shared
   word. One helper so both pages behave identically and a token is stored in
   exactly one place.

   The legacy token is still accepted server-side while Operations set their
   PINs — nobody working today gets interrupted. It is switched off centrally
   once every seat has signed in at least once.
   ========================================================================== */
(function () {
  var AUTH = 'https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/ops-auth';
  var KEY  = 'tsfg_ops_token';
  var SEATKEY = 'tsfg_ops_seat';

  /* The sign-in sheet's own styling. Self-contained on purpose: this loads on five
     pages with different chrome, and it must look the same on all of them. Colours
     come from the app's variables where they exist and fall back otherwise, so it
     is correct in light and dark without knowing which page it is on. */
  var CSS = ''
    + '.opsq-bg{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);'
    + 'display:flex;align-items:center;justify-content:center;padding:20px;'
    + 'padding-top:calc(20px + env(safe-area-inset-top));'
    + '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}'
    + '.opsq-card{width:100%;max-width:360px;background:var(--panel,#fff);color:var(--ink,#1d1d1f);'
    + 'border:1px solid var(--line,#e6e6ea);border-radius:16px;padding:22px 20px 18px;'
    + 'box-shadow:0 18px 50px rgba(0,0,0,.32);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'
    + '.opsq-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--ink3,#8e8e93);margin:0 0 4px;}'
    + '.opsq-title{font-size:18px;font-weight:800;letter-spacing:-.02em;margin:0 0 6px;}'
    + '.opsq-sub{font-size:13px;color:var(--ink2,#5c5c66);margin:0 0 14px;}'
    + '.opsq-row{margin:0 0 10px;}'
    + '.opsq-card label{display:block;font-size:11px;font-weight:700;color:var(--ink3,#8e8e93);margin:0 0 5px;}'
    + '.opsq-card input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;'
    + 'border:1px solid var(--line2,#d7d7de);background:var(--bg,#fff);color:var(--ink,#1d1d1f);'
    + 'font-size:16px;font-weight:700;letter-spacing:.14em;font-variant-numeric:tabular-nums;}'
    + '.opsq-card input:focus{outline:none;border-color:var(--accent,#c99a2e);box-shadow:0 0 0 3px rgba(201,154,46,.18);}'
    + '.opsq-msg{min-height:17px;font-size:12px;color:var(--ink3,#8e8e93);margin:2px 0 10px;}'
    + '.opsq-msg.bad{color:var(--red,#d6543c);font-weight:700;}'
    + '.opsq-btns{display:flex;gap:8px;}'
    + '.opsq-card button{flex:1;padding:11px 14px;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;border:1px solid transparent;}'
    + '.opsq-go{background:var(--accent,#c99a2e);color:#fff;}'
    + '.opsq-go[disabled]{opacity:.6;cursor:default;}'
    + '.opsq-cancel{flex:0 0 auto;background:transparent;color:var(--ink3,#8e8e93);border-color:var(--line2,#d7d7de);}';

  function buildSheet(){
    if (!document.getElementById('opsq-css')) {
      var s = document.createElement('style'); s.id = 'opsq-css'; s.textContent = CSS;
      document.head.appendChild(s);
    }
    var root = document.createElement('div');
    root.className = 'opsq-bg';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML =
      '<div class="opsq-card">'
      + '<p class="opsq-eyebrow">Operations sign-in</p>'
      + '<h2 class="opsq-title">Who is signing in?</h2>'
      + '<p class="opsq-sub">Enter your Operations code to continue.</p>'
      + '<div class="opsq-row opsq-coderow"><label>Operations code</label>'
      + '<input class="opsq-code" inputmode="numeric" autocomplete="off" placeholder="0000" maxlength="12"></div>'
      + '<div class="opsq-pinrow" style="display:none">'
      + '<div class="opsq-row"><label>6-digit PIN</label>'
      + '<input class="opsq-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="••••••"></div>'
      + '<div class="opsq-row opsq-pin2row" style="display:none"><label>Confirm PIN</label>'
      + '<input class="opsq-pin2" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="••••••"></div>'
      + '</div>'
      + '<div class="opsq-msg"></div>'
      + '<div class="opsq-btns"><button class="opsq-go" type="button">Continue</button>'
      + '<button class="opsq-cancel" type="button">Cancel</button></div>'
      + '</div>';
    return { root: root, q: function(sel){ return root.querySelector(sel); } };
  }

  /* The token lived in sessionStorage, which is per-TAB. That alone signed Operations
     out several times a day without any session having expired: opening a second tab,
     closing the window, or cold-starting the installed app all began with an empty
     store and a PIN box. It belongs in localStorage, where one sign-in covers the
     whole browser and survives a restart. Any token already held in the old place is
     carried over on load, so nobody signed in right now is interrupted by this change. */
  function get(){
    try {
      var t = localStorage.getItem(KEY);
      if (t) return t;
      var old = sessionStorage.getItem(KEY);          // migrate, once
      if (old) { localStorage.setItem(KEY, old); sessionStorage.removeItem(KEY); return old; }
      return '';
    } catch (e) { return ''; }
  }
  function put(t){
    try {
      if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY);
      sessionStorage.removeItem(KEY);
    } catch (e) {}
  }
  /* Which seat is signed in, remembered so a re-prompt can skip straight to the PIN
     instead of asking "who are you?" again in the middle of someone's work. */
  function lastSeat(){ try { return localStorage.getItem(SEATKEY) || ''; } catch (e) { return ''; } }
  function putSeat(c){ try { if (c) localStorage.setItem(SEATKEY, String(c)); } catch (e) {} }
  function call(b){
    return fetch(AUTH, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b) })
      .then(function(r){ return r.json(); })
      .catch(function(){ return { ok:false, error:'Network error — try again.' }; });
  }
  /* Carry the seat over from the old per-tab store, once. Without this, everyone
     signed in at the moment this ships would meet the gate on their next page load
     even though their session is perfectly valid. */
  (function(){
    try {
      ['tsfg_ops','tsfg_ops_bsscope','nb_ops','tsfg_approver'].forEach(function(k){
        var old = sessionStorage.getItem(k);
        if (old && !localStorage.getItem(k)) localStorage.setItem(k, old);
        if (old) sessionStorage.removeItem(k);
      });
    } catch (e) {}
  })();

  window.tsfgOps = {
    token:    get,
    setToken: put,
    status:   function(code){ return call({ action:'status', code:code }); },
    setPin:   function(code, pin){ return call({ action:'set',  code:code, pin:pin }); },
    login:    function(code, pin){ return call({ action:'login',code:code, pin:pin }); },
    check:    function(){ var t = get(); return t ? call({ action:'check', token:t }) : Promise.resolve({ ok:false }); },
    logout:   function(){ var t = get(); put(''); return t ? call({ action:'logout', token:t }) : Promise.resolve({ ok:true }); },
    /* Sign in and keep the token. Returns {ok} or {ok:false,error} or {needs_pin:true}. */
    signIn: function(code, pin){
      return window.tsfgOps.login(code, pin).then(function(r){
        if (r && r.ok && r.token) { put(r.token); putSeat(code); return { ok:true, label:r.label, bases:r.bases, master:r.master }; }
        return r || { ok:false, error:'Could not sign in.' };
      });
    },
    /* Make sure this tab holds a live Operations session, asking for the code and
       PIN only if it does not. Pages that used to grant themselves admin from a
       local flag call this instead, so the authority comes from the server. */
    ensure: function(){
      return window.tsfgOps.check().then(function(c){
        if (c && c.ok) return { ok:true };
        return window.tsfgOps.promptSignIn(lastSeat());
      });
    },
    /* The sign-in sheet. This used to be two native prompt() boxes, which typed a
       six-digit credential in plain view, offered no way to confirm it \u2014 one typo
       became your PIN and locked you out of your own seat \u2014 and looked broken
       inside the installed app. Same flow as the gate built into ops.html, now
       shared by every page so Operations sees one consistent thing. */
    promptSignIn: function(seedCode){
      return new Promise(function(resolve){
        var seat = null;                 // resolved seat once the code is known
        var el = buildSheet();
        var msg = el.q('.opsq-msg'), codeIn = el.q('.opsq-code'),
            pinIn = el.q('.opsq-pin'), pin2In = el.q('.opsq-pin2'),
            pin2Row = el.q('.opsq-pin2row'), title = el.q('.opsq-title'),
            sub = el.q('.opsq-sub'), go = el.q('.opsq-go'), cancel = el.q('.opsq-cancel');

        function say(t, bad){ msg.textContent = t || ''; msg.className = 'opsq-msg' + (bad ? ' bad' : ''); }
        function close(r){ try { el.root.remove(); } catch (e) {} document.removeEventListener('keydown', onEsc, true); resolve(r); }
        function onEsc(e){ if (e.key === 'Escape') { e.preventDefault(); close({ ok:false, cancelled:true }); } }
        document.addEventListener('keydown', onEsc, true);
        cancel.onclick = function(){ close({ ok:false, cancelled:true }); };
        el.root.addEventListener('mousedown', function(e){ if (e.target === el.root) close({ ok:false, cancelled:true }); });

        /* Step 1 \u2014 which seat? */
        function askCode(){
          var code = String(codeIn.value || '').trim();
          if (!code) { say('Enter your Operations code.', true); codeIn.focus(); return; }
          say('Checking\u2026');
          window.tsfgOps.status(code).then(function(st){
            if (!st || !st.ok) { say((st && st.error) || 'That Operations code is not recognised.', true); codeIn.focus(); return; }
            if (st.locked)     { say('Too many wrong PINs on this seat. Try again in a few minutes.', true); return; }
            seat = { code: code, label: st.label || code, has_pin: !!st.has_pin };
            el.q('.opsq-coderow').style.display = 'none';
            el.q('.opsq-pinrow').style.display = '';
            pin2Row.style.display = seat.has_pin ? 'none' : '';
            title.textContent = seat.label;
            if (seat.has_pin) {
              sub.textContent = 'Enter your 6-digit Operations PIN.';
              go.textContent = 'Sign in';
            } else {
              sub.textContent = 'First sign-in for this seat. Choose a 6-digit PIN \u2014 you will use it from now on, and nobody else can see it.';
              go.textContent = 'Set PIN & sign in';
            }
            say('');
            setTimeout(function(){ pinIn.focus(); }, 60);
          });
        }

        /* Step 2 \u2014 the PIN itself. */
        function askPin(){
          var pin = String(pinIn.value || '').trim();
          if (!/^[0-9]{6}$/.test(pin)) { say('Your Operations PIN is 6 digits.', true); pinIn.focus(); return; }
          if (!seat.has_pin) {
            var p2 = String(pin2In.value || '').trim();
            if (pin !== p2) { say('Those two PINs do not match.', true); pin2In.value = ''; pin2In.focus(); return; }
            if (/^(\d)\1{5}$/.test(pin) || pin === '123456' || pin === '654321') {
              say('Pick something less guessable than that.', true); pinIn.value = ''; pin2In.value = ''; pinIn.focus(); return;
            }
          }
          say(seat.has_pin ? 'Signing in\u2026' : 'Setting your PIN\u2026');
          go.disabled = true;
          var run = seat.has_pin ? window.tsfgOps.signIn(seat.code, pin) : window.tsfgOps.createPin(seat.code, pin);
          run.then(function(r){
            go.disabled = false;
            if (r && r.ok) { close({ ok:true, label: seat.label, bases: r.bases, master: r.master }); return; }
            say((r && r.error) || 'Could not sign in.', true);
            pinIn.value = ''; pin2In.value = ''; pinIn.focus();
          });
        }

        go.onclick = function(){ if (seat) askPin(); else askCode(); };
        [codeIn, pinIn, pin2In].forEach(function(i){
          i.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
        });

        document.body.appendChild(el.root);
        if (seedCode) { codeIn.value = String(seedCode); askCode(); }
        else setTimeout(function(){ codeIn.focus(); }, 60);
      });
    },
    /* First run for a seat: choose the PIN, then sign straight in with it. */
    createPin: function(code, pin){
      return window.tsfgOps.setPin(code, pin).then(function(r){
        if (r && r.ok) return window.tsfgOps.signIn(code, pin);
        return r || { ok:false, error:'Could not set that PIN.' };
      });
    }
  };

  /* ------------------------------------------------------------------------
     NOTHING TYPED IS EVER LOST.

     Every Operations screen builds its own request and posts it directly, so an
     expired session used to surface as a silent failure at whichever call happened
     to be next -- and if that call was "save this note", the note went with it. The
     person saw a toast, re-signed in, and found their paragraph gone.

     One wrapper around fetch fixes it for every screen at once, including screens
     added later. When an Operations call comes back 401, the original request is
     HELD, the sign-in sheet is shown once, and then the SAME request is replayed
     with the refreshed token. The save completes; the caller never knows anything
     happened. Concurrent calls all wait on the one sheet rather than stacking up
     five PIN boxes on top of each other.
     ------------------------------------------------------------------------ */
  var reauth = null;                       // the single in-flight sign-in, shared
  function reSignIn(){
    if (reauth) return reauth;
    reauth = window.tsfgOps.promptSignIn(lastSeat()).then(function(r){
      reauth = null;
      return !!(r && r.ok);
    }, function(){ reauth = null; return false; });
    return reauth;
  }

  var of = window.fetch;
  window.fetch = function(input, init){
    var url = String((input && input.url) || input || '');
    /* Only Operations calls, and never the sign-in endpoint itself -- a wrong PIN
       there is a legitimate 401 and must reach the sheet, not trigger another one. */
    var mine = url.indexOf('/functions/v1/') > -1 && url.indexOf('/ops-auth') < 0;
    if (!mine || !init || String(init.method || 'GET').toUpperCase() !== 'POST') {
      return of.apply(this, arguments);
    }
    var raw = init.body;
    if (typeof raw !== 'string') return of.apply(this, arguments);

    var sent = null;
    try { sent = JSON.parse(raw); } catch (e) { return of.apply(this, arguments); }
    /* Only requests that were carrying THIS seat's token. An agent-session call that
       happens to 401 belongs to session.js, which bounces to the agent sign-in. */
    var tok = get();
    if (!tok || !sent || sent.token !== tok) return of.apply(this, arguments);

    var self = this, args = arguments;
    return of.apply(self, args).then(function(res){
      if (res.status !== 401) return res;
      return reSignIn().then(function(ok){
        if (!ok) return res;                       // cancelled -- hand back the original
        var fresh = get();
        if (!fresh || fresh === tok) return res;
        sent.token = fresh;
        var retry = {};
        for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) retry[k] = init[k];
        retry.body = JSON.stringify(sent);
        return of.call(self, input, retry);
      });
    });
  };

  /* A tab left open all afternoon should still be signed in when it is next touched.
     One quiet call every ten minutes, only while the tab is actually visible, slides
     the server-side window forward. Deliberately not a poller: it moves no data. */
  setInterval(function(){
    if (document.hidden) return;
    if (!get()) return;
    window.tsfgOps.check();
  }, 600000);
})();
