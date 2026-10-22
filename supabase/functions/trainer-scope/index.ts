// trainer-scope v4 — who a broker may book, and from which baseshop.
//
// Each baseshop runs as its own operating space, so its Certified Field Trainers
// belong to it. Somebody in SMMT does not get to fill a TITANS trainer's diary.
// Leadership is the exception: MDs and EMDs can be booked across baseshops,
// because that is how a cross-baseshop assignment is supposed to happen.
// Operations is bookable by everyone — licensing help is not territorial.
//
//   same baseshop      -> anyone: CFT, MD, EMD
//   different baseshop -> MD and EMD only. A CFT is not offered at all.
//   Operations         -> always
//
// The trainer list in app_settings.cft_availability mostly has no baseshop on it
// (3 of 12 did, and one of those read "LORENZ", a legacy team name). So each
// trainer is matched to their tracker_agents record and, where that carries a
// legacy value, resolved UP the upline until a real baseshop is found — the same
// walk the DM picker uses.
//
// A trainer who still cannot be placed stays bookable by everyone rather than
// disappearing: an unknown baseshop is a data gap, and quietly hiding trainers
// would empty the Scheduler. Those are returned flagged so Operations can fix
// them rather than never noticing.
//
// v4 (2026-10-15): IDENTITY COMES FROM THE SESSION. `code` was read straight from the request
// body, so anybody could ask "what is this person's baseshop, and who may they book?" about
// anyone, and get back the whole trainer roster with each trainer's baseshop attached. No page
// in the app calls this function today — it is reachable, answered anonymously, and was handing
// out org structure to whoever asked. The caller now has to be signed in as themselves.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();

const LEADER_ROLES = new Set(["MD", "EMD", "NVP", "SEVP"]);

async function loadKey(k: string) {
  const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH });
  return ((await r.json()) || [])[0]?.value ?? null;
}
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};

    /* Proved, not typed. An Operations seat may ask too, for its own screens. */
    let code = "";
    const tok = String(body.token ?? "").trim();
    if (tok) { const r = await rpc("ops_authorize", { p_token: tok }); if (r && r.ok) code = norm(r.code); }
    if (!code) {
      const s = String(body.session ?? "").trim().slice(0, 120);
      if (!s) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
      const got = await rpc("agent_session_code", { p_token: s });
      code = (typeof got === "string") ? norm(got) : "";
      if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    }

    const basesCfg = (await loadKey("baseshops")) || { root: "STANDARD", bases: [] };
    const root = norm(basesCfg.root || "STANDARD");
    const realBases = new Set<string>(
      (Array.isArray(basesCfg.bases) ? basesCfg.bases : [])
        .map((b: Record<string, unknown>) => norm(b.name))
        .filter((b: string) => b && b !== root),
    );
    realBases.add(root);

    const av = (await loadKey("cft_availability")) || { cfts: [] };
    const trainers: Record<string, unknown>[] = Array.isArray(av.cfts) ? av.cfts : [];

    // roster, for matching a trainer to a real baseshop
    const ar = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,baseshop,direct_to,status&limit=3000`, { headers: DBH });
    const agents: Record<string, unknown>[] = (await ar.json()) || [];
    const byCode: Record<string, Record<string, unknown>> = {};
    const byName: Record<string, Record<string, unknown>> = {};
    for (const a of agents) {
      const c = norm(a.code); if (!c) continue;
      byCode[c] = a;
      const nm = low(`${a.first_name || ""} ${a.last_name || ""}`);
      if (nm.trim() && !byName[nm]) byName[nm] = a;
    }

    // walk up the upline until an ancestor sits on a real baseshop
    function resolveBase(a: Record<string, unknown> | undefined, depth = 0): string {
      if (!a || depth > 8) return "";
      const b = norm(a.baseshop);
      if (b && realBases.has(b)) return b;
      const up = norm(a.direct_to);
      if (!up || up === norm(a.code)) return "";
      return resolveBase(byCode[up], depth + 1);
    }

    const meAgent = byCode[code];
    const myBase = resolveBase(meAgent);

    const out = trainers.map((t) => {
      const tName = String(t.name || "");
      const tCode = norm(t.code);
      const role = norm(t.role) || "CFT";
      const isOps = String(t.ops) === "true" || role === "OPS";
      const rec = (tCode && byCode[tCode]) || byName[low(tName)];
      // an explicit baseshop on the trainer wins, if it is a real one
      const declared = norm(t.baseshop);
      const base = (declared && realBases.has(declared)) ? declared : resolveBase(rec);
      const isLeader = LEADER_ROLES.has(role);
      const sameBase = !!base && !!myBase && base === myBase;

      let bookable = true, reason = "";
      if (isOps) { bookable = true; reason = "operations"; }
      else if (!base) { bookable = true; reason = "baseshop unknown"; }
      else if (!myBase) { bookable = true; reason = "your baseshop unknown"; }
      else if (sameBase) { bookable = true; reason = "your baseshop"; }
      else if (isLeader) { bookable = true; reason = "leadership — cross-baseshop"; }
      else { bookable = false; reason = base + " trainer — not your baseshop"; }

      return {
        name: tName, code: tCode || null, role,
        baseshop: base || null, is_ops: isOps, is_leader: isLeader,
        same_baseshop: sameBase, cross_baseshop: !!base && !!myBase && !sameBase,
        bookable, reason,
        hidden: String(t.hidden) === "true",
        unplaced: !base && !isOps,
      };
    });

    return json({
      ok: true,
      code, my_baseshop: myBase || null, root,
      rule: "Certified Field Trainers are bookable inside your own baseshop. MDs and EMDs can be booked across baseshops. Operations is always available.",
      trainers: out,
      bookable: out.filter((t) => t.bookable && !t.hidden).map((t) => t.name),
      blocked: out.filter((t) => !t.bookable).map((t) => ({ name: t.name, baseshop: t.baseshop })),
      unplaced: out.filter((t) => t.unplaced).map((t) => t.name),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
