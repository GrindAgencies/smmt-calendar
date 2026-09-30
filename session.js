/* session.js — who is actually calling.
 *
 * Until 2026-09-30 every screen identified itself to the backend with a bare GFI code, and GFI
 * codes are printed on the org chart. Anyone could read — and in places write — as a colleague
 * simply by typing their code. The fix is a session token minted the one moment the platform
 * really knows who somebody is: when they enter their PIN.
 *
 * This file is deliberately ONE small thing loaded first on every page, rather than an edit to
 * forty call sites. It wraps fetch, so every request to an edge function carries the session
 * without any page having to remember to send it — and a page added next month gets it for free.
 *
 * It also handles the migration. Everyone signed in today has a code in localStorage and no
 * session, because sessions did not exist. The first call that comes back `needs_session` sends
 * them to sign in once, and from then on they are carrying real identity.
 */
(function () {
  var KEY = 'tsfg_sess';
  var FN = '/functions/v1/';

  function get() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function set(t) { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch (e) {} }
  function code() { try { return (localStorage.getItem('tsfg_code') || '').toUpperCase(); } catch (e) { return ''; } }

  /* Signing out has to take the session with it, or the token outlives the sign-out. */
  function clear() {
    var t = get();
    set('');
    if (t) {
      try {
        fetch('https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/pin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'logout', session: t }), keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    }
  }

  var bouncing = false;
  /* The server says this request had no usable identity. Send them to sign in, once, keeping
     where they were so they land back on it. Never loop: index.html is the sign-in page. */
  function needSignIn() {
    if (bouncing) return;
    bouncing = true;
    set('');
    try {
      var here = location.pathname.split('/').pop() || 'index.html';
      if (here === 'index.html' || here === '') return;
      location.href = 'index.html?next=' + encodeURIComponent(here + location.search);
    } catch (e) { try { location.href = 'index.html'; } catch (_) {} }
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = '';
    try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) {}

    if (url.indexOf(FN) >= 0 && init && typeof init.body === 'string') {
      var tok = get();
      if (tok) {
        try {
          var b = JSON.parse(init.body);
          /* Only ever ADD it. A page that deliberately sends its own session (the Operations
             seat, say) is left exactly as it is. */
          if (b && typeof b === 'object' && !Array.isArray(b) && b.session === undefined) {
            b.session = tok;
            init = Object.assign({}, init, { body: JSON.stringify(b) });
          }
        } catch (e) { /* not JSON — leave it alone */ }
      }
    }

    var p = realFetch(input, init);
    if (url.indexOf(FN) < 0) return p;

    return p.then(function (res) {
      /* Peek without consuming: the caller still gets an unread body. */
      try {
        if (!res.ok && res.status !== 401) return res;
        var c = res.clone();
        c.json().then(function (d) {
          if (d && d.needs_session === true) needSignIn();
        }).catch(function () {});
      } catch (e) {}
      return res;
    });
  };

  window.tsfgSession = { get: get, set: set, clear: clear, code: code, signInAgain: needSignIn };
})();
