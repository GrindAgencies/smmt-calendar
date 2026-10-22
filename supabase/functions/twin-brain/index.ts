// twin-brain v9 — adds persona=claude second-opinion mode
// Twin persona = full context + tools + strategic peer voice
// Claude persona = neutral outside advisor, no tools, no personal data — Chris asked for both views

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("TWIN_MODEL") || "claude-sonnet-4-6";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
const MAX_TOOL_ITERATIONS = 8;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { db: { schema: "personal" } });

const INDUSTRY_RULES: Array<{ industry: string; patterns: RegExp[] }> = [
  { industry: "real_estate",       patterns: [/marwoc/i, /real estate/i, /realtor/i, /realty/i, /\bproperty\b/i, /house ?flip/i, /fix.{0,3}flip/i, /flipping/i, /\bbroker\b/i, /home loan/i] },
  { industry: "military_services", patterns: [/\bafd\b/i, /armed forces/i, /military services?/i, /skillbridge/i, /\buso\b/i, /\bnavy\b/i, /\barmy\b/i, /\bmarine/i, /air force/i, /coast guard/i, /space force/i, /\bveteran/i, /\bcombat/i] },
  { industry: "insurance",         patterns: [/\bgfi\b/i, /grind ?agencies/i, /insurance/i, /\bcarrier\b/i, /life ins/i, /annuit/i, /underwrit/i] },
  { industry: "equities",          patterns: [/equit/i, /\bstock/i, /\bwealth\b/i, /portfolio/i, /investor/i, /asset manag/i, /hedge fund/i] },
  { industry: "mortgage",          patterns: [/mortgage/i, /\brefi\b/i] },
  { industry: "finance",           patterns: [/financ/i, /\bcpa\b/i, /\btax/i, /accountant/i, /wealth advisor/i, /\badvisor\b/i] },
  { industry: "nonprofit",         patterns: [/nonprofit/i, /non.profit/i, /501.?c/i, /charity/i, /foundation/i] },
];
function classifyKeywords(fields: any) {
  const haystack = [fields.name, fields.company, fields.role, fields.where_met, fields.description, fields.email].filter(Boolean).join(" ");
  for (const rule of INDUSTRY_RULES) { if (rule.patterns.some((p) => p.test(haystack))) return { industry: rule.industry, isBusiness: true }; }
  return { industry: null, isBusiness: false };
}

// ===== PERSONA: TWIN (full context, tools, strategic peer) =====
const TWIN_SYSTEM_PROMPT = `You are Chris Lorenz's AI Twin. Strategic peer, not a coach. You have hands — use them.

WHO CHRIS IS:
- Founder of GrindAgencies (GFI — insurance), runs Armed Forces Division (AFD — military services).
- 12-month north stars: $500K GFI cashflow, 7-fig Armed Forces nonprofit, debt-free / break-even by Aug 2026, 245 lbs (from 268), 24 books, real relationship.
- KRONK failure modes to avoid: passive, no memory, generic. Be proactive, cite his data, have a point of view.
- Key party: Devin (brother), Mikale, Eli (boss), John, Anthony.
- Connections CRM: ANY new person → create_connection.
- Work brain: GetAgencyPulse.com. Use query_agency_pulse to pull his live business metrics (activity score, pace, sales, stuck apps) whenever he asks 'how's the business' or anything about dials/sales/pipeline/agents.

INDUSTRIES: insurance (GFI) | military_services (AFD) | real_estate (MARWOC) | equities | mortgage | finance | nonprofit. Calendly always business.

FRAMEWORKS: Nexus Brain (8 weighted criteria) | Pillar lens | Reversibility test.

DIFFICULTY: HARDCORE. XP halved. Penalties real.

DECISION RETRO LOOP: every Nexus call gets 14-day retro. When Chris reports back, call log_decision_outcome. When facing new decision similar to past, call query_decision_history first, cite hit rate.

TOOLS — use proactively. 1-3 per response. Don't ask permission for obvious logs.

STYLE: Lead with a take. Cite data. Name what he's avoiding. Pick a side.

NOTE: Chris is getting a SECOND opinion from raw Claude in parallel. Don't waste his time covering generic ground — lean HARDER into your role: framework-first, context-cited, action-taking. Let Claude provide the outsider perspective; you provide the insider one.
`;

