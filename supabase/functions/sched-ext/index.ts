// sched-ext v11 — isolated Scheduler helper (does NOT touch atlas-api).
// actions: emds, create_appt, my_appts, update_appt, delete_appt, staff_appt.
//
// v11 (2026-10-26) OPERATIONS CAN RUN THE CALENDAR. Christopher: Operations (Anais, seat 0000)
// needs full access to edit and create. Every action here took `body.code` as the caller and then
// demanded an active agent row (create/staff) or booked_by === caller (update/delete). An Ops seat
// has no agent code, so it could not create, change or remove a single appointment. Now an Ops
// session with no code acts as Operations itself: it books as "OPS:<seat>", edits and deletes any
// manual appointment, and sees every shop. An Ops session that names an agent in `code` still acts
// for that agent, exactly as before.
//
// v10 (2026-10-20) A MANUAL EVENT HAS THREE PEOPLE TOO, AND ITS CONTACT DETAILS WERE BEING
// THROWN AWAY. Christopher: "for all events please make everything fillable. trainee, guests,
// emails for both and phone numnber."
//   TWO SEPARATE FAULTS, both silent:
//   1. A FIELD-NAME MISMATCH. staff_appt read `p.email` and `p.phone`, while scheduler.html sent
//      `client_email` and `client_phone`. Neither side errored; the values simply never arrived,
//      so every quick-added event stored NULL contact details. With no address on the record
//      there was nobody to notify, which is one half of "people are not getting notified".
//      Both spellings are now accepted, so neither caller can be wrong.
//   2. NO TRAINEE, AND NO GUESTS AT ALL. agent_name was set to the CLIENT and agent_code was
//      hard-coded null, so a field training recorded nobody as having been trained — which is
//      also why these rows never counted as a training attended. A trainee can now be named
//      (agent_code/agent_name), the client keeps their own fields, and `guests` is stored.
//      When no trainee is given the old behaviour is kept exactly, so existing callers are
//      unaffected: the client still lands in agent_name and agent_code stays null.
//   A manual row is still LOCAL. It does not touch Calendly and therefore sends no invitations —
//   calendly-book is the only path that notifies anyone, because Calendly is what sends the mail.
//   The Scheduler now says so on the form rather than leaving people to wonder.
//
// v8 (2026-09-13) ONE PERSON, TWO ROLES.
// Christopher: "Summits EMD is Elijah cox. he is ALSO THE NVP in charge of standard. 2 roles same
// person." v7 reported a single `role`, resolved contract-first, so Elijah came back as "NVP" and
// the fact that he is SUMMIT's EMD disappeared. `baseOwners()` also keyed a flat map by owner code,
// so owning two bases meant the second overwrote the first and only SMMT survived.
// Now: `roles` lists every hat a person wears, `owns_bases` lists every base they own, and the
// primary `role` is resolved IN CONTEXT.
//
// v7 (2026-09-11) LEADERSHIP RANK IS NOT COMMISSION RANK. `emds` matched the literal string
// contract_level='emd'. Elijah's contract_level reads "National Vice President" — what he is PAID
// on — while his title reads "Executive Marketing Director" — what he LEADS on.
//
// v6 (2026-09-10) BASESHOP ISOLATION — the list is scoped through agent_scope().
const URL = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const txt = await r.text(); let data: any = null; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { ok: r.ok, status: r.status, data };
}
async function rpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await r.json();
  } catch { return null; }
}
/* The one canonical answer to "which baseshops may this person see" — shared with the other tabs. */
async function agentScope(code: string) {
  const r = await rpc('agent_scope', { p_code: (code || '').toUpperCase().trim() });
  if (!r || r.ok !== true) return { ok: false, all: false, bases: [] as string[] };
  return { ok: true, all: !!r.all, bases: Array.isArray(r.bases) ? r.bases.map((x: unknown) => String(x || '').toUpperCase()) : [] as string[] };
}

const UP = (s: unknown) => (s || '').toString().trim().toUpperCase();
const LOW = (s: unknown) => (s || '').toString().trim().toLowerCase();
const TXT = (s: unknown) => (s ?? '').toString().trim();
const isEmail = (s: unknown) => { const v = LOW(s); return v.indexOf('@') > 0 && v.indexOf('.', v.indexOf('@')) > 0; };
/* Accept a comma/space separated list, keep only things that are actually addresses. */
function guestList(raw: unknown, exclude: string[] = []): string[] {
  const ex = exclude.map(LOW).filter(Boolean);
  const all = TXT(raw).split(/[,;\s]+/).map(LOW).filter(isEmail);
  return Array.from(new Set(all)).filter((g) => ex.indexOf(g) < 0).slice(0, 10);
}

