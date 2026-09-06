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
        var code = prompt('Operations code (0000\u20130005, or your own if you have Operations rights):');
        if (!code) return { ok:false, cancelled:true };
        code = String(code).trim();
        return window.tsfgOps.status(code).then(function(st){
          if (!st || !st.ok) return { ok:false, error:(st && st.error) || 'That Operations code is not recognised.' };
          if (st.locked)     return { ok:false, error:'Too many wrong PINs on this seat. Try again shortly.' };
          var pin = prompt(st.has_pin
            ? ('PIN for ' + (st.label || code) + ':')
            : ('First sign-in for ' + (st.label || code) + ' \u2014 choose a 6-digit PIN:'));
          if (!pin) return { ok:false, cancelled:true };
          pin = String(pin).trim();
          return st.has_pin ? window.tsfgOps.signIn(code, pin) : window.tsfgOps.createPin(code, pin);
        });
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