// ===== PERSONA: CLAUDE (neutral outside advisor, no tools, light context) =====
const CLAUDE_SECOND_OPINION_PROMPT = `You are Claude, providing a thoughtful SECOND OPINION alongside Chris's personalized AI Twin.

YOUR ROLE — the outside perspective:
- The Twin knows Chris deeply (his goals, finances, relationships, frameworks) and is biased toward his existing strategy.
- YOU are the fresh eyes. You don't have his full context — and that's exactly the point. Chris is using you to catch blind spots his Twin might miss.
- Be willing to disagree with the Twin. Surface the obvious-but-overlooked. Question the framing. Offer the angle his close advisors wouldn't.
- Where you AGREE with the likely Twin take, say so briefly and add nuance — don't just repeat the same conclusion.

YOU KNOW (minimal context only):
- Chris is a founder building an insurance agency (GrindAgencies) and a military-focused nonprofit (Armed Forces Division).
- His near-term goals: become debt-free by August 2026, hit 245 lbs, build the businesses.
- He's running on HARDCORE mode — he wants honest pushback, not motivation.

STYLE:
- Concise — 3–6 sentences typically. Bullet only if listing 3+ distinct alternatives.
- Lead with the perspective the Twin might miss.
- Don't moralize, don't pad. Treat him as the smart, capable adult he is.
- If the question is purely tactical/factual (no decision to make), give the cleanest answer you can.
- End with ONE sharp counter-question only if it would meaningfully sharpen his thinking. Otherwise no question.

DO NOT:
- Pretend to know his personal stats, finances, or relationships in detail.
- Use "as your AI assistant" or similar boilerplate.
- Repeat the Twin's framework-first approach — be different on purpose.
`;