// EMD and above. Accepts the abbreviations and the written-out forms, on EITHER field.
function leaderRank(contract: unknown, title: unknown): string {
  for (const raw of [contract, title]) {
    const s = LOW(raw);
    if (!s) continue;
    if (s === 'sevp' || /senior executive vice/.test(s)) return 'SEVP';
    if (s === 'nvp' || /national vice/.test(s)) return 'NVP';
    if (s === 'emd' || /executive marketing director/.test(s)) return 'EMD';
  }
  return '';
}

async function baseOwners(): Promise<Record<string, { name: string; root: boolean }[]>> {
  const out: Record<string, { name: string; root: boolean }[]> = {};
  try {
    const r = await db(`app_settings?key=eq.baseshops&select=value`);
    const v = (Array.isArray(r.data) ? r.data[0] : null)?.value;
    const bases = (v && Array.isArray(v.bases)) ? v.bases : [];
    const rootName = UP(v?.root || 'STANDARD');
    for (const b of bases) {
      if (b && b.admin_grant === true) continue;
      const nm = UP(b?.name), oc = UP(b?.owner_code);
      if (!nm || !oc) continue;
      if (!out[oc]) out[oc] = [];
      if (!out[oc].some((x) => x.name === nm)) out[oc].push({ name: nm, root: nm === rootName });
    }
  } catch { /* registry is optional */ }
  return out;
}

function cap(s: string) { return (s || '').replace(/\b\w/g, (c) => c.toUpperCase()); }
const enc = encodeURIComponent;
async function ownedBy(id: string, caller: string, ops = false) {
  const r = await db(`bookings?select=id,booked_by&id=eq.${enc(id)}&limit=1`);
  const b = Array.isArray(r.data) ? r.data[0] : null;
  if (!b) return { ok: false, code: 404 };
  // Operations may change any appointment; everyone else only their own.
  if (!ops && String(b.booked_by || '').toUpperCase() !== caller) return { ok: false, code: 403 };
  return { ok: true, booking: b };
}
async function activeCaller(caller: string) {
  const who = await db(`tracker_agents?select=code,first_name,last_name,status&code=eq.${enc(caller)}&limit=1`);
  const me = Array.isArray(who.data) ? who.data[0] : null;
  if (!me || (me.status || '').toLowerCase() === 'quit') return null;
  return me;
}


