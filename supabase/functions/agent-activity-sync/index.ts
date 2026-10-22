// agent-activity-sync v1
// Computes weekly per-agent appointment activity from the calendar_events Chris has on his Google Calendar.
// Rule: any event with Chris + agent both present = 'brought to Chris'. Any event with agent alone (or with non-Chris invitees) = 'self-run'.
// Writes to personal.agent_activity weekly buckets.
//
// Inputs: none. Pulls last 60 days of calendar data from personal.calendar_events_raw (or falls back to fetching from Google Calendar via Chris's GFI infrastructure if that table exists).
// For now we read from `personal.connections` `last_contact_date` + new column we'll add separately. Simplest MVP: aggregate over `personal.connections` source notes.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(URL, KEY, { db: { schema: "personal" } });

const CHRIS_EMAIL = (Deno.env.get("CHRIS_EMAIL") || "admin@grindagencies.com").toLowerCase();

function isoMonday(d: Date): string {
  const x = new Date(d);
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

function weeksBack(n: number): string[] {
  const today = new Date();
  const weeks: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i * 7);
    weeks.push(isoMonday(d));
  }
  return weeks;
}

async function fetchCalendarEvents(since: Date): Promise<any[]> {
  // Attempt: read from a personal.calendar_events_raw table if it exists (some autosync flows populate it).
  // If not, fallback: derive 'appointment hits' from connections.last_contact_date as a coarse proxy.
  const { data, error } = await sb
    .from("calendar_events_raw")
    .select("id, start_time, summary, attendees, organizer_email")
    .gte("start_time", since.toISOString());
  if (error) {
    // Table likely doesn't exist yet; return null sentinel
    if (String(error.message || "").includes("does not exist") || error.code === "42P01") return [];
    console.warn("calendar_events_raw read failed:", error.message);
    return [];
  }
  return data || [];
}

async function fetchTeamAgents() {
  const { data, error } = await sb
    .from("connections")
    .select("id, name, email, cft_stage, team_role, status, last_contact_date, importance, coaching_priority_score, last_coached_at")
    .eq("connection_type", "team_member");
  if (error) throw error;
  return data || [];
}