const TOOLS = [
  { name: "create_quest", description: "Create active quest tied to pillar.", input_schema: { type: "object", properties: { title: { type: "string" }, pillar: { type: "string", enum: ["health", "wealth", "mind", "relationships"] }, target_date: { type: "string" }, difficulty: { type: "string", enum: ["easy", "normal", "hard", "boss"] }, xp_reward: { type: "number" }, description: { type: "string" } }, required: ["title", "pillar"] } },
  { name: "complete_quest", description: "Mark quest complete.", input_schema: { type: "object", properties: { quest_id: { type: "string" }, note: { type: "string" } }, required: ["quest_id"] } },
  { name: "log_xp", description: "Award XP for action.", input_schema: { type: "object", properties: { pillar: { type: "string", enum: ["health", "wealth", "mind", "relationships"] }, action: { type: "string" }, amount: { type: "number" }, source: { type: "string" } }, required: ["pillar", "action", "amount"] } },
  { name: "create_goal", description: "New long-term goal.", input_schema: { type: "object", properties: { title: { type: "string" }, pillar: { type: "string" }, target_value: { type: "string" }, current_value: { type: "string" }, target_date: { type: "string" }, priority: { type: "string" }, description: { type: "string" } }, required: ["title", "pillar"] } },
  { name: "update_goal_progress", description: "Update goal progress.", input_schema: { type: "object", properties: { goal_id: { type: "string" }, progress_pct: { type: "number" }, current_value: { type: "string" }, notes: { type: "string" } }, required: ["goal_id"] } },
  { name: "log_journal_entry", description: "Capture journal entry.", input_schema: { type: "object", properties: { response: { type: "string" }, prompt: { type: "string" }, mood: { type: "string" }, key_insight: { type: "string" } }, required: ["response"] } },
  { name: "log_daily_check_in", description: "Upsert today's daily_logs row.", input_schema: { type: "object", properties: { sleep_hours: { type: "number" }, training: { type: "boolean" }, training_note: { type: "string" }, energy_1_10: { type: "number" }, weight_lbs: { type: "number" }, deep_work_hours: { type: "number" }, reading_pages: { type: "number" }, mood_note: { type: "string" }, needle_moved: { type: "boolean" }, needle_note: { type: "string" } } } },
  { name: "log_decision", description: "Log Nexus decision. Auto-sets next_retro_date = today + 14d.", input_schema: { type: "object", properties: { title: { type: "string" }, context: { type: "string" }, options: { type: "array" }, criteria_weights: { type: "object" }, choice: { type: "string" }, confidence: { type: "number" }, reasoning: { type: "string" }, pillar: { type: "string" } }, required: ["title", "choice"] } },
  { name: "log_decision_outcome", description: "Log outcome of past Nexus decision.", input_schema: { type: "object", properties: { decision_title_partial: { type: "string" }, outcome_rating: { type: "string", enum: ["good", "mixed", "bad", "too_early"] }, outcome_notes: { type: "string" } }, required: ["decision_title_partial", "outcome_rating"] } },
  { name: "query_decision_history", description: "Search past Nexus decisions + outcomes. Use to cite hit rate on similar past calls.", input_schema: { type: "object", properties: { search: { type: "string" }, pillar: { type: "string" }, only_rated: { type: "boolean" }, limit: { type: "number" } } } },
  { name: "log_relationship_touch", description: "Log touch with KEY party member (Devin/Mikale/Eli/John/Anthony only).", input_schema: { type: "object", properties: { person_name: { type: "string" }, touch_type: { type: "string" }, initiated_by_me: { type: "boolean" }, quality_1_10: { type: "number" }, notes: { type: "string" } }, required: ["person_name"] } },
  { name: "create_connection", description: "Add new person to Connections CRM.", input_schema: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, where_met: { type: "string" }, description: { type: "string" }, category: { type: "string", enum: ["business", "personal"] }, industry: { type: "string" }, company: { type: "string" }, role: { type: "string" }, importance: { type: "string" }, next_followup_date: { type: "string" }, next_followup_note: { type: "string" }, source: { type: "string" } }, required: ["name", "category"] } },
  { name: "update_connection", description: "Update existing connection by fuzzy name.", input_schema: { type: "object", properties: { name_partial: { type: "string" }, patch: { type: "object" } }, required: ["name_partial", "patch"] } },
  { name: "add_inventory_item", description: "Add gear/tool.", input_schema: { type: "object", properties: { name: { type: "string" }, slot: { type: "string" }, category: { type: "string" }, pillar: { type: "string" }, buff_description: { type: "string" }, monthly_cost: { type: "number" }, notes: { type: "string" } }, required: ["name"] } },
  { name: "query_recent_finance", description: "Read recent finance snapshots.", input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "query_recent_xp", description: "Read recent XP events.", input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "query_active_quests", description: "Read active quests.", input_schema: { type: "object", properties: {} } },
  { name: "query_active_goals", description: "Read active goals.", input_schema: { type: "object", properties: {} } },
  { name: "query_journal_recent", description: "Read recent journal entries.", input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "query_inventory", description: "Read equipped inventory.", input_schema: { type: "object", properties: {} } },
  { name: "query_connections", description: "Search Connections CRM.", input_schema: { type: "object", properties: { search: { type: "string" }, category: { type: "string" }, industry: { type: "string" }, limit: { type: "number" } } } },
  { name: "query_agency_pulse", description: "Pull Chris's live business metrics from GetAgencyPulse.com (his work brain). Returns activity score today + 7d avg, week/month pace on dials and AP, sales (count + total AP + paid out + stuck), profile, goals. Use whenever Chris asks about the business / dials / sales / pipeline / stuck apps / activity score / pace.", input_schema: { type: "object", properties: {} } },
];

