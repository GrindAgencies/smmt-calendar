// profile-api v22 (2026-10-26: Calendly link validated) · v21 — profile + ONBOARDING + NESTED BASESHOP + full profile record.
//
// v21 (2026-09-30): WHO IS CALLING. Every action below took the caller's identity from a typed
//   `code`, and GFI codes are printed on the org chart. That made this endpoint a set of tools for
//   operating somebody else's account:
//     · get_profile     — read anyone's email, phone, ICA number, state and upline
//     · save_contact    — REWRITE anyone's name, contact details and upline
//     · save_photo      — replace anyone's profile photo
//     · roster          — read any leader's team with every email and phone number
//     · base_ops        — type a manager's code for their shop's directory; type the platform
//                          builder's code and `scope` came back "super", i.e. every baseshop
//     · enable_bookable — make anyone bookable as a trainer
//     · set_level       — change anyone's CONTRACT LEVEL, which is what their commission rate is
//                          calculated from
//   And one that was not about `code` at all: `current_name` was a typed name used to find a
//   trainer's availability row, so save_contact could overwrite ANOTHER trainer's phone, email and
//   Calendly link — quietly redirecting their bookings. It is now derived from the signed-in
//   record rather than read off the request.
//   Identity comes from the session token minted at PIN entry, or an Operations token.
//   `signup` and `resolve_upline` stay deliberately public: they are the join form, which by
//   definition runs before anybody has an account to prove. resolve_upline returns only a name,
//   code and baseshop — never contact details — and needs two characters, so it cannot be used to
//   page through the roster.
//
// v20 (2026-09-13): DUPLICATE GUARD ON SIGNUP.
//   Christopher: "yes add the duplicate guard to signup".
//   Three duplicate people in three weeks — Abbey Coker, Rudy Sanchez, Priscila Marroquin — every
//   one the same story: someone ALREADY in the roster self-registers again with a different code.
//   Both rows go active, both point at the same upline, and the person is counted twice in every
//   downline above them. Nobody notices until a leader's numbers look wrong; Edgar's team read 12
//   when it was 11. signup now asks find_person_conflicts() first and stops to ask "is this you?"
//   instead of silently creating the second record. Passing confirm_duplicate:true proceeds, for
//   the real case of two different people sharing a name.
// v19 (2026-09-12): an upline typed as a NAME resolves to a code via resolve_agent_ref() — accepts
//   a code, a full name in either order, a name with the middle dropped, an email or a phone.
//   It refuses to GUESS: ambiguous names and near-miss typos come back with candidates to confirm,
//   because a wrong upline mis-credits an entire downline. Action `resolve_upline` powers the
//   form's live confirmation. save_contact's direct_to uses the same resolver.
// v17 (2026-09-05): the org root counts as a COMPLETE profile without an upline.
// v16 (2026-09-03): honours tracker_agents.platform_admin, and authorises Operations through
//   ops_authorize() instead of the literal "2026". platform_admin counts as EMD+Ops everywhere
//   in this file and grants "super" access scope, without touching contract_level.
// v15: signup uses the AGENT'S OWN GFI-assigned code instead of a random one.
// Actions: get_profile / save_contact / save_photo / signup / resolve_upline / roster / base_ops /
//          enable_bookable / set_level.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm  = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 300);
const lo    = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const fullName = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
// Builder rights: full EMD/Ops power without a promotion. See is_platform_admin() in the DB.
const isPlatformAdmin = (a: any) => !!(a && a.platform_admin === true);

async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
// A live Operations session (ops-auth) or a machine token.
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = (session ?? "").toString().trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
// The top of the org tree, resolved from the tree itself (never a hardcoded name).
let ROOT_CODE = "";
async function orgRoot(): Promise<string> { if (ROOT_CODE) return ROOT_CODE; try { const r = await rpc("org_root_code", {}); ROOT_CODE = norm(r); } catch (_) { ROOT_CODE = ""; } return ROOT_CODE; }

/* "Who did they mean?" — one shared answer for a code, a name, an email or a phone number.
   Never pass an uppercased string in: the resolver needs the text as typed. */
