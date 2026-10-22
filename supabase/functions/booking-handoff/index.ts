// booking-handoff v4 — pass an appointment to another trainer, keeping the client's slot.
//
// A declined training used to be the end of it: the agent got "please choose another time or
// trainer" and had to start over, and the slot they had already committed to went to waste.
// atlas_transfer cannot help — it refuses anything that is not booked or confirmed ("Only active
// bookings can be transferred"), which a declined booking never is. So this reassigns a DECLINED
// or PENDING booking to another trainer and brings it back to life at the same date and time.
//
// v4 (2026-09-08) — WHY NOBODY COULD EVER HAND ANYTHING OFF.
//
//   bookings.trainer_code has a FOREIGN KEY to tracker_agents(code), but EIGHT of the fourteen
//   trainers in app_settings.cft_availability carried no `code` at all — including every CFT you
//   would realistically hand a training to. The handoff wrote trainer_code = '' and Postgres threw
//     Key (trainer_code)=() is not present in table "tracker_agents"
//   which surfaced to the trainer as the flat "Could not hand this off." It only ever worked for
//   the five people who happened to have a code stored. The roster has been backfilled, and the
//   code is ALSO resolved from tracker_agents by name here, so one missing field can never break
//   the feature again. An unresolvable trainer writes NULL, never the empty string.
//
// Also fixed in v3, all of which stopped candidates appearing in the first place:
//   1. THE AVAILABILITY TEST DEMANDED AN EXACT SLOT START, so a trainer publishing hourly windows
//      could never take an 11:30 booking even with 11:00 and 12:00 both open. Published windows
//      are expanded into covered minutes and the booking simply has to FIT inside them.
//   2. CFTs ONLY — every MD and EMD was excluded. All trainers are offered now, CFTs first.
//   3. NO WAY TO SEE THE OTHER TRAINER'S CALENDAR. Every trainer's Calendly comes back with them,
//      free or not, so you can open their real calendar before deciding.
//
// Trainers who are NOT free are returned too, each with the reason, so the picker shows the whole
// roster instead of an empty list. Handing to one of them requires `force`, and the database still
// has the final say: bookings_trainer_no_overlap guarantees nobody is double-booked and
// bookings_agent_no_overlap guards the agent's own diary.
//
// Nothing is re-keyed. The booking row is the SAME row — client, notes, location, meeting link,
// intake and confirmation number all travel with it; only the trainer changes.
//
// Actions:
//   candidates { id, code }                               -> who can take it, and who cannot
//   handoff    { id, code, to_trainer_code|to_trainer_name, force? }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown, n = 200) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "7:00 AM" / "12:30 PM" / "14:00" -> minutes from midnight, or -1
function t2min(t: unknown): number {
  const s = String(t ?? "").trim();
  let m = /^(\d{1,2}):(\d{2})\s*([AaPp])[Mm]?$/.exec(s);
  if (m) { let h = +m[1] % 12; if (/[Pp]/.test(m[3])) h += 12; return h * 60 + (+m[2]); }
  m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? (+m[1]) * 60 + (+m[2]) : -1;
}
function m2t(v: number): string {
  const h24 = Math.floor(v / 60), mm = v % 60;
  const ap = h24 >= 12 ? "PM" : "AM"; let h = h24 % 12; if (h === 0) h = 12;
  return `${h}:${mm < 10 ? "0" + mm : mm} ${ap}`;
}

async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function loadKey(k: string) { const rows = await getJSON(`app_settings?key=eq.${k}&select=value`); return rows[0] ? rows[0].value : null; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

// The minutes a trainer has actually published for that weekday. Each slot start opens a window
// as long as the gap to the next slot (60 when there is only one), so hourly windows cover the
// half hours inside them instead of rejecting them.
function publishedRanges(c: any, date: string): Array<[number, number]> {
  const dow = WD[new Date(date + "T12:00:00Z").getUTCDay()];
  const slots = (c.slots && typeof c.slots === "object") ? c.slots : {};
  const day: string[] = Array.isArray(slots[dow]) ? slots[dow] : [];
  const starts = day.map(t2min).filter((v) => v >= 0).sort((a, b) => a - b);
  if (!starts.length) return [];
  let step = 60;
  for (let i = 1; i < starts.length; i++) { const g = starts[i] - starts[i - 1]; if (g > 0 && g < step) step = g; }
  if (step < 15) step = 15;
  const out: Array<[number, number]> = [];
  for (const s of starts) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], s + step);   // merge touching windows
    else out.push([s, s + step]);
  }
  return out;
}

