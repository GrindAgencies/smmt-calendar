// task-api (2026-10-28): Operations completing a task auto-archives it (completed_at kept, recurrence still spawns).
// task-api v10 — Task Management + AUTOMATIONS + per-task NOTES log. Tasks link to AGENTS and/or CLIENTS.
// v4 FIX: for_client / for_policy PostgREST filters were missing the `=` (client_names.cs vs client_names=cs),
//         so they silently returned EVERY task. Now correctly scoped to the specific client / policy.
// v5 (2026-09-02): authorisation goes through ops_authorize — a human Operations session from
//         ops-auth, or the cron machine token — instead of the literal "2026", which shipped inside
//         ops.html AND was the credential for the scheduled job that runs the automations.
// v6 (2026-09-05): WHO MAY CHANGE A TASK. update / set_status had no ownership check at all, so any
//         signed-in agent could rename or complete ANYONE's task just by knowing its id — and `list`
//         hands every task to every agent, so ids were there for the taking. Mutation now requires
//         Operations, the owner, the creator, or someone the task is assigned to.
// v7 (2026-09-10): WHO MAY *READ* A TASK — the other half of the v6 bug, which v6 named out loud
//         ("`list` hands every task to every agent") and then left open. Scoping was OPT-IN: the
//         caller had to pass `mine`. Omit it and a TITANS Marketing Director with no downline was
//         served all 144 tasks, owned by two SMMT brokers and Operations, each row carrying
//         `client_names` — client identities crossing a baseshop boundary. Reading is now scoped by
//         default for everyone except Operations, and `search` gets the same filter it never had.
// v10 (2026-09-30): AND WHO ARE YOU? v6 and v7 built careful rules around `who.code` — then took
//         `who.code` from whatever the request typed in `code`. GFI codes are printed on the org
//         chart, so every ownership rule above was one typed code away from being someone else's.
//         Worse: platformAdmin(code) granted the FULL Operations board and every Operations-only
//         action to anyone who typed the platform builder's code. That was privilege escalation,
//         not just a read leak.
//         Identity is now the session token minted when somebody enters their PIN, or an
//         Operations token. A typed `code` no longer says anything about who is calling.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 8000);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const arr = (v: unknown) => Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
const uid = () => crypto.randomUUID().slice(0, 8);
const STATUSES = ["in_progress", "waiting", "complete", "archived"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const RECUR = ["", "daily", "weekly", "monthly", "quarterly", "yearly", "custom"];
function todayPT() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()); }
function plusDays(base: string, days: number) { const d = new Date((base || todayPT()) + "T12:00:00Z"); if (isNaN(d.getTime())) return todayPT(); d.setUTCDate(d.getUTCDate() + (Number(days) || 0)); return d.toISOString().slice(0, 10); }

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function loadKey(k: string) { try { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; } catch (_) { return null; } }
async function saveKey(k: string, v: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
// The platform builder has every Operations control without holding the rank. See is_platform_admin().
// NOTE: only ever called with a code that came out of a verified session — never a typed one.
async function platformAdmin(code: string) { if (!code) return false; const r = await rpc("is_platform_admin", { p_code: code }); return r === true; }
async function agentName(code: string): Promise<string> { if (!code || code === "OPS") return code === "OPS" ? "Operations" : ""; const r = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(norm(code))}&select=first_name,last_name&limit=1`); const a = r[0]; return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : code; }

// WHO IS CALLING. Operations by token, or a member by the session minted at PIN entry.
// `body.code` / `body.by_code` are no longer consulted: they are what the request TYPED, and
// everything downstream (ownership, the Operations board, platform-admin) hangs off this answer.
async function actor(body: any, q: URLSearchParams): Promise<{ ok: boolean; ops: boolean; code: string; name: string }> {
  if (await opsAuthorized(body.token || q.get("token"))) return { ok: true, ops: true, code: "OPS", name: clean(body.by_name) || "Operations" };
  const sess = clean(body.session || q.get("session")).slice(0, 120);
  if (!sess) return { ok: false, ops: false, code: "", name: "" };
  const got = await rpc("agent_session_code", { p_token: sess });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { ok: false, ops: false, code: "", name: "" };
  if (await platformAdmin(code)) return { ok: true, ops: true, code, name: await agentName(code) };
  return { ok: true, ops: false, code, name: await agentName(code) };
}

// A task is yours to change if you own it, created it, or it was assigned to you.
// Everyone else can read it and add a note, but not rewrite it.
async function mayChange(id: string, who: { ops: boolean; code: string }): Promise<{ ok: boolean; task: any }> {
  const t = (await getJSON(`tasks?id=eq.${encodeURIComponent(id)}&select=id,owner_code,created_by,agent_codes&limit=1`))[0];
  if (!t) return { ok: false, task: null };
  if (who.ops) return { ok: true, task: t };
  const me = norm(who.code);
  if (!me) return { ok: false, task: t };
  if (norm(t.owner_code) === me) return { ok: true, task: t };
  if (norm(t.created_by) === me) return { ok: true, task: t };
  const assigned = Array.isArray(t.agent_codes) ? t.agent_codes.map((x: unknown) => norm(x)) : [];
  if (assigned.indexOf(me) >= 0) return { ok: true, task: t };
  return { ok: false, task: t };
}
const DENY = "That task belongs to someone else. You can add a note on it, but only its owner, whoever created it, someone it is assigned to, or Operations can change it.";

// READ scope. Operations (and the platform builder) see the whole board — Tasks is an Operations
// tool. Everyone else sees only what is theirs: owned, created, or assigned to them. Returning a
// filter of `null` means "no restriction"; returning the impossible-code filter means "nothing",
// which is what an unidentified caller gets — fail closed, never open.
function scopedFilter(who: { ops: boolean; code: string }): string | null {
  if (who.ops) return null;
  const me = norm(who.code);
  if (!me) return `owner_code=eq.__none__`;
  const c = encodeURIComponent(me);
  return `or=(owner_code.eq.${c},created_by.eq.${c},agent_codes.cs.%5B%22${c}%22%5D)`;
}

function mapTask(body: any) {
  const t: Record<string, unknown> = {};
  if (body.title !== undefined) t.title = clean(body.title);
  if (body.description !== undefined) t.description = clean(body.description);
  if (body.kind !== undefined) t.kind = (["agent", "backoffice", "general"].indexOf(low(body.kind)) >= 0 ? low(body.kind) : "general");
  if (body.priority !== undefined) t.priority = (PRIORITIES.indexOf(low(body.priority)) >= 0 ? low(body.priority) : "medium");
  if (body.category !== undefined) t.category = clean(body.category);
  if (body.tags !== undefined) t.tags = arr(body.tags).map((x) => clean(x)).filter(Boolean);
  if (body.owner_code !== undefined) t.owner_code = norm(body.owner_code);
  if (body.agent_codes !== undefined) t.agent_codes = arr(body.agent_codes).map((x) => norm(x)).filter(Boolean);
  if (body.client_names !== undefined) t.client_names = arr(body.client_names).map((x) => clean(x)).filter(Boolean);
  if (body.policy_ids !== undefined) t.policy_ids = arr(body.policy_ids).map((x) => String(x)).filter(Boolean);
  if (body.due_date !== undefined) t.due_date = clean(body.due_date) || null;
  if (body.recurrence !== undefined) t.recurrence = (RECUR.indexOf(low(body.recurrence)) >= 0 ? low(body.recurrence) : "");
  if (body.recurrence_config !== undefined) t.recurrence_config = (body.recurrence_config && typeof body.recurrence_config === "object") ? body.recurrence_config : null;
  return t;
}
function advanceDate(base: string, recurrence: string, cfg: any): string | null {
  const d = base ? new Date(base + "T12:00:00Z") : new Date();
  if (isNaN(d.getTime())) return null;
  const add = (days: number) => d.setUTCDate(d.getUTCDate() + days);
  const addMonths = (m: number) => d.setUTCMonth(d.getUTCMonth() + m);
  switch (recurrence) {
    case "daily": add(1); break; case "weekly": add(7); break; case "monthly": addMonths(1); break;
    case "quarterly": addMonths(3); break; case "yearly": addMonths(12); break;
    case "custom": { const every = Math.max(1, Number(cfg?.every) || 1); const unit = low(cfg?.unit) || "week"; if (unit === "day") add(every); else if (unit === "month") addMonths(every); else if (unit === "year") addMonths(every * 12); else add(every * 7); break; }
    default: return null;
  }
  return d.toISOString().slice(0, 10);
}
function decorate(t: any, today: string) {
  const overdue = !!t.due_date && t.due_date < today && t.status !== "complete" && t.status !== "archived";
  const open = t.status === "in_progress" || t.status === "waiting";
  return { ...t, overdue, open };
}

const DEFAULT_RULES: Record<string, any> = {
  paidout_thankyou: { active: true, label: "Client Paid Out → Thank-you email + update FUB", title: "Send thank-you email & update FUB profile", kind: "backoffice", category: "Client Care", priority: "high", due_days: 2 },
  license_sendout: { active: true, label: "Fully Licensed & Appointed → License send-out due", title: "License send-out is due", kind: "agent", category: "Licensing", priority: "high", due_days: 3 },
  net_gear: { active: true, label: "Agent Net Licensed → Create flyer & send gear", title: "Create flyer & send out gear", kind: "agent", category: "New Agent", priority: "medium", due_days: 5 },
};
async function rulesConfig() { const cfg = (await loadKey("task_automations")) || {}; const saved = (cfg && cfg.rules) || {}; const out: Record<string, any> = {}; for (const k of Object.keys(DEFAULT_RULES)) out[k] = { ...DEFAULT_RULES[k], ...(saved[k] || {}) }; return out; }
function isLicensedAppointed(ls: unknown) { const s = low(ls); return s.includes("licensed") && s.includes("appointed") && !s.includes("not licensed"); }
function isLicensed(prog: any) { const p = (prog && typeof prog === "object") ? prog : {}; return !!(p.w3_reslic || p.w3_exam || p.w1_exam); }
const mkTask = (o: any) => ({ status: "in_progress", description: "", tags: [], agent_codes: [], client_names: [], policy_ids: [], notes: [], owner_code: "OPS", owner_name: "Operations", created_by: "AUTO", created_by_name: "Automation", recurrence: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...o });

async function runAutomations(): Promise<any> {
  const rules = await rulesConfig();
  const today = todayPT();
  const existing = new Set((await getJSON(`tasks?select=auto_key&auto_key=not.is.null&limit=100000`)).map((x: any) => String(x.auto_key)));
  const rows: any[] = []; const by_rule: Record<string, number> = { paidout_thankyou: 0, license_sendout: 0, net_gear: 0 };
  if (rules.paidout_thankyou.active) {
    const r = rules.paidout_thankyou;
    const pols = await getJSON(`policies?status=eq.paid&select=id,client_name,agent_code&limit=20000`);
    for (const p of pols) { const key = "paidout:" + p.id; if (existing.has(key)) continue; const cn = (p.client_name || "").trim(); rows.push(mkTask({ title: r.title + (cn ? " — " + cn : ""), kind: r.kind, category: r.category, priority: r.priority, client_names: cn ? [cn] : [], due_date: plusDays(today, r.due_days), auto_key: key })); existing.add(key); by_rule.paidout_thankyou++; }
  }
  if (rules.license_sendout.active) {
    const r = rules.license_sendout;
    const ags = await getJSON(`tracker_agents?select=code,first_name,last_name,license_status&code=neq.POOL&limit=5000`);
    for (const a of ags) { if (!isLicensedAppointed(a.license_status)) continue; const key = "license:" + norm(a.code); if (existing.has(key)) continue; const nm = `${a.first_name || ""} ${a.last_name || ""}`.trim(); rows.push(mkTask({ title: r.title + (nm ? " — " + nm : ""), kind: r.kind, category: r.category, priority: r.priority, agent_codes: [norm(a.code)], due_date: plusDays(today, r.due_days), auto_key: key })); existing.add(key); by_rule.license_sendout++; }
  }
  if (rules.net_gear.active) {
    const r = rules.net_gear;
    const ags = await getJSON(`tracker_agents?select=code,first_name,last_name,progress,cashflow&code=neq.POOL&limit=5000`);
    const produced = new Set((await getJSON(`policies?select=agent_code&limit=20000`)).map((p: any) => norm(p.agent_code)));
    for (const a of ags) { const netLic = isLicensed(a.progress) && ((Number(a.cashflow) || 0) > 0 || produced.has(norm(a.code))); if (!netLic) continue; const key = "netgear:" + norm(a.code); if (existing.has(key)) continue; const nm = `${a.first_name || ""} ${a.last_name || ""}`.trim(); rows.push(mkTask({ title: r.title + (nm ? " — " + nm : ""), kind: r.kind, category: r.category, priority: r.priority, agent_codes: [norm(a.code)], due_date: plusDays(today, r.due_days), auto_key: key })); existing.add(key); by_rule.net_gear++; }
  }
  let created = 0;
  if (rows.length) { const ins = await fetch(`${SUPA}/rest/v1/tasks`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(rows) }); if (ins.ok) created = rows.length; }
  return { ok: true, created, by_rule, at: new Date().toISOString() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: any = {}; if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = String(body.action || url.searchParams.get("action") || "list");
    const who = await actor(body, url.searchParams);
    const today = todayPT();

    // Nothing in Tasks is public. Say so plainly so the page can send them through sign-in once
    // (session.js watches for needs_session) rather than rendering a mysteriously empty board.
    if (!who.ok) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

    if (action === "run_automations") { if (!who.ops) return json({ ok: false, error: "unauthorized" }, 401); return json(await runAutomations()); }
    if (action === "automations_list") { if (!who.ops) return json({ ok: false, error: "Operations only." }, 403); return json({ ok: true, rules: await rulesConfig() }); }
    if (action === "automations_set") {
      if (!who.ops) return json({ ok: false, error: "Operations only." }, 403);
      const rule = String(body.rule || ""); if (!DEFAULT_RULES[rule]) return json({ ok: false, error: "unknown rule" });
      const cfg = (await loadKey("task_automations")) || {}; if (!cfg.rules) cfg.rules = {};
      const cur = { ...DEFAULT_RULES[rule], ...(cfg.rules[rule] || {}) };
      if (body.active !== undefined) cur.active = !!body.active;
      if (body.priority !== undefined && PRIORITIES.indexOf(low(body.priority)) >= 0) cur.priority = low(body.priority);
      if (body.title !== undefined) cur.title = clean(body.title);
      if (body.category !== undefined) cur.category = clean(body.category);
      if (body.due_days !== undefined) cur.due_days = Math.max(0, Number(body.due_days) || 0);
      cfg.rules[rule] = cur; await saveKey("task_automations", cfg);
      return json({ ok: true, rules: await rulesConfig() });
    }

    if (action === "create") {
      const t = mapTask(body); if (!t.title) return json({ ok: false, error: "title required" });
      t.status = (STATUSES.indexOf(low(body.status)) >= 0 ? low(body.status) : "in_progress");
      if (t.owner_code === undefined) t.owner_code = who.code;
      t.owner_name = await agentName(String(t.owner_code || who.code));
      t.created_by = who.code; t.created_by_name = who.name; t.notes = [];
      t.created_at = new Date().toISOString(); t.updated_at = t.created_at;
      if (t.status === "complete") t.completed_at = new Date().toISOString();
      const ins = await fetch(`${SUPA}/rest/v1/tasks`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(t) });
      const r = await ins.json(); return json({ ok: ins.ok, task: Array.isArray(r) ? r[0] : r });
    }
    if (action === "update") {
      const id = String(body.id || ""); if (!id) return json({ ok: false, error: "no id" });
      const may = await mayChange(id, who);
      if (!may.task) return json({ ok: false, error: "Task not found." }, 404);
      if (!may.ok) return json({ ok: false, error: DENY }, 403);
      const t = mapTask(body); t.updated_at = new Date().toISOString();
      if (body.owner_code !== undefined) t.owner_name = await agentName(String(t.owner_code));
      const up = await fetch(`${SUPA}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(t) });
      const r = await up.json(); return json({ ok: up.ok, task: Array.isArray(r) ? r[0] : r });
    }
    if (action === "add_note" || action === "del_note") {
      const id = String(body.id || ""); if (!id) return json({ ok: false, error: "no id" });
      const cur = (await getJSON(`tasks?id=eq.${encodeURIComponent(id)}&select=notes&limit=1`))[0];
      let notes: any[] = (cur && Array.isArray(cur.notes)) ? cur.notes : [];
      if (action === "add_note") { const text = clean(body.text); if (!text) return json({ ok: false, error: "empty note" }); notes = [{ id: uid(), ts: new Date().toISOString(), by_code: who.code, by_name: who.name, text }].concat(notes); }
      else { const nid = String(body.note_id || ""); const n = notes.find((x) => x.id === nid); if (n && !who.ops && norm(n.by_code) !== who.code) return json({ ok: false, error: "only your own notes" }, 403); notes = notes.filter((x) => x.id !== nid); }
      const up = await fetch(`${SUPA}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ notes, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, notes });
    }
    if (action === "set_status") {
      const id = String(body.id || ""); const status = low(body.status);
      if (!id || STATUSES.indexOf(status) < 0) return json({ ok: false, error: "bad id/status" });
      const may = await mayChange(id, who);
      if (!may.task) return json({ ok: false, error: "Task not found." }, 404);
      if (!may.ok) return json({ ok: false, error: DENY }, 403);
      const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      patch.completed_at = (status === "complete") ? new Date().toISOString() : null;
      const up = await fetch(`${SUPA}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(patch) });
      const r = await up.json(); const task = Array.isArray(r) ? r[0] : r;
      let spawned = null;
      if (status === "complete" && task && task.recurrence) {
        const nextDue = advanceDate(String(task.due_date || today), String(task.recurrence), task.recurrence_config);
        if (nextDue) {
          const clone = mkTask({ title: task.title, description: task.description, kind: task.kind, priority: task.priority, category: task.category, tags: task.tags, owner_code: task.owner_code, owner_name: task.owner_name, agent_codes: task.agent_codes, client_names: task.client_names, policy_ids: task.policy_ids, due_date: nextDue, recurrence: task.recurrence, recurrence_config: task.recurrence_config, recurrence_parent: task.recurrence_parent || task.id, created_by: who.code, created_by_name: who.name });
          const ins = await fetch(`${SUPA}/rest/v1/tasks`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(clone) });
          const cr = await ins.json(); spawned = Array.isArray(cr) ? cr[0] : cr;
        }
      }
      /* 2026-10-28 (Christopher): "when operations clears her tasks via the click button that
         needs to trigger an automatic archive of the task". Operations completing a task files it
         straight into Archived. The completion still counts: completed_at is kept, and a repeating
         task has already scheduled its next copy above. Anyone else's Complete is unchanged. */
      let archived = false;
      if (up.ok && status === "complete" && who.ops && task) {
        const ar = await fetch(`${SUPA}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify({ status: "archived", updated_at: new Date().toISOString() }) });
        if (ar.ok) { const aj = await ar.json(); const at = Array.isArray(aj) ? aj[0] : aj; if (at) { archived = true; return json({ ok: true, task: at, spawned, archived }); } }
      }
      return json({ ok: up.ok, task, spawned, archived });
    }
    if (action === "delete") {
      const id = String(body.id || ""); if (!id) return json({ ok: false, error: "no id" });
      // Deleting is narrower than editing: an assignee may complete a task, but only
      // Operations, the owner or whoever created it can destroy the record.
      const t = (await getJSON(`tasks?id=eq.${encodeURIComponent(id)}&select=id,owner_code,created_by&limit=1`))[0];
      if (!t) return json({ ok: false, error: "Task not found." }, 404);
      const me = norm(who.code);
      const mine = who.ops || (!!me && (norm(t.owner_code) === me || norm(t.created_by) === me));
      if (!mine) return json({ ok: false, error: "Only Operations, the owner, or whoever created this task can delete it." }, 403);
      const del = await fetch(`${SUPA}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: del.ok, id });
    }

    const sel = "id,title,description,kind,status,priority,category,tags,owner_code,owner_name,agent_codes,client_names,policy_ids,notes,due_date,completed_at,recurrence,recurrence_config,recurrence_parent,auto_key,created_by,created_by_name,created_at,updated_at";
    const mineOnly = scopedFilter(who);

    if (action === "get") {
      const id = String(body.id || ""); if (!id) return json({ ok: false, error: "no id" });
      let gp = `tasks?id=eq.${encodeURIComponent(id)}&select=${sel}&limit=1`;
      if (mineOnly) gp += `&${mineOnly}`;
      const t = (await getJSON(gp))[0];
      return json({ ok: !!t, task: t ? decorate(t, today) : null });
    }

    if (action === "for_agent" || action === "for_client" || action === "for_policy") {
      let path = `tasks?select=${sel}&order=due_date.asc.nullslast,priority.desc`;
      if (action === "for_agent") { const code = norm(body.code || body.agent); if (!code) return json({ ok: false, error: "code required" }); path += `&or=(owner_code.eq.${encodeURIComponent(code)},agent_codes.cs.%5B%22${encodeURIComponent(code)}%22%5D)`; }
      else if (action === "for_client") { const nm = clean(body.name || body.client); if (!nm) return json({ ok: false, error: "name required" }); path += `&client_names=cs.${encodeURIComponent(JSON.stringify([nm]))}`; }
      else { const pid = String(body.policy_id || body.id || ""); if (!pid) return json({ ok: false, error: "policy_id required" }); path += `&policy_ids=cs.${encodeURIComponent(JSON.stringify([pid]))}`; }
      // for_agent already narrows to one person, but for_client / for_policy do not — without this a
      // client name was enough to read another shop's tasks about that client.
      if (mineOnly && action !== "for_agent") path += `&${mineOnly}`;
      if (mineOnly && action === "for_agent" && norm(body.code || body.agent) !== norm(who.code)) path += `&${mineOnly}`;
      const rows = (await getJSON(path)).map((t: any) => decorate(t, today));
      const open = rows.filter((t: any) => t.open && !t.overdue); const overdue = rows.filter((t: any) => t.overdue); const completed = rows.filter((t: any) => t.status === "complete"); const archived = rows.filter((t: any) => t.status === "archived");
      return json({ ok: true, tasks: rows, open, overdue, completed, archived, counts: { open: open.length, overdue: overdue.length, completed: completed.length } });
    }
    if (action === "counts") {
      let path = `tasks?select=id,due_date,status,owner_code,agent_codes`;
      if (mineOnly) path += `&${mineOnly}`;
      const rows = (await getJSON(path)).map((t: any) => decorate(t, today));
      return json({ ok: true, open: rows.filter((t: any) => t.open).length, overdue: rows.filter((t: any) => t.overdue).length });
    }
    if (action === "search") {
      const term = low(body.q || url.searchParams.get("q")); if (!term) return json({ ok: true, tasks: [] });
      // PostgREST takes ONE `or=` per request, so the search terms and the ownership filter cannot
      // both be expressed as `or`. Search wide, then narrow in code.
      let sp = `tasks?select=${sel}&or=(title.ilike.*${encodeURIComponent(term)}*,description.ilike.*${encodeURIComponent(term)}*,category.ilike.*${encodeURIComponent(term)}*)&status=neq.archived&order=due_date.asc.nullslast&limit=200`;
      let rows = (await getJSON(sp)).map((t: any) => decorate(t, today));
      if (!who.ops) {
        const me = norm(who.code);
        rows = me ? rows.filter((t: any) => norm(t.owner_code) === me || norm(t.created_by) === me || (Array.isArray(t.agent_codes) && t.agent_codes.map((x: unknown) => norm(x)).indexOf(me) >= 0)) : [];
      }
      return json({ ok: true, tasks: rows.slice(0, 40) });
    }

    let path = `tasks?select=${sel}`;
    const filters: string[] = [];
    const status = low(body.status || url.searchParams.get("status") || "active");
    if (status === "active") filters.push(`status=neq.archived`);
    else if (STATUSES.indexOf(status) >= 0) filters.push(`status=eq.${status}`);
    else if (status === "open") filters.push(`status=in.(in_progress,waiting)`);
    if (body.priority && PRIORITIES.indexOf(low(body.priority)) >= 0) filters.push(`priority=eq.${low(body.priority)}`);
    if (body.category) filters.push(`category=eq.${encodeURIComponent(clean(body.category))}`);
    if (body.owner) filters.push(`owner_code=eq.${encodeURIComponent(norm(body.owner))}`);
    if (body.kind && ["agent", "backoffice", "general"].indexOf(low(body.kind)) >= 0) filters.push(`kind=eq.${low(body.kind)}`);
    if (body.agent) filters.push(`agent_codes=cs.%5B%22${encodeURIComponent(norm(body.agent))}%22%5D`);
    // THE FIX: scoping is no longer something the caller opts into with `mine`. Anyone who is not
    // Operations gets their own tasks, whether they asked to be scoped or not.
    if (mineOnly) filters.push(mineOnly);
    if (body.q) { const term = encodeURIComponent(low(body.q)); filters.push(`title.ilike.*${term}*`); }
    path += (filters.length ? "&" + filters.join("&") : "") + `&order=due_date.asc.nullslast,priority.desc,created_at.desc&limit=1000`;
    let rows = (await getJSON(path)).map((t: any) => decorate(t, today));
    if (body.overdue_only) rows = rows.filter((t: any) => t.overdue);
    const cats = Array.from(new Set(rows.map((t: any) => t.category).filter(Boolean))).sort();
    return json({ ok: true, tasks: rows, count: rows.length, categories: cats, today, is_ops: who.ops, scope: who.ops ? "all" : "mine" });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
