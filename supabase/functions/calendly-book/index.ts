// calendly-book v4 (2026-10-21) — ONE booking, made in Calendly, mirrored into TSFG.
//
// v4: LONGER CONFIRMATION CODES. The code was five hex characters of the Calendly event UUID —
//     1,048,576 possibilities. At 1,494 bookings that is not a comfortable margin, it is roughly
//     even odds of a collision, and TWO had already happened: CAL-901B0 and CAL-B4CCB each sit on
//     two different clients' appointments. A collision is not a confidentiality problem —
//     atlas_public_manage matches the code and THEN checks the client's email — but the lookup
//     takes the first row it finds, so the second client is told their booking does not exist and
//     cannot manage it. Now 12 hex characters (2.8e14). Simulated over real UUIDs: at a hundred
//     thousand bookings the old scheme produced 4,683 collisions and this one none.
//     Still derived from the event UUID, because this row is upserted on calendly_event_uuid and
//     a random code would be rewritten on every re-sync.
//
// v3: WHO THE MEETING IS ACTUALLY WITH. Christopher: "its showing im booking as myself... it
//     should not show christopher lorenz has a meeting with christopher lorenz in the zoom call.
//     it should show dash so and so has a meeting with jeremy franklin whos trainer is
//     christopher lorenz and its on my calendar".
//
//     THE BUG WAS A PAIR THAT CAME APART. v2 resolved the invitee like this:
//         inviteeName  = body.name  || <the booking agent's name>
//         inviteeEmail = body.email || <the booking agent's email>
//     Two independent fallbacks for two halves of one identity. calendar.html sends
//     `name: NAME` — always the signed-in agent — beside whatever email was typed into a field
//     labelled "Your email", because that form was built for an agent booking time with a
//     trainer FOR THEMSELVES. The moment it was used to book a client, Calendly received
//     name "Christopher Lorenz" with email "daniel.gray02@icloud.com": a real person's address
//     under somebody else's name. Calendly shows the name, so the invite, the calendar entry and
//     the Zoom room all read as Christopher meeting Christopher. Three of October's bookings are
//     in that state, including the one whose guest is jfranklin112016@gmail.com.
//     A name and an email are now ONE value that falls back together, and a half-supplied pair
//     is refused rather than quietly completed from the booker's own profile.
//
//     A FIELD TRAINING HAS THREE PEOPLE, so it is now described as having three:
//       TRAINER  whose Calendly hosts it — trainer_code
//       TRAINEE  the agent being trained; Calendly's one invitee, so they can reschedule
//       CLIENT   the prospect being met; a guest, emailed the same invite
//     Everyone with an address is notified by Calendly itself, which is what was not happening:
//     the Scheduler's quick-add sent client_email:'' every time, so there was nobody to notify.
//
// v2 (2026-09-29): `cancel` added. Cancelling in TSFG has to cancel in Calendly too, or we have
//     rebuilt the exact problem in reverse. Also record the trainer by their real name: v1 stored
//     the Calendly ACCOUNT name, so a booking with Christopher read "Grind Agencies Inc".
//
// WHAT THIS DOES. Calendly is the only place an appointment is ever created:
//   · `types`  — the trainer's REAL event types, live from their Calendly.
//   · `slots`  — the trainer's REAL open times, live from their Calendly.
//   · `book`   — POST /invitees on the trainer's own Calendly, then writes the confirmation into
//                `bookings` immediately so it is on the TSFG calendar before the agent looks away.
//
// We do NOT guess which Calendly event type matches a TSFG category. Keyword matching is what
// once booked a Skillbridge interview as a field training. The agent picks from the trainer's
// own list instead.
//
// WHEN CALENDLY NEEDS A HUMAN. Some event types demand things we cannot invent: a required
// dropdown question, an invitee-specified address. Rather than fail or fake an answer, `book`
// returns that slot's own `scheduling_url` so the agent finishes there. Still exactly one
// booking, still in Calendly.
//
// The trainer's Personal Access Token never leaves this function.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const CAL = "https://api.calendly.com";
const PT = "America/Los_Angeles";