function priorityScore(agent: any, last8wkActivity: any[]): number {
  // Score components:
  // 1. Pipeline urgency: recruit=80, licensed=60, first_sale=50, recruiting=70 (this is the duplication moment!), cft_track=85, cft=20, md=10, dormant=5
  const stageScore: Record<string, number> = {
    recruit: 80, licensed: 60, first_sale: 50, recruiting: 85, cft_track: 90, cft: 20, md: 10, dormant: 5
  };
  let score = stageScore[agent.cft_stage || "licensed"] || 50;

  // 2. Activity heat — booking with Chris adds priority
  const withChrisLast2wks = last8wkActivity.slice(0, 2).reduce((s, w) => s + (w.appointments_with_chris || 0), 0);
  score += withChrisLast2wks * 5;

  // 3. Self-run also adds priority but less (still wants attention)
  const selfRunLast2wks = last8wkActivity.slice(0, 2).reduce((s, w) => s + (w.appointments_self_run || 0), 0);
  score += selfRunLast2wks * 2;

  // 4. Cold penalty: no contact in 14+ days drops score (but for recruits it doesn't — they need outreach)
  const lastSeen = agent.last_contact_date ? new Date(agent.last_contact_date) : null;
  if (lastSeen) {
    const daysSince = Math.floor((Date.now() - lastSeen.getTime()) / 86400000);
    if (daysSince > 30) score -= 15;
    else if (daysSince > 14) score -= 5;
  }

  // 5. Last coached penalty: if not coached in 21+ days, BOOST priority (overdue 1:1)
  if (agent.last_coached_at) {
    const lastCoachedDays = Math.floor((Date.now() - new Date(agent.last_coached_at).getTime()) / 86400000);
    if (lastCoachedDays > 21) score += 15;
  } else {
    score += 10; // never coached — high priority
  }

  // 6. Importance modifier
  if (agent.importance === "high") score += 10;
  if (agent.importance === "low") score -= 10;

  return Math.max(0, Math.round(score));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sinceWeeks = 8;
    const since = new Date(); since.setDate(since.getDate() - sinceWeeks * 7);
    const [events, agents] = await Promise.all([fetchCalendarEvents(since), fetchTeamAgents()]);

    const agentByEmail = new Map<string, any>();
    for (const a of agents) if (a.email) agentByEmail.set(a.email.toLowerCase(), a);

    // Bucket events into weeks per agent
    type Bucket = { with_chris: number; self_run: number; titles: string[] };
    const buckets = new Map<string, Map<string, Bucket>>(); // agent.id -> week_start -> Bucket

    function ensureBucket(agentId: string, weekStart: string): Bucket {
      if (!buckets.has(agentId)) buckets.set(agentId, new Map());
      const wkMap = buckets.get(agentId)!;
      if (!wkMap.has(weekStart)) wkMap.set(weekStart, { with_chris: 0, self_run: 0, titles: [] });
      return wkMap.get(weekStart)!;
    }

    let eventsProcessed = 0;
    for (const ev of events) {
      const startStr = ev.start_time;
      if (!startStr) continue;
      const start = new Date(startStr);
      if (isNaN(start.getTime())) continue;
      const week = isoMonday(start);
      const attendees: string[] = Array.isArray(ev.attendees) ? ev.attendees.map((a: any) => (typeof a === "string" ? a : a.email || "").toLowerCase()).filter(Boolean) : [];
      const organizer = (ev.organizer_email || "").toLowerCase();
      const allEmails = new Set([...attendees, organizer].filter(Boolean));
      const chrisInvolved = allEmails.has(CHRIS_EMAIL);
      // Match any team agent that's in the attendee set
      for (const email of allEmails) {
        if (email === CHRIS_EMAIL) continue;
        const agent = agentByEmail.get(email);
        if (!agent) continue;
        const b = ensureBucket(agent.id, week);
        if (chrisInvolved) b.with_chris++; else b.self_run++;
        if (b.titles.length < 5) b.titles.push(ev.summary || "(untitled)");
        eventsProcessed++;
      }
    }

    // Upsert weekly rollups
    let upserted = 0;
    for (const [agentId, wkMap] of buckets.entries()) {
      for (const [week, b] of wkMap.entries()) {
        const total = b.with_chris + b.self_run;
        const ratio = total > 0 ? b.with_chris / total : 0;
        const { error } = await sb.from("agent_activity").upsert({
          agent_id: agentId, week_start: week,
          appointments_with_chris: b.with_chris,
          appointments_self_run: b.self_run,
          appointments_total: total,
          ratio_brought_to_chris: ratio,
          appointment_titles: b.titles,
          computed_at: new Date().toISOString(),
        }, { onConflict: "agent_id,week_start" });
        if (!error) upserted++;
      }
    }

    // Compute priority score per agent
    const priorityUpdates: any[] = [];
    for (const a of agents) {
      // Fetch last 8 weeks for this agent
      const { data: last8 } = await sb.from("agent_activity")
        .select("week_start, appointments_with_chris, appointments_self_run, appointments_total")
        .eq("agent_id", a.id)
        .order("week_start", { ascending: false })
        .limit(8);
      const score = priorityScore(a, last8 || []);
      priorityUpdates.push({ id: a.id, name: a.name, score });
      await sb.from("connections").update({ coaching_priority_score: score }).eq("id", a.id);
    }

    priorityUpdates.sort((a, b) => b.score - a.score);

    return json({
      ok: true,
      events_seen: events.length,
      events_matched: eventsProcessed,
      activity_rows_upserted: upserted,
      agents_scored: priorityUpdates.length,
      top_5_priority: priorityUpdates.slice(0, 5),
      note: events.length === 0 ? "calendar_events_raw is empty or missing. Activity counts will be 0 until calendar sync populates it." : null,
    });
  } catch (e: any) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
});

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey" };
function json(obj: any, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } }); }
