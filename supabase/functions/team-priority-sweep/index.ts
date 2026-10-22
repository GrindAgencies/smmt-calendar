// team-priority-sweep v2 — SAFE MODE
// Only auto-moves agents that have REAL activity signal. If activity table is empty for an agent,
// the sweep does NOT touch their tier (no data = no decision).
// New agents are still auto-discovered.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(URL, KEY, { db: { schema: "personal" } });

const CHRIS_EMAIL = (Deno.env.get("CHRIS_EMAIL") || "admin@grindagencies.com").toLowerCase();

const GFI_EMAIL_PATTERNS = [
  /\.gfi@/i,
  /\.gfi[0-9]*@/i,
  /@mygficonnect\.com$/i,
  /gfi[0-9]+@/i,
];
const GFI_EVENT_TITLE_PATTERNS = [
  /field training/i,
  /licensed agent/i,
  /gfi/i,
  /^afd /i,
  /armed forces/i,
];

function looksLikeGfiAgent(email: string, eventTitles: string[] = []): boolean {
  if (!email || email === CHRIS_EMAIL) return false;
  if (GFI_EMAIL_PATTERNS.some(p => p.test(email))) return true;
  if (eventTitles.some(t => GFI_EVENT_TITLE_PATTERNS.some(p => p.test(t)))) return true;
  return false;
}

async function discoverNewAgents(): Promise<{ added: any[], scanned: number }> {
  const since = new Date(); since.setDate(since.getDate() - 30);
  const { data: events } = await sb.from("calendar_events_raw")
    .select("id, summary, organizer_email, attendees, start_time")
    .gte("start_time", since.toISOString());

  const emailEvents = new Map<string, string[]>();
  for (const ev of events || []) {
    const attendees: string[] = Array.isArray(ev.attendees) ? ev.attendees.map((a: any) => (typeof a === "string" ? a : a.email || "").toLowerCase()).filter(Boolean) : [];
    const allEmails = new Set([...attendees, (ev.organizer_email || "").toLowerCase()].filter(Boolean));
    for (const email of allEmails) {
      if (!email) continue;
      if (!emailEvents.has(email)) emailEvents.set(email, []);
      emailEvents.get(email)!.push(ev.summary || "");
    }
  }

  const { data: existing } = await sb.from("connections").select("id, email").eq("connection_type", "team_member");
  const existingEmails = new Set((existing || []).map((r: any) => (r.email || "").toLowerCase()).filter(Boolean));

  const added: any[] = [];
  for (const [email, titles] of emailEvents.entries()) {
    if (existingEmails.has(email)) continue;
    if (!looksLikeGfiAgent(email, titles)) continue;
    const local = email.split("@")[0].split(".")[0];
    const guessName = local.charAt(0).toUpperCase() + local.slice(1).replace(/\d+/g, "");
    const { data: newConn, error } = await sb.from("connections").insert({
      name: guessName, email, connection_type: "team_member", is_team_member: true,
      team_role: "GFI Agent", category: "business", industry: "insurance", cft_stage: "licensed",
      priority_tier: 2, priority_why: `Auto-added by daily sweep — seen in ${titles.length} calendar event(s) as a GFI/AFD attendee.`,
      priority_action: "Verify name + role on first 1:1.", priority_reviewed_at: new Date().toISOString(),
      source: "team_priority_sweep_discover", status: "active", first_met_date: new Date().toISOString().slice(0, 10),
    }).select().single();
    if (!error && newConn) {
      added.push({ id: newConn.id, name: newConn.name, email, signal_count: titles.length });
      await sb.from("team_tier_sweep_log").insert({
        agent_id: newConn.id, agent_name: newConn.name, from_tier: null, to_tier: 2,
        reason: `Auto-discovered as GFI agent (${titles.length} cal event hits)`,
        signals: { email, event_titles: titles.slice(0, 5) }, source: "auto_discover",
      });
    }
  }
  return { added, scanned: emailEvents.size };
}

