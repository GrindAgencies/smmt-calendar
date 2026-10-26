// ops-newbiz v13 — MULTI-BOARD column-driven ticket boards. board='newbiz' or 'gfi'.
// v8: authorisation is an Operations session rather than the literal "2026".
//
// v9 (2026-09-03): each Operations seat now runs its OWN board. Until now every seat
// read and wrote the same two app_settings keys, so a baseshop Operations person adding
// a column, recolouring a status or importing their book changed it for everybody — the
// platform looked personal and was in fact shared. Boards are keyed per seat now.
//
// The two halves inherit differently on purpose:
//   COLUMNS  fall back to the shared layout until the seat changes something, so a new
//            seat opens on the familiar board instead of a blank one.
//   TICKETS  never inherit. Their book is theirs; copying the existing board into a new
//            baseshop would be exactly the cross-contamination this is meant to prevent.
//
// v12 (2026-10-15) — A TYPED CODE IS NOT A CREDENTIAL. This board holds client names,
// carriers, premiums, policy numbers and commission notes, and until now there were two
// ways in that required nothing anyone could not read off a screen or an org chart:
//
//   · `operations_users[by_code]` — a four-digit seat code, typed on the sign-in screen
//     every morning, granted full Operations READ AND WRITE.
//   · an agent code belonging to any MD or EMD granted READ. Agent codes are printed on
//     the org chart.
//
// Emptying operations_users on 14 Oct closed both doors and took Operations down with
// them, because four separate functions used that same list to recognise people — tickets
// vanished, New Business emptied, and the master seat could not sign in. So the fix
// belongs here, at the point where the decision is actually made, not in a shared list
// that other code depends on:
//
//   · Operations — an Ops session token, minted at PIN entry. Nothing else.
//   · A leader   — may still READ the board, but must carry their own signed-in agent
//                  session instead of typing a code they can read off a chart.
//
// The seat is now taken from the token as well. `by_code` used to choose WHICH seat's
// private board to open, so any Ops token could read any other seat's book just by naming
// it; and note authorship recorded whatever name and code the caller claimed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SC = { "Top Priority": "#d64550", "Need to Escalate": "#e07a2f", "Awaiting GFI": "#2e86c9", "Awaiting Agent": "#8a63d2", "Confirm Fix": "#1f9c8a", "Needs Attention": "#c99a2e", "Needs Follow Up": "#c99a2e", "Complete": "#1a9c52", "Cancelled": "#8e8e93" };
const STATUS_OPTS = Object.keys(SC).map((v) => ({ value: v, color: (SC as any)[v] }));
const GFI_STATUS = [["Top Priority","#d64550"],["Need to Escalate","#e07a2f"],["Awaiting GFI","#2e86c9"],["Awaiting Agent","#8a63d2"],["Confirm Fix","#1f9c8a"],["Needs Attention","#c99a2e"],["Needs Follow Up","#c99a2e"],["Complete","#1a9c52"],["Resolved","#1a9c52"]].map((x) => ({ value: x[0], color: x[1] }));
const GFI_CAT = [["Commissions","#1a9c52"],["Support Case","#2e86c9"],["Coding","#8a63d2"],["Ethos","#e07a2f"],["Split","#c99a2e"],["Other","#8e8e93"]].map((x) => ({ value: x[0], color: x[1] }));
const DEFAULT_NEWBIZ = [
  { key: "client_name", label: "Client Name", type: "text", options: [] }, { key: "writing_agent", label: "Writing Agent", type: "text", options: [] }, { key: "split_agent", label: "Split Agent", type: "text", options: [] }, { key: "split", label: "Split", type: "text", options: [] }, { key: "state", label: "State", type: "text", options: [] }, { key: "company", label: "Company", type: "text", options: [] }, { key: "date_submitted", label: "Date Submitted", type: "text", options: [] }, { key: "process", label: "Process", type: "text", options: [] }, { key: "status", label: "Status", type: "select", options: STATUS_OPTS }, { key: "policy_num", label: "Policy #", type: "text", options: [] }, { key: "target_premium", label: "Target Premium", type: "money", options: [] }, { key: "product", label: "Product", type: "text", options: [] }, { key: "face_amount", label: "Face Amount", type: "money", options: [] }
];
const DEFAULT_GFI = [
  { key: "client_name", label: "Client / Agent", type: "text", options: [] }, { key: "leader", label: "Leader", type: "text", options: [] }, { key: "ticket", label: "Ticket #", type: "text", options: [] }, { key: "category", label: "Category", type: "select", options: GFI_CAT }, { key: "date", label: "Date Opened", type: "text", options: [] }, { key: "status", label: "Status", type: "select", options: GFI_STATUS }, { key: "description", label: "Description", type: "text", options: [] }
];
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 6000);
const has = (v: unknown) => !!(v && String(v).trim());
const uid = () => crypto.randomUUID().slice(0, 8);
const enc = encodeURIComponent;
const slug = (s: unknown) => (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const color = (c: unknown) => /^#[0-9a-fA-F]{3,8}$/.test(String(c || "")) ? String(c) : "";
const TERMINAL = ["complete", "completed", "resolved"];
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${enc(k)}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, v: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

type Auth = { ok: boolean; role?: string; canEdit?: boolean; name?: string; code?: string; master?: boolean; error?: string };

async function agentLevel(code: string) { const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(norm(code))}&select=contract_level,first_name,last_name`, { headers: DBH }); const rows = await r.json(); return rows[0] || null; }

async function authOf(body: any): Promise<Auth> {
  /* Operations. The token is minted when a seat enters its PIN, expires in 8 hours, and
     carries the seat it belongs to — so the board below is chosen by the credential, not
     by whatever the caller typed. */
  const t = String(body.token ?? "").trim();
  if (t) {
    const r = await rpc("ops_authorize", { p_token: t });
    if (r && r.ok) {
      return { ok: true, role: "ops", canEdit: true, name: String(r.label || "Operations"),
               code: norm(r.code), master: !!r.master };
    }
  }
  /* A leader reading the board. Still allowed — but they have to be signed in as
     themselves. A typed code proves nothing: every one of them is on the org chart. */
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return { ok: false, error: "Sign in to Operations to open this board." };
  const got = await rpc("agent_session_code", { p_token: s });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { ok: false, error: "Your session has expired — sign in again." };
  const a = await agentLevel(code);
  if (a) {
    const lvl = norm(a.contract_level);
    if (lvl === "MD" || lvl === "EMD") {
      return { ok: true, role: lvl.toLowerCase(), canEdit: false,
               name: `${a.first_name || ""} ${a.last_name || ""}`.trim(), code, master: false };
    }
  }
  return { ok: false, error: "This board is for Operations and team leaders." };
}

/* The seat whose private board this is, taken from the verified identity. null = the
   shared/master board, which is also what a leader reads. */
function seatOf(az: Auth, body?: any): string | null {
  /* v13 (2026-10-26): the MASTER seat can open any seat's private board by naming it in
     `board_seat`. Before this, 0000 only ever reached the shared board, so tickets and client
     notes a baseshop seat kept on its own board were invisible to the General Manager. */
  if (az.role === "ops" && az.master) {
    const want = String(body?.board_seat ?? "").trim();
    return /^\d{4}$/.test(want) && want !== "0000" ? want : null;
  }
  if (az.role !== "ops") return null;
  const c = String(az.code || "");
  return /^\d{4}$/.test(c) ? c : null;
}
function boardOf(body: any, seat: string | null) {
  const b = clean(body.board) === "gfi" ? "gfi" : "newbiz";
  const KKbase = b === "gfi" ? "ops_gfi_tickets" : "ops_newbiz_tickets";
  const KCbase = b === "gfi" ? "ops_gfi_columns" : "ops_newbiz_columns";
  return { board: b, KKbase, KCbase,
    KK: seat ? `${KKbase}__${seat}` : KKbase,
    KC: seat ? `${KCbase}__${seat}` : KCbase,
    DEF: b === "gfi" ? DEFAULT_GFI : DEFAULT_NEWBIZ };
}
async function tickets(KK: string): Promise<any[]> { const raw = await loadKey(KK); return Array.isArray(raw) ? raw : []; }
function normOpts(o: unknown) { if (!Array.isArray(o)) return []; return o.map((x: any) => (x && typeof x === "object") ? { value: clean(x.value).slice(0, 60), color: color(x.color) || "#8e8e93" } : { value: clean(x).slice(0, 60), color: "#8e8e93" }).filter((x: any) => has(x.value)).slice(0, 60); }
function normCol(c: any) { const t = ["text", "select", "status", "money", "date", "check"].indexOf(String(c.type)) >= 0 ? String(c.type) : "text"; const type = t === "status" ? "select" : t; return { key: (has(c.key) ? String(c.key).slice(0, 40) : slug(c.label)) || ("col_" + uid()), label: clean(c.label).slice(0, 40), type, options: (type === "select") ? normOpts(c.options) : [], headerColor: color(c.headerColor) }; }
// columns inherit the shared layout until this seat changes something
async function columns(KC: string, KCbase: string, DEF: any[]): Promise<any[]> {
  let raw = await loadKey(KC);
  if ((!Array.isArray(raw) || !raw.length) && KC !== KCbase) raw = await loadKey(KCbase);
  const arr = (Array.isArray(raw) && raw.length) ? raw : DEF;
  return arr.map(normCol);
}
function cleanData(d: any): Record<string, string> { const out: Record<string, string> = {}; if (d && typeof d === "object") { let n = 0; for (const k in d) { if (n++ > 80) break; out[String(k).slice(0, 40)] = clean(d[k]); } } return out; }
function cleanTicket(t: any) { return { id: String(t.id || ("nb" + uid())), data: cleanData(t.data), notes: Array.isArray(t.notes) ? t.notes.slice(0, 800) : [], archived: !!t.archived }; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const action = String(body.action || "nb_list");
  const az = await authOf(body);
  /* Deliberately NOT needs_session: that flag tells the page to throw the person out to the
     agent sign-in screen, which is the wrong place for an Operations seat whose 8-hour
     token simply ran out. Say what is wrong and let them sign in again where they are. */
  if (!az.ok) return json({ ok: false, error: az.error || "unauthorized" }, 401);
  const seat = seatOf(az, body);
  const { KK, KC, KCbase, DEF } = boardOf(body, seat);
  /* Note authorship is the verified identity. It used to be whatever the body claimed. */
  const byName = az.name || "Operations"; const byCode = norm(az.code || "");

  if (action === "nb_list") {
    const all = await tickets(KK); const wantArch = body.archived === true;
    const shown = all.filter((t) => wantArch ? !!t.archived : !t.archived);
    return json({ ok: true, role: az.role, can_edit: az.canEdit, tickets: shown, columns: await columns(KC, KCbase, DEF), archived_count: all.filter((t) => !!t.archived).length, board_of: seat || "shared" });
  }
  if (action === "nb_set_columns") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const seen = new Set<string>();
    const cols = (Array.isArray(body.columns) ? body.columns : []).slice(0, 40).map(normCol).filter((c: any) => { if (!c.label) return false; if (seen.has(c.key)) c.key = c.key + "_" + uid(); seen.add(c.key); return true; });
    if (!cols.length) return json({ ok: false, error: "Provide at least one column." });
    await saveKey(KC, cols); return json({ ok: true, columns: cols });
  }
  if (action === "nb_import") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const arr = (Array.isArray(body.tickets) ? body.tickets : []).slice(0, 5000).map(cleanTicket);
    const append = body.append === true;
    const final = append ? (await tickets(KK)).concat(arr) : arr;
    await saveKey(KK, final.slice(0, 8000));
    if (Array.isArray(body.columns) && body.columns.length) await saveKey(KC, body.columns.slice(0, 40).map(normCol));
    return json({ ok: true, count: arr.length, total: final.length });
  }
  if (action === "nb_add") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const data = cleanData(body.data); if (!Object.values(data).some(has)) return json({ ok: false, error: "Enter at least one field." });
    const arr = await tickets(KK); const t = { id: "nb" + uid(), data, notes: [] as any[], archived: false };
    arr.unshift(t); await saveKey(KK, arr); return json({ ok: true, ticket: t, tickets: arr.filter((x) => !x.archived) });
  }
  if (action === "nb_update") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const arr = await tickets(KK); const t = arr.find((x) => x.id === String(body.id)); if (!t) return json({ ok: false, error: "Record not found." }, 404);
    if (!t.data || typeof t.data !== "object") t.data = {};
    if (has(body.field)) t.data[String(body.field).slice(0, 40)] = clean(body.value);
    else if (body.data && typeof body.data === "object") { const cd = cleanData(body.data); for (const k in cd) t.data[k] = cd[k]; }
    let archived = false;
    if (!t.archived && TERMINAL.indexOf((t.data.status || "").toString().trim().toLowerCase()) >= 0) {
      t.archived = true; archived = true;
      if (!Array.isArray(t.notes)) t.notes = [];
      t.notes.unshift({ id: uid(), ts: new Date().toISOString(), by_code: byCode, by_name: byName, by_role: az.role, text: "✅ " + (t.data.status || "Completed") + " — auto-moved to Archived" });
    }
    await saveKey(KK, arr); return json({ ok: true, archived });
  }
  if (action === "nb_archive" || action === "nb_unarchive") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const arr = await tickets(KK); const t = arr.find((x) => x.id === String(body.id)); if (!t) return json({ ok: false, error: "Record not found." }, 404);
    t.archived = (action === "nb_archive");
    if (!Array.isArray(t.notes)) t.notes = [];
    t.notes.unshift({ id: uid(), ts: new Date().toISOString(), by_code: byCode, by_name: byName, by_role: az.role, text: (action === "nb_archive" ? "🗄 Archived for records" : "♻ Reactivated") });
    await saveKey(KK, arr); return json({ ok: true, tickets: arr.filter((x) => !x.archived) });
  }
  if (action === "nb_delete") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const arr = (await tickets(KK)).filter((x) => x.id !== String(body.id)); await saveKey(KK, arr);
    return json({ ok: true, tickets: arr.filter((x) => !x.archived) });
  }
  if (action === "nb_note" || action === "nb_note_edit" || action === "nb_note_del") {
    const arr = await tickets(KK); const t = arr.find((x) => x.id === String(body.id)); if (!t) return json({ ok: false, error: "Record not found." }, 404);
    if (!Array.isArray(t.notes)) t.notes = [];
    if (action === "nb_note") {
      const text = clean(body.text); if (!text) return json({ ok: false, error: "Note is empty." });
      t.notes.unshift({ id: uid(), ts: new Date().toISOString(), by_code: byCode, by_name: byName, by_role: az.role, text });
    } else {
      const nid = String(body.note_id || ""); const nt = t.notes.find((x: any) => x.id === nid); if (!nt) return json({ ok: false, error: "Note not found." }, 404);
      const mine = has(byCode) && norm(nt.by_code) === byCode;
      if (!az.canEdit && !mine) return json({ ok: false, error: "You can only edit or delete your own notes." }, 403);
      if (action === "nb_note_del") t.notes = t.notes.filter((x: any) => x.id !== nid);
      else { const text = clean(body.text); if (!text) return json({ ok: false, error: "Note is empty." }); nt.text = text; nt.edited_at = new Date().toISOString(); }
    }
    await saveKey(KK, arr); return json({ ok: true, notes: t.notes });
  }
  return json({ ok: false, error: "unknown action" }, 400);
});
