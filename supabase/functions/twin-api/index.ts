// twin-api — bearer-token-protected REST API for Twin AI
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function authenticate(req: Request, sb: SupabaseClient): Promise<{ keyId: string; scopes: string[] } | null> {
  const header = req.headers.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!bearer || !bearer.startsWith("twin_")) return null;
  const keyHash = await sha256Hex(bearer);
  const { data, error } = await sb.schema("personal").from("api_keys").select("id, scopes").eq("key_hash", keyHash).is("revoked_at", null).maybeSingle();
  if (error || !data) return null;
  sb.schema("personal").from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
  return { keyId: data.id, scopes: data.scopes };
}

type Handler = (req: Request, sb: SupabaseClient, params: Record<string, string>) => Promise<Response>;
interface Route { method: string; pattern: RegExp; paramNames: string[]; needsWrite: boolean; handler: Handler; }

function route(method: string, path: string, needsWrite: boolean, handler: Handler): Route {
  const paramNames: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:([a-zA-Z_]+)/g, (_, name) => { paramNames.push(name); return "([^/]+)"; }) + "/?$");
  return { method, pattern, paramNames, needsWrite, handler };
}

const ping: Handler = async () => json({ ok: true, service: "twin-api", time: new Date().toISOString() });

const dashboard: Handler = async (_req, sb) => {
  const today = todayISO();
  const [xpRes, habitsRes, todayLogsRes, dailyRes, questsRes, goalsRes] = await Promise.all([
    sb.schema("personal").from("xp_events").select("xp_amount"),
    sb.schema("personal").from("habits").select("*").eq("active", true).order("pillar_id"),
    sb.schema("personal").from("habit_logs").select("habit_id, completed").eq("logged_date", today),
    sb.schema("personal").from("daily_logs").select("*").eq("log_date", today).maybeSingle(),
    sb.schema("personal").from("quests").select("*").eq("status", "active").order("target_date", { ascending: true, nullsFirst: false }).limit(10),
    sb.schema("personal").from("goals").select("*").eq("status", "active"),
  ]);
  const totalXp = (xpRes.data || []).reduce((s, r) => s + (r.xp_amount || 0), 0);
  let level = 1;
  while (100 * level * level <= totalXp) level++;
  const curLvlXp = 100 * (level - 1) * (level - 1);
  const nextLvlXp = 100 * level * level;
  const doneSet = new Set((todayLogsRes.data || []).filter((l) => l.completed).map((l) => l.habit_id));
  return json({
    total_xp: totalXp, level,
    xp_into_level: totalXp - curLvlXp,
    xp_to_next_level: nextLvlXp - totalXp,
    habits_today: (habitsRes.data || []).map((h) => ({ ...h, done_today: doneSet.has(h.id) })),
    daily_log_today: dailyRes.data || null,
    active_quests: questsRes.data || [],
    active_goals: goalsRes.data || [],
  });
};

const listHabits: Handler = async (_req, sb) => {
  const { data, error } = await sb.schema("personal").from("habits").select("*").eq("active", true).order("pillar_id");
  if (error) return json({ error: error.message }, 500);
  return json(data);
};