/* ===== sched-ext: WHO IS CALLING (2026-09-30) ===== */
const _SB = Deno.env.get("SUPABASE_URL")!;
const _SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function _authRpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${_SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: _SK, Authorization: `Bearer ${_SK}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
/* The authorize result itself, not a yes/no: the seat code becomes the booker of record. */
async function _opsAuth(token: unknown): Promise<{ ok: boolean; code?: string } | null> {
  const t = String(token ?? "").trim(); if (!t) return null;
  const r = await _authRpc("ops_authorize", { p_token: t }); return (r && r.ok) ? r : null;
}
async function _sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120); if (!s) return "";
  const got = await _authRpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let p: any = {}; try { p = await req.json(); } catch { /* */ }
  const action = p.action || '';
  const OPS = await _opsAuth((p as Record<string, unknown>).token);
    {
      const _ops = !!OPS;
      if (!_ops) {
        const _me = await _sessionCode((p as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (p as Record<string, unknown>).code = _me;
      }
    }
  const caller = (p.code || '').toString().toUpperCase().trim();
  /* Operations acting as itself: signed into a seat and not standing in for a named agent. */
  const opsSelf = !!OPS && !caller;
  const opsTag = OPS ? `OPS:${OPS.code || '?'}` : '';

  /* Both spellings, every time. The quick-add sent client_email/client_phone while this read
     email/phone, and the values vanished in between without either side complaining. */
  const inEmail = TXT(p.email || p.client_email);
  const inPhone = TXT(p.phone || p.client_phone);

  if (action === 'emds') {
    if (!caller && !opsSelf) return json({ ok: true, emds: [], scope: 'unknown' });
    const sc = opsSelf ? { ok: true, all: true, bases: [] as string[] } : await agentScope(caller);
    if (!sc.ok) return json({ ok: true, emds: [], scope: 'unknown' });
    let path = `tracker_agents?select=code,first_name,last_name,cal_link,contract_level,title,status,baseshop&order=first_name.asc`;
    if (!sc.all) {
      if (!sc.bases.length) return json({ ok: true, emds: [], scope: 'baseshop', bases: [] });
      path += `&baseshop=in.(${enc(sc.bases.map((b) => `"${b}"`).join(','))})`;
    }
    const r = await db(path);
    if (!r.ok) return json({ ok: false, error: 'lookup failed', detail: r.data }, 500);
    const owners = await baseOwners();
    const viewing = sc.all ? '' : (sc.bases[0] || '');

    const emds = (Array.isArray(r.data) ? r.data : [])
      .filter((a: any) => (a.status || '').toLowerCase() !== 'quit')
      .map((a: any) => {
        const rank = leaderRank(a.contract_level, a.title);
        const owned = owners[UP(a.code)] || [];
        if (!rank && !owned.length) return null;
        const roles: { role: string; base: string }[] = [];
        for (const b of owned) roles.push({ role: b.root ? (rank || 'NVP') : 'EMD', base: b.name });
        if (!roles.length && rank) roles.push({ role: rank, base: a.baseshop || '' });
        const here = viewing ? roles.find((x) => x.base === UP(viewing)) : null;
        const primary = here ? here.role : (rank || (roles[0] && roles[0].role) || 'EMD');
        return {
          code: a.code,
          name: `${cap(a.first_name || '')} ${cap(a.last_name || '')}`.trim(),
          calendly: a.cal_link || '',
          role: primary, rank: rank || '', roles,
          owns_bases: owned.map((b) => b.name),
          owns_base: owned.length ? owned[0].name : '',
          baseshop: a.baseshop || '',
        };
      })
      .filter(Boolean);

    return json({ ok: true, emds, scope: sc.all ? 'all' : 'baseshop', bases: sc.bases });
  }

  if (action === 'my_appts') {
    if (opsSelf) {
      const r = await db(`bookings?select=id,title,agent_name,trainer_name,booked_by,date,time,notes,status,duration_minutes,color,client_email,client_phone,guests&source=eq.manual&order=date.desc,time.desc&limit=500`);
      return json({ ok: true, appts: Array.isArray(r.data) ? r.data : [], scope: 'all' });
    }
    if (!caller) return json({ ok: false, error: 'missing code' }, 400);
    const r = await db(`bookings?select=id,title,agent_name,date,time,notes,status,duration_minutes,color,client_email,client_phone,guests&source=eq.manual&booked_by=eq.${enc(caller)}&order=date.asc,time.asc`);
    return json({ ok: true, appts: Array.isArray(r.data) ? r.data : [] });
  }

  if (action === 'create_appt') {
    if (!caller && !opsSelf) return json({ ok: false, error: 'missing code' }, 400);
    if (!p.date || !p.time) return json({ ok: false, error: 'date and time required' }, 400);
    const me = opsSelf ? null : await activeCaller(caller);
    if (!opsSelf && !me) return json({ ok: false, error: 'unknown/inactive agent' }, 403);
    const callerName = me ? `${cap(me.first_name || '')} ${cap(me.last_name || '')}`.trim() : 'Operations';
    const booker = opsSelf ? opsTag : caller;
    const title = TXT(p.title); const withWho = TXT(p.with || p.client_name);
    const guests = guestList(p.guests, [inEmail]);
    const row = { agent_code: null, agent_name: withWho || title || 'Appointment', trainer_code: opsSelf ? null : caller, trainer_name: callerName,
      title: title || null, notes: TXT(p.notes) || null, color: TXT(p.color) || null,
      category: (p.category || 'Appointment').toString(), date: p.date, time: p.time, status: 'confirmed', source: 'manual', booked_by: booker,
      timezone: 'America/Los_Angeles', duration_minutes: Number(p.minutes) || 30,
      client_phone: inPhone || null, client_email: inEmail || null,
      guests: guests.length ? guests.join(', ') : null };
    const ins = await db('bookings', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (!ins.ok) return json({ ok: false, error: 'insert failed', detail: ins.data }, 500);
    return json({ ok: true, booking: Array.isArray(ins.data) ? ins.data[0] : ins.data });
  }

  // book a client WITH a chosen trainer (e.g. an EMD) at a manual time
  if (action === 'staff_appt') {
    if (!caller && !opsSelf) return json({ ok: false, error: 'missing code' }, 400);
    const booker = opsSelf ? opsTag : caller;
    const clientName = TXT(p.client_name);
    const traineeName = TXT(p.trainee_name);
    /* Either a client or a trainee is enough to say who this is for. Requiring client_name was
       what pushed the Scheduler into sending the booker's own name as the "client". */
    if (!p.date || !p.time || !(clientName || traineeName) || !TXT(p.trainer_name))
      return json({ ok: false, error: 'trainer, date, time and at least one of trainee or client are required' }, 400);
    if (!opsSelf) { const me = await activeCaller(caller); if (!me) return json({ ok: false, error: 'unknown/inactive agent' }, 403); }
    let tcode = UP(p.trainer_code);
    if (!tcode) {
      const parts = TXT(p.trainer_name).split(/\s+/);
      const fn = parts[0] || ''; const ln = parts.slice(1).join(' ');
      const tr = await db(`tracker_agents?select=code&first_name=ilike.${enc(fn)}&last_name=ilike.${enc(ln)}&limit=1`);
      const t = Array.isArray(tr.data) ? tr.data[0] : null; if (t) tcode = t.code;
    }
    // You may only put a booking on the calendar of someone in a shop you can actually see.
    if (tcode && !opsSelf) {
      const sc = await agentScope(caller);
      if (sc.ok && !sc.all) {
        const tr2 = await db(`tracker_agents?select=baseshop&code=eq.${enc(tcode)}&limit=1`);
        const t2 = Array.isArray(tr2.data) ? tr2.data[0] : null;
        const tb = String((t2 && t2.baseshop) || '').toUpperCase();
        if (tb && sc.bases.indexOf(tb) < 0) return json({ ok: false, error: 'That person is in another baseshop.' }, 403);
      }
    }

    /* WHO THIS EVENT IS ABOUT. With a trainee named, the booking records the trainee as the
       agent (so it counts as a training attended) and the client keeps their own fields, with
       the title carrying both names plus the trainer - matching calendly-book v3 exactly, so a
       manual event and a Calendly one read the same on the board.
       With no trainee named, nothing changes from before: the client sits in agent_name. */
    const traineeCode = UP(p.trainee_code);
    const trainerDisplay = TXT(p.trainer_name);
    let agentName = clientName, agentCode: string | null = null, title = TXT(p.title) || null;
    if (traineeName) {
      agentName = traineeName;
      agentCode = traineeCode || null;
      const headline = (clientName && LOW(clientName) !== LOW(traineeName)) ? `${traineeName} & ${clientName}` : traineeName;
      title = TXT(p.title) || ((LOW(trainerDisplay) !== LOW(traineeName)) ? `${headline} · trainer ${trainerDisplay}` : headline);
    }
    const guests = guestList(p.guests, [inEmail, TXT(p.trainee_email)]);

    const row = { agent_code: agentCode, agent_name: agentName, trainer_code: tcode || null,
      trainer_name: trainerDisplay, title: title,
      notes: TXT(p.notes) || null, color: TXT(p.color) || null,
      category: (p.category || 'Appointment').toString(), date: p.date, time: p.time, status: 'confirmed', source: 'manual', booked_by: booker,
      timezone: 'America/Los_Angeles', duration_minutes: Number(p.minutes) || 30,
      client_phone: inPhone || null, client_email: inEmail || null,
      guests: guests.length ? guests.join(', ') : null };
    const ins = await db('bookings', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (!ins.ok) return json({ ok: false, error: 'insert failed', detail: ins.data }, 500);
    /* Said plainly, because a form that collects three addresses and sends nothing is a promise
       it did not keep: a manual row is local. Calendly is what emails people. */
    return json({ ok: true, booking: Array.isArray(ins.data) ? ins.data[0] : ins.data,
      local_only: true, notified: [],
      note: 'Saved to the calendar. A manual event does not send invitations — book through the trainer’s Calendly if the client and guests need an invite.' });
  }

  if (action === 'update_appt') {
    if ((!caller && !OPS) || !p.id) return json({ ok: false, error: 'missing code/id' }, 400);
    const own = await ownedBy(p.id, caller, !!OPS); if (!own.ok) return json({ ok: false, error: 'not allowed' }, own.code || 403);
    const patch: any = { updated_at: new Date().toISOString() };
    if (p.title !== undefined) patch.title = TXT(p.title) || null;
    if (p.with !== undefined || p.title !== undefined) patch.agent_name = TXT(p.with || p.title || 'Appointment');
    if (p.date) patch.date = p.date; if (p.time) patch.time = p.time;
    if (p.notes !== undefined) patch.notes = TXT(p.notes) || null;
    if (p.color !== undefined) patch.color = TXT(p.color) || null;
    if (p.email !== undefined || p.client_email !== undefined) patch.client_email = inEmail || null;
    if (p.phone !== undefined || p.client_phone !== undefined) patch.client_phone = inPhone || null;
    if (p.guests !== undefined) { const g = guestList(p.guests, [inEmail]); patch.guests = g.length ? g.join(', ') : null; }
    const up = await db(`bookings?id=eq.${enc(p.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    if (!up.ok) return json({ ok: false, error: 'update failed', detail: up.data }, 500);
    return json({ ok: true, booking: Array.isArray(up.data) ? up.data[0] : up.data });
  }

  if (action === 'delete_appt') {
    if ((!caller && !OPS) || !p.id) return json({ ok: false, error: 'missing code/id' }, 400);
    const own = await ownedBy(p.id, caller, !!OPS); if (!own.ok) return json({ ok: false, error: 'not allowed' }, own.code || 403);
    const del = await db(`bookings?id=eq.${enc(p.id)}`, { method: 'DELETE' });
    if (!del.ok) return json({ ok: false, error: 'delete failed', detail: del.data }, 500);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'unknown action' }, 400);
});
