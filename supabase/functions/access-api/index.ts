// access-api v9 — platform-access approval workflow. Login/verification still lives in
// tracker-api; this only manages who is approved. New signups auto-land 'pending'
// (tracker_agents column default).
//
// v6 (2026-09-08): stopped showing the system placeholder logins (POOL, GOD MODE, DEMO2026, the
//   App Store reviewer) as if real people were waiting; returns baseshop + upline so an approver
//   can see WHO is asking; accepts a real Operations session as well as the legacy literal; and
//   notifies a broker the moment they are approved.
// v7 (2026-09-10): A LEADER SEES THEIR OWN TEAM — people whose upline chain walks up to them, or
//   who share their baseshop. Signups belonging to nobody surface for everyone plus Ops rather
//   than falling silently between two teams.
// v8 (2026-09-10): MARKETING DIRECTORS CAN APPROVE. Christopher: "MDs can approve recruits as
//   well. they have enough leadership to control newly added recruits. it will help offset ops
//   responsibilities." Until now only EMD+ and base owners could, so a recruit under an MD sat
//   waiting on someone two levels up who had no idea. The team scoping in v7 is what makes this
//   safe: an MD only ever sees and decides on people beneath THEM.
//   Deliberately NOT widened: announcing to a shop channel and editing its bots stay with the
//   EMD who owns the shop (emd-broadcast v3). Approving your own recruit is not the same as
//   speaking for the whole baseshop.
//
// v9 (2026-09-30) — TWO REAL HOLES, BOTH CLOSED.
//
//   1. THE LITERAL "2026" WAS STILL A MASTER KEY *HERE*. Every other function was moved onto
//      ops_authorize() during the September cutover, and the legacy switch behind it is now off.
//      This one kept its OWN `token === ADMIN_TOKEN` comparison ahead of that call, so the switch
//      never applied to it. Verified tonight: `{action:"list",filter:"all",token:"2026"}` returned
//      all 189 people with email addresses and phone numbers, and `set` could flip anybody's
//      access on or off. The constant is gone; ops_authorize is the only way in.
//
//   2. THE APPROVER WAS WHOEVER THE REQUEST SAID IT WAS. `approver` was a typed GFI code, and
//      codes are printed on the org chart — so typing a Marketing Director's code made you that
//      Marketing Director, with their queue and their power to approve. Identity now comes from
//      the session token minted when somebody enters their PIN.
//
//   Also: the audit trail no longer takes `by` from the request (it was a free-text field next to
//   a forgeable identity), and nobody can decide on their own account.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 200);
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;

const SYSTEM_CODES = ["POOL", "9999", "DEMO2026", "APLREVIEW"];
const notSystem = `code=not.in.(${SYSTEM_CODES.join(",")})`;

function isEmdPlus(cl: unknown): boolean {
  const s = lo(cl);
  if (!s) return false;
  return s === "emd" || s.includes("executive marketing") || s === "nvp" || s.includes("national vice") || s === "sevp" || s.includes("senior executive");
}
// An MD leads a team of their own, so they decide on their own recruits.
function isMd(cl: unknown): boolean {
  const s = lo(cl);
  if (!s) return false;
  return s === "md" || s === "marketing director" || /(^|\s)marketing director(\s|$)/.test(s);
}
async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function loadKey(k: string) { try { const rows = await getJSON(`app_settings?key=eq.${enc(k)}&select=value`); return rows[0] ? rows[0].value : null; } catch (_) { return null; } }
async function baseOwner(code: string): Promise<{ name: string; base: string }> {
  try {
    const bs = await loadKey("baseshops");
    const list = (bs && Array.isArray(bs.bases)) ? bs.bases : [];
    const hit = list.find((b: Record<string, unknown>) => norm(b.owner_code) === code && !b.admin_grant);
    return hit ? { name: String(hit.owner_name || "") || code, base: String(hit.name || "") } : { name: "", base: "" };
  } catch (_) { return { name: "", base: "" }; }
}

/* WHO IS ASKING.
   Operations — a token ops_authorize() accepts (a human seat session, or a machine job).
   A leader   — the session minted when they entered their PIN. Their RANK is then read from
                their own record, never from anything the request said about them. */