function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 500) => (s ?? "").toString().trim().slice(0, n);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;
const isEmail = (s: unknown) => { const v = low(s); return v.indexOf("@") > 0 && v.indexOf(".", v.indexOf("@")) > 0; };

/* The confirmation code suffix, derived from the Calendly event UUID.
   DETERMINISTIC ON PURPOSE: the booking row is upserted on calendly_event_uuid, so the same
   event must always yield the same code — a random one would be rewritten on every re-sync,
   changing a code a client may already be holding.
   12 hex characters, not 5. Five was 1,048,576 possibilities and had already collided twice in
   1,494 bookings; twelve is 2.8e14, which stays clean well past any size this will reach. */
function confFromUuid(uuid: unknown): string {
  const hex = String(uuid ?? "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length >= 12) return hex.slice(0, 12);
  return crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 12);
}

async function db(path: string, init?: RequestInit) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { ...(init || {}), headers: { ...DBH, ...((init || {}).headers || {}) } });
  const txt = await r.text();
  let body: unknown = null; try { body = txt ? JSON.parse(txt) : null; } catch (_) { body = txt; }
  return { ok: r.ok, status: r.status, body };
}

/* ---- the trainer's Calendly credentials, used here and nowhere else ---- */
type Conn = { code: string; token: string; uri: string; scheduling_url: string; name: string };
async function connOf(code: string): Promise<Conn | null> {
  const r = await db(`calendly_connections?code=eq.${enc(code)}&select=code,token,uri,scheduling_url,cal_name`);
  const row = Array.isArray(r.body) ? r.body[0] : null;
  if (!row || !row.token) return null;
  return { code: row.code, token: row.token, uri: row.uri || "", scheduling_url: row.scheduling_url || "", name: row.cal_name || "" };
}
async function calGet(token: string, path: string) {
  const r = await fetch(`${CAL}${path}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const txt = await r.text();
  let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch (_) { body = { raw: txt }; }
  return { ok: r.ok, status: r.status, body };
}
async function calPost(token: string, path: string, payload: unknown) {
  const r = await fetch(`${CAL}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const txt = await r.text();
  let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch (_) { body = { raw: txt }; }
  return { ok: r.ok, status: r.status, body };
}

/* ---- Pacific-time date/time strings, matching every booking row already in the table ---- */
function ptParts(iso: string) {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(d);
  const g = (t: string) => (p.find((x) => x.type === t) || { value: "" }).value;
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  const time = `${g("hour")}:${g("minute")} ${g("dayPeriod").toUpperCase()}`;
  return { date, time };
}

/* The Calendly account name is a business name ("Grind Agencies Inc"); the board wants the person. */
async function trainerName(code: string, fallback: string) {
  const r = await db(`tracker_agents?code=eq.${enc(code)}&select=first_name,last_name`);
  const a = Array.isArray(r.body) ? r.body[0] : null;
  const nm = a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : "";
  return nm || fallback || code;
}

async function agentOf(code: string) {
  if (!code) return null;
  const r = await db(`tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,email,phone,baseshop,status`);
  const a = Array.isArray(r.body) ? r.body[0] : null;
  if (!a) return null;
  if (low(a.status) === "quit") return null;
  return a;
}

/* Which trainers can actually be booked: on the CFT board AND holding a live Calendly token. */
async function bookableTrainers() {
  const s = await db(`app_settings?key=eq.cft_availability&select=value`);
  const v = (Array.isArray(s.body) && s.body[0]) ? s.body[0].value : null;
  const cfts: any[] = (v && Array.isArray(v.cfts)) ? v.cfts : [];
  const k = await db(`calendly_connections?select=code,cal_name,scheduling_url,token`);
  const conns: any[] = Array.isArray(k.body) ? k.body : [];
  const connected = new Set(conns.filter((c) => c.token).map((c) => norm(c.code)));
  const out = cfts.filter((c) => connected.has(norm(c.code))).map((c) => ({
    name: c.name, code: norm(c.code), baseshop: c.baseshop || "", calendly_connected: true,
  }));
  const waiting = cfts.filter((c) => !connected.has(norm(c.code))).map((c) => ({ name: c.name, code: norm(c.code) }));
  return { trainers: out, awaiting_connection: waiting };
}


/* ===== WHO IS CALLING (2026-09-30) ===== */
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
  let body: any = {};
  try { body = req.method === "POST" ? await req.json() : Object.fromEntries(new URL(req.url).searchParams); } catch (_) { body = {}; }
  const action = clean(body.action, 40);
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }

  try {
    if (action === "trainers") return json({ ok: true, ...(await bookableTrainers()) });

    if (action === "types") {
      const code = norm(body.trainer_code || body.code);
      const conn = await connOf(code);
      if (!conn) return json({ ok: false, error: "That trainer has not connected their Calendly yet." }, 400);
      if (!conn.uri) return json({ ok: false, error: "That Calendly connection is incomplete — ask them to reconnect." }, 400);
      const r = await calGet(conn.token, `/event_types?user=${enc(conn.uri)}&active=true&count=100`);
      if (!r.ok) return json({ ok: false, error: "Calendly would not list their meeting types.", detail: clean(r.body && r.body.message, 160) }, 502);
      const types = (r.body.collection || [])
        .filter((t: any) => t.active !== false && low(t.type) !== "adhoc")
        .map((t: any) => ({
          uri: t.uri, name: clean(t.name, 160), slug: t.slug || "",
          duration: Number(t.duration) || 30,
          description: clean(t.description_plain || "", 240),
          scheduling_url: t.scheduling_url || "",
          secret: !!t.secret, kind: t.kind || "", color: t.color || "",
          pooling: t.pooling_type || null,
        }));
      return json({ ok: true, trainer: conn.name, count: types.length, types });
    }

    if (action === "slots") {
      const code = norm(body.trainer_code || body.code);
      const et = clean(body.event_type, 400);
      if (!et) return json({ ok: false, error: "missing event_type" }, 400);
      const conn = await connOf(code);
      if (!conn) return json({ ok: false, error: "That trainer has not connected their Calendly yet." }, 400);
      const days = Math.min(21, Math.max(1, Number(body.days) || 14));
      const base = body.from ? new Date(String(body.from) + "T00:00:00Z") : new Date();
      let cursor = new Date(Math.max(base.getTime(), Date.now() + 60_000));
      const hardEnd = new Date(cursor.getTime() + days * 86400000);
      const slots: any[] = [];
      let guard = 0;
      while (cursor < hardEnd && guard++ < 4) {
        const winEnd = new Date(Math.min(hardEnd.getTime(), cursor.getTime() + 6.5 * 86400000));
        const r = await calGet(conn.token,
          `/event_type_available_times?event_type=${enc(et)}&start_time=${enc(cursor.toISOString())}&end_time=${enc(winEnd.toISOString())}`);
        if (!r.ok) {
          if (slots.length) break;
          return json({ ok: false, error: "Calendly would not return their availability.", detail: clean(r.body && r.body.message, 160) }, 502);
        }
        for (const s of (r.body.collection || [])) {
          if (low(s.status) !== "available") continue;
          const p = ptParts(s.start_time);
          slots.push({ start_time: s.start_time, date: p.date, time: p.time, scheduling_url: s.scheduling_url || "" });
        }
        cursor = winEnd;
      }
      return json({ ok: true, count: slots.length, slots });
    }

    /* ---------- book it, in Calendly ---------- */
    if (action === "book") {
      const trainerCode = norm(body.trainer_code);
      const byCode = norm(body.by_code || body.code);
      const et = clean(body.event_type, 400);
      const start = clean(body.start_time, 60);
      if (!trainerCode || !et || !start) return json({ ok: false, error: "missing trainer, meeting type or time" }, 400);

      const agent = await agentOf(byCode);
      if (!agent) return json({ ok: false, error: "Sign in again — we could not find your profile." }, 401);
      const bookerName = `${agent.first_name || ""} ${agent.last_name || ""}`.trim() || byCode;

      const conn = await connOf(trainerCode);
      if (!conn) return json({ ok: false, error: "That trainer has not connected their Calendly yet." }, 400);

      if (new Date(start).getTime() <= Date.now()) return json({ ok: false, error: "That time has already passed. Pick another." }, 400);

      /* ---- THE INVITEE IS ONE PERSON: a name and an address that belong together. ----
         The trainee is Calendly's single invitee, so they can reschedule their own training
         (Christopher's call, 2026-10-20). `name`/`email` are still accepted as that pair so the
         existing caller keeps working, but the two NEVER fall back separately any more — that
         is precisely how one person's address ended up under another person's name. */
      let inviteeName = clean(body.trainee_name || body.name, 120);
      let inviteeEmail = low(body.trainee_email || body.email);

      if (!inviteeName && !inviteeEmail) {
        // Nobody named at all: the booking is for the person making it. Both halves, one person.
        inviteeName = bookerName;
        inviteeEmail = low(agent.email);
      } else if (inviteeEmail && !inviteeName) {
        // An address with no name is the exact shape of the old bug. Ask rather than assume.
        return json({ ok: false, error: "Add the name that goes with " + inviteeEmail + ", so the invite is not sent under somebody else's name." }, 400);
      } else if (inviteeName && !inviteeEmail) {
        // A name with no address: if it is the booker, use their address; otherwise we cannot invite them.
        if (low(inviteeName) === low(bookerName) && isEmail(agent.email)) inviteeEmail = low(agent.email);
        else return json({ ok: false, error: "Add an email address for " + inviteeName + " so Calendly can send the invite." }, 400);
      }
      if (!isEmail(inviteeEmail)) {
        return json({ ok: false, error: "Add a valid email address so Calendly can send the invite." }, 400);
      }

      /* ---- the client being met: a guest on the invite, and recorded on the booking ---- */
      const clientName = clean(body.client_name, 120);
      const clientEmail = low(body.client_email);
      const clientPhone = clean(body.client_phone, 40);
      if (clientEmail && !isEmail(clientEmail)) {
        return json({ ok: false, error: "That client email does not look right: " + clientEmail }, 400);
      }

      const tz = clean(body.timezone, 60) || PT;
      /* Everyone else who should receive it. The client is folded in here, de-duplicated against
         the invitee so Calendly is never handed the same address twice. */
      const extra = String(body.guests || "").split(/[,;\s]+/).map(low).filter(isEmail);
      if (clientEmail) extra.unshift(clientEmail);
      const guests = Array.from(new Set(extra)).filter((g) => g !== inviteeEmail).slice(0, 10);
      const notes = clean(body.notes, 800);

      const etRes = await calGet(conn.token, `/event_types/${enc(et.split("/").pop() || "")}`);
      const etRow = etRes.ok ? (etRes.body.resource || {}) : {};
      const etName = clean(etRow.name, 160) || clean(body.event_type_name, 160) || "Meeting";
      const duration = Number(etRow.duration) || Number(body.duration) || 30;
      const locations: any[] = Array.isArray(etRow.locations) ? etRow.locations : [];
      const questions: any[] = Array.isArray(etRow.custom_questions) ? etRow.custom_questions : [];

      const NEEDS_HUMAN = questions.filter((q: any) => q.required && ["single_select", "multi_select", "phone_number"].indexOf(low(q.type)) >= 0);
      const answerable = questions.filter((q: any) => q.required && NEEDS_HUMAN.indexOf(q) < 0);
      const inviteeSpecified = locations.some((l: any) => low(l.kind) === "invitee_specified_location" || low(l.kind) === "custom");

      async function fallback(reason: string) {
        const r = await calGet(conn!.token, `/event_type_available_times?event_type=${enc(et)}&start_time=${enc(new Date(Date.now() + 60_000).toISOString())}&end_time=${enc(new Date(new Date(start).getTime() + 86400000).toISOString())}`);
        let url = "";
        if (r.ok) {
          const hit = (r.body.collection || []).find((s: any) => s.start_time === start);
          if (hit) url = hit.scheduling_url || "";
        }
        if (!url) url = etRow.scheduling_url || conn!.scheduling_url || "";
        return json({ ok: false, needs_calendly: true, reason, scheduling_url: url, event_type_name: etName });
      }

      if (NEEDS_HUMAN.length) return await fallback("This meeting asks a question only you can answer.");
      if (inviteeSpecified) return await fallback("This meeting needs a location you choose.");

      /* What the invite, the calendar entry and the Zoom room are called. A training has three
         people in it and the title now says so, instead of repeating one name twice. */
      const trainerReal = await trainerName(trainerCode, conn.name);
      let headline = inviteeName;
      if (clientName && low(clientName) !== low(inviteeName)) headline = `${inviteeName} & ${clientName}`;
      const title = (low(trainerReal) !== low(inviteeName))
        ? `${headline} · trainer ${trainerReal}`
        : headline;

      /* The note Calendly carries into the event. Phone numbers live here because Calendly has
         nowhere else to put one unless the event type asks for it. */
      const detailBits: string[] = [];
      if (clientName) detailBits.push(`Client: ${clientName}${clientEmail ? ` <${clientEmail}>` : ""}${clientPhone ? ` · ${clientPhone}` : ""}`);
      if (low(trainerReal) !== low(inviteeName)) detailBits.push(`Trainer: ${trainerReal}`);
      if (notes) detailBits.push(notes);
      const detail = detailBits.join("\n");

      const payload: any = {
        event_type: et,
        start_time: start,
        invitee: { email: inviteeEmail, name: inviteeName, timezone: tz },
      };
      if (guests.length) payload.event_guests = guests;
      if (answerable.length) {
        payload.questions_and_answers = answerable.map((q: any) => ({
          question: q.name, position: Number(q.position) || 0,
          answer: detail || `Booked by ${bookerName} in The Standard app.`,
        }));
      }
      const simple = locations.find((l: any) => ["zoom_conference", "google_conference", "microsoft_teams_conference", "webex_conference", "inbound_call"].indexOf(low(l.kind)) >= 0);
      if (locations.length === 1 && simple) payload.location = { kind: low(simple.kind) };

      let made = await calPost(conn.token, `/invitees`, payload);
      if (!made.ok && payload.location) { delete payload.location; made = await calPost(conn.token, `/invitees`, payload); }
      if (!made.ok && payload.event_guests) {
        /* A guest address Calendly will not accept must not cost us the whole booking — the
           appointment matters more than the copy list, and the guests are recorded here either way. */
        const noGuests = { ...payload }; delete noGuests.event_guests;
        made = await calPost(conn.token, `/invitees`, noGuests);
      }
      if (!made.ok) {
        const msg = clean((made.body && (made.body.message || (made.body.details && made.body.details[0] && made.body.details[0].message))) || "", 200);
        if (/already|taken|unavailable|no longer/i.test(msg)) {
          return json({ ok: false, taken: true, error: "That time was just taken in Calendly. Pick another." });
        }
        return await fallback(msg || "Calendly could not complete this booking.");
      }

      const res = made.body.resource || {};
      const eventUri: string = res.event || "";
      const eventUuid = eventUri.split("/").pop() || "";
      let startIso = start, endIso = new Date(new Date(start).getTime() + duration * 60000).toISOString();
      let joinUrl = "", locKind = "";
      if (eventUuid) {
        const ev = await calGet(conn.token, `/scheduled_events/${enc(eventUuid)}`);
        if (ev.ok) {
          const e = ev.body.resource || {};
          startIso = e.start_time || startIso;
          endIso = e.end_time || endIso;
          locKind = clean(e.location && e.location.type, 60) || clean(e.location && e.location.kind, 60);
          joinUrl = clean(e.location && (e.location.join_url || e.location.location), 500);
        }
      }
      const mins = Math.max(1, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
      const p = ptParts(startIso);

      /* agent_* is the TRAINEE — the person the training is for. It used to be whoever happened
         to be signed in, which is why a board of Christopher's bookings was a wall of his own name. */
      const traineeCode = norm(body.trainee_code) || (low(inviteeEmail) === low(agent.email) ? byCode : "");
      const row: any = {
        conf: "CAL-" + confFromUuid(eventUuid),
        agent_code: traineeCode || null, agent_name: inviteeName,
        trainer_code: trainerCode, trainer_name: trainerReal,
        category: etName, title: title,
        date: p.date, time: p.time,
        starts_at: startIso, ends_at: endIso, duration_minutes: mins,
        status: "confirmed", source: "calendly",
        calendly_event_uuid: eventUuid || null,
        timezone: PT, notes: detail || null,
        client_email: clientEmail || inviteeEmail,
        client_phone: clientPhone || null,
        guests: guests.length ? guests.join(", ") : null,
        meeting_medium: locKind || null, meeting_link: joinUrl || null,
        booked_by: byCode,
      };
      let warning: string | null = null;
      let ins = await db(`bookings?on_conflict=calendly_event_uuid`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      if (!ins.ok) {
        const t = JSON.stringify(ins.body || "");
        if (/exclusion|overlap|23P01/i.test(t)) {
          warning = "Recorded, but TSFG already had something for this trainer at that time — Operations should check for a stale appointment.";
          delete row.trainer_code;
          ins = await db(`bookings?on_conflict=calendly_event_uuid`, {
            method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(row),
          });
        }
      }
      if (!ins.ok) {
        return json({
          ok: true, calendly_only: true, event_uuid: eventUuid,
          warning: "Booked in Calendly, but TSFG could not record it — it will appear within 30 minutes on the next sync.",
          detail: clean(JSON.stringify(ins.body), 200),
        });
      }
      const saved = Array.isArray(ins.body) ? ins.body[0] : ins.body;
      return json({
        ok: true, booking: saved, event_uuid: eventUuid, conf: row.conf, warning,
        title, invitee: { name: inviteeName, email: inviteeEmail }, guests, notified: [inviteeEmail].concat(guests),
      });
    }

    /* ---------- cancel it, in Calendly ---------- */
    if (action === "cancel") {
      const byCode = norm(body.by_code || body.code);
      const uuid = clean(body.event_uuid, 80) || "";
      const id = clean(body.id, 80);
      if (!byCode) return json({ ok: false, error: "Sign in again." }, 401);
      const q = uuid ? `bookings?calendly_event_uuid=eq.${enc(uuid)}&select=*`
                     : `bookings?id=eq.${enc(id)}&select=*`;
      const br = await db(q);
      const bk = Array.isArray(br.body) ? br.body[0] : null;
      if (!bk) return json({ ok: false, error: "That appointment no longer exists." }, 404);
      const isOps = await (async () => {
        const r = await fetch(`${SUPA}/rest/v1/rpc/ops_authorize`, { method: "POST", headers: DBH, body: JSON.stringify({ p_token: String(body.token || "") }) });
        try { const j = await r.json(); return !!(j && j.ok); } catch (_) { return false; }
      })();
      if (!isOps && norm(bk.agent_code) !== byCode && norm(bk.trainer_code) !== byCode && norm(bk.booked_by) !== byCode) {
        return json({ ok: false, error: "Only the person who booked it or the trainer can cancel it." }, 403);
      }
      const reason = clean(body.reason, 300) || "Cancelled from The Standard app.";
      if (bk.calendly_event_uuid && bk.trainer_code) {
        const conn = await connOf(norm(bk.trainer_code));
        if (conn) {
          const c = await calPost(conn.token, `/scheduled_events/${enc(bk.calendly_event_uuid)}/cancellation`, { reason });
          if (!c.ok && c.status !== 404) {
            const m = clean(c.body && c.body.message, 160);
            if (/already|not.*active|canceled/i.test(m)) { /* already gone in Calendly */ }
            else return json({ ok: false, error: "Calendly would not cancel it.", detail: m }, 502);
          }
        }
      }
      await db(`bookings?id=eq.${enc(bk.id)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "canceled", updated_at: new Date().toISOString() }),
      });
      return json({ ok: true, cancelled: true, id: bk.id, event_uuid: bk.calendly_event_uuid || null });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