// Why can this trainer not take it? Empty string means they can.
function blockedReason(c: any, date: string, time: string, dur: number, booked: any[]): string {
  const start = t2min(time); if (start < 0) return "bad time";
  const end = start + dur;

  const blackouts: string[] = Array.isArray(c.blackouts) ? c.blackouts : [];
  if (blackouts.some((d) => String(d) === date)) return "away that day";

  const ranges = publishedRanges(c, date);
  if (!ranges.length) return "no hours published for that day";
  if (!ranges.some(([a, b]) => start >= a && end <= b)) return "outside their hours";

  // imported external busy (Google / Apple / Calendly via cal-sync): {date, s, e} in minutes
  const busy: any[] = Array.isArray(c.busy) ? c.busy : [];
  for (const b of busy) {
    if (String(b.date || "") !== date) continue;
    const bs = Number(b.s), be = Number(b.e);
    if (!isNaN(bs) && !isNaN(be) && start < be && bs < end) return `busy ${m2t(bs)}–${m2t(be)}`;
  }

  for (const b of booked) {
    const sameTrainer = (norm(b.trainer_code) && norm(b.trainer_code) === norm(c.code)) || (b.trainer_name && lo(b.trainer_name) === lo(c.name));
    if (!sameTrainer) continue;
    const bs = t2min(b.time); if (bs < 0) continue;
    const be = bs + (Number(b.duration_minutes) || 60);
    if (start < be && bs < end) return `already booked ${m2t(bs)}`;
  }
  return "";
}

const ROLE_ORDER: Record<string, number> = { CFT: 0, MD: 1, EMD: 2 };


/* ===== booking-handoff v: WHO IS CALLING (2026-09-30) =====
   Every check below used to read the caller's identity out of `body.code`, and GFI codes are
   printed on the org chart, so any of them could be performed as somebody else. Identity now comes
   from the session token minted when a person enters their PIN, or an Operations token. `body.code`
   is overwritten with the verified answer, so every rule further down becomes sound exactly where
   it already stands rather than being moved. */
