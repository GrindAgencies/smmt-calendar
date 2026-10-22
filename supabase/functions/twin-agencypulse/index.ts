// twin-agencypulse v3 — graceful 200 on auth failure (was 500). Caller can read ok:false + code:reauth_required.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TWIN_URL = Deno.env.get("SUPABASE_URL")!;
const TWIN_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
const twin = createClient(TWIN_URL, TWIN_KEY, { db: { schema: "personal" } });

async function getConfig(): Promise<Record<string, string>> {
  const { data, error } = await twin.from("config").select("key, value").like("key", "AGENCYPULSE%");
  if (error) throw new Error("Config load failed: " + error.message);
  const cfg: Record<string, string> = {};
  (data || []).forEach((r: any) => cfg[r.key] = r.value);
  return cfg;
}

async function setConfigValue(key: string, value: string) {
  await twin.from("config").upsert({ key, value, updated_at: new Date().toISOString() });
}

class ReauthRequiredError extends Error {
  constructor(msg: string) { super(msg); this.name = "ReauthRequiredError"; }
}

async function refreshAgencyPulseSession(cfg: Record<string, string>): Promise<string> {
  const res = await fetch(`${cfg.AGENCYPULSE_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "apikey": cfg.AGENCYPULSE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: cfg.AGENCYPULSE_REFRESH_TOKEN }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ReauthRequiredError(`AgencyPulse refresh token expired (${res.status}). Re-extract token from browser via the AgencyPulse integration flow.`);
    }
    throw new Error(`Refresh failed (${res.status}): ${txt}`);
  }
  const data = await res.json();
  await setConfigValue("AGENCYPULSE_ACCESS_TOKEN", data.access_token);
  await setConfigValue("AGENCYPULSE_REFRESH_TOKEN", data.refresh_token);
  return data.access_token;
}

async function apFetch(cfg: Record<string, string>, accessToken: string, path: string, opts: RequestInit = {}) {
  const url = `${cfg.AGENCYPULSE_SUPABASE_URL}/rest/v1/${path}`;
  const headers: Record<string, string> = {
    "apikey": cfg.AGENCYPULSE_ANON_KEY,
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...(opts.headers as Record<string, string> || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const txt = await res.text();
    const err: any = new Error(`AP fetch ${path} failed (${res.status}): ${txt.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

function computeActivityScore(day: any, dailyDialsGoal: number, dailyApGoal: number) {
  if (!day) return 0;
  const dialsScore = Math.min(100, (Number(day.dials || 0) / Math.max(1, dailyDialsGoal)) * 100);
  const apScore = Math.min(100, (Number(day.ap_dollars || 0) / Math.max(1, dailyApGoal)) * 100);
  const apps = Number(day.apps || 0);
  const apps_score = Math.min(100, apps * 50);
  const presentations = Number(day.presentations || 0);
  const pres_score = Math.min(100, presentations * 33);
  return Math.round(apScore * 0.4 + dialsScore * 0.25 + apps_score * 0.20 + pres_score * 0.15);
}

function aggregateActivity(days: any[]) {
  const fields = ["dials", "pickups", "presentations", "apps", "ap_dollars", "appt_set", "appt_showed"];
  const out: any = { day_count: days.length };
  for (const f of fields) out[f] = days.reduce((s, d) => s + Number(d[f] || 0), 0);
  return out;
}

async function buildSummary(cfg: Record<string, string>, accessToken: string) {
  const userId = cfg.AGENCYPULSE_USER_ID;
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const monthStart = (() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); })();
  const today30Ago = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();

  const out: any = { as_of: new Date().toISOString(), user_id: userId };
  const errors: any = {};

  try { const profile = await apFetch(cfg, accessToken, `user_profiles?user_id=eq.${userId}&select=name,rank,ap_code,role,licensing_status,subscription_tier,trial_ends_at,team_name`); out.profile = profile[0] || null; }
  catch (e: any) { errors.profile = String(e.message); if (e.status === 401 || e.status === 403) throw e; }
  try { const goals = await apFetch(cfg, accessToken, `user_goals?user_id=eq.${userId}&select=*`); out.goals = goals[0] || { weekly_dials: 0, weekly_ap: 0, monthly_dials: 0, monthly_ap: 0 }; }
  catch (e: any) { errors.goals = String(e.message); }
  try { const rows = await apFetch(cfg, accessToken, `activity_days?user_id=eq.${userId}&date=eq.${today}&select=*`); out.today = rows[0] || null; }
  catch (e: any) { errors.today = String(e.message); }
  try { const rows = await apFetch(cfg, accessToken, `activity_days?user_id=eq.${userId}&date=gte.${weekStart}&select=*&order=date.asc`); out.this_week_days = rows; out.week_totals = aggregateActivity(rows); }
  catch (e: any) { errors.this_week = String(e.message); }
  try { const rows = await apFetch(cfg, accessToken, `activity_days?user_id=eq.${userId}&date=gte.${monthStart}&select=*&order=date.asc`); out.month_totals = aggregateActivity(rows); }
  catch (e: any) { errors.this_month = String(e.message); }
  try {
    const sales = await apFetch(cfg, accessToken, `sales?user_id=eq.${userId}&date_written=gte.${today30Ago}&select=id,date_written,first_draft_date,paid_out_date,client_name,carrier,product,annual_premium,coverage_amount,status,sale_type,lead_vendor,cash_flow,projected_pay&order=date_written.desc`);
    out.sales_30d = sales;
    const totalAP = sales.reduce((s: number, r: any) => s + Number(r.annual_premium || 0), 0);
    const paidOut = sales.filter((r: any) => r.paid_out_date);
    const stuck = sales.filter((r: any) => !r.paid_out_date && !r.first_draft_date && (Date.now() - new Date(r.date_written).getTime()) > 7 * 86400000);
    out.sales_summary = { count: sales.length, total_annual_premium: totalAP, paid_out_count: paidOut.length, paid_out_ap: paidOut.reduce((s: number, r: any) => s + Number(r.annual_premium || 0), 0), stuck_count: stuck.length, stuck_titles: stuck.slice(0, 5).map((r: any) => `${r.client_name} — ${r.carrier || "?"} (${Math.floor((Date.now() - new Date(r.date_written).getTime()) / 86400000)}d ago)`) };
  } catch (e: any) { errors.sales = String(e.message); }

  if (out.goals && out.week_totals) {
    const g = out.goals; const w = out.week_totals; const m = out.month_totals || {};
    out.pace = {
      week_dials_pct: g.weekly_dials > 0 ? Math.round((w.dials / g.weekly_dials) * 100) : 0,
      week_ap_pct: g.weekly_ap > 0 ? Math.round((w.ap_dollars / g.weekly_ap) * 100) : 0,
      month_dials_pct: g.monthly_dials > 0 ? Math.round(((m.dials || 0) / g.monthly_dials) * 100) : 0,
      month_ap_pct: g.monthly_ap > 0 ? Math.round(((m.ap_dollars || 0) / g.monthly_ap) * 100) : 0,
    };
    const dailyDialsGoal = (g.weekly_dials || 0) / 5;
    const dailyApGoal = (g.weekly_ap || 0) / 5;
    out.activity_score_today = computeActivityScore(out.today, dailyDialsGoal, dailyApGoal);
    if (out.this_week_days?.length) {
      const scores = out.this_week_days.map((d: any) => computeActivityScore(d, dailyDialsGoal, dailyApGoal));
      out.activity_score_7d_avg = Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length);
    } else {
      out.activity_score_7d_avg = 0;
    }
  }
  if (Object.keys(errors).length) out._errors = errors;
  return out;
}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey" };
function json(obj: any, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } }); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const cfg = await getConfig();
    if (!cfg.AGENCYPULSE_REFRESH_TOKEN) {
      // Always 200 — caller reads ok:false + code
      return json({ ok: false, error: "AgencyPulse not configured. Run the AgencyPulse browser flow to extract a token.", code: "not_configured" });
    }

    let accessToken = cfg.AGENCYPULSE_ACCESS_TOKEN;
    let summary;
    try {
      summary = await buildSummary(cfg, accessToken);
      const errStr = JSON.stringify(summary._errors || {});
      if (errStr.includes("401") || errStr.includes("403") || errStr.includes("JWT") || errStr.includes("expired")) throw new Error("stale");
    } catch (e: any) {
      // If first build failed due to auth, try to refresh
      try {
        accessToken = await refreshAgencyPulseSession(cfg);
      } catch (refreshErr: any) {
        // ALWAYS 200 so caller doesn't see HTTP error
        if (refreshErr instanceof ReauthRequiredError) {
          return json({ ok: false, error: refreshErr.message, code: "reauth_required", last_updated: cfg.AGENCYPULSE_REFRESH_TOKEN ? "" : "never" });
        }
        return json({ ok: false, error: String(refreshErr.message || refreshErr), code: "refresh_failed" });
      }
      summary = await buildSummary(await getConfig(), accessToken);
    }
    return json({ ok: true, summary });
  } catch (e: any) {
    // Never throw 500 — always structured response so twin-brain sees clean JSON
    if (e instanceof ReauthRequiredError) {
      return json({ ok: false, error: e.message, code: "reauth_required" });
    }
    return json({ ok: false, error: String(e.message || e), code: "unexpected" });
  }
});