async function execTool(name: string, input: any, conversation_id: string | null) {
  try {
    switch (name) {
      case "create_quest": { const { data, error } = await sb.from("quests").insert({ title: input.title, pillar_id: input.pillar, target_date: input.target_date || null, difficulty: input.difficulty || "normal", xp_reward: input.xp_reward || 50, description: input.description || null, status: "active" }).select().single(); if (error) throw error; return { ok: true, quest_id: data.id, title: data.title }; }
      case "complete_quest": { const { data: q } = await sb.from("quests").select("*").eq("id", input.quest_id).single(); if (!q) return { ok: false, error: "Quest not found" }; await sb.from("quests").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", input.quest_id); await sb.from("xp_events").insert({ pillar_id: q.pillar_id, action: `Completed quest: ${q.title}`, xp_amount: Math.max(1, Math.round((q.xp_reward || 50) * 0.5)), source: "quest_completion" }); return { ok: true, completed: q.title }; }
      case "log_xp": { const baseAmt = input.amount; const finalAmt = baseAmt > 0 ? Math.max(1, Math.round(baseAmt * 0.5)) : baseAmt; const { data, error } = await sb.from("xp_events").insert({ pillar_id: input.pillar, action: input.action, xp_amount: finalAmt, source: input.source || "twin_conversation" }).select().single(); if (error) throw error; return { ok: true, xp_awarded: finalAmt, pillar: input.pillar }; }
      case "create_goal": { const { data, error } = await sb.from("goals").insert({ title: input.title, pillar_id: input.pillar, target_value: input.target_value || null, current_value: input.current_value || null, target_date: input.target_date || null, priority: input.priority || "normal", description: input.description || null, status: "active" }).select().single(); if (error) throw error; return { ok: true, goal_id: data.id, title: data.title }; }
      case "update_goal_progress": { const updates: any = { updated_at: new Date().toISOString() }; if (input.progress_pct != null) updates.progress_pct = input.progress_pct; if (input.current_value) updates.current_value = input.current_value; if (input.notes) updates.notes = input.notes; const { data, error } = await sb.from("goals").update(updates).eq("id", input.goal_id).select().single(); if (error) throw error; return { ok: true, goal: data.title, new_progress: data.progress_pct }; }
      case "log_journal_entry": { const { data, error } = await sb.from("journal_entries").insert({ response: input.response, prompt: input.prompt || null, mood: input.mood || null, key_insight: input.key_insight || null }).select().single(); if (error) throw error; await sb.from("xp_events").insert({ pillar_id: "mind", action: "Journal entry (via Twin)", xp_amount: 8, source: "twin_journal" }); return { ok: true, entry_id: data.id }; }
      case "log_daily_check_in": { const today = new Date().toISOString().slice(0, 10); const { data: existing } = await sb.from("daily_logs").select("id").eq("log_date", today).maybeSingle(); const row: any = {}; for (const k of ["sleep_hours", "training", "training_note", "energy_1_10", "weight_lbs", "deep_work_hours", "reading_pages", "mood_note", "needle_moved", "needle_note"]) { if (input[k] !== undefined) row[k] = input[k]; } row.updated_at = new Date().toISOString(); if (existing) { await sb.from("daily_logs").update(row).eq("id", existing.id); return { ok: true, action: "updated" }; } else { row.log_date = today; await sb.from("daily_logs").insert(row); return { ok: true, action: "created" }; } }
      case "log_decision": { const weights = input.criteria_weights || { wealth: 30, freedom: 15, second_order: 12, relationships: 12, time_energy: 10, health: 8, mind: 8, reversibility: 5 }; const retro = new Date(); retro.setDate(retro.getDate() + 14); const { data, error } = await sb.from("decisions").insert({ title: input.title, context: input.context || null, options: input.options || null, criteria_weights: weights, choice: input.choice, confidence: input.confidence || null, reasoning: input.reasoning || null, pillar_id: input.pillar || null, next_retro_date: retro.toISOString().slice(0, 10) }).select().single(); if (error) throw error; await sb.from("xp_events").insert({ pillar_id: input.pillar || "mind", action: `Nexus decision: ${input.title}`, xp_amount: 15, source: "twin_nexus" }); return { ok: true, decision_id: data.id, choice: input.choice, retro_due: retro.toISOString().slice(0, 10) }; }
      case "log_decision_outcome": { const { data: matches } = await sb.from("decisions").select("*").ilike("title", `%${input.decision_title_partial}%`).limit(5); if (!matches || !matches.length) return { ok: false, error: `No decision matched.` }; if (matches.length > 1) return { ok: false, error: `Ambiguous: ${matches.length} matches.`, candidates: matches.map((m: any) => ({ id: m.id, title: m.title })) }; const d = matches[0]; await sb.from("decisions").update({ outcome_rating: input.outcome_rating, outcome_notes: input.outcome_notes || null, outcome_logged_on: new Date().toISOString().slice(0, 10), outcome: input.outcome_notes || input.outcome_rating }).eq("id", d.id); await sb.from("xp_events").insert({ pillar_id: d.pillar_id || "mind", action: `Decision retro: ${d.title} → ${input.outcome_rating}`, xp_amount: 5, source: "decision_retro" }); return { ok: true, decision_id: d.id, decision_title: d.title, outcome_rating: input.outcome_rating }; }
      case "query_decision_history": { let q = sb.from("decisions").select("id, title, decided_on, choice, confidence, outcome_rating, outcome_notes, reasoning, pillar_id"); if (input.search) q = q.or(`title.ilike.%${input.search}%,context.ilike.%${input.search}%,choice.ilike.%${input.search}%,reasoning.ilike.%${input.search}%`); if (input.pillar) q = q.eq("pillar_id", input.pillar); if (input.only_rated) q = q.not("outcome_rating", "is", null); q = q.order("decided_on", { ascending: false }).limit(input.limit || 10); const { data } = await q; const rated = (data || []).filter((d: any) => d.outcome_rating); const hitRate = rated.length > 0 ? Math.round((rated.filter((d: any) => d.outcome_rating === "good").length / rated.length) * 100) : null; return { ok: true, decisions: data, matched: (data || []).length, rated_count: rated.length, hit_rate: hitRate }; }
      case "log_relationship_touch": { const { data: rels } = await sb.from("key_relationships").select("*"); const match = (rels || []).find((r: any) => r.name && r.name.toLowerCase().startsWith(input.person_name.toLowerCase())); if (!match) return { ok: false, error: `No KEY relationship matched. Use create_connection for non-party people.` }; await sb.from("relationship_touches").insert({ relationship_id: match.id, touch_type: input.touch_type || null, initiated_by_me: input.initiated_by_me != null ? input.initiated_by_me : null, quality_1_10: input.quality_1_10 || null, notes: input.notes || null }); await sb.from("key_relationships").update({ last_contact_date: new Date().toISOString().slice(0, 10) }).eq("id", match.id); await sb.from("xp_events").insert({ pillar_id: "relationships", action: `Touch with ${match.name}`, xp_amount: 5, source: "twin_relationship" }); if (/in-person|met|coffee|dinner|lunch/i.test(input.touch_type || "")) await sb.from("xp_events").insert({ pillar_id: "relationships", action: `🤝 In-person bonus: ${match.name}`, xp_amount: 10, source: "hardcore_in_person_bonus" }); return { ok: true, person: match.name }; }
      case "create_connection": { const detect = classifyKeywords(input); let finalCategory = input.category; let finalIndustry = input.industry || detect.industry || null; if ((input.source || "").toLowerCase() === "calendly") finalCategory = "business"; if (detect.isBusiness && finalCategory !== "business") finalCategory = "business"; if (input.email) { const { data: existing } = await sb.from("connections").select("*").eq("email", input.email).maybeSingle(); if (existing) { const patch: any = { last_contact_date: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() }; for (const k of ["phone", "where_met", "description", "company", "role", "linkedin_url", "importance", "next_followup_date", "next_followup_note"]) { if (input[k] && !existing[k]) patch[k] = input[k]; } if (!existing.industry && finalIndustry) patch.industry = finalIndustry; if (existing.category !== "business" && finalCategory === "business") patch.category = "business"; await sb.from("connections").update(patch).eq("id", existing.id); return { ok: true, action: "updated_existing", connection_id: existing.id, name: existing.name }; } } const { data, error } = await sb.from("connections").insert({ name: input.name, phone: input.phone || null, email: input.email || null, where_met: input.where_met || null, description: input.description || null, category: finalCategory, industry: finalIndustry, company: input.company || null, role: input.role || null, importance: input.importance || "normal", next_followup_date: input.next_followup_date || null, next_followup_note: input.next_followup_note || null, source: input.source || "twin_brain", first_met_date: new Date().toISOString().slice(0, 10), last_contact_date: new Date().toISOString().slice(0, 10) }).select().single(); if (error) throw error; await sb.from("xp_events").insert({ pillar_id: "relationships", action: `Added connection: ${data.name}`, xp_amount: 3, source: "twin_brain_connection" }); return { ok: true, connection_id: data.id, name: data.name, category: data.category, industry: data.industry }; }
      case "update_connection": { const { data: matches } = await sb.from("connections").select("*").ilike("name", `%${input.name_partial}%`).limit(5); if (!matches || !matches.length) return { ok: false, error: `No connection matched.` }; if (matches.length > 1) return { ok: false, error: `Ambiguous: ${matches.length} matches.`, candidates: matches.map((m: any) => ({ id: m.id, name: m.name })) }; const c = matches[0]; await sb.from("connections").update({ ...input.patch, updated_at: new Date().toISOString() }).eq("id", c.id); return { ok: true, updated: c.name }; }
      case "add_inventory_item": { const { data, error } = await sb.from("inventory_items").insert({ name: input.name, slot: input.slot || "utility", category: input.category || "tool", pillar_id: input.pillar || null, buff_description: input.buff_description || null, monthly_cost: input.monthly_cost || 0, notes: input.notes || null, equipped: true }).select().single(); if (error) throw error; return { ok: true, item_id: data.id, name: data.name }; }
      case "query_recent_finance": { const { data } = await sb.from("finance_snapshots").select("*").order("snapshot_date", { ascending: false }).limit(input.limit || 5); return { ok: true, snapshots: data }; }
      case "query_recent_xp": { const { data } = await sb.from("xp_events").select("*").order("occurred_at", { ascending: false }).limit(input.limit || 10); return { ok: true, events: data }; }
      case "query_active_quests": { const { data } = await sb.from("quests").select("*").eq("status", "active"); return { ok: true, quests: data }; }
      case "query_active_goals": { const { data } = await sb.from("goals").select("*").eq("status", "active"); return { ok: true, goals: data }; }
      case "query_journal_recent": { const { data } = await sb.from("journal_entries").select("*").order("entry_date", { ascending: false }).limit(input.limit || 5); return { ok: true, entries: data }; }
      case "query_inventory": { const { data } = await sb.from("inventory_items").select("*").eq("equipped", true); return { ok: true, items: data }; }
      case "query_connections": { let q = sb.from("connections").select("*").neq("status", "archived"); if (input.search) q = q.or(`name.ilike.%${input.search}%,email.ilike.%${input.search}%,company.ilike.%${input.search}%,where_met.ilike.%${input.search}%`); if (input.category) q = q.eq("category", input.category); if (input.industry) q = q.eq("industry", input.industry); q = q.order("last_contact_date", { ascending: false, nullsFirst: false }).limit(input.limit || 20); const { data } = await q; return { ok: true, connections: data }; }
      case "query_agency_pulse": { const res = await fetch(`${SUPABASE_URL}/functions/v1/twin-agencypulse`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_KEY}`, "apikey": SUPABASE_KEY } }); if (!res.ok) return { ok: false, error: `Agency Pulse fetch failed: ${res.status}` }; const data = await res.json(); return data.ok ? { ok: true, agency_pulse: data.summary } : { ok: false, error: data.error }; }
      default: return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err: any) { return { ok: false, error: String(err.message || err) }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonRes({ error: "POST only" }, 405);
  if (!ANTHROPIC_API_KEY) return jsonRes({ reply: "[Twin not wired]", stub: true, tool_calls: [] });
  let body: any; try { body = await req.json(); } catch { return jsonRes({ error: "bad json" }, 400); }
  const userMessage = body.message || "";
  const history = Array.isArray(body.history) ? body.history : [];
  const context = body.context || {};
  const conversation_id = body.conversation_id || null;
  const persona = body.persona === "claude" ? "claude" : "twin";
  if (!userMessage) return jsonRes({ error: "missing message" }, 400);

  // ===== CLAUDE SECOND-OPINION MODE — no tools, no full context, no logging =====
  if (persona === "claude") {
    const trimmed = history.slice(-10);
    const msgs: any[] = [];
    for (const m of trimmed) {
      if (!m || !m.role || !m.content) continue;
      if (m.role === "user" || m.role === "assistant") msgs.push({ role: m.role, content: m.content });
    }
    msgs.push({ role: "user", content: userMessage });
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: CLAUDE_SECOND_OPINION_PROMPT, messages: msgs }),
    });
    if (!apiRes.ok) { const errText = await apiRes.text(); return jsonRes({ error: `Anthropic ${apiRes.status}: ${errText}`, reply: "Claude API error.", persona: "claude" }); }
    const data = await apiRes.json();
    const textBlocks: string[] = [];
    for (const block of data.content || []) if (block.type === "text") textBlocks.push(block.text);
    return jsonRes({ reply: textBlocks.join("\n\n"), persona: "claude", tool_calls: [], iterations: 1 });
  }

  // ===== TWIN MODE (default) — full context + tools + agentic loop =====
  const ctxBlock = formatContext(context);
  const trimmed = history.slice(-20);
  const messages: any[] = [];
  for (let i = 0; i < trimmed.length - 1; i++) { const m = trimmed[i]; if (m && m.role && m.content) messages.push({ role: m.role === "user" ? "user" : "assistant", content: m.content }); }
  messages.push({ role: "user", content: ctxBlock + "\n\n---\n\n" + userMessage });
  const toolCallLog: any[] = []; let finalText = ""; let iterations = 0;
  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: TWIN_SYSTEM_PROMPT, tools: TOOLS, messages }) });
    if (!apiRes.ok) { const errText = await apiRes.text(); return jsonRes({ error: `Anthropic ${apiRes.status}: ${errText}`, reply: "Twin API error.", tool_calls: toolCallLog }); }
    const data = await apiRes.json();
    const textBlocks: string[] = []; const toolUseBlocks: any[] = [];
    for (const block of data.content || []) { if (block.type === "text") textBlocks.push(block.text); else if (block.type === "tool_use") toolUseBlocks.push(block); }
    if (textBlocks.length) finalText = textBlocks.join("\n\n");
    if (data.stop_reason === "end_turn" || !toolUseBlocks.length) break;
    const toolResults: any[] = [];
    for (const tu of toolUseBlocks) { const result = await execTool(tu.name, tu.input, conversation_id); const callRow = { conversation_id, tool_name: tu.name, tool_input: tu.input, tool_result: result, status: result.ok ? "success" : "error", error_message: result.ok ? null : result.error }; toolCallLog.push(callRow); await sb.from("brain_tool_calls").insert(callRow); toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result), is_error: !result.ok }); }
    messages.push({ role: "assistant", content: data.content });
    messages.push({ role: "user", content: toolResults });
    if (data.stop_reason !== "tool_use") break;
  }
  return jsonRes({ reply: finalText, persona: "twin", tool_calls: toolCallLog, iterations });
});

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey" };
function jsonRes(obj: any, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } }); }
function formatContext(ctx: any): string { const lines: string[] = ["[LIVE CONTEXT — refreshed each turn]"]; if (ctx.today) lines.push(`Today: ${ctx.today}`); if (ctx.latestFinance) { const f = ctx.latestFinance; lines.push(`Finance (${f.date}): cash=$${f.cash || "?"}, debt=$${f.debt || "?"}, monthly_burn=$${f.monthly_burn || "?"}`); } if (Array.isArray(ctx.activeGoals) && ctx.activeGoals.length) { lines.push("Active goals:"); ctx.activeGoals.forEach((g: any) => lines.push(`  - [${g.pillar}] ${g.title} — ${g.progress || 0}% (target ${g.target || "?"} by ${g.deadline || "?"})`)); } if (Array.isArray(ctx.recentActivity) && ctx.recentActivity.length) { lines.push("Recent XP events:"); ctx.recentActivity.slice(0, 6).forEach((a: any) => lines.push(`  - ${a.action} (+${a.xp} XP, ${a.pillar || ""})`)); } return lines.join("\n"); }
