// announce v6 (2026-10-26; v5 2026-09-30) — chain of command for hierarchy-wide announcements.
//
// Anything company-wide used to go straight into #main over every EMD's head.
// That is how 56 training reminders ended up burying three human messages. Now
// a hierarchy announcement is PROPOSED, every EMD sees it waiting on them, and
// it reaches a team only once that team's EMD approves it. An EMD may decline
// for their own baseshop without blocking anyone else's — each leader owns what
// lands in front of their people.
//
// Who may propose: Operations, Eli Cox, and anyone flagged as a platform builder
// (is_platform_admin). An EMD proposing to their OWN baseshop skips the queue,
// because that is just them posting to their own team.
//
// v2 (2026-09-03): the builder capability replaced a hardcoded creator account.
// Christopher built the platform but is an MD in the field — promoting him to EMD
// to grant the controls would have put him in EMD leaderboards and promotion
// ladders as if he had earned the rank. is_platform_admin is a named capability,
// carried in the database and independent of contract level, so rank keeps meaning
// what it says while the builder can still operate every level.
// v2 also drops the literal "2026" for ops_authorize, in line with the rest of the endpoints.
//
// v5 — WHO IS SPEAKING. Every authority test above ran off `body.code`: an Ops seat code, Eli's
// code, the platform builder's code, an EMD's code. All of those are printed on the org chart, so
// typing one made you that person here — and this endpoint's whole job is to speak to the company.
// A forged `propose` reached every EMD's approval queue under Operations' name; a forged `decide`
// posted into a baseshop's announcements channel signed by its EMD. That is the most convincing
// phishing surface in the app, because announcements are the one place agents are told to trust.
// Identity is now the session token minted when somebody enters their PIN, or an Operations token
// ops_authorize() accepts. `body.code` is not read at all any more.
//
// v7 (2026-10-26) — AN OPS TOKEN DECIDES ONLY FOR THE SHOPS IT COVERS. v6 let Operations decide,
// but any token ops_authorize() accepted counted: a baseshop seat (0001-0005) could approve an
// announcement into another shop's channel, and a machine token (a cron job, not a person) could
// sign a decision. Now a master seat (0000, C1991) decides anywhere, a baseshop seat only for
// targets in its own bases, and a machine token never.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPS_CODE = /^(000[0-5]|9999)$/;
const HIERARCHY_OWNERS = new Set(["GFI20"]);      // Eli Cox
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown, n = 4000) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;

async function loadKey(k: string) {
  const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH });
  return ((await r.json()) || [])[0]?.value ?? null;
}
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorize(token: unknown): Promise<Record<string, unknown> | null> { const t = String(token ?? ""); if (!t) return null; const r = await rpc("ops_authorize", { p_token: t }); return (r && r.ok) ? r : null; }

/* v7: may this Ops token decide for this baseshop? Machine tokens are scheduled jobs, not a person
   who can approve anything. Non-master seats are expanded through baseshop_groups by ops_scope,
   the same helper every other scoped Ops screen uses. */
async function opsMayDecide(auth: Record<string, unknown> | null, token: unknown, baseshop: string): Promise<boolean> {
  if (!auth || auth.via === "machine") return false;
  if (auth.master === true) return true;
  const sc = await rpc("ops_scope", { p_token: String(token ?? "") });
  const seatBases: string[] = Array.isArray(sc?.bases) ? sc.bases.map((b: unknown) => norm(b)) : [];
  if (sc && sc.seat && !sc.scoped) return true;
  return !!baseshop && seatBases.indexOf(norm(baseshop)) >= 0;
}
async function isBuilder(code: string) { if (!code) return false; return (await rpc("is_platform_admin", { p_code: code })) === true; }

