// twin-capture — voice transcript → Twin Brain in capture mode → tool use → 1-line confirmation
// Designed for iOS Shortcut + voice.html. One-shot, no chat history.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("TWIN_MODEL") || "claude-sonnet-4-6";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
const MAX_TOOL_ITERATIONS = 6;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { db: { schema: "personal" } });

const INDUSTRY_RULES: Array<{ industry: string; patterns: RegExp[] }> = [
  { industry: "real_estate",       patterns: [/marwoc/i, /real estate/i, /realtor/i, /realty/i, /\bproperty\b/i, /house ?flip/i, /fix.{0,3}flip/i, /flipping/i, /\bbroker\b/i, /home loan/i] },
  { industry: "military_services", patterns: [/\bafd\b/i, /armed forces/i, /military services?/i, /skillbridge/i, /\buso\b/i, /\bnavy\b/i, /\barmy\b/i, /\bmarine/i, /air force/i, /coast guard/i, /space force/i, /\bveteran/i] },
  { industry: "insurance",         patterns: [/\bgfi\b/i, /grind ?agencies/i, /insurance/i, /\bcarrier\b/i, /life ins/i, /annuit/i] },
  { industry: "equities",          patterns: [/equit/i, /\bstock/i, /\bwealth\b/i, /portfolio/i, /investor/i] },
  { industry: "mortgage",          patterns: [/mortgage/i, /\brefi\b/i] },
  { industry: "finance",           patterns: [/financ/i, /\bcpa\b/i, /\btax/i, /accountant/i, /\badvisor\b/i] },
  { industry: "nonprofit",         patterns: [/nonprofit/i, /non.profit/i, /501.?c/i, /charity/i, /foundation/i] },
];
function classifyKeywords(fields: any) {
  const haystack = [fields.name, fields.company, fields.role, fields.where_met, fields.description].filter(Boolean).join(" ");
  for (const rule of INDUSTRY_RULES) { if (rule.patterns.some((p) => p.test(haystack))) return { industry: rule.industry, isBusiness: true }; }
  return { industry: null, isBusiness: false };
}

const CAPTURE_SYSTEM_PROMPT = `You are Chris Lorenz's Twin AI in CAPTURE MODE. Voice or text just came in. Parse it, fire the right tools, confirm in ONE sentence.

WHO CHRIS IS:
- Founder GrindAgencies (GFI — insurance), runs Armed Forces Division (AFD — military services).
- 12-month north stars: $500K GFI cashflow, 7-fig AFD nonprofit, debt-free Aug 2026, 245 lbs (from 268), 24 books, real relationship.
- Key party: Devin (brother), Mikale, Eli (boss), John, Anthony.
- Industries: insurance (GFI), military_services (AFD), real_estate (MARWOC), equities, mortgage, finance, nonprofit.

CAPTURE MODE RULES (different from chat mode):
- VOICE TRANSCRIPTION may have typos / misspellings — interpret charitably.
- USE TOOLS, not chat. Tools are the WHOLE POINT of capture mode.
- Fire ALL relevant tools in parallel — one capture may have 1-4 separate things to log.
- After tools execute, reply with ONE SHORT SENTENCE (under 25 words) confirming what was logged. Examples:
  - "Logged: +15 Health XP, weight 263, added Sarah Chen (real_estate)."
  - "Logged training, daily check-in, and touch with Devin."
  - "Added 2 connections, logged journal entry. +28 XP total."
- NO chat reply. NO questions. NO suggestions. ONLY the confirmation sentence.
- If nothing actionable in the transcript, reply: "Nothing to log — try again with what you did, who you met, or what you decided."

DIFFICULTY: HARDCORE. XP rewards halved automatically. Penalties separate.

Common capture patterns to recognize:
- "trained / worked out / hit the gym" → log_xp(health,...) AND log_daily_check_in(training: true)
- "weight was X / I'm at X lbs" → log_daily_check_in(weight_lbs: X)
- "slept X hours" → log_daily_check_in(sleep_hours: X)
- "met / had coffee with / talked to [name]" → if party member: log_relationship_touch. Else: create_connection.
- "finished [book]" → query_books / mark finished + log_xp(mind)
- "decided to [X]" → log_decision if it's a meaningful Nexus-grade call
- "closed / sold / signed up [client]" → log_xp(wealth) and remind that the actual sale goes in AgencyPulse
- "feeling / realized / understood [insight]" → log_journal_entry
`;