function computeTargetTier(agent: any, recentActivity: any[]): { tier: number | null, reason: string, signals: any } {
  // === SAFETY: if zero activity data exists for this agent, do NOT make a move ===
  if (!recentActivity || recentActivity.length === 0) {
    return { tier: null, reason: "no activity data available — skipping (manual tier respected)", signals: { hasData: false } };
  }

  const last4 = recentActivity.slice(0, 4);
  const last8 = recentActivity.slice(0, 8);
  const activeLast30 = last4.reduce((s, w) => s + (w.appointments_with_chris || 0), 0);
  const totalLast30 = last4.reduce((s, w) => s + (w.appointments_total || 0), 0);
  const activeLast60 = last8.reduce((s, w) => s + (w.appointments_with_chris || 0), 0);
  const totalLast60 = last8.reduce((s, w) => s + (w.appointments_total || 0), 0);
  const hasProduction = (agent.production_ytd || 0) > 0;

  // === SECOND SAFETY: if all 8 weeks have zero total appointments, treat as no-signal ===
  if (totalLast60 === 0 && !hasProduction) {
    return { tier: null, reason: "no recent appointment signal and no production — manual tier respected", signals: { hasData: false, activeLast60, totalLast60 } };
  }

  let daysSinceLastActivity = 999;
  for (const w of recentActivity) {
    if ((w.appointments_with_chris || 0) + (w.appointments_self_run || 0) > 0) {
      const d = new Date(w.week_start);
      daysSinceLastActivity = Math.floor((Date.now() - d.getTime()) / 86400000);
      break;
    }
  }

  const signals = { activeLast30, totalLast30, activeLast60, hasProduction, daysSinceLastActivity, productionYtd: agent.production_ytd || 0 };

  if (activeLast30 >= 3) {
    return { tier: 1, reason: `${activeLast30} active Calendly cohosts last 30d`, signals };
  }
  if (activeLast30 >= 1 || hasProduction) {
    return { tier: 2, reason: `${activeLast30} active last 30d${hasProduction ? `, $${signals.productionYtd} YTD` : ""}`, signals };
  }
  if (daysSinceLastActivity <= 30) {
    return { tier: 3, reason: `No activity ${daysSinceLastActivity}d`, signals };
  }
  if (daysSinceLastActivity <= 60) {
    return { tier: 4, reason: `Cold ${daysSinceLastActivity}d`, signals };
  }
  return { tier: 4, reason: `Cold ${daysSinceLastActivity}d (eligible for manual QUIT)`, signals };
}

async function sweepExistingAgents(): Promise<{ moved: any[], unchanged: number, skipped_no_data: number, scanned: number }> {
  const { data: agents } = await sb.from("connections")
    .select("id, name, priority_tier, production_ytd, calendly_active, calendly_cancel, last_contact_date")
    .eq("connection_type", "team_member")
    .neq("priority_tier", 5);

  const moved: any[] = [];
  let unchanged = 0, skipped = 0;

  for (const agent of agents || []) {
    const { data: weeks } = await sb.from("agent_activity")
      .select("week_start, appointments_with_chris, appointments_self_run, appointments_total")
      .eq("agent_id", agent.id).order("week_start", { ascending: false }).limit(8);

    const target = computeTargetTier(agent, weeks || []);
    const currentTier = agent.priority_tier || null;

    if (target.tier === null) { skipped++; continue; }

    let newTier = target.tier;
    if (currentTier === 4 && newTier < 3) newTier = 3;
    if (currentTier === 1 && newTier > 2) newTier = 2;

    if (newTier === currentTier) { unchanged++; continue; }

    const { error } = await sb.from("connections")
      .update({ priority_tier: newTier, priority_reviewed_at: new Date().toISOString() })
      .eq("id", agent.id);
    if (error) continue;

    await sb.from("team_tier_sweep_log").insert({
      agent_id: agent.id, agent_name: agent.name,
      from_tier: currentTier, to_tier: newTier,
      reason: target.reason, signals: target.signals, source: "auto_sweep",
    });
    moved.push({ id: agent.id, name: agent.name, from: currentTier, to: newTier, reason: target.reason });
  }
  return { moved, unchanged, skipped_no_data: skipped, scanned: agents?.length || 0 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const discovered = await discoverNewAgents();
    const swept = await sweepExistingAgents();
    const promotions = swept.moved.filter(m => (m.from || 99) > m.to);
    const demotions = swept.moved.filter(m => (m.from || 0) < m.to);
    return json({
      ok: true, ran_at: new Date().toISOString(),
      new_agents_added: discovered.added.length, new_agents_detail: discovered.added,
      events_scanned: discovered.scanned,
      agents_swept: swept.scanned, tier_changes: swept.moved.length,
      unchanged: swept.unchanged, skipped_no_data: swept.skipped_no_data,
      promotions, demotions,
      note: swept.skipped_no_data === swept.scanned ? "All agents skipped — no calendar activity data yet. Sweep will start moving people once agent_activity table is populated." : null,
    });
  } catch (e: any) { return json({ ok: false, error: String(e.message || e) }, 500); }
});

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey" };
function json(obj: any, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } }); }