type Ref = { ok: boolean; code?: string; name?: string; baseshop?: string; status?: string;
             how?: string; confidence?: number; reason?: string; candidates?: any[] };
async function resolveRef(text: unknown, exclude?: string): Promise<Ref> {
  const r = await rpc("resolve_agent_ref", { p_text: (text ?? "").toString(), p_exclude: exclude || null });
  if (!r || typeof r !== "object") return { ok: false, reason: "no_match", candidates: [] };
  return r as Ref;
}
// One wording for every place a lookup fails, so the person is told what to do next.
function refError(r: Ref, what = "recruiter"): string {
  const list = Array.isArray(r.candidates) ? r.candidates : [];
  if (r.reason === "ambiguous") {
    return `More than one person goes by that name — ${list.map((c: any) => `${c.name} (${c.code})`).join(" or ")}. ` +
           `Enter their GFI code instead so we attach you to the right one.`;
  }
  if (r.reason === "uncertain" && list.length) {
    return `We couldn't find that exactly. Did you mean ${list.map((c: any) => `${c.name} (${c.code})`).join(" or ")}? ` +
           `Enter their GFI code to confirm.`;
  }
  return `We couldn't find your ${what}. Check the spelling, or enter their GFI code — whoever invited you can tell you what it is.`;
}

/* "Does this person already exist?" — email and phone are near-certain, a shared name is worth
   asking about but not blocking outright. */
type Conflict = { code: string; name: string; baseshop: string; upline: string; status: string; has_email: boolean; why: string };
async function findConflicts(first: string, last: string, email: string, phone: string, exclude: string): Promise<Conflict[]> {
  const r = await rpc("find_person_conflicts", { p_first: first, p_last: last, p_email: email || null, p_phone: phone || null, p_exclude: exclude || null });
  return Array.isArray(r) ? r as Conflict[] : [];
}
function conflictMessage(list: Conflict[]): string {
  const c = list[0];
  const where = c.baseshop ? ` in ${c.baseshop}` : "";
  const under = c.upline ? `, under ${c.upline}` : "";
  const gone  = c.status === "quit" ? " (marked as departed)" : "";
  if (c.why === "email") {
    return `An account already uses that email address: ${c.name} — code ${c.code}${where}${gone}. ` +
           `That is almost certainly you. Sign in with ${c.code} instead of creating a second account.`;
  }
  if (c.why === "phone") {
    return `An account already uses that phone number: ${c.name} — code ${c.code}${where}${gone}. ` +
           `If that is you, sign in with ${c.code} rather than registering again.`;
  }
  return `${c.name} is already on the platform — code ${c.code}${where}${under}${gone}. ` +
         `If that is you, sign in with ${c.code}. If you are a different person with the same name, choose Continue.`;
}

function normLevel(v: unknown): string {
  const s = (v ?? "").toString().trim().toLowerCase();
  /* NVP sits above EMD; for access purposes it is EMD-tier. It used to fall through to
     "Associate", which refused Elijah every set_level. */
  if (s === "emd" || s === "nvp" || s.includes("executive") || s.includes("vice president")) return "EMD";
  if (s === "md" || (s.includes("marketing director") && !s.includes("executive"))) return "MD";
  if (s.includes("senior")) return "Senior Associate";
  return "Associate";
}
/* v23 (handoff sections 7 and 9): contract levels come from the live catalog in
   app_settings.contract_rates, in its ladder order, stored under the spelling already used on
   the roster. Anything not in the catalog is refused, never folded into "Associate" (which is
   what used to happen to "National Vice President" -- assigning NVP demoted the person). */
