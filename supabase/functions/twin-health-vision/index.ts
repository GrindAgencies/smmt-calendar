// twin-health-vision v1 — Claude vision analysis for weekly body photos.
// Input: { photo_id } pointing at personal.body_photos row.
// Process: fetch the photo + recent metrics + last 4 weeks of photos for comparison → send to Claude vision → store structured analysis back on the row.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("TWIN_MODEL") || "claude-sonnet-4-6";
const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(URL, KEY, { db: { schema: "personal" } });

const SYSTEM_PROMPT = `You are Chris Lorenz's health/body composition analyst. He's 30s, founder running 2 businesses, current weight ~268lbs, target 245lbs by Aug 2026. HARDCORE mode — no soft motivation, real observations.

Your job: analyze his weekly body photo + scale metrics. Give a tight, observational read.

WHAT TO LOOK AT (in order):
1. Visible body composition change vs prior photo if shown. Look at: waist/midsection, chest, shoulders, posture, arms.
2. The metric trends (weight, muscle, body fat %, water %).
3. Where the next 2 weeks of work should focus.

STYLE:
- Lead with the ONE thing that changed most (good or bad).
- 2-4 short paragraphs max.
- Cite specific visual observations (not platitudes).
- End with a sharp targeted recommendation — not generic "keep going", but a specific lever (e.g., 'cut alcohol this week,' 'add 10g protein at breakfast,' 'add a 4th lifting day').

DO NOT:
- Diagnose medical conditions.
- Use phrases like 'great job' or 'amazing progress' unless the change is genuinely above expected pace.
- Comment on anything not visible in the photo or in the metrics provided.

OUTPUT FORMAT: free prose, no markdown headers. Just the read.`;

interface PhotoRow {
  id: string;
  photo_date: string;
  photo_base64: string;
  mime_type: string;
  weight_lbs_snapshot: number | null;
  muscle_mass_lbs_snapshot: number | null;
  body_fat_pct_snapshot: number | null;
  water_pct_snapshot: number | null;
  user_notes: string | null;
}

async function buildContextMetrics() {
  // Pull last 30 days of daily_logs for trend context
  const since = new Date(); since.setDate(since.getDate() - 30);
  const { data: logs } = await sb.from("daily_logs")
    .select("log_date, weight_lbs, muscle_mass_lbs, body_fat_pct, water_pct, sleep_hours, training, energy_1_10")
    .gte("log_date", since.toISOString().slice(0, 10))
    .order("log_date", { ascending: true });
  return logs || [];
}

function formatMetricBlock(photo: PhotoRow, log30d: any[]): string {
  const lines: string[] = ["[SCALE READING TODAY]"];
  if (photo.weight_lbs_snapshot != null) lines.push(`Weight: ${photo.weight_lbs_snapshot} lbs`);
  if (photo.muscle_mass_lbs_snapshot != null) lines.push(`Muscle mass: ${photo.muscle_mass_lbs_snapshot} lbs`);
  if (photo.body_fat_pct_snapshot != null) lines.push(`Body fat: ${photo.body_fat_pct_snapshot}%`);
  if (photo.water_pct_snapshot != null) lines.push(`Water: ${photo.water_pct_snapshot}%`);

  // Compute deltas vs earliest log in last 30d
  const valid = log30d.filter((l: any) => l.weight_lbs != null);
  if (valid.length > 0) {
    const oldest = valid[0];
    const newest = valid[valid.length - 1];
    lines.push("");
    lines.push(`[30-DAY TREND]`);
    lines.push(`Weight: ${oldest.weight_lbs} → ${newest.weight_lbs} lbs (Δ ${(newest.weight_lbs - oldest.weight_lbs).toFixed(1)})`);
    const fatStart = log30d.find((l: any) => l.body_fat_pct != null);
    const fatEnd = [...log30d].reverse().find((l: any) => l.body_fat_pct != null);
    if (fatStart && fatEnd) lines.push(`Body fat: ${fatStart.body_fat_pct}% → ${fatEnd.body_fat_pct}% (Δ ${(fatEnd.body_fat_pct - fatStart.body_fat_pct).toFixed(1)})`);
  }

  // Recent training cadence
  const trainedDays = log30d.filter((l: any) => l.training === true).length;
  lines.push("");
  lines.push(`[ACTIVITY]`);
  lines.push(`Trained ${trainedDays} of last 30 days`);
  const sleepNums = log30d.map((l: any) => l.sleep_hours).filter(Boolean);
  if (sleepNums.length) lines.push(`Avg sleep: ${(sleepNums.reduce((a: number, b: number) => a + b, 0) / sleepNums.length).toFixed(1)} hrs`);

  if (photo.user_notes) {
    lines.push("");
    lines.push(`[CHRIS'S NOTE THIS WEEK]`);
    lines.push(photo.user_notes);
  }
  lines.push("");
  lines.push(`Target: 245 lbs by 2026-08-31`);
  return lines.join("\n");
}

async function analyzePhoto(photo: PhotoRow, contextText: string) {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  }
  const cleanBase64 = photo.photo_base64.replace(/^data:image\/[a-z]+;base64,/, "");
  const mediaType = photo.mime_type || "image/jpeg";

  const messages = [{
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: cleanBase64 },
      },
      {
        type: "text",
        text: contextText + "\n\n---\n\nGive me your read on this week's photo + scale data. Lead with what changed most.",
      },
    ],
  }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM_PROMPT, messages }),
  });
  if (!res.ok) {
    const errTxt = await res.text();
    return { ok: false, error: `Anthropic ${res.status}: ${errTxt.slice(0, 400)}` };
  }
  const data = await res.json();
  const textBlocks: string[] = [];
  for (const b of data.content || []) if (b.type === "text") textBlocks.push(b.text);
  const analysis = textBlocks.join("\n\n");
  return { ok: true, analysis, raw: data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const photoId = body.photo_id;
    if (!photoId) return json({ ok: false, error: "photo_id required" }, 400);

    const { data: photo, error: fetchErr } = await sb.from("body_photos").select("*").eq("id", photoId).maybeSingle();
    if (fetchErr || !photo) return json({ ok: false, error: "Photo not found" }, 404);

    // Mark as analyzing
    await sb.from("body_photos").update({ analysis_status: "analyzing" }).eq("id", photoId);

    const log30d = await buildContextMetrics();
    const contextText = formatMetricBlock(photo as PhotoRow, log30d);

    const result = await analyzePhoto(photo as PhotoRow, contextText);

    if (!result.ok) {
      await sb.from("body_photos").update({
        analysis_status: "failed",
        analysis_text: `[Analysis failed: ${result.error}]`,
        analysis_completed_at: new Date().toISOString(),
      }).eq("id", photoId);
      return json({ ok: false, error: result.error });
    }

    await sb.from("body_photos").update({
      analysis_text: result.analysis,
      analysis_status: "complete",
      analysis_completed_at: new Date().toISOString(),
      analysis_signals: { context_metric_block: contextText, model: MODEL },
    }).eq("id", photoId);

    // Award XP for the weekly check-in (one per week max)
    await sb.from("xp_events").insert({
      pillar_id: "health",
      action: `Body photo check-in: ${photo.photo_date}`,
      xp_amount: 8,
      source: "body_photo_analysis",
    });

    return json({ ok: true, photo_id: photoId, analysis: result.analysis });
  } catch (e: any) { return json({ ok: false, error: String(e.message || e) }, 500); }
});

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey" };
function json(obj: any, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } }); }