const TOOLS = [
  { name: "log_xp", description: "Award XP for an action Chris reported.", input_schema: { type: "object", properties: { pillar: { type: "string", enum: ["health", "wealth", "mind", "relationships"] }, action: { type: "string" }, amount: { type: "number" }, source: { type: "string" } }, required: ["pillar", "action", "amount"] } },
  { name: "log_daily_check_in", description: "Upsert today's daily_logs row with reported metrics.", input_schema: { type: "object", properties: { sleep_hours: { type: "number" }, training: { type: "boolean" }, training_note: { type: "string" }, energy_1_10: { type: "number" }, weight_lbs: { type: "number" }, deep_work_hours: { type: "number" }, reading_pages: { type: "number" }, mood_note: { type: "string" }, needle_moved: { type: "boolean" }, needle_note: { type: "string" } } } },
  { name: "log_relationship_touch", description: "Log touch with KEY party member (Devin/Mikale/Eli/John/Anthony).", input_schema: { type: "object", properties: { person_name: { type: "string" }, touch_type: { type: "string" }, initiated_by_me: { type: "boolean" }, quality_1_10: { type: "number" }, notes: { type: "string" } }, required: ["person_name"] } },
  { name: "create_connection", description: "Add new non-party person to Connections CRM.", input_schema: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, where_met: { type: "string" }, description: { type: "string" }, category: { type: "string", enum: ["business", "personal"] }, industry: { type: "string" }, company: { type: "string" }, role: { type: "string" }, next_followup_date: { type: "string" }, next_followup_note: { type: "string" } }, required: ["name", "category"] } },
  { name: "log_journal_entry", description: "Capture journal entry/insight.", input_schema: { type: "object", properties: { response: { type: "string" }, mood: { type: "string" }, key_insight: { type: "string" } }, required: ["response"] } },
  { name: "create_quest", description: "Create active quest from a commitment Chris made.", input_schema: { type: "object", properties: { title: { type: "string" }, pillar: { type: "string", enum: ["health", "wealth", "mind", "relationships"] }, target_date: { type: "string" }, difficulty: { type: "string", enum: ["easy", "normal", "hard", "boss"] }, xp_reward: { type: "number" }, description: { type: "string" } }, required: ["title", "pillar"] } },
  { name: "log_decision", description: "Log Nexus decision Chris just made.", input_schema: { type: "object", properties: { title: { type: "string" }, context: { type: "string" }, choice: { type: "string" }, confidence: { type: "number" }, reasoning: { type: "string" }, pillar: { type: "string" } }, required: ["title", "choice"] } },
];