/* The one place identity is decided. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = clean(session, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

async function whoIs(code: string) {
  if (!code) return null;
  const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,contract_level,title,baseshop&limit=1`, { headers: DBH });
  const a = ((await r.json()) || [])[0];
  if (!a) return null;
  const lvl = low(a.contract_level) + " " + low(a.title);
  return {
    code: norm(a.code), name: `${a.first_name || ""} ${a.last_name || ""}`.trim(),
    baseshop: norm(a.baseshop),
    isEmd: /\bemd\b|executive marketing|national vice|senior executive/.test(lvl),
  };
}
async function post(channel: string, authorCode: string, authorName: string, bodyTxt: string) {
  await fetch(`${SUPA}/rest/v1/hub_messages`, {
    method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
    body: JSON.stringify({ channel, author_code: authorCode, author_name: authorName, body: bodyTxt, kind: "announce", attach: { source: "Announcement" }, reactions: {} }),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = clean(body.action, 20) || "pending";

    const opsAuth = await opsAuthorize(body.token);
    const opsToken = !!opsAuth;
    const myCode = opsToken ? "" : await sessionCode(body.session);
    if (!opsToken && !myCode) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

    const me = myCode ? await whoIs(myCode) : null;
    const builder = me ? await isBuilder(me.code) : false;
    const isOps = opsToken || builder ||
                  (!!me && (OPS_CODE.test(me.code) || HIERARCHY_OWNERS.has(me.code)));

    const cfg = (await loadKey("baseshops")) || { root: "STANDARD", bases: [] };
    const root = norm(cfg.root || "STANDARD");
    const baseList: Record<string, unknown>[] = Array.isArray(cfg.bases) ? cfg.bases : [];
    const bases: { name: string; owner: string }[] = [];
    for (const b of baseList) {
      const nm = norm(b.name);
      if (!nm || nm === root) continue;
      if (bases.some((x) => x.name === nm)) continue;
      bases.push({ name: nm, owner: norm(b.owner_code) });
    }

    /* ---------- what is waiting on this EMD ---------- */
    if (action === "pending") {
      const mine = me ? bases.filter((b) => b.owner === me.code || (me.isEmd && b.name === me.baseshop)).map((b) => b.name) : [];
      if (!mine.length && !isOps) return json({ ok: true, is_emd: false, mine: [], pending: [] });
      const q = isOps ? "" : `&baseshop=in.(${mine.map(enc).join(",")})`;
      const r = await fetch(`${SUPA}/rest/v1/announcement_targets?status=eq.pending${q}&select=*&order=id.desc&limit=100`, { headers: DBH });
      const targets = (await r.json()) || [];
      const ids = Array.from(new Set(targets.map((t: Record<string, unknown>) => t.announcement_id)));
      let anns: Record<string, unknown>[] = [];
      if (ids.length) {
        const ar = await fetch(`${SUPA}/rest/v1/announcements?id=in.(${ids.map((i) => enc(String(i))).join(",")})&select=*`, { headers: DBH });
        anns = (await ar.json()) || [];
      }
      const byId: Record<string, unknown> = {}; anns.forEach((a) => byId[String(a.id)] = a);
      return json({
        ok: true, is_emd: !!(me && me.isEmd) || isOps, is_ops: isOps, is_builder: builder,
        mine: isOps ? bases.map((b) => b.name) : mine,
        pending: targets.map((t: Record<string, unknown>) => ({ ...t, announcement: byId[String(t.announcement_id)] || null })),
      });
    }

    /* ---------- everything, with progress ---------- */
    if (action === "list") {
      const r = await fetch(`${SUPA}/rest/v1/announcements?select=*&order=created_at.desc&limit=50`, { headers: DBH });
      const anns = (await r.json()) || [];
      const tr = await fetch(`${SUPA}/rest/v1/announcement_targets?select=*&limit=500`, { headers: DBH });
      const targets = (await tr.json()) || [];
      const byAnn: Record<string, Record<string, unknown>[]> = {};
      targets.forEach((t: Record<string, unknown>) => { (byAnn[String(t.announcement_id)] = byAnn[String(t.announcement_id)] || []).push(t); });
      return json({
        ok: true, can_propose: isOps,
        announcements: anns.map((a: Record<string, unknown>) => {
          const ts = byAnn[String(a.id)] || [];
          return {
            ...a, targets: ts,
            approved: ts.filter((t) => t.status === "approved").length,
            declined: ts.filter((t) => t.status === "declined").length,
            waiting: ts.filter((t) => t.status === "pending").length,
          };
        }),
      });
    }

    /* ---------- propose ---------- */
    if (action === "propose") {
      const title = clean(body.title, 160);
      const text = clean(body.body, 4000);
      if (!title || !text) return json({ ok: false, error: "A title and a message are both needed." }, 400);

      const ownBase = me && me.isEmd ? (bases.find((b) => b.owner === me.code) || bases.find((b) => b.name === me.baseshop)) : null;
      if (!isOps && !ownBase) {
        return json({ ok: false, error: "Hierarchy announcements are proposed by Operations or Eli Cox. You can post to your own baseshop channel directly." }, 403);
      }

      const targetsFor = isOps ? bases : [ownBase!];
      const ins = await fetch(`${SUPA}/rest/v1/announcements`, {
        method: "POST", headers: { ...DBH, Prefer: "return=representation" },
        body: JSON.stringify({
          title, body: text, scope: isOps ? "hierarchy" : "baseshop",
          created_by: me?.code || "OPS", created_by_name: me?.name || "Operations",
          post_to_main: body.post_to_main === true,
        }),
      });
      const ann = ((await ins.json()) || [])[0];
      if (!ann) return json({ ok: false, error: "Could not create the announcement." }, 500);

      const rows = targetsFor.map((b) => ({
        announcement_id: ann.id, baseshop: b.name, emd_code: b.owner || null,
      }));
      await fetch(`${SUPA}/rest/v1/announcement_targets`, {
        method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(rows),
      });

      return json({
        ok: true, announcement: ann, awaiting: rows.length,
        note: isOps
          ? `Sent to ${rows.length} EMD${rows.length === 1 ? "" : "s"} for approval. It reaches each team only once their EMD approves it.`
          : "Waiting on your approval to post to your baseshop.",
      });
    }

    /* ---------- approve or decline, for one baseshop ---------- */
    if (action === "decide") {
      /* 2026-10-26: Operations (Anais, seat 0000) decides too. It could propose and withdraw but
         not approve or decline, so a target an EMD never got to sat pending forever. An Ops
         decision is recorded and signed as Operations, never as the EMD. */
      const actor = me || (opsToken ? { code: "OPSANN", name: "Operations", isEmd: false, baseshop: "" } : null);
      if (!actor) return json({ ok: false, error: "Only a baseshop's own EMD can decide this." }, 403);
      const targetId = clean(body.target_id, 60);
      const decision = low(body.decision) === "approve" ? "approved" : "declined";
      if (!targetId) return json({ ok: false, error: "target_id required" }, 400);

      const tr = await fetch(`${SUPA}/rest/v1/announcement_targets?id=eq.${enc(targetId)}&select=*&limit=1`, { headers: DBH });
      const t = ((await tr.json()) || [])[0];
      if (!t) return json({ ok: false, error: "That announcement is no longer waiting." }, 404);
      if (t.status !== "pending") return json({ ok: false, error: `Already ${t.status}.` }, 409);

      /* v7: an Ops TOKEN is judged by its seat's bases (master = everywhere, machine = never);
         the agent-session paths (builder, Eli, the target's own EMD) are unchanged. */
      const ownsIt = opsToken
        ? await opsMayDecide(opsAuth, body.token, norm(t.baseshop))
        : (isOps || norm(t.emd_code) === actor.code || (actor.isEmd && norm(t.baseshop) === actor.baseshop));
      if (!ownsIt) return json({ ok: false, error: "Only this baseshop's EMD can decide this." }, 403);

      const ar = await fetch(`${SUPA}/rest/v1/announcements?id=eq.${enc(String(t.announcement_id))}&select=*&limit=1`, { headers: DBH });
      const ann = ((await ar.json()) || [])[0];
      if (!ann) return json({ ok: false, error: "announcement missing" }, 404);

      let postedAt: string | null = null;
      if (decision === "approved") {
        const channel = low(t.baseshop) + "_announcements";
        const text = "📢 " + ann.title + "\n\n" + ann.body +
          "\n\n— " + (ann.created_by_name || "Operations") + " · approved for " + t.baseshop + " by " + actor.name;
        await post(channel, actor.code, actor.name, text);
        postedAt = new Date().toISOString();
      }

      await fetch(`${SUPA}/rest/v1/announcement_targets?id=eq.${enc(targetId)}`, {
        method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify({
          status: decision, decided_by: actor.name, decided_at: new Date().toISOString(),
          note: clean(body.note, 300), posted_at: postedAt,
        }),
      });

      const rest = await fetch(`${SUPA}/rest/v1/announcement_targets?announcement_id=eq.${enc(String(t.announcement_id))}&status=eq.pending&select=id`, { headers: DBH });
      const stillWaiting = ((await rest.json()) || []).length;
      if (!stillWaiting) {
        await fetch(`${SUPA}/rest/v1/announcements?id=eq.${enc(String(t.announcement_id))}`, {
          method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ status: "complete", updated_at: new Date().toISOString() }),
        });
        if (ann.post_to_main && decision === "approved") {
          await post("main", "OPSANN", "Operations · Announcements", "📢 " + ann.title + "\n\n" + ann.body);
        }
      }

      return json({
        ok: true, decision, baseshop: t.baseshop, posted: !!postedAt,
        still_waiting: stillWaiting,
        note: decision === "approved"
          ? `Posted to ${t.baseshop}.`
          : `Declined for ${t.baseshop}. No one else's baseshop is affected.`,
      });
    }

    if (action === "withdraw") {
      if (!isOps) return json({ ok: false, error: "Operations only." }, 403);
      const id = clean(body.id, 60);
      if (!id) return json({ ok: false, error: "id required" }, 400);
      await fetch(`${SUPA}/rest/v1/announcement_targets?announcement_id=eq.${enc(id)}&status=eq.pending`, {
        method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" },
      });
      await fetch(`${SUPA}/rest/v1/announcements?id=eq.${enc(id)}`, {
        method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "withdrawn", updated_at: new Date().toISOString() }),
      });
      return json({ ok: true, withdrawn: id, note: "Pulled back from anyone who had not yet approved it." });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