async function approver(token: string, session: string) {
  if (token) {
    const az = await rpc("ops_authorize", { p_token: token });
    if (az && az.ok) return { ok: true, by: String(az.label || "Operations"), level: "ops", code: "", baseshop: "" };
  }
  const sess = clean(session).slice(0, 120);
  if (!sess) return { ok: false, by: "", level: "", code: "", baseshop: "", no_session: true };
  const got = await rpc("agent_session_code", { p_token: sess });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { ok: false, by: "", level: "", code: "", baseshop: "", no_session: true };

  const owner = await baseOwner(code);
  const a = (await getJSON(`tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,contract_level,title,baseshop,platform_admin&limit=1`))[0];
  if (owner.name) {
    return { ok: true, by: owner.name + " (EMD)", level: "emd", code, baseshop: owner.base || (a ? String(a.baseshop || "") : "") };
  }
  if (!a) return { ok: false, by: "", level: "", code, baseshop: "" };
  const lvl = a.contract_level || a.title;
  const nm = (((a.first_name as string) || "") + " " + ((a.last_name as string) || "")).trim();
  if (a.platform_admin === true || isEmdPlus(lvl)) {
    return { ok: true, by: (nm || code) + " (" + String(lvl || "ADMIN").toUpperCase() + ")", level: "emd", code, baseshop: String(a.baseshop || "") };
  }
  if (isMd(lvl)) {
    return { ok: true, by: (nm || code) + " (MD)", level: "md", code, baseshop: String(a.baseshop || "") };
  }
  return { ok: false, by: "", level: "", code, baseshop: String(a.baseshop || "") };
}

/* Everyone beneath this leader, by walking direct_to upward from each agent. */
async function teamCodes(leaderCode: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!leaderCode) return out;
  const all = await getJSON(`tracker_agents?select=code,direct_to&limit=5000`);
  const parent: Record<string, string> = {};
  all.forEach((a: any) => parent[norm(a.code)] = norm(a.direct_to));
  const root = norm(leaderCode);
  for (const c of Object.keys(parent)) {
    let cur = parent[c], hops = 0;
    while (cur && hops++ < 40) {
      if (cur === root) { out.add(c); break; }
      cur = parent[cur];
    }
  }
  return out;
}

async function pendingRows() {
  return await getJSON(`tracker_agents?access_status=eq.pending&${notSystem}&select=code,first_name,last_name,emd,md,baseshop,sub_base,direct_to,email,phone,access_status,access_requested_at,access_decided_at,access_decided_by,created_at&order=created_at.desc`);
}

/* Split the queue into "mine", "nobody's", and the rest.
   An EMD who OWNS a shop also claims everyone in it. An MD claims only their own downline —
   sharing a baseshop with someone does not make them yours to decide on, or every MD in SMMT
   would be approving each other's recruits. */
