/* i18n.js — platform-wide English/Spanish layer for tsfg.app
   - One shared script included on every page. Reads/writes the language choice in localStorage
     (key 'tsfg_lang') so a switch on ANY page carries across the WHOLE platform.
   - When Spanish is on, it walks the page (text + placeholders/titles/aria-labels), translating via a
     shared, growing server cache (i18n-api). New phrases are translated once by AI and cached forever.
   - A MutationObserver + delayed sweeps catch content that renders after load (leaderboards, tickets,
     PFR steps, chat, etc.), so dynamic tabs get translated too.
   - Injects a small floating EN/ES pill on every page; the welcome page also has its own toggle that
     calls window.tsfgSetLang().
   Skip translation on any element (or subtree) by adding the attribute  data-no-i18n. */
(function () {
  "use strict";
  var API = "https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/i18n-api";
  var LANG = "en";
  try { LANG = localStorage.getItem("tsfg_lang") || "en"; } catch (e) {}
  var DICT = {};
  try { DICT = JSON.parse(localStorage.getItem("tsfg_i18n_es") || "{}") || {}; } catch (e) { DICT = {}; }

  var TX = new WeakMap();          // text node -> original English
  var applying = false;            // guard so our own edits don't retrigger the observer
  var pending = {};                // unknown strings waiting to be translated
  var flushT = null, sweepT = null, rounds = 0;

  function saveDict() { try { localStorage.setItem("tsfg_i18n_es", JSON.stringify(DICT)); } catch (e) {} }

  // Is this string worth translating? (skip codes, numbers, money, emails, urls, pure symbols)
  function translatable(s) {
    var t = (s == null ? "" : String(s)).trim();
    if (t.length < 2 || t.length > 400) return false;
    if (!/[A-Za-zÀ-ÿ]/.test(t)) return false;         // must contain a letter
    if (/^[A-Z0-9]{1,8}$/.test(t)) return false;      // agent codes / short acronyms (C1991, EMD)
    if (/^\S+@\S+\.\S+$/.test(t)) return false;       // email
    if (/^https?:\/\//i.test(t)) return false;        // url
    if (/^[\d.,:%$€£\-\/\s()]+$/.test(t)) return false; // numbers / money / times
    return true;
  }

  function esc() {}

  function queue(str) { if (DICT[str] == null && !pending[str]) { pending[str] = 1; scheduleFlush(); } }
  function scheduleFlush() { if (flushT) return; flushT = setTimeout(flush, 250); }
  function flush() {
    flushT = null;
    var list = Object.keys(pending);
    if (!list.length) return;
    pending = {};
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "translate", strings: list.slice(0, 200) }) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.ok && r.map) {
          var got = false;
          for (var k in r.map) { if (DICT[k] == null) { DICT[k] = r.map[k]; got = true; } }
          if (got) { saveDict(); scheduleSweep(); }
          // if a page had more new strings than one batch handled, keep going (bounded)
          if (r.remaining && rounds < 8) { rounds++; sweep(document.body); }
        }
      })
      .catch(function () {});
  }

  function applyText(node) {
    var orig = TX.has(node) ? TX.get(node) : node.nodeValue;
    if (!translatable(orig)) return;
    TX.set(node, orig);
    var key = orig.trim();
    var tr = DICT[key];
    if (tr == null) { queue(key); return; }
    var lead = (orig.match(/^\s*/) || [""])[0];
    var trail = (orig.match(/\s*$/) || [""])[0];
    var val = lead + tr + trail;
    if (node.nodeValue !== val) node.nodeValue = val;   // guard: avoid redundant writes (observer loop)
  }

  function applyAttr(el, a) {
    var store = "data-i18n-" + a;
    var orig = el.getAttribute(store);
    if (orig == null) { orig = el.getAttribute(a) || ""; if (!translatable(orig)) return; el.setAttribute(store, orig); }
    var tr = DICT[orig.trim()];
    if (tr == null) { queue(orig.trim()); return; }
    if (el.getAttribute(a) !== tr) el.setAttribute(a, tr);
  }

  function sweep(root) {
    if (LANG !== "es" || !root) return;
    applying = true;
    try {
      var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var p = n.parentNode; if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.nodeName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") return NodeFilter.FILTER_REJECT;
          if (p.closest && p.closest("[data-no-i18n]")) return NodeFilter.FILTER_REJECT;
          var o = TX.has(n) ? TX.get(n) : n.nodeValue;
          return translatable(o) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var n; while ((n = tw.nextNode())) applyText(n);
      // element-level: the root itself + descendants that carry translatable attributes
      var scope = (root.querySelectorAll ? root : document);
      var els = scope.querySelectorAll("[placeholder],[title],[aria-label]");
      for (var i = 0; i < els.length; i++) {
        var el = els[i]; if (el.closest && el.closest("[data-no-i18n]")) continue;
        if (el.hasAttribute("placeholder")) applyAttr(el, "placeholder");
        if (el.hasAttribute("title")) applyAttr(el, "title");
        if (el.hasAttribute("aria-label")) applyAttr(el, "aria-label");
      }
    } catch (e) {}
    applying = false;
  }

  function scheduleSweep() { if (sweepT) return; sweepT = setTimeout(function () { sweepT = null; sweep(document.body); }, 150); }

  function startObserver() {
    if (!window.MutationObserver || !document.body) return;
    var mo = new MutationObserver(function () { if (!applying && LANG === "es") scheduleSweep(); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function ensureDict() {
    // pull the shared cache once so already-known phrases translate instantly
    return fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dict" }) })
      .then(function (r) { return r.json(); })
      .then(function (r) { if (r && r.ok && r.map) { for (var k in r.map) DICT[k] = r.map[k]; saveDict(); } })
      .catch(function () {});
  }

  window.tsfgSetLang = function (l) {
    l = (l === "es") ? "es" : "en";
    if (l === LANG) return;
    try { localStorage.setItem("tsfg_lang", l); } catch (e) {}
    location.reload();   // clean, reliable switch (re-renders the page, then translates if ES)
  };
  window.tsfgLang = function () { return LANG; };

  function paintToggle() {
    var w = document.getElementById("i18nToggle");
    if (w) {
      var btns = w.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute("data-l") === LANG;
        btns[i].style.background = on ? "#5b6cff" : "transparent";
        btns[i].style.color = on ? "#fff" : "rgba(255,255,255,.7)";
      }
    }
    // in-page toggles anywhere (welcome page, topbar) marked with data-lang-btn="en|es"
    var custom = document.querySelectorAll("[data-lang-btn]");
    for (var j = 0; j < custom.length; j++) {
      var active = custom[j].getAttribute("data-lang-btn") === LANG;
      custom[j].style.background = active ? "#5b6cff" : "transparent";
      custom[j].style.color = active ? "#fff" : "";
      custom[j].style.opacity = active ? "1" : ".72";
    }
  }
  function injectToggle() {
    if (document.getElementById("i18nToggle") || !document.body) return;
    var w = document.createElement("div");
    w.id = "i18nToggle"; w.setAttribute("data-no-i18n", "");
    w.style.cssText = "position:fixed;bottom:calc(14px + env(safe-area-inset-bottom));right:14px;z-index:99999;display:flex;gap:2px;background:rgba(18,18,24,.86);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-radius:999px;padding:3px;box-shadow:0 4px 16px rgba(0,0,0,.28)";
    var mk = function (l, t) { return '<button data-l="' + l + '" style="border:none;cursor:pointer;border-radius:999px;padding:6px 12px;font:800 12px/1 -apple-system,system-ui,sans-serif;letter-spacing:.02em">' + t + "</button>"; };
    w.innerHTML = mk("en", "EN") + mk("es", "ES");
    var bs = w.querySelectorAll("button");
    bs[0].onclick = function () { window.tsfgSetLang("en"); };
    bs[1].onclick = function () { window.tsfgSetLang("es"); };
    document.body.appendChild(w);
    if (!document.getElementById("i18nPad")) {
      var st = document.createElement("style"); st.id = "i18nPad";
      st.textContent = "body.tsfg-haspill{padding-bottom:66px;}"
        /* The Ask button owns the bottom-right corner. When it is present the
           pill sits above it rather than on top of it. */
        + "body.tsfg-hasfab #i18nToggle{bottom:calc(76px + env(safe-area-inset-bottom))!important;}"
        + "body.tsfg-hasfab.tsfg-haspill{padding-bottom:132px;}";
      document.head.appendChild(st);
    }
    paintToggle();
  }

  // Never show two language controls on one screen. Pages that carry their own
  // visible EN/ES toggle (the welcome card, the privacy page) suppress the
  // floating pill; once that toggle is gone — e.g. the welcome card after
  // sign-in — the pill comes back.
  function hasVisibleInPageToggle() {
    var els = document.querySelectorAll("[data-lang-btn]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.offsetParent !== null && el.getClientRects().length) return true;
    }
    return false;
  }
  function syncToggleVisibility() {
    var pill = document.getElementById("i18nToggle");
    if (!pill) return;
    var hide = hasVisibleInPageToggle();
    pill.style.display = hide ? "none" : "flex";
    /* Reserve space so the pill never sits on top of a form field or a button
       on pages that have no menu to host it (Profile, Privacy). */
    try { document.body.classList.toggle("tsfg-haspill", !hide); } catch (e) {}
  }

  function boot() {
    document.documentElement.lang = LANG;
    injectToggle();
    paintToggle();
    syncToggleVisibility();
    // the welcome card hides on sign-in, so re-check as the page settles
    [300, 900, 2000].forEach(function (ms) { setTimeout(syncToggleVisibility, ms); });
    try {
      new MutationObserver(syncToggleVisibility)
        .observe(document.body, { attributes: true, childList: true, subtree: true,
                                  attributeFilter: ["class", "style", "hidden"] });
    } catch (e) {}
    if (LANG === "es") {
      ensureDict().then(function () {
        sweep(document.body); startObserver();
        [400, 1200, 2600, 5000].forEach(function (ms) { setTimeout(function () { sweep(document.body); }, ms); });
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