const logHabit: Handler = async (req, sb, params) => {
  const body = await req.json().catch(() => ({}));
  const date = body.date || todayISO();
  const note = body.note ?? null;
  const habitId = params.id;
  const { data: habit, error: hErr } = await sb.schema("personal").from("habits").select("*").eq("id", habitId).maybeSingle();
  if (hErr || !habit) return json({ error: "habit not found" }, 404);
  const { data: existing } = await sb.schema("personal").from("habit_logs").select("*").eq("habit_id", habitId).eq("logged_date", date).maybeSingle();
  if (existing && existing.completed) return json({ ok: true, already_logged: true, log: existing });
  if (existing) {
    await sb.schema("personal").from("habit_logs").update({ completed: true, note }).eq("id", existing.id);
  } else {
    await sb.schema("personal").from("habit_logs").insert({ habit_id: habitId, logged_date: date, completed: true, note });
  }
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yISO = yesterday.toISOString().slice(0, 10);
  let newStreak = 1;
  if (habit.last_completed === yISO) newStreak = (habit.current_streak || 0) + 1;
  else if (habit.last_completed === date) newStreak = habit.current_streak || 1;
  const newBest = Math.max(habit.best_streak || 0, newStreak);
  await sb.schema("personal").from("habits").update({ current_streak: newStreak, best_streak: newBest, last_completed: date }).eq("id", habitId);
  const base = habit.xp_per_completion || 10;
  const xpAmount = Math.max(1, Math.round(base * 0.5));
  await sb.schema("personal").from("xp_events").insert({ pillar_id: habit.pillar_id, action: `Habit: ${habit.name}`, xp_amount: xpAmount, source: "claude_api", metadata: { habit_id: habitId, base_amount: base, multiplier: 0.5, streak: newStreak } });
  return json({ ok: true, streak: newStreak, xp_awarded: xpAmount, habit: habit.name });
};

const upsertDailyLog: Handler = async (req, sb) => {
  const body = await req.json().catch(() => ({}));
  const log_date = body.log_date || todayISO();
  const allowed = ["sleep_hours", "training", "training_note", "energy_1_10", "weight_lbs", "deep_work_hours", "reading_pages", "mood_note", "needle_moved", "needle_note"];
  const patch: Record<string, unknown> = { log_date };
  for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
  patch.updated_at = new Date().toISOString();
  const { data: existing } = await sb.schema("personal").from("daily_logs").select("*").eq("log_date", log_date).maybeSingle();
  let row;
  if (existing) {
    const { data, error } = await sb.schema("personal").from("daily_logs").update(patch).eq("id", existing.id).select().single();
    if (error) return json({ error: error.message }, 500);
    row = data;
  } else {
    const { data, error } = await sb.schema("personal").from("daily_logs").insert(patch).select().single();
    if (error) return json({ error: error.message }, 500);
    row = data;
    await sb.schema("personal").from("xp_events").insert({ pillar_id: "health", action: "Daily log started", xp_amount: 3, source: "claude_api", metadata: { log_id: row.id } });
  }
  return json({ ok: true, log: row });
};

const listDailyLogs: Handler = async (req, sb) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "30", 10), 365);
  const { data, error } = await sb.schema("personal").from("daily_logs").select("*").order("log_date", { ascending: false }).limit(limit);
  if (error) return json({ error: error.message }, 500);
  return json(data);
};

const listQuests: Handler = async (req, sb) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") || "active";
  const { data, error } = await sb.schema("personal").from("quests").select("*").eq("status", status).order("target_date", { ascending: true, nullsFirst: false });
  if (error) return json({ error: error.message }, 500);
  return json(data);
};

const completeQuest: Handler = async (_req, sb, params) => {
  const { data: quest, error: qErr } = await sb.schema("personal").from("quests").select("*").eq("id", params.id).maybeSingle();
  if (qErr || !quest) return json({ error: "quest not found" }, 404);
  if (quest.status !== "active") return json({ error: "quest not active" }, 400);
  await sb.schema("personal").from("quests").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", params.id);
  const base = quest.xp_reward || 50;
  const xpAmount = Math.max(1, Math.round(base * 0.5));
  await sb.schema("personal").from("xp_events").insert({ pillar_id: quest.pillar_id, action: `Quest: ${quest.title}`, xp_amount: xpAmount, source: "claude_api", metadata: { quest_id: quest.id, base_amount: base, multiplier: 0.5 } });
  return json({ ok: true, quest: quest.title, xp_awarded: xpAmount });
};

const createQuest: Handler = async (req, sb) => {
  const body = await req.json().catch(() => ({}));
  if (!body.title) return json({ error: "title required" }, 400);
  const { data, error } = await sb.schema("personal").from("quests").insert({ title: body.title, pillar_id: body.pillar_id, description: body.description, target_date: body.target_date, xp_reward: body.xp_reward || 50, difficulty: body.difficulty || "normal", parent_goal_id: body.parent_goal_id }).select().single();
  if (error) return json({ error: error.message }, 500);
  return json(data, 201);
};