const LEVEL_ORDER: [string, string[]][] = [
  ["Associate", ["associate"]],
  ["Senior Associate", ["senior associate"]],
  ["MD", ["md", "marketing director"]],
  ["EMD", ["emd", "executive marketing director"]],
  ["National Vice President", ["national vice president", "nvp"]],
];
async function levelCatalog(): Promise<string[]> {
  const rates = await loadKey("contract_rates");
  const keys = (rates && typeof rates === "object") ? Object.keys(rates).map((k) => k.toLowerCase()) : [];
  return LEVEL_ORDER.filter(([, al]) => al.some((a) => keys.indexOf(a) >= 0)).map(([l]) => l);
}
function catalogLevel(v: unknown, cat: string[]): string | null {
  const s = (v ?? "").toString().trim().toLowerCase();
  const hit = LEVEL_ORDER.find(([l, al]) => l.toLowerCase() === s || al.indexOf(s) >= 0);
  return hit && cat.indexOf(hit[0]) >= 0 ? hit[0] : null;
}
const levelRank = (l: unknown) => LEVEL_ORDER.findIndex(([n, al]) => n.toLowerCase() === String(l ?? "").trim().toLowerCase() || al.indexOf(String(l ?? "").trim().toLowerCase()) >= 0);
function levelToRole(l: string): string { return l === "EMD" ? "exec" : l === "MD" ? "senior" : "agent"; }
function levelToTitle(l: string): string { return l === "EMD" ? "Executive Marketing Director" : l === "MD" ? "Marketing Director" : l; }

async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, value: unknown) { return fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value, updated_at: new Date().toISOString() }) }); }
const loadCftAvail = () => loadKey("cft_availability");
const saveCftAvail = (v: unknown) => saveKey("cft_availability", v);
const loadOrg = () => loadKey("org_structure");
const saveOrg = (v: unknown) => saveKey("org_structure", v);
const loadBases = () => loadKey("baseshops");
async function getAgent(code: string) { const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,email,phone,cal_link,title,md,emd,contract_level,baseshop,ica,ica_date,state,direct_to,direct_to_name,status,platform_admin`, { headers: DBH }); return ((await r.json()) || [])[0] || null; }
async function getPhoto(code: string): Promise<string | null> { const r = await fetch(`${SUPA}/rest/v1/hub_avatars?code=eq.${encodeURIComponent(code)}&select=url`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].url : null; }
async function allCodes(): Promise<Set<string>> { const r = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code`, { headers: DBH }); const rows = (await r.json()) || []; return new Set(rows.map((x: any) => (x.code || "").toUpperCase())); }
function titleIsEmd(t: string) { return /executive marketing/i.test(t || ""); }
function titleIsMd(t: string) { return /marketing director/i.test(t || "") && !/executive/i.test(t || ""); }
/* v24: the assigned contract level only. `title` is free text and is not authority (checked live:
   no leader depended on a title fallback). */