async function splitForLeader(rows: any[], who: any) {
  if (who.level === "ops") return { mine: rows, unassigned: [] as any[], others: [] as any[] };
  const team = await teamCodes(who.code);
  const owner = await baseOwner(who.code);
  const base = lo(owner.base || (who.level === "emd" ? who.baseshop : ""));
  const mine: any[] = [], unassigned: any[] = [], others: any[] = [];
  for (const r of rows) {
    // Your own row is never yours to decide on — see the guard in `set`.
    if (who.code && norm(r.code) === norm(who.code)) { others.push(r); continue; }
    const hasHome = !!clean(r.baseshop) || !!clean(r.direct_to);
    if (team.has(norm(r.code)) || (base && lo(r.baseshop) === base)) mine.push(r);
    else if (!hasHome) unassigned.push(r);
    else others.push(r);
  }
  return { mine, unassigned, others };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || url.searchParams.get("action") || "";
    const token = (body.token as string) || url.searchParams.get("token") || "";
    const session = (body.session as string) || url.searchParams.get("session") || "";

    if (action === "status") {
      // Deliberately open: the sign-in screen has to tell somebody "you're approved" or "you're
      // still waiting" BEFORE they have a session. It returns only their own name and that state —
      // no contact details, nothing about anyone else.
      const code = norm(body.code || url.searchParams.get("code"));
      if (!code) return json({ ok: false, error: "no code" });
      const a = (await getJSON(`tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,access_status`))[0];
      if (!a) return json({ ok: true, found: false });
      return json({ ok: true, found: true, access_status: a.access_status || "approved", name: (((a.first_name as string) || "") + " " + ((a.last_name as string) || "")).trim() });
    }

    if (action === "pending_count") {
      const who = await approver(token, session);
      if (!who.ok) return json({ ok: true, can_approve: false, pending_count: 0 });
      const split = await splitForLeader(await pendingRows(), who);
      return json({
        ok: true, can_approve: true,
        pending_count: split.mine.length,
        unassigned_count: split.unassigned.length,
        company_count: split.mine.length + split.unassigned.length + split.others.length,
        by: who.by, level: who.level, baseshop: who.baseshop,
      });
    }

    if (action === "whoami") {
      const who = await approver(token, session);
      return json({ ok: true, can_approve: who.ok, by: who.by, level: who.level, baseshop: who.baseshop, needs_session: !!who.no_session });
    }

    if (action === "list") {
      const who = await approver(token, session);
      if (!who.ok) return json(who.no_session ? { ok: false, needs_session: true, error: "Please sign in again." } : { ok: false, error: "unauthorized" }, 401);
      const which = clean(body.filter || "pending").toLowerCase();

      if (which === "pending") {
        const split = await splitForLeader(await pendingRows(), who);
        const rows = who.level === "ops" ? split.mine : split.mine.concat(split.unassigned);
        return json({
          ok: true, requests: rows, pending_count: split.mine.length,
          unassigned: split.unassigned.length, can_approve: true,
          by: who.by, level: who.level, baseshop: who.baseshop, scoped: who.level !== "ops",
        });
      }

      let q = `${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,emd,md,baseshop,sub_base,direct_to,email,phone,access_status,access_requested_at,access_decided_at,access_decided_by,created_at&${notSystem}`;
      if (which === "denied") q += `&access_status=eq.denied&order=access_decided_at.desc.nullslast`;
      else if (which === "approved") q += `&access_status=eq.approved&order=access_decided_at.desc.nullslast&limit=200`;
      else q += `&order=created_at.desc&limit=400`;
      let rows = (await (await fetch(q, { headers: DBH })).json()) || [];
      if (!Array.isArray(rows)) rows = [];
      if (who.level !== "ops") {
        const team = await teamCodes(who.code);
        const owner = await baseOwner(who.code);
        const base = lo(owner.base || (who.level === "emd" ? who.baseshop : ""));
        rows = rows.filter((r: any) => team.has(norm(r.code)) || (base && lo(r.baseshop) === base));
      }
      const split = await splitForLeader(await pendingRows(), who);
      return json({ ok: true, requests: rows, pending_count: split.mine.length, can_approve: true, by: who.by, level: who.level, scoped: who.level !== "ops" });
    }

    if (action === "set") {
      const who = await approver(token, session);
      if (!who.ok) return json(who.no_session ? { ok: false, needs_session: true, error: "Please sign in again." } : { ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      const decision = clean(body.decision).toLowerCase();
      // The audit trail records the identity we VERIFIED, not a label the request supplied.
      const by = who.by;
      if (!code || ["approved", "denied", "pending"].indexOf(decision) < 0) return json({ ok: false, error: "missing code or bad decision" });

      // Nobody grants themselves access, whatever their rank. An EMD's own row sits inside their
      // own baseshop, so the scope check below would otherwise have said yes.
      if (who.code && norm(who.code) === code) {
        return json({ ok: false, error: "You cannot decide on your own access. Ask Operations or your upline." }, 403);
      }

      if (who.level !== "ops") {
        const t = (await getJSON(`tracker_agents?code=eq.${enc(code)}&select=code,baseshop,direct_to&limit=1`))[0];
        if (!t) return json({ ok: false, error: "No such agent." }, 404);
        const team = await teamCodes(who.code);
        const owner = await baseOwner(who.code);
        const base = lo(owner.base || (who.level === "emd" ? who.baseshop : ""));
        const sameBase = !!base && lo(t.baseshop) === base;
        const unclaimed = !clean(t.baseshop) && !clean(t.direct_to);
        if (!team.has(norm(code)) && !sameBase && !unclaimed) {
          return json({ ok: false, error: "That person is not on your team." }, 403);
        }
      }

      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ access_status: decision, access_decided_at: new Date().toISOString(), access_decided_by: by }) });
      if (up.ok && decision === "approved") {
        try {
          await fetch(`${SUPA}/rest/v1/notifications`, {
            method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
            body: JSON.stringify({ recipient_code: code, title: "You're in — welcome to The Standard", body: "Your access has been approved. Sign in with your code and PIN.", created_at: new Date().toISOString() }),
          });
        } catch (_) { /* a notification failure must not undo the approval */ }
      }
      return json({ ok: up.ok, code, access_status: decision, by });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