const listRelationships: Handler = async (_req, sb) => {
  const { data, error } = await sb.schema("personal").from("key_relationships").select("*").order("name");
  if (error) return json({ error: error.message }, 500);
  return json(data);
};

const touchRelationship: Handler = async (req, sb, params) => {
  const body = await req.json().catch(() => ({}));
  const touch_type = body.touch_type || "call";
  const initiated_by_me = body.initiated_by_me ?? true;
  const quality = body.quality_1_10 ?? null;
  const notes = body.notes ?? null;
  const { data: rel } = await sb.schema("personal").from("key_relationships").select("name").eq("id", params.id).maybeSingle();
  if (!rel) return json({ error: "relationship not found" }, 404);
  const { data: touch, error: tErr } = await sb.schema("personal").from("relationship_touches").insert({ relationship_id: params.id, touch_type, initiated_by_me, quality_1_10: quality, notes }).select().single();
  if (tErr) return json({ error: tErr.message }, 500);
  await sb.schema("personal").from("key_relationships").update({ last_contact_date: todayISO() }).eq("id", params.id);
  let xpAmount = Math.max(1, Math.round(10 * 0.5));
  if (touch_type === "in-person" || touch_type === "in_person") xpAmount += 10;
  await sb.schema("personal").from("xp_events").insert({ pillar_id: "relationships", action: `Touch: ${rel.name} (${touch_type})`, xp_amount: xpAmount, source: "claude_api", metadata: { relationship_id: params.id, touch_type, in_person_bonus: touch_type.includes("person") } });
  return json({ ok: true, touch, xp_awarded: xpAmount });
};

const listBooks: Handler = async (_req, sb) => {
  const { data, error } = await sb.schema("personal").from("books").select("*").order("status").order("created_at", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json(data);
};

const finishBook: Handler = async (req, sb, params) => {
  const body = await req.json().catch(() => ({}));
  const { data: book, error: bErr } = await sb.schema("personal").from("books").update({ status: "finished", finished_on: todayISO(), rating_1_10: body.rating_1_10, key_insight: body.key_insight, notes: body.notes }).eq("id", params.id).select().single();
  if (bErr) return json({ error: bErr.message }, 500);
  let xpAmount = Math.max(1, Math.round(100 * 0.5));
  if ((book.rating_1_10 || 0) >= 8) xpAmount += 25;
  await sb.schema("personal").from("xp_events").insert({ pillar_id: "mind", action: `Finished: ${book.title}`, xp_amount: xpAmount, source: "claude_api", metadata: { book_id: book.id, rating: book.rating_1_10 } });
  return json({ ok: true, book, xp_awarded: xpAmount });
};

const addJournal: Handler = async (req, sb) => {
  const body = await req.json().catch(() => ({}));
  if (!body.response) return json({ error: "response required" }, 400);
  const { data, error } = await sb.schema("personal").from("journal_entries").insert({ entry_date: body.entry_date || todayISO(), prompt: body.prompt, response: body.response, mood: body.mood, key_insight: body.key_insight }).select().single();
  if (error) return json({ error: error.message }, 500);
  const xpAmount = Math.max(1, Math.round(15 * 0.5));
  await sb.schema("personal").from("xp_events").insert({ pillar_id: "mind", action: "Journal entry", xp_amount: xpAmount, source: "claude_api", metadata: { entry_id: data.id } });
  return json({ ok: true, entry: data, xp_awarded: xpAmount });
};

const addFinanceSnapshot: Handler = async (req, sb) => {
  const body = await req.json().catch(() => ({}));
  const { data, error } = await sb.schema("personal").from("finance_snapshots").upsert({ snapshot_date: body.snapshot_date || todayISO(), net_worth: body.net_worth, cash_on_hand: body.cash_on_hand, debt_total: body.debt_total, monthly_cashflow: body.monthly_cashflow, monthly_burn: body.monthly_burn, source: body.source || "claude_api", notes: body.notes }, { onConflict: "snapshot_date" }).select().single();
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, snapshot: data });
};