function agentLevel(a: any): string { return a?.contract_level ? normLevel(a.contract_level) : "Associate"; }
function accessibleBases(baseshop: string, bases: any): string[] {
  const list = (bases && Array.isArray(bases.bases)) ? bases.bases : [];
  const byName: Record<string, any> = {}; list.forEach((b: any) => byName[b.name] = b);
  const root = (bases && bases.root) || "STANDARD";
  const out: string[] = []; const queue: string[] = [baseshop || root]; let g = 0;
  while (queue.length && g++ < 60) { const cur = queue.shift(); if (!cur || out.includes(cur)) continue; out.push(cur); const b = byName[cur]; if (b) { if (b.parent) queue.push(b.parent); if (Array.isArray(b.also)) b.also.forEach((x: string) => queue.push(x)); } }
  if (!out.includes(root)) out.push(root); return out;
}
function accessInfo(a: any, bases: any, isAdmin: boolean) {
  const list = (bases && Array.isArray(bases.bases)) ? bases.bases : [];
  const superOwn = list.find((b: any) => b.super && norm(b.owner_code) === norm(a?.code));
  const own = list.find((b: any) => norm(b.owner_code) === norm(a?.code) && !b.super);
  let scope = "member";
  if (isAdmin || superOwn || isPlatformAdmin(a)) scope = "super";
  else if (own || agentLevel(a) === "MD" || agentLevel(a) === "EMD") scope = "base_owner";
  return { baseshop: a?.baseshop || "STANDARD", scope, owns_base: superOwn ? superOwn.name : (own ? own.name : "") };
}
async function callerIsManager(code: string, isAdmin: boolean): Promise<boolean> { if (isAdmin) return true; if (!code) return false; const a = await getAgent(code); if (!a) return false; if (isPlatformAdmin(a)) return true; const l = agentLevel(a); return l === "MD" || l === "EMD"; }
async function callerIsEmdOrOps(code: string, isAdmin: boolean): Promise<boolean> { if (isAdmin) return true; if (!code) return false; const a = await getAgent(code); if (!a) return false; return isPlatformAdmin(a) || agentLevel(a) === "EMD"; }
async function sameBaseOrSuper(callerCode: string, isAdmin: boolean, target: any): Promise<boolean> {
  if (isAdmin) return true;
  const me = await getAgent(callerCode); const bases = await loadBases(); const acc = accessInfo(me, bases, isAdmin);
  if (acc.scope === "super") return true;
  return (target.baseshop || "STANDARD") === acc.baseshop;
}
// The root of the org has no upline and never will, so it is complete without one.
function profileComplete(row: any, root = ""): boolean {
  const hasUpline = !!clean(row.direct_to) || (!!root && norm(row.code) === norm(root));
  return !!(clean(row.first_name) && clean(row.last_name) && clean(row.phone) && clean(row.email) && clean(row.state) && hasUpline);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }
  const action = String(body.action || "");
  const token = String(body.token || "");
  // One Operations authorisation for the whole request.
  const isAdmin = await opsAuthorized(token);
  // `code` is DATA for the two public join-form actions below (the code being registered, or the
  // one to exclude from a lookup). For everything after them it is overwritten with the verified
  // identity, so every check downstream is sound without being moved.
  let code = norm(body.code);

  // Live confirmation for the join form: "who is this?" before anything is written.
  // Returns only name / code / baseshop — never contact details — and needs at least two
  // characters, so it cannot be used to page through the roster.
  if (action === "resolve_upline") {
    const q = clean(body.q ?? body.upline_code ?? body.text);
    if (q.length < 2) return json({ ok: false, reason: "empty" });
    const r = await resolveRef(q, norm(body.code));
    const trim = (c: any) => ({ code: c.code, name: c.name, baseshop: c.baseshop, status: c.status });
    return json({
      ok: !!r.ok,
      code: r.code || "", name: r.name || "", baseshop: r.baseshop || "",
      how: r.how || "", reason: r.reason || "",
      candidates: (Array.isArray(r.candidates) ? r.candidates.slice(0, 5).map(trim) : []),
      message: r.ok ? "" : refError(r),
    });
  }

  if (action === "signup") {
    const first = clean(body.first_name), last = clean(body.last_name);
    const email = clean(body.email), phone = clean(body.phone);
    const uplineRaw = clean(body.upline_code);   // as TYPED — may be a name, email or phone
    const myCode = norm(body.code);
    /* A new account always starts as Associate. The level someone types about themselves is not
       authority: a self-registered "EMD" used to become an approver and a standards editor. The
       upline, an EMD or Operations assigns the real level afterwards with set_level. */
    const level = "Associate";
    if (!first || !last) return json({ ok: false, error: "Please enter your first and last name." });
    if (!myCode) return json({ ok: false, error: "Enter the GFI code you were assigned." });
    if (!/^[A-Z0-9]{2,12}$/.test(myCode)) return json({ ok: false, error: "That GFI code doesn't look right — use the letters and numbers GFI gave you." });
    if (!uplineRaw) return json({ ok: false, error: "Enter your direct recruiter — their name or their GFI code." });

    const used = await allCodes();
    if (used.has(myCode)) return json({ ok: false, error: "That GFI code is already registered — sign in with it instead." });

    // THE DUPLICATE GUARD. Checked before anything is written, and before we bother resolving the
    // upline, so the person is not asked to fix a recruiter name on a signup that should not happen.
    if (body.confirm_duplicate !== true) {
      const conflicts = await findConflicts(first, last, email, phone, myCode);
      if (conflicts.length) {
        return json({
          ok: false, reason: "duplicate_person",
          error: conflictMessage(conflicts),
          existing: conflicts.slice(0, 4),
          // A shared name is plausible; a shared email almost never is. The form makes
          // "that's me" the obvious action either way.
          can_override: true,
        });
      }
    }

    // Name, code, email or phone — all accepted. Excluding myCode stops anyone recruiting themselves.
    const ref = await resolveRef(uplineRaw, myCode);
    if (!ref.ok || !ref.code) {
      return json({ ok: false, error: refError(ref), reason: ref.reason || "no_match",
                    candidates: Array.isArray(ref.candidates) ? ref.candidates.slice(0, 5) : [] });
    }
    const upCode = norm(ref.code);
    if (myCode === upCode) return json({ ok: false, error: "Your GFI code and your recruiter's code can't be the same." });
    const up = await getAgent(upCode);
    if (!up) return json({ ok: false, error: "That recruiter code wasn't found. Check with whoever invited you." });
    const newCode = myCode;
    const upName = fullName(up); const upLevel = agentLevel(up);
    const derivedMd  = (upLevel === "MD")  ? upName : (up.md  || "");
    const derivedEmd = (upLevel === "EMD") ? upName : (up.emd || "");
    const md  = (level === "MD")  ? `${first} ${last}` : (level === "EMD" ? "" : derivedMd);
    const emd = (level === "EMD") ? `${first} ${last}` : derivedEmd;
    const baseshop = up.baseshop || "STANDARD";
    const ins = await fetch(`${SUPA}/rest/v1/tracker_agents`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ code: newCode, first_name: first, last_name: last, email: email || null, phone: phone || null, md: md || null, emd: emd || null, title: levelToTitle(level), contract_level: level, baseshop, direct_to: upCode, direct_to_name: upName, status: "active" }) });
    if (!ins.ok) { const t = await ins.text(); return json({ ok: false, error: "Could not create your account.", detail: t.slice(0, 200) }); }
    const org = await loadOrg();
    if (org && Array.isArray(org.nodes)) {
      let upNode = org.nodes.find((n: any) => norm(n.id) === upCode);
      if (!upNode) upNode = org.nodes.find((n: any) => norm(n.gfi) === upCode);
      const parentId = upNode ? upNode.id : upCode;
      const maxOrd = org.nodes.reduce((m: number, n: any) => Math.max(m, Number(n.ord) || 0), 0);
      org.nodes.push({ id: newCode, name: `${first} ${last}`, parent: parentId, role: levelToRole(level), title: levelToTitle(level), ord: maxOrd + 1, baseshop: (upNode && upNode.baseshop) || baseshop });
      await saveOrg(org);
    }
    // matched_by tells the form whether we read a code or worked it out from a name.
    return json({ ok: true, code: newCode, name: `${first} ${last}`, upline: upName, upline_code: upCode,
                  matched_by: ref.how || "code", contract_level: level, baseshop });
  }

  /* ===== everything past here is about a real account, so it needs proof ===== */
  const sessCode = isAdmin ? "" : await sessionCode(body.session);
  if (!isAdmin && !sessCode) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
  code = isAdmin ? norm(body.code) : sessCode;

  if (action === "roster") {
    if (!code) return json({ ok: false, error: "sign in required" }, 401);
    const me = await getAgent(code); const myName = me ? fullName(me) : "";
    const r = await fetch(`${SUPA}/rest/v1/tracker_agents?or=(md.eq.${encodeURIComponent(myName)},emd.eq.${encodeURIComponent(myName)})&status=neq.quit&select=code,first_name,last_name,email,phone,title,contract_level,baseshop&order=first_name.asc`, { headers: DBH });
    const rows = (await r.json()) || [];
    const avail = await loadCftAvail(); const bookable = new Set((avail && Array.isArray(avail.cfts)) ? avail.cfts.map((c: any) => lo(c.name)) : []);
    return json({ ok: true, roster: rows.map((a: any) => ({ code: a.code, name: fullName(a), email: a.email || "", phone: a.phone || "", title: a.title || "", contract_level: a.contract_level || "Associate", baseshop: a.baseshop || "STANDARD", bookable: bookable.has(lo(fullName(a))) })) });
  }

  if (action === "base_ops") {
    if (!code) return json({ ok: false, error: "sign in required" }, 401);
    const me = await getAgent(code); if (!me) return json({ ok: false, error: "not found" }, 404);
    const bases = await loadBases(); const acc = accessInfo(me, bases, isAdmin);
    if (acc.scope === "member") return json({ ok: false, error: "Ops access is for base owners and managers." }, 403);
    const baseList = (bases && Array.isArray(bases.bases)) ? bases.bases.map((b: any) => b.name) : ["STANDARD"];
    let viewBase = acc.baseshop; let all = false;
    if (acc.scope === "super") { const req = norm(body.base); if (req === "ALL" || body.all === true) all = true; else if (req) viewBase = req; }
    const filter = all ? "" : `&baseshop=eq.${encodeURIComponent(viewBase)}`;
    const r = await fetch(`${SUPA}/rest/v1/tracker_agents?status=neq.quit${filter}&select=code,first_name,last_name,email,phone,contract_level,baseshop,md,emd&order=contract_level.asc,first_name.asc`, { headers: DBH });
    const rows = (await r.json()) || [];
    const avail = await loadCftAvail(); const bookable = new Set((avail && Array.isArray(avail.cfts)) ? avail.cfts.map((c: any) => lo(c.name)) : []);
    return json({ ok: true, scope: acc.scope, base: all ? "ALL" : viewBase, bases: acc.scope === "super" ? baseList : accessibleBases(acc.baseshop, bases), count: rows.length,
      people: rows.map((a: any) => ({ code: a.code, name: fullName(a), email: a.email || "", phone: a.phone || "", contract_level: a.contract_level || "Associate", baseshop: a.baseshop || "STANDARD", md: a.md || "", emd: a.emd || "", bookable: bookable.has(lo(fullName(a))) })) });
  }

  if (action === "enable_bookable") {
    if (!(await callerIsManager(code, isAdmin))) return json({ ok: false, error: "Only an MD, EMD, or Ops can make someone bookable." }, 401);
    const target = norm(body.target_code); if (!target) return json({ ok: false, error: "target required" });
    const a = await getAgent(target); if (!a) return json({ ok: false, error: "agent not found" }, 404);
    if (!(await sameBaseOrSuper(code, isAdmin, a))) return json({ ok: false, error: "You can only manage people in your own baseshop." }, 403);
    const nm = fullName(a); const lvl = agentLevel(a);
    const avail = await loadCftAvail() || { cfts: [] }; avail.cfts = Array.isArray(avail.cfts) ? avail.cfts : [];
    let idx = avail.cfts.findIndex((c: any) => lo(c.name) === lo(nm));
    const wantOn = body.bookable !== false;
    if (wantOn) {
      if (idx < 0) { avail.cfts.push({ name: nm, code: target, role: lvl === "EMD" ? "EMD" : (lvl === "MD" ? "MD" : "CFT"), baseshop: a.baseshop || "STANDARD", slots: {}, blackouts: [], vacations: [], buffer_before: 0, buffer_after: 0, locked: false, calendly: a.cal_link || "", email: a.email || "", phone: a.phone || "" }); }
      else { avail.cfts[idx].hidden = false; }
    } else if (idx >= 0) { avail.cfts[idx].hidden = true; }
    await saveCftAvail(avail);
    return json({ ok: true, name: nm, bookable: wantOn });
  }

  if (action === "level_catalog") {
    return json({ ok: true, levels: await levelCatalog() });
  }

  if (action === "set_level") {
    const me = code ? await getAgent(code) : null;
    const builder = isPlatformAdmin(me);
    if (!(await callerIsEmdOrOps(code, isAdmin))) return json({ ok: false, error: "Only an EMD or Operations can change contract levels." }, 401);
    const target = norm(body.target_code); if (!target) return json({ ok: false, error: "target required" });
    if (target === code && !isAdmin && !builder) return json({ ok: false, error: "You can’t change your own contract level." }, 403);
    const a = await getAgent(target); if (!a) return json({ ok: false, error: "agent not found" }, 404);
    if (!(await sameBaseOrSuper(code, isAdmin, a))) return json({ ok: false, error: "You can only manage people in your own baseshop." }, 403);
    const cat = await levelCatalog();
    const level = catalogLevel(body.level, cat); const nm = fullName(a);
    if (!level) return json({ ok: false, error: `That is not a contract level. Choose one of: ${cat.join(", ")}.`, levels: cat }, 400);
    /* An EMD assigns levels up to their own, never above it. Operations and the platform builder
       are not limited. */
    if (!isAdmin && !builder && levelRank(level) > levelRank(me && me.contract_level)) return json({ ok: false, error: "You can only assign a contract level up to your own." }, 403);
    /* Contract level ONLY. Title (leadership rank), the md/emd chain and the org-chart role are
       separate things and are not changed by a pay level -- the brief is explicit that picking a
       contract must not make someone an EMD administrator. */
    const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(target)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ contract_level: level }) });
    if (!up.ok) return json({ ok: false, error: "Could not update." });
    return json({ ok: true, name: nm, contract_level: level });
  }

  if (!code) return json({ ok: false, error: "sign in required" }, 401);
  const avail = await loadCftAvail();
  /* WHOSE trainer row. This used to be `body.current_name` — a typed name — so save_contact could
     overwrite another trainer's phone, email and Calendly link and silently redirect their
     bookings. It is the signed-in person's own name now. */
  const meRow = await getAgent(code);
  const currentName = isAdmin ? (clean(body.current_name) || (meRow ? fullName(meRow) : "")) : (meRow ? fullName(meRow) : "");
  const cftIdx = (avail && Array.isArray(avail.cfts) && currentName) ? avail.cfts.findIndex((c: any) => lo(c.name) === lo(currentName)) : -1;

  if (action === "get_profile") {
    const row = meRow || {};
    const bases = await loadBases(); const acc = accessInfo(row, bases, isAdmin);
    const root = await orgRoot();
    return json({ ok: true, profile: { code, first_name: row.first_name || "", last_name: row.last_name || "", email: row.email || "", phone: row.phone || "", calendly: row.cal_link || "", title: row.title || "", contract_level: row.contract_level || "", ica: row.ica || "", ica_date: row.ica_date || "", state: row.state || "", direct_to: row.direct_to || "", direct_to_name: row.direct_to_name || "", baseshop: acc.baseshop, access_scope: acc.scope, owns_base: acc.owns_base, platform_admin: isPlatformAdmin(row), is_org_root: !!root && norm(code) === norm(root), profile_complete: profileComplete({ ...row, code }, root), accessible_bases: acc.scope === "super" ? ((bases && Array.isArray(bases.bases)) ? bases.bases.map((b: any) => b.name) : ["STANDARD"]) : accessibleBases(acc.baseshop, bases), photo: await getPhoto(code), google_connected: cftIdx >= 0 ? !!avail.cfts[cftIdx].google_connected : false, is_trainer: cftIdx >= 0 } });
  }

  if (action === "save_photo") {
    const url = (body.photo || "").toString(); if (!url || url.length > 3000000) return json({ ok: false, error: "Photo missing or too large (keep under ~2MB)." });
    const up = await fetch(`${SUPA}/rest/v1/hub_avatars?on_conflict=code`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ code, url, updated_at: new Date().toISOString() }) });
    return json({ ok: up.ok });
  }

  if (action === "save_contact") {
    const patch: Record<string, unknown> = {};
    if (body.email     !== undefined) patch.email = clean(body.email);
    if (body.phone     !== undefined) patch.phone = clean(body.phone);
    /* v22 (2026-10-26): the Calendly booking link is validated, not just stored. It is rendered
       as a link on the profile and handed to clients, so only an https Calendly page is accepted;
       a bare "calendly.com/name" gets its https:// added. Blank clears it, which is an honest
       "not set up" -- it never claims a connection. */
    if (body.calendly  !== undefined) {
      let link = clean(body.calendly);
      if (link && /^(www\.)?calendly\.com\//i.test(link)) link = "https://" + link;
      if (link && !/^https:\/\/(www\.)?calendly\.com\/[A-Za-z0-9._~\/?=&%-]+$/i.test(link)) {
        return json({ ok: false, field: "calendly", error: "That is not a Calendly booking link. It should look like https://calendly.com/your-name." });
      }
      patch.cal_link = link;
    }
    if (body.first_name!== undefined) patch.first_name = clean(body.first_name);
    if (body.last_name !== undefined) patch.last_name = clean(body.last_name);
    if (body.ica       !== undefined) patch.ica = clean(body.ica);
    if (body.ica_date  !== undefined) patch.ica_date = clean(body.ica_date);
    if (body.state     !== undefined) patch.state = clean(body.state);
    // Same resolver as signup — someone correcting their upline in their profile types a name
    // just as readily as a new recruit does.
    if (body.direct_to !== undefined) {
      const typed = clean(body.direct_to);
      /* v23 (handoff 7/8): once a recruiter link exists, a profile edit cannot move it or clear it.
         Reparenting goes through org-api set_upline (EMD/Operations), which is audited. Setting a
         missing upline, or re-sending the same one, is still allowed. */
      const had = norm(meRow && meRow.direct_to);
      if (had && !isAdmin) {
        const same = typed && (norm(typed) === had || lo(typed) === lo(meRow.direct_to_name));
        if (!same) return json({ ok: false, field: "direct_to", error: `Your recruiter is already set to ${meRow.direct_to_name || had}. Ask your EMD or Operations if it needs to change.` }, 403);
      }
      if (!typed) { if (had && isAdmin) { patch.direct_to = ""; patch.direct_to_name = ""; patch.upline_set_by = "OPS"; } }
      else if (had && !isAdmin && norm(typed) === had) { /* unchanged */ }
      else {
        const ref = await resolveRef(typed, code);
        if (!ref.ok || !ref.code) {
          return json({ ok: false, error: refError(ref, "upline"), reason: ref.reason || "no_match",
                        candidates: Array.isArray(ref.candidates) ? ref.candidates.slice(0, 5) : [] });
        }
        if (had && !isAdmin && norm(ref.code) !== had) return json({ ok: false, field: "direct_to", error: `Your recruiter is already set to ${meRow.direct_to_name || had}. Ask your EMD or Operations if it needs to change.` }, 403);
        patch.direct_to = norm(ref.code);
        patch.upline_set_by = isAdmin ? "OPS" : code;   // recorded in org_upline_changes by the trigger
        const up2 = await getAgent(norm(ref.code));
        patch.direct_to_name = up2 ? fullName(up2) : (ref.name || "");
      }
    }
    let ok = true;
    if (Object.keys(patch).length) {
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      ok = up.ok;
      /* Say why. The org-chart guard refuses an upline that would put someone under their own
         team; before this the person only ever saw "Save failed". */
      if (!ok) {
        const t = await up.text();
        const why = /BELOW them|close a loop/i.test(t) ? "That person is already in your own team, so they can't be your recruiter."
          : /their own upline/i.test(t) ? "You can't be your own recruiter."
          : /top of the organisation/i.test(t) ? "You're at the top of the organisation, so you have no recruiter."
          : /does not exist on the roster/i.test(t) ? "That recruiter isn't on the roster yet. Ask Operations to add them first."
          : "Could not save your details. Try again, or tell Operations.";
        return json({ ok: false, detail: t.slice(0, 200), error: why });
      }
    }
    if (cftIdx >= 0) {
      const t = avail.cfts[cftIdx];
      if (body.phone    !== undefined) t.phone = clean(body.phone);
      if (body.email    !== undefined) t.email = clean(body.email);
      if (body.calendly !== undefined) t.calendly = String(patch.cal_link ?? "");
      if (body.first_name !== undefined || body.last_name !== undefined) { const nn = (clean(body.first_name) + " " + clean(body.last_name)).trim(); if (nn) t.name = nn; }
      avail.cfts[cftIdx] = t; await saveCftAvail(avail);
    }
    const fresh = await getAgent(code);
    const root = await orgRoot();
    return json({ ok, profile_complete: fresh ? profileComplete(fresh, root) : false, direct_to: (patch.direct_to as string) ?? (fresh ? fresh.direct_to : ""), direct_to_name: (patch.direct_to_name as string) ?? (fresh ? fresh.direct_to_name : "") });
  }
  return json({ ok: false, error: "unknown action" }, 400);
});
