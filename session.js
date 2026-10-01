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
    /* The code has to go too. Home decides whether to draw the app or the sign-in gate by looking
       for tsfg_code, so leaving it behind meant a person with no valid session was shown the full
       dashboard with their name on it, quietly failing every panel — "Leaderboard unavailable",
       empty numbers — instead of simply being asked to sign in. No session means not signed in,
       and the screen should say so. */
    try { localStorage.removeItem('tsfg_code'); } catch (e) {}
    try {
      var here = location.pathname.split('/').pop() || 'index.html';
      if (here === 'index.html' || here === '') return;
      location.href = 'index.html?next=' + encodeURIComponent(here + location.search);
    } catch (e) { try { location.href = 'index.html'; } catch (_) {} }
  }

  /* Some screens call the backend the OLD way: everything in the query string and no body at all
     — fetch(AT + '?action=atlas_my&code=' + CODE). There is no body for the wrapper below to add
     the session to, so those requests used to arrive with no proof of identity at all. Once the
     backend started requiring proof, every one of them answered needs_session and bounced the
     person straight back to the sign-in screen: the Scheduler and the PFR builder became
     unreachable, and Road to EMD quietly loaded the wrong, cut-down record.

     These are turned into a normal POST carrying the same values in a JSON body, which every one
     of these functions already reads. Deliberately NOT done by appending the token to the URL:
     query strings end up in server logs, and a session token does not belong there.

     Restricted to the handful of functions actually called this way, so nothing that genuinely
     wants a GET (cal-feed serves a calendar file) is touched. */
  var GETFIX = ['atlas-api', 'tracker-api', 'hub-api', 'trainer-bookings'];
  function asPost(url, init, tok) {
    try {
      var q = url.indexOf('?');
      if (q < 0) return null;
      var slug = url.slice(url.indexOf(FN) + FN.length).split(/[?/]/)[0];
      if (GETFIX.indexOf(slug) < 0) return null;
      var body = {};
      var sp = new URLSearchParams(url.slice(q + 1));
      sp.forEach(function (v, k) { body[k] = v; });
      /* The public booking page is reached by clients who have no account; leave it alone. */
      if (String(body.action || '').indexOf('atlas_public_') === 0) return null;
      if (tok) body.session = tok;
      return Object.assign({}, init || {}, {
        method: 'POST',
        headers: Object.assign({}, (init && init.headers) || {}, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    } catch (e) { return null; }
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = '';
    try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) {}

    var noBody = !init || init.body === undefined || init.body === null;
    if (url.indexOf(FN) >= 0 && noBody) {
      var fixed = asPost(url, init, get());
      if (fixed) init = fixed;
    }

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