const listBrainConversations: Handler = async (_req, sb) => {
  const { data, error } = await sb.schema("personal").from("brain_conversations").select("*").order("updated_at", { ascending: false }).limit(50);
  if (error) return json({ error: error.message }, 500);
  return json(data);
};

const addBrainMessage: Handler = async (req, sb) => {
  const body = await req.json().catch(() => ({}));
  if (!body.role || !body.content) return json({ error: "role and content required" }, 400);
  let conversationId = body.conversation_id;
  if (!conversationId) {
    const { data: conv, error: cErr } = await sb.schema("personal").from("brain_conversations").insert({ title: body.title || body.content.slice(0, 60), status: "open" }).select().single();
    if (cErr) return json({ error: cErr.message }, 500);
    conversationId = conv.id;
  }
  const { data, error } = await sb.schema("personal").from("brain_messages").insert({ conversation_id: conversationId, role: body.role, content: body.content, metadata: body.metadata || {} }).select().single();
  if (error) return json({ error: error.message }, 500);
  await sb.schema("personal").from("brain_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  return json({ ok: true, message: data, conversation_id: conversationId });
};

const listInventory: Handler = async (_req, sb) => {
  const { data, error } = await sb.schema("personal").from("inventory_items").select("*").order("equipped", { ascending: false }).order("acquired_on", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json(data);
};

const getXp: Handler = async (_req, sb) => {
  const { data, error } = await sb.schema("personal").from("xp_events").select("xp_amount, pillar_id, occurred_at, action, source").order("occurred_at", { ascending: false }).limit(50);
  if (error) return json({ error: error.message }, 500);
  const total = (data || []).reduce((s, r) => s + (r.xp_amount || 0), 0);
  let level = 1;
  while (100 * level * level <= total) level++;
  return json({ total_xp: total, level, recent: data });
};

const listKeys: Handler = async (_req, sb) => {
  const { data, error } = await sb.schema("personal").from("api_keys").select("id, label, key_prefix, scopes, last_used_at, revoked_at, created_at").order("created_at", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json(data);
};

const ROUTES: Route[] = [
  route("GET", "/ping", false, ping),
  route("GET", "/dashboard", false, dashboard),
  route("GET", "/xp", false, getXp),
  route("GET", "/habits", false, listHabits),
  route("POST", "/habits/:id/log", true, logHabit),
  route("GET", "/daily-logs", false, listDailyLogs),
  route("POST", "/daily-logs", true, upsertDailyLog),
  route("GET", "/quests", false, listQuests),
  route("POST", "/quests", true, createQuest),
  route("POST", "/quests/:id/complete", true, completeQuest),
  route("GET", "/relationships", false, listRelationships),
  route("POST", "/relationships/:id/touch", true, touchRelationship),
  route("GET", "/books", false, listBooks),
  route("POST", "/books/:id/finish", true, finishBook),
  route("POST", "/journal", true, addJournal),
  route("POST", "/finance", true, addFinanceSnapshot),
  route("GET", "/brain/conversations", false, listBrainConversations),
  route("POST", "/brain/messages", true, addBrainMessage),
  route("GET", "/inventory", false, listInventory),
  route("GET", "/keys", false, listKeys),
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      },
    });
  }
  const url = new URL(req.url);
  // Supabase strips /functions/v1 in some envs; handle both shapes.
  const path = url.pathname.replace(/^\/(functions\/v1\/)?twin-api/, "") || "/";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "personal" } });
  if (path === "/ping" && req.method === "GET") return ping(req, sb, {});
  const auth = await authenticate(req, sb);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    if (r.needsWrite && !auth.scopes.includes("write")) return json({ error: "API key lacks write scope" }, 403);
    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => (params[name] = m[i + 1]));
    try {
      return await r.handler(req, sb, params);
    } catch (e) {
      console.error("[twin-api] handler error", path, e);
      return json({ error: (e as Error).message || "internal error" }, 500);
    }
  }
  return json({ error: "Not found", path }, 404);
});