const _SB = Deno.env.get("SUPABASE_URL")!;
const _SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function _authRpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${_SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: _SK, Authorization: `Bearer ${_SK}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function _isOps(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim(); if (!t) return false;
  const r = await _authRpc("ops_authorize", { p_token: t }); return !!(r && r.ok);
}
async function _sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120); if (!s) return "";
  const got = await _authRpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = clean(body.action, 20) || "candidates";
    /* Resolve the caller once, then overwrite body.code with the verified answer. */
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }
    const id = clean(body.id, 60);
    const me = norm(body.code);
    if (!id) return json({ ok: false, error: "appointment id required" });

    const bk = (await getJSON(`bookings?id=eq.${enc(id)}&select=*&limit=1`))[0];
    if (!bk) return json({ ok: false, error: "That appointment no longer exists." }, 404);
    if (["declined", "pending"].indexOf(lo(bk.status)) < 0) {
      return json({ ok: false, error: `Only a declined or pending appointment can be handed off (this one is ${bk.status}).` });
    }

    const az = await rpc("ops_authorize", { p_token: String(body.token ?? "") });
    const isOps = !!(az && az.ok);
    const mine = !!me && me === norm(bk.trainer_code);
    // A leader may also rescue their own team's booking, not just the trainer who declined it.
    let isLeader = false;
    if (!isOps && !mine && me) {
      const rows = await getJSON(`tracker_agents?code=eq.${enc(me)}&select=contract_level,platform_admin`);
      const a = rows[0];
      if (a) isLeader = a.platform_admin === true || ["MD", "EMD"].indexOf(norm(a.contract_level)) >= 0;
    }
    if (!isOps && !mine && !isLeader) return json({ ok: false, error: "Only the trainer who was booked, their leader, or Operations, can hand this off." }, 401);

    const avail = (await loadKey("cft_availability")) || {};
    const roster: any[] = Array.isArray(avail.cfts) ? avail.cfts : [];
    const dur = Number(bk.duration_minutes) || 60;
    const dayBooked = await getJSON(`bookings?date=eq.${enc(bk.date)}&status=in.(booked,confirmed,pending)&select=trainer_code,trainer_name,time,duration_minutes`);

    // trainer_code is a FOREIGN KEY into tracker_agents. The availability roster does not always
    // carry one, so resolve it by name here rather than trusting the stored field.
    const agents = await getJSON(`tracker_agents?select=code,first_name,last_name&limit=3000`);
    const codeByName: Record<string, string> = {};
    for (const a of agents) {
      const n = lo(`${a.first_name || ""} ${a.last_name || ""}`);
      if (n && !codeByName[n]) codeByName[n] = String(a.code);
    }
    const realCode = (c: any) => {
      const stored = clean(c.code, 40);
      if (stored && agents.some((a: any) => norm(a.code) === norm(stored))) return stored;
      return codeByName[lo(c.name)] || "";
    };

    const open: any[] = []; const busyList: any[] = [];
    for (const c of roster) {
      const code = realCode(c);
      if (code && norm(code) === norm(bk.trainer_code)) continue;               // not the one who declined
      if (lo(c.name) === lo(bk.trainer_name)) continue;
      if (c.locked === true) continue;
      const role = String(c.role || "CFT").toUpperCase();
      if (role === "OPS") continue;                                             // Operations do not run trainings
      const row = { code, name: c.name, role, calendly: c.calendly || "" };
      const why = blockedReason({ ...c, code }, bk.date, bk.time, dur, dayBooked);
      if (why) busyList.push({ ...row, reason: why }); else open.push(row);
    }
    const bySort = (a: any, b: any) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || String(a.name).localeCompare(String(b.name));
    open.sort(bySort); busyList.sort(bySort);

    if (action === "candidates") {
      return json({
        ok: true,
        booking: {
          id: bk.id, agent_name: bk.agent_name, agent_code: bk.agent_code, category: bk.category,
          date: bk.date, time: bk.time, status: bk.status, declined_by: bk.trainer_name,
          duration_minutes: dur, location: bk.location || "", meeting_link: bk.meeting_link || "",
          notes: bk.notes || "", conf: bk.conf || "",
        },
        candidates: open,
        unavailable: busyList,
      });
    }

    if (action !== "handoff") return json({ ok: false, error: "unknown action" }, 400);

    const toCode = norm(body.to_trainer_code); const toName = clean(body.to_trainer_name, 120);
    const match = (c: any) => (toCode && norm(c.code) === toCode) || (toName && lo(c.name) === lo(toName));
    let target = open.find(match);
    let forced = false;
    if (!target) {
      const blocked = busyList.find(match);
      if (blocked && body.force === true) { target = blocked; forced = true; }
      else if (blocked) return json({ ok: false, error: `${blocked.name} is ${blocked.reason}. Hand it over anyway?`, needs_force: true, reason: blocked.reason });
      else return json({ ok: false, error: "That trainer is not on the availability roster." });
    }

    const up = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${enc(id)}&status=in.(declined,pending)`, {
      method: "PATCH", headers: { ...DBH, Prefer: "return=representation" },
      // NEVER '' — the empty string is not a valid tracker_agents code and the FK rejects it.
      body: JSON.stringify({ trainer_name: target.name, trainer_code: target.code || null, trainer_calendly: target.calendly, status: "booked", updated_at: new Date().toISOString() }),
    });
    const txt = await up.text();
    if (!up.ok) {
      if (txt.indexOf("bookings_trainer_no_overlap") >= 0) {
        return json({ ok: false, taken: true, error: `${target.name} was just booked for that slot. Pick another trainer.` });
      }
      if (txt.indexOf("bookings_agent_no_overlap") >= 0) {
        return json({ ok: false, taken: true, error: `${bk.agent_name || "That agent"} already has another appointment at ${bk.time}.` });
      }
      if (txt.indexOf("bookings_trainer_code_fk") >= 0) {
        return json({ ok: false, error: `${target.name} is not on the agent roster under that code, so the appointment cannot be assigned to them. Operations needs to link their profile first.` });
      }
      return json({ ok: false, error: "Could not hand this off.", detail: txt.slice(0, 200) });
    }
    let updated: any = null; try { const p = JSON.parse(txt); updated = Array.isArray(p) ? p[0] : p; } catch (_) { /* */ }
    if (!updated) return json({ ok: false, error: "That appointment changed while you were deciding. Reload and try again." });

    // tell both sides: the agent that their session survived, the trainer that they now have it
    const note = async (to: unknown, title: string, text: string) => {
      if (!to) return;
      try {
        await fetch(`${SUPA}/rest/v1/notifications`, {
          method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ recipient_code: to, title, body: text, created_at: new Date().toISOString() }),
        });
      } catch (_) { /* a notification failure must not undo the handoff */ }
    };
    await note(bk.agent_code || null,
      `Your ${bk.category || "training"} is covered — now with ${target.name}`,
      `${bk.date} at ${bk.time}. Same time, new trainer.`);
    await note(target.code || null,
      `${bk.category || "Training"} handed to you — ${bk.agent_name || "an agent"}`,
      `${bk.date} at ${bk.time}${bk.location ? " · " + bk.location : ""}. It is already on your calendar.`);

    return json({ ok: true, id, to: target, status: "booked", forced, booking: updated });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