async function execTool(name: string, input: any) {
  try {
    switch (name) {
      case "log_xp": {
        const baseAmt = input.amount;
        const finalAmt = baseAmt > 0 ? Math.max(1, Math.round(baseAmt * 0.5)) : baseAmt;
        await sb.from("xp_events").insert({ pillar_id: input.pillar, action: input.action, xp_amount: finalAmt, source: input.source || "voice_capture" });
        return { ok: true, xp_awarded: finalAmt, pillar: input.pillar };
      }
      case "log_daily_check_in": {
        const today = new Date().toISOString().slice(0, 10);
        const { data: existing } = await sb.from("daily_logs").select("id").eq("log_date", today).maybeSingle();
        const row: any = {};
        for (const k of ["sleep_hours", "training", "training_note", "energy_1_10", "weight_lbs", "deep_work_hours", "reading_pages", "mood_note", "needle_moved", "needle_note"]) {
          if (input[k] !== undefined) row[k] = input[k];
        }
        row.updated_at = new Date().toISOString();
        if (existing) {
          await sb.from("daily_logs").update(row).eq("id", existing.id);
          return { ok: true, action: "updated_today", fields: Object.keys(row).filter(k => k !== "updated_at") };
        } else {
          row.log_date = today;
          await sb.from("daily_logs").insert(row);
          return { ok: true, action: "created_today", fields: Object.keys(row).filter(k => k !== "log_date" && k !== "updated_at") };
        }
      }
      case "log_relationship_touch": {
        const { data: rels } = await sb.from("key_relationships").select("*");
        const match = (rels || []).find((r: any) => r.name && r.name.toLowerCase().startsWith(input.person_name.toLowerCase()));
        if (!match) return { ok: false, error: `Not a key party member. Use create_connection.` };
        await sb.from("relationship_touches").insert({ relationship_id: match.id, touch_type: input.touch_type || null, initiated_by_me: input.initiated_by_me != null ? input.initiated_by_me : null, quality_1_10: input.quality_1_10 || null, notes: input.notes || null });
        await sb.from("key_relationships").update({ last_contact_date: new Date().toISOString().slice(0, 10) }).eq("id", match.id);
        await sb.from("xp_events").insert({ pillar_id: "relationships", action: `Touch with ${match.name}`, xp_amount: 5, source: "voice_capture" });
        if (/in-person|met|coffee|dinner|lunch/i.test(input.touch_type || "")) await sb.from("xp_events").insert({ pillar_id: "relationships", action: `🤝 In-person bonus: ${match.name}`, xp_amount: 10, source: "hardcore_in_person_bonus" });
        return { ok: true, person: match.name };
      }
      case "create_connection": {
        const detect = classifyKeywords(input);
        let finalCategory = input.category;
        let finalIndustry = input.industry || detect.industry || null;
        if (detect.isBusiness && finalCategory !== "business") finalCategory = "business";
        if (input.email) {
          const { data: existing } = await sb.from("connections").select("*").eq("email", input.email).maybeSingle();
          if (existing) {
            const patch: any = { last_contact_date: new Date().toISOString().slice(0, 10) };
            if (!existing.industry && finalIndustry) patch.industry = finalIndustry;
            await sb.from("connections").update(patch).eq("id", existing.id);
            return { ok: true, action: "updated_existing", name: existing.name };
          }
        }
        const { data, error } = await sb.from("connections").insert({ name: input.name, phone: input.phone || null, email: input.email || null, where_met: input.where_met || null, description: input.description || null, category: finalCategory, industry: finalIndustry, company: input.company || null, role: input.role || null, next_followup_date: input.next_followup_date || null, next_followup_note: input.next_followup_note || null, source: "voice_capture", first_met_date: new Date().toISOString().slice(0, 10), last_contact_date: new Date().toISOString().slice(0, 10) }).select().single();
        if (error) throw error;
        await sb.from("xp_events").insert({ pillar_id: "relationships", action: `Added connection: ${data.name}`, xp_amount: 3, source: "voice_capture" });
        return { ok: true, name: data.name, category: data.category, industry: data.industry };
      }
      case "log_journal_entry": {
        const { data } = await sb.from("journal_entries").insert({ response: input.response, mood: input.mood || null, key_insight: input.key_insight || null }).select().single();
        await sb.from("xp_events").insert({ pillar_id: "mind", action: "Journal (voice)", xp_amount: 8, source: "voice_capture" });
        return { ok: true, entry_id: data?.id };
      }
      case "create_quest": {
        const { data } = await sb.from("quests").insert({ title: input.title, pillar_id: input.pillar, target_date: input.target_date || null, difficulty: input.difficulty || "normal", xp_reward: input.xp_reward || 50, description: input.description || null, status: "active" }).select().single();
        return { ok: true, quest_id: data?.id, title: data?.title };
      }
      case "log_decision": {
        const retro = new Date(); retro.setDate(retro.getDate() + 14);
        const { data } = await sb.from("decisions").insert({ title: input.title, context: input.context || null, choice: input.choice, confidence: input.confidence || null, reasoning: input.reasoning || null, pillar_id: input.pillar || null, next_retro_date: retro.toISOString().slice(0, 10) }).select().single();
        await sb.from("xp_events").insert({ pillar_id: input.pillar || "mind", action: `Nexus decision: ${input.title}`, xp_amount: 15, source: "voice_capture" });
        return { ok: true, decision_id: data?.id, choice: input.choice };
      }
      default: return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err: any) { return { ok: false, error: String(err.message || err) }; }
}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey" };
function json(obj: any, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } }); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!ANTHROPIC_API_KEY) return json({ ok: false, reply: "[Twin not wired]", actions: [] });

  let body: any; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const transcript = (body.transcript || body.text || "").trim();
  const source = body.source || "voice";
  if (!transcript) return json({ ok: false, reply: "Empty transcript.", actions: [] });

  const today = new Date().toISOString().slice(0, 10);
  const userMessage = `Source: ${source}\nDate: ${today}\n\nTranscript:\n"${transcript}"`;

  const messages: any[] = [{ role: "user", content: userMessage }];
  const actionsTaken: any[] = [];
  let finalText = "";
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 800, system: CAPTURE_SYSTEM_PROMPT, tools: TOOLS, messages }),
    });
    if (!apiRes.ok) { const errText = await apiRes.text(); return json({ ok: false, error: `Anthropic ${apiRes.status}: ${errText}`, actions: actionsTaken }); }
    const data = await apiRes.json();
    const textBlocks: string[] = []; const toolUseBlocks: any[] = [];
    for (const block of data.content || []) {
      if (block.type === "text") textBlocks.push(block.text);
      else if (block.type === "tool_use") toolUseBlocks.push(block);
    }
    if (textBlocks.length) finalText = textBlocks.join(" ");
    if (data.stop_reason === "end_turn" || !toolUseBlocks.length) break;
    const toolResults: any[] = [];
    for (const tu of toolUseBlocks) {
      const result = await execTool(tu.name, tu.input);
      actionsTaken.push({ tool: tu.name, input: tu.input, result, ok: result.ok });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result), is_error: !result.ok });
    }
    messages.push({ role: "assistant", content: data.content });
    messages.push({ role: "user", content: toolResults });
    if (data.stop_reason !== "tool_use") break;
  }

  return json({ ok: true, reply: finalText || "Logged.", actions: actionsTaken, action_count: actionsTaken.length, iterations });
});
