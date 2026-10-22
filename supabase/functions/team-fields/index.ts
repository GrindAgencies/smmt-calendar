// team-fields v2 (2026-09-30) — custom fields on the My Team chart.
//
// Christopher: "on the my team chart. please allow for us to add custom fields to the mix.
// for instance to track upcoming events within GFI"
//
// A leader wants to track something the platform does not model — who is going to the GFI
// convention, who finished a bootcamp, who has their headshot done. Rather than guess at those
// in advance, they define the field themselves and it becomes a chip on every person's card.
//
// v2: WHO IS ASKING. v1 wrote careful rules — leaders define, own downline only, company-wide
// fields for Operations — and then read the caller's identity from a typed `code`. GFI codes are
// printed on the org chart, so typing a leader's code let you define fields for their shop and
// annotate their people, and typing the platform builder's code granted `admin`, which is
// company-wide fields and every shop. Identity is now the session token minted at PIN entry.
//
// DEFINITIONS   app_settings.team_custom_fields
// VALUES        tracker_agents.custom  — the SAME jsonb the Ops tracker already writes, so a
//               field defined here and a column defined there cannot disagree about where the
//               answer lives. 41 agents already carry values in it.
//
// WHO SEES WHAT. A field created by an EMD belongs to their baseshop and is invisible to the
// others. A field created by Operations, the platform builder or the org root is company-wide —
// which is what a GFI event needs, since a convention is not one shop's business.
//
// WHO MAY SET A VALUE. Only on someone in your OWN downline, walked from direct_to by
// is_in_downline(). A leader cannot annotate another leader's people, and an agent with no
// downline cannot annotate anyone. Operations and the org root reach everyone.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 300) => (s ?? "").toString().trim().slice(0, n);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const has = (v: unknown) => !!(v && String(v).trim());
const TYPES = ["text", "date", "check", "select"];
const normType = (t: unknown) => TYPES.indexOf(low(t)) >= 0 ? low(t) : "text";
const FIELDKEY = "team_custom_fields";
const MAXFIELDS = 12;   // a chart, not a spreadsheet — past this the cards stop being readable

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function loadKey(k: string) { const rows = await getJSON(`app_settings?key=eq.${encodeURIComponent(k)}&select=value`); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, v: unknown) {
  return fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) });
}
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
async function agentScope(code: string) {
  const r = await rpc("agent_scope", { p_code: norm(code) });
  if (!r || r.ok !== true) return { ok: false, all: false, bases: [] as string[], baseshop: "" };
  return { ok: true, all: !!r.all, bases: Array.isArray(r.bases) ? r.bases.map((x: unknown) => norm(x)) : [], baseshop: norm(r.baseshop) };
}
async function getAgent(code: string) {
  const rows = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(norm(code))}&select=code,first_name,last_name,contract_level,title,baseshop,platform_admin,custom&limit=1`);
  return rows[0] || null;
}
const LEADERY = /(^|\b)(md|emd|nvp|sevp|marketing director|executive marketing director|national vice president|senior executive)(\b|$)/i;
function looksLikeLeader(a: any) {
  return LEADERY.test(String(a?.contract_level || "")) || LEADERY.test(String(a?.title || ""));
}

/* Fields this caller should see: their own shop's, plus every company-wide one. */
function visibleFields(all: any[], sc: { all: boolean; bases: string[] }) {
  return all.filter((f) => {
    const b = norm(f.baseshop);
    if (!b) return true;                 // company-wide
    if (sc.all) return true;             // Operations / org root / platform builder
    return sc.bases.indexOf(b) >= 0;
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const action = String(body.action || "list");
  const isOps = await opsAuthorized(body.token);
  // Operations may act for a named person; everybody else is whoever the session says they are.
  const me = isOps ? norm(body.code) : await sessionCode(body.session);

  if (!me && !isOps) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

  const meRow = me ? await getAgent(me) : null;
  if (me && !meRow) return json({ ok: false, error: "We couldn't find your record." }, 404);
  const sc = me ? await agentScope(me) : { ok: true, all: true, bases: [], baseshop: "" };
  const admin = isOps || !!(meRow && meRow.platform_admin === true) || sc.all;
  // Defining a field shapes what a whole team tracks, so it sits with leaders, not everyone.
  const canDefine = admin || looksLikeLeader(meRow);

  const raw = await loadKey(FIELDKEY);
  const allFields: any[] = Array.isArray(raw) ? raw : [];

  /* ---------- the fields, and every value across this leader's downline ---------- */
  if (action === "list") {
    const fields = visibleFields(allFields, sc);
    const values: Record<string, Record<string, unknown>> = {};
    if (fields.length) {
      // One request for the whole team rather than one per person.
      const rows = await getJSON(`tracker_agents?select=code,custom&custom=not.is.null&limit=5000`);
      const keys = new Set(fields.map((f) => String(f.key)));
      for (const r of rows) {
        const c = (r.custom && typeof r.custom === "object") ? r.custom : {};
        const keep: Record<string, unknown> = {};
        for (const k in c) if (keys.has(k) && has(c[k])) keep[k] = c[k];
        if (Object.keys(keep).length) values[norm(r.code)] = keep;
      }
    }
    return json({ ok: true, fields, values, can_define: canDefine, admin, baseshop: sc.baseshop });
  }

  /* ---------- define a new field ---------- */
  if (action === "add") {
    if (!canDefine) return json({ ok: false, error: "Adding a field is for Marketing Directors and above." }, 403);
    const label = clean(body.label, 40);
    if (!label) return json({ ok: false, error: "Give the field a name." });
    if (allFields.length >= MAXFIELDS) return json({ ok: false, error: `That is the limit of ${MAXFIELDS} fields — remove one first.` });
    const type = normType(body.type);
    const options = (type === "select" && Array.isArray(body.options))
      ? body.options.map((o: unknown) => clean(o, 40)).filter(has).slice(0, 20) : [];
    if (type === "select" && !options.length) return json({ ok: false, error: "A choice field needs at least one option." });
    // Only someone who can see every shop may create a company-wide field. A leader's field
    // belongs to their own baseshop, so it never appears on another shop's chart.
    const wantAll = body.scope === "company";
    const baseshop = (wantAll && admin) ? "" : sc.baseshop;
    if (allFields.some((f) => low(f.label) === low(label) && norm(f.baseshop) === norm(baseshop))) {
      return json({ ok: false, error: `There is already a field called “${label}”.` });
    }
    const rec = {
      key: crypto.randomUUID().slice(0, 8), label, type, options, baseshop,
      by: me || "OPS", by_name: meRow ? `${meRow.first_name || ""} ${meRow.last_name || ""}`.trim() : "Operations",
      created_at: new Date().toISOString(),
    };
    allFields.push(rec);
    await saveKey(FIELDKEY, allFields);
    return json({ ok: true, field: rec, fields: visibleFields(allFields, sc) });
  }

  /* ---------- remove a field (the definition; values are left alone) ---------- */
  if (action === "remove") {
    if (!canDefine) return json({ ok: false, error: "Removing a field is for Marketing Directors and above." }, 403);
    const k = clean(body.key, 40);
    const f = allFields.find((x) => String(x.key) === k);
    if (!f) return json({ ok: false, error: "Field not found." }, 404);
    // You may only remove a field your own shop owns, unless you can see every shop.
    if (!admin && norm(f.baseshop) !== norm(sc.baseshop)) {
      return json({ ok: false, error: "That field belongs to another baseshop." }, 403);
    }
    if (!admin && !has(f.baseshop)) {
      return json({ ok: false, error: "Company-wide fields are removed by Operations." }, 403);
    }
    const next = allFields.filter((x) => String(x.key) !== k);
    await saveKey(FIELDKEY, next);
    return json({ ok: true, removed: k, fields: visibleFields(next, sc) });
  }

  /* ---------- set one person's value ---------- */
  if (action === "set") {
    const target = norm(body.target);
    const k = clean(body.key, 40);
    if (!target || !k) return json({ ok: false, error: "Who, and which field?" });
    const f = allFields.find((x) => String(x.key) === k);
    if (!f) return json({ ok: false, error: "Field not found." }, 404);
    if (!visibleFields([f], sc).length) return json({ ok: false, error: "That field belongs to another baseshop." }, 403);

    // THE BOUNDARY: your own downline only. Walked from direct_to in the database so this
    // cannot drift from what the org chart shows.
    if (!admin) {
      const inDl = await rpc("is_in_downline", { p_leader: me, p_target: target });
      if (inDl !== true) return json({ ok: false, error: "You can only update people on your own team." }, 403);
    }

    const t = await getAgent(target);
    if (!t) return json({ ok: false, error: "That person was not found." }, 404);
    const cur: Record<string, unknown> = (t.custom && typeof t.custom === "object") ? { ...t.custom } : {};
    const val = clean(body.value, 200);
    if (!has(val)) delete cur[k]; else cur[k] = val;

    const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(target)}`, {
      method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ custom: cur, updated_at: new Date().toISOString() }),
    });
    if (!up.ok) return json({ ok: false, error: "Could not save that." });
    return json({ ok: true, code: target, key: k, value: has(val) ? val : "" });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
