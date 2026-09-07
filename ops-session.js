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

  function get(){ try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function put(t){ try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch (e) {} }
  function call(b){
    return fetch(AUTH, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b) })
      .then(function(r){ return r.json(); })
      .catch(function(){ return { ok:false, error:'Network error — try again.' }; });
  }
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
        if (r && r.ok && r.token) { put(r.token); return { ok:true, label:r.label, bases:r.bases, master:r.master }; }
        return r || { ok:false, error:'Could not sign in.' };
      });
    },
    /* Make sure this tab holds a live Operations session, asking for the code and
       PIN only if it does not. Pages that used to grant themselves admin from a
       local flag call this instead, so the authority comes from the server. */
    ensure: function(){
      return window.tsfgOps.check().then(function(c){
        if (c && c.ok) return { ok:true };
        return window.tsfgOps.promptSignIn();
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
})();
