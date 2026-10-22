// bot-admin v4 (2026-09-30) — an EMD's controls for their own baseshop.
//
// v4 — WHO IS ASKING. v3 got the SHOP boundary right (a GRIND EMD can no longer rename TITANS'
// bots) and then decided WHO was asking from a typed `code`. GFI codes are printed on the org
// chart, so typing an EMD's code gave you their shop's bots; typing the platform builder's code
// gave you `scope: "global"` — the COMPANY-WIDE defaults: a bot's name, its tone, and the text it
// posts automatically into team channels. That is content control over the company's automated
// messaging, which is the same class of problem as writing into the assistant's knowledge base.
// Identity now comes from the session token minted at PIN entry, and `body.code` is overwritten
// with the verified answer so every check below — and every `updated_by` stamp — becomes sound
// where it already stands. `run_custom` is the cron and keeps its Operations machine token.
//
// The bots were named Bob, Kevin and Stuart — placeholder Minion names — with their behaviour
// spread across five functions and two settings screens. An EMD could not tell what any of them
// did, let alone change it.
//
// v3 — CUSTOMISABLE BOTS PER BASESHOP. Christopher: "in the EMD settings please allow for
//   customizable bots."
//
//   The bug this also fixes: `bots` is a GLOBAL table and `save` wrote straight to it, so a GRIND
//   EMD renaming Stuart renamed him for TITANS, SCAPED and everybody else — silently, with no way
//   to tell. Each shop now has its own layer in `baseshop_bots`:
//     · an OVERRIDE of a built-in bot (name, badge, tone, or switching it off) for that shop only
//     · a CUSTOM bot the leader invents, with its own recurring schedule
//   The built-in row remains the default, so a shop that has never touched a bot still gets it,
//   and bot_channel_policy() now prefers the shop's override when it posts.
//
//   Operations and the platform builder still edit the GLOBAL defaults — that is the difference
//   between "change it for my team" and "change it for the company".
//
// Everything is data:
//   · WHO the bots are        -> `bots` (defaults) + `baseshop_bots` (this shop)
//   · WHERE they may speak    -> `kind`, enforced in the DB by bot_channel_policy()
//   · WHEN they speak         -> per-baseshop schedule
//   · What the channel is CALLED -> per-baseshop label. The channel KEY never changes, because
//                                messages are stored against it.
//
// Actions: list | save | create | remove · base_get | base_save · run_custom (cron)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 400) => (s ?? "").toString().trim().slice(0, n);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;
const slug = (s: unknown) => (s ?? "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14);

async function getJSON(p: string) { try { const r = await fetch(`${SUPA}/rest/v1/${p}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, a: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(a) }); return await r.json(); } catch (_) { return null; } }
async function loadKey(k: string) { const r = await getJSON(`app_settings?key=eq.${k}&select=value`); return ((r as any[])[0] || {}).value || null; }
async function saveKey(k: string, value: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value, updated_at: new Date().toISOString() }) }); }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

async function whoIs(code: string, token: unknown) {
  const t = await rpc("ops_authorize", { p_token: String(token ?? "") });
  const c = norm(code);
  const builder = c ? ((await rpc("is_platform_admin", { p_code: c })) === true) : false;
  if ((t && t.ok) || builder) {
    let base = "";
    if (c) { const rr = (await getJSON(`tracker_agents?code=eq.${enc(c)}&select=baseshop`))[0]; base = rr ? String(rr.baseshop || "") : ""; }
    return { ok: true, all: true, why: builder ? "platform builder" : "operations", base };
  }
  if (!c) return { ok: false, all: false, why: "", base: "" };
  const a = (await getJSON(`tracker_agents?code=eq.${enc(c)}&select=contract_level,title,baseshop`))[0];
  if (!a) return { ok: false, all: false, why: "", base: "" };
  const lvl = low((a.contract_level || "") + " " + (a.title || ""));
  const emd = /executive|national vice|senior executive/.test(lvl) || ["emd", "nvp", "sevp"].indexOf(lvl.trim()) >= 0;
  return { ok: emd, all: false, why: emd ? "EMD" : "", base: String(a.baseshop || "") };
}

const KINDS = ["team", "ops", "dm"];
const WHERE: Record<string, string> = {
  team: "Your baseshop's own channel only — never the company chat, never Operations.",
  ops:  "The Operations channel only. This is a tool, not a team bot.",
  dm:   "Direct messages only. Never posts anywhere public.",
};
const DEFAULT_SCHED = {
  announce: true, reminders: [60, 30, 10, 0], highlights_hour: 8,
  highlights_days: [1, 2, 3, 4, 5], quiet_before: 6, quiet_after: 21, highlights: [] as string[],
};
function cleanSched(inp: any, cur: any) {
  const s: any = { ...DEFAULT_SCHED, ...(cur || {}) };
  if (inp.announce !== undefined) s.announce = !!inp.announce;
  if (Array.isArray(inp.reminders)) s.reminders = inp.reminders.map((x: unknown) => Number(x)).filter((n: number) => [60, 30, 10, 0].indexOf(n) >= 0);
  if (inp.highlights_hour !== undefined) s.highlights_hour = Math.max(0, Math.min(23, Number(inp.highlights_hour) || 0));
  if (Array.isArray(inp.highlights_days)) s.highlights_days = inp.highlights_days.map((x: unknown) => Number(x)).filter((n: number) => n >= 0 && n <= 6);
  if (inp.quiet_before !== undefined) s.quiet_before = Math.max(0, Math.min(23, Number(inp.quiet_before) || 0));
  if (inp.quiet_after !== undefined) s.quiet_after = Math.max(0, Math.min(23, Number(inp.quiet_after) || 23));
  if (Array.isArray(inp.highlights)) s.highlights = inp.highlights.map((x: unknown) => clean(x, 200)).filter(Boolean).slice(0, 10);
  return s;
}
// A custom bot's own recurring post: which days, what hour, and the lines it rotates through.
function cleanBotSched(inp: any) {
  const s: any = { days: [], hour: 9, messages: [], next_index: 0 };
  if (Array.isArray(inp && inp.days)) s.days = inp.days.map((x: unknown) => Number(x)).filter((n: number) => n >= 0 && n <= 6);
  if (inp && inp.hour !== undefined) s.hour = Math.max(0, Math.min(23, Number(inp.hour) || 0));
  if (Array.isArray(inp && inp.messages)) s.messages = inp.messages.map((x: unknown) => clean(x, 600)).filter(Boolean).slice(0, 20);
  if (inp && inp.next_index !== undefined) s.next_index = Math.max(0, Number(inp.next_index) || 0);
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = clean(body.action, 20) || "list";

    /* ---------- cron: post the custom bots whose hour has come ---------- */
    if (action === "run_custom") {
      const az = await rpc("ops_authorize", { p_token: String(body.token ?? "") });
      if (!(az && az.ok)) return json({ ok: false, error: "unauthorized" }, 401);
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", hour12: false });
      const parts = fmt.formatToParts(new Date());
      const wd = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[(parts.find((p) => p.type === "weekday") || { value: "" }).value] ?? -1;
      const hr = parseInt((parts.find((p) => p.type === "hour") || { value: "-1" }).value, 10);
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
      const rows = await getJSON(`baseshop_bots?is_custom=is.true&enabled=is.true&select=*`);
      let posted = 0;
      for (const r of rows as any[]) {
        const s = r.schedule || {};
        if (!Array.isArray(s.days) || s.days.indexOf(wd) < 0) continue;
        if (Number(s.hour) !== hr) continue;
        if (r.last_run_on === today) continue;                 // once a day, whatever the cron does
        const msgs: string[] = Array.isArray(s.messages) ? s.messages : [];
        if (!msgs.length) continue;
        const i = Math.max(0, Number(s.next_index) || 0) % msgs.length;
        const ch = low(r.baseshop).replace(/[^a-z0-9]/g, "") + "_announcements";
        const ins = await fetch(`${SUPA}/rest/v1/hub_messages`, {
          method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ channel: ch, author_code: r.code, author_name: r.name, body: msgs[i], kind: "announce", reactions: {} }),
        });
        if (!ins.ok) continue;
        await fetch(`${SUPA}/rest/v1/baseshop_bots?baseshop=eq.${enc(r.baseshop)}&code=eq.${enc(r.code)}`, {
          method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ last_run_on: today, schedule: { ...s, next_index: (i + 1) % msgs.length } }),
        });
        posted++;
      }
      return json({ ok: true, weekday: wd, hour: hr, checked: (rows as any[]).length, posted });
    }

    /* Everything else is a person editing bots. Prove who they are, then overwrite body.code with
       the verified answer so whoIs() and every updated_by stamp below read the real identity. */
    const opsTok = await rpc("ops_authorize", { p_token: String(body.token ?? "") });
    if (!(opsTok && opsTok.ok)) {
      const me = await sessionCode(body.session);
      if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
      body.code = me;
    }

    const who = await whoIs(String(body.code || ""), body.token);

    /* ---------- what this shop actually sees ---------- */
    if (action === "list") {
      const shop = clean(body.baseshop, 40) || who.base;
      const defs = await getJSON(`bots?order=kind.asc,code.asc&select=*`);
      const mine = shop ? await getJSON(`baseshop_bots?baseshop=eq.${enc(shop)}&select=*`) : [];
      const byCode: Record<string, any> = {};
      (mine as any[]).forEach((m) => byCode[norm(m.code)] = m);
      const merged = (defs as any[]).map((b) => {
        const o = byCode[norm(b.code)] || {};
        return {
          code: b.code, kind: b.kind, is_custom: false, built_in: true,
          name: o.name || b.name, emoji: o.emoji || b.emoji,
          role: o.role || b.role, posts: o.posts || b.posts, tone: o.tone || b.tone,
          enabled: (o.enabled !== undefined && o.enabled !== null) ? o.enabled : b.enabled,
          customised: !!byCode[norm(b.code)],
          default_name: b.name, default_emoji: b.emoji,
          where: WHERE[b.kind] || "",
        };
      });
      const custom = (mine as any[]).filter((m) => m.is_custom).map((m) => ({
        code: m.code, kind: "team", is_custom: true, built_in: false,
        name: m.name, emoji: m.emoji, role: m.role, posts: m.posts, tone: m.tone,
        enabled: m.enabled, schedule: m.schedule || {}, last_run_on: m.last_run_on,
        where: WHERE.team,
      }));
      return json({ ok: true, can_edit: who.ok, as: who.why, baseshop: shop, is_ops: who.all, bots: merged, custom });
    }

    if (!who.ok) return json({ ok: false, error: "Executive Marketing Directors and Operations can change the bots." }, 403);

    /* ---------- edit a bot ---------- */
    if (action === "save") {
      const b: any = body.bot || body;
      const code = norm(b.bot || b.code_target || b.botcode || b.target || b.code);
      const shop = clean(body.baseshop, 40) || who.base;
      if (!code) return json({ ok: false, error: "Which bot?" });
      if (!who.all && !shop) return json({ ok: false, error: "Your profile has no baseshop." }, 400);
      if (!who.all && low(shop) !== low(who.base)) return json({ ok: false, error: "You can only change your own baseshop's bots." }, 403);

      const isCustom = code.startsWith("X");
      // Operations edits the company default; a leader edits their own shop's copy.
      const global = who.all && body.scope === "global" && !isCustom;

      if (global) {
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: norm(body.code) || null };
        if (b.name !== undefined) { const n = clean(b.name, 40); if (!n) return json({ ok: false, error: "A bot needs a name." }); patch.name = n; }
        if (b.emoji !== undefined) patch.emoji = clean(b.emoji, 8);
        if (b.role !== undefined) patch.role = clean(b.role, 160);
        if (b.posts !== undefined) patch.posts = clean(b.posts, 600);
        if (b.tone !== undefined) patch.tone = clean(b.tone, 400);
        if (b.enabled !== undefined) patch.enabled = !!b.enabled;
        if (b.kind !== undefined) { const k = low(b.kind); if (KINDS.indexOf(k) < 0) return json({ ok: false, error: "Where it posts must be team, ops or dm." }); patch.kind = k; }
        const r = await fetch(`${SUPA}/rest/v1/bots?code=eq.${enc(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(patch) });
        const out = await r.json(); const saved = Array.isArray(out) ? out[0] : out;
        if (!saved) return json({ ok: false, error: "That bot does not exist." }, 404);
        return json({ ok: true, scope: "global", bot: { ...saved, where: WHERE[saved.kind] || "" } });
      }

      const row: Record<string, unknown> = {
        baseshop: shop, code, updated_by: norm(body.code) || null, updated_at: new Date().toISOString(),
      };
      if (b.name !== undefined) row.name = clean(b.name, 40);
      if (b.emoji !== undefined) row.emoji = clean(b.emoji, 8);
      if (b.role !== undefined) row.role = clean(b.role, 160);
      if (b.posts !== undefined) row.posts = clean(b.posts, 600);
      if (b.tone !== undefined) row.tone = clean(b.tone, 400);
      if (b.enabled !== undefined) row.enabled = !!b.enabled;
      if (isCustom && b.schedule !== undefined) row.schedule = cleanBotSched(b.schedule);
      const up = await fetch(`${SUPA}/rest/v1/baseshop_bots?on_conflict=baseshop,code`, {
        method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      const out = await up.json();
      if (!up.ok) return json({ ok: false, error: "Could not save that.", detail: JSON.stringify(out).slice(0, 200) });
      return json({ ok: true, scope: "baseshop", baseshop: shop, bot: Array.isArray(out) ? out[0] : out });
    }

    /* ---------- invent a bot ---------- */
    if (action === "create") {
      const shop = clean(body.baseshop, 40) || who.base;
      if (!shop) return json({ ok: false, error: "Your profile has no baseshop." }, 400);
      if (!who.all && low(shop) !== low(who.base)) return json({ ok: false, error: "You can only add a bot to your own baseshop." }, 403);
      const name = clean(body.name, 40);
      if (!name) return json({ ok: false, error: "Give your bot a name." });
      const code = "X" + slug(shop).slice(0, 6) + slug(name).slice(0, 8) || "";
      if (code.length < 3) return json({ ok: false, error: "That name has no letters or numbers in it." });
      const exists = (await getJSON(`baseshop_bots?baseshop=eq.${enc(shop)}&code=eq.${enc(code)}&select=code`))[0];
      if (exists) return json({ ok: false, error: "You already have a bot with that name." });

      // It also needs a row in `bots`, because bot_channel_policy() looks the author up there —
      // without it the post would be treated as a person and skip the channel guard entirely.
      await fetch(`${SUPA}/rest/v1/bots?on_conflict=code`, {
        method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          code, name, emoji: clean(body.emoji, 8) || "\u{1F916}",
          role: clean(body.role, 160) || (shop + " custom bot"),
          kind: "team", enabled: true,
          posts: clean(body.posts, 600) || "A recurring message set by the team's leader",
          tone: clean(body.tone, 400), updated_by: norm(body.code) || null,
        }),
      });
      const ins = await fetch(`${SUPA}/rest/v1/baseshop_bots`, {
        method: "POST", headers: { ...DBH, Prefer: "return=representation" },
        body: JSON.stringify({
          baseshop: shop, code, name, emoji: clean(body.emoji, 8) || "\u{1F916}",
          role: clean(body.role, 160), posts: clean(body.posts, 600), tone: clean(body.tone, 400),
          enabled: true, is_custom: true, schedule: cleanBotSched(body.schedule),
          created_by: norm(body.code) || null, updated_by: norm(body.code) || null,
        }),
      });
      const out = await ins.json();
      if (!ins.ok) return json({ ok: false, error: "Could not create that bot.", detail: JSON.stringify(out).slice(0, 200) });
      return json({ ok: true, bot: Array.isArray(out) ? out[0] : out });
    }

    /* ---------- remove a custom bot (never a built-in) ---------- */
    if (action === "remove") {
      const shop = clean(body.baseshop, 40) || who.base;
      const code = norm(body.bot || body.target);
      if (!code) return json({ ok: false, error: "Which bot?" });
      if (!who.all && low(shop) !== low(who.base)) return json({ ok: false, error: "That is not your baseshop." }, 403);
      const row = (await getJSON(`baseshop_bots?baseshop=eq.${enc(shop)}&code=eq.${enc(code)}&select=is_custom`))[0];
      if (!row) return json({ ok: false, error: "Not found." }, 404);
      if (!row.is_custom) {
        // Removing an override just restores the company default, which is the sane meaning here.
        await fetch(`${SUPA}/rest/v1/baseshop_bots?baseshop=eq.${enc(shop)}&code=eq.${enc(code)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
        return json({ ok: true, restored_default: true });
      }
      await fetch(`${SUPA}/rest/v1/baseshop_bots?baseshop=eq.${enc(shop)}&code=eq.${enc(code)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      await fetch(`${SUPA}/rest/v1/bots?code=eq.${enc(code)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: true, deleted: code });
    }

    /* ---- an EMD's own baseshop: when the bots speak, and what the channel is called ---- */
    if (action === "base_get") {
      const cfg = (await loadKey("hub_bot_config")) || {};
      const basesCfg = cfg.bases || {};
      const all = (await loadKey("baseshops")) || { bases: [] };
      const root = low(all.root || "standard");
      let names: string[] = (all.bases || []).map((b: any) => String(b.name)).filter((n: string) => low(n) !== root);
      if (!who.all) names = names.filter((n) => low(n) === low(who.base));
      const out = names.map((n) => {
        const k = low(n); const c = basesCfg[k] || {};
        return {
          baseshop: n, channel_key: k + "_announcements",
          label: clean(c.label, 40) || (n + " Announcements"),
          schedule: cleanSched({}, c.schedule || { announce: c.announce !== false, highlights: c.highlights || [] }),
        };
      });
      return json({ ok: true, can_edit: true, as: who.why, bases: out, defaults: DEFAULT_SCHED });
    }

    if (action === "base_save") {
      const base = clean(body.baseshop, 40); if (!base) return json({ ok: false, error: "Which baseshop?" });
      if (!who.all && low(base) !== low(who.base)) return json({ ok: false, error: "You can only change your own baseshop's settings." }, 403);
      const cfg = (await loadKey("hub_bot_config")) || {}; if (!cfg.bases) cfg.bases = {};
      const k = low(base); const cur = cfg.bases[k] || {};
      if (body.label !== undefined) cur.label = clean(body.label, 40);
      if (body.schedule !== undefined) cur.schedule = cleanSched(body.schedule, cur.schedule);
      if (cur.schedule) { cur.announce = cur.schedule.announce !== false; cur.highlights = cur.schedule.highlights || []; }
      cfg.bases[k] = cur;
      await saveKey("hub_bot_config", cfg);
      return json({ ok: true, baseshop: base, label: cur.label || (base + " Announcements"), schedule: cur.schedule });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
