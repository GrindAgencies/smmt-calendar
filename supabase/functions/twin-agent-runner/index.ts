// twin-agent-runner v3 — FIXED agent_runs schema columns (triggered_by/input_summary/output_summary).
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const CLAUDE_API_KEY = Deno.env.get('CLAUDE_API_KEY') || Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
  db: { schema: 'personal' },
  auth: { persistSession: false, autoRefreshToken: false }
})

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }

function pillarFor(agentName: string): string {
  const m: Record<string,string> = {
    'Health Agent': 'health', 'Wealth Agent': 'wealth', 'Mind/Knowledge Agent': 'mind',
    'Relationships Agent': 'relationships', 'Team Coach Agent': 'wealth', 'CEO Agent': 'wealth',
    'Decision Architect': 'mind', 'Memory Curator': 'mind', 'Pattern Detective': 'mind',
    'Forecast Agent': 'mind', 'Reflection Agent': 'mind', 'Risk Sentinel': 'mind',
    'Executive Assistant': 'mind', 'Chief of Staff': 'mind', 'Visionary Agent': 'mind',
    'Content Strategist': 'mind', 'Copy and Script Writer': 'mind', 'Inbox Agent': 'wealth',
  }
  return m[agentName] || 'mind'
}

async function callClaude(systemPrompt: string, userMessage: string, max_tokens = 2000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CLAUDE_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`Claude API: ${JSON.stringify(json).slice(0,500)}`)
  return (json.content?.[0]?.text || '').trim()
}

async function buildContextFor(agent: any) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString()
  const ctx: any = { now: new Date().toISOString(), agent_name: agent.name }
  const scope: string[] = agent.read_scope || []
  const p: Promise<void>[] = []
  const get = (key: string, q: any) => p.push(q.then(({data}: any) => { ctx[key] = data }).catch(() => {}))

  if (scope.includes('identity'))         get('identity', supa.from('identity').select('*').limit(1).maybeSingle())
  if (scope.includes('event_stream'))     get('recent_events', supa.from('event_stream').select('event_type,pillar,source,actor,payload,occurred_at').gte('occurred_at', since).order('occurred_at',{ascending:false}).limit(100))
  if (scope.includes('daily_logs'))       get('daily_logs', supa.from('daily_logs').select('*').gte('log_date', since.slice(0,10)).order('log_date',{ascending:false}).limit(30))
  if (scope.includes('finance_snapshots')) get('finance', supa.from('finance_snapshots').select('*').order('snapshot_date',{ascending:false}).limit(8))
  if (scope.includes('transactions'))     get('transactions', supa.from('transactions').select('date,amount,merchant,category').gte('date', since.slice(0,10)).order('date',{ascending:false}).limit(100))
  if (scope.includes('weekly_reports'))   get('weekly_reports', supa.from('weekly_reports').select('*').order('week_start',{ascending:false}).limit(4))
  if (scope.includes('goals'))            get('goals', supa.from('goals').select('title,pillar_id,progress_pct,current_value,target_value,target_date').eq('status','active'))
  if (scope.includes('quests'))           get('quests', supa.from('quests').select('title,xp_reward,status,deadline').eq('status','active'))
  if (scope.includes('decisions'))        get('decisions', supa.from('decisions').select('title,choice,confidence,next_retro_date,actual_outcome').order('decided_at',{ascending:false}).limit(10))
  if (scope.includes('key_relationships')) get('relationships', supa.from('key_relationships').select('name,role,last_touch_date,touch_frequency_days'))
  if (scope.includes('connections'))      get('team', supa.from('connections').select('name,connection_type,pipeline_stage,last_contact').eq('is_team_member',true).limit(30))
  if (scope.includes('memory_episodic'))  get('recent_episodes', supa.from('memory_episodic').select('headline,summary,occurred_at').order('occurred_at',{ascending:false}).limit(10))
  if (scope.includes('memory_semantic'))  get('semantic_facts', supa.from('memory_semantic').select('subject,predicate,object,confidence').limit(40))
  if (scope.includes('memory_reflective')) get('lessons', supa.from('memory_reflective').select('lesson,domain,extracted_from').order('created_at',{ascending:false}).limit(15))
  if (scope.includes('patterns'))         get('recent_patterns', supa.from('patterns').select('description,confidence,domain,first_seen').gte('first_seen', since))
  if (scope.includes('forecasts'))        get('recent_forecasts', supa.from('forecasts').select('metric,horizon_days,predicted_value,confidence_interval,created_at').order('created_at',{ascending:false}).limit(10))
  if (scope.includes('commitments'))      get('commitments', supa.from('commitments').select('text,deadline,status').eq('status','open'))
  if (scope.includes('xp_events'))        get('xp_recent', supa.from('xp_events').select('action,pillar_id,xp_amount,occurred_at').order('occurred_at',{ascending:false}).limit(30))
  await Promise.all(p)
  return ctx
}

async function persistOutputs(agent: any, output: string) {
  await supa.from('event_stream').insert({
    event_type: 'agent_proactive_run',
    pillar: pillarFor(agent.name),
    source: 'agent',
    actor: agent.name,
    payload: { summary: output.slice(0, 600) },
  })

  if (agent.name === 'Pattern Detective') {
    try {
      const m = output.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0])
        if (Array.isArray(parsed.patterns)) {
          for (const pp of parsed.patterns) {
            if (typeof pp.confidence === 'number' && pp.confidence >= 0.7 && pp.description) {
              await supa.from('patterns').insert({
                description: pp.description, domain: pp.domain || 'general',
                confidence: pp.confidence, first_seen: new Date().toISOString(), detected_by: 'Pattern Detective',
              })
            }
          }
        }
      }
    } catch (_) { /* best-effort */ }
  }

  if (agent.name === 'Memory Curator') {
    try {
      const m = output.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0])
        if (Array.isArray(parsed.atoms)) {
          for (const a of parsed.atoms) {
            if (a.subject && a.predicate && a.object) {
              await supa.from('memory_semantic').insert({
                subject: a.subject, predicate: a.predicate, object: a.object,
                confidence: a.confidence || 0.8, source: 'Memory Curator nightly'
              })
            }
          }
        }
      }
    } catch (_) { /* best-effort */ }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const body = await req.json().catch(() => ({}))
    const agentName: string = body.agent_name || ''
    if (!agentName) return new Response(JSON.stringify({ error: 'missing agent_name' }), { status: 400, headers: { ...CORS, 'content-type': 'application/json' } })

    const { data: agent, error } = await supa.from('agents').select('*').eq('name', agentName).eq('active', true).maybeSingle()
    if (error || !agent) return new Response(JSON.stringify({ error: 'agent_not_found', name: agentName }), { status: 404, headers: { ...CORS, 'content-type': 'application/json' } })

    const runStart = Date.now()
    const ctx = await buildContextFor(agent)

    const isStructured = ['Pattern Detective', 'Memory Curator', 'Forecast Agent', 'Risk Sentinel'].includes(agent.name)
    const formatInstruction = isStructured
      ? `\n\n# Output format\nReturn STRICT JSON only, no prose:\n${
          agent.name === 'Pattern Detective' ? '{"patterns": [{"description": str, "domain": str, "confidence": float 0-1, "evidence": str}]}' :
          agent.name === 'Memory Curator' ? '{"atoms": [{"subject": str, "predicate": str, "object": str, "confidence": float}], "summary": str}' :
          agent.name === 'Forecast Agent' ? '{"forecasts": [{"metric": str, "horizon_days": int, "predicted_value": float, "confidence_interval": [low, high], "reasoning": str}]}' :
          '{"risks": [{"description": str, "severity": "low"|"med"|"high"|"critical", "likelihood": float, "impact_area": str}], "top_3": [str, str, str]}'
        }`
      : '\n\nReturn a tight, actionable response in Chris\'s strategic-peer voice.'

    const sys = `${agent.system_prompt}${formatInstruction}\n\n# Cadence\nYou are running on schedule: ${agent.cadence}. This is a proactive run — no user prompt; analyze the context and deliver your domain output.`
    const userBlock = `Context snapshot (last 7 days):\n${JSON.stringify(ctx, null, 1).slice(0, 12000)}`

    let output = ''
    let status = 'success'
    let errMsg: string | null = null
    try { output = await callClaude(sys, userBlock, 2000) }
    catch (e) { status = 'error'; errMsg = (e as Error).message; output = `Claude error: ${errMsg}` }

    const duration = Date.now() - runStart

    // FIXED: use actual schema columns (triggered_by/input_summary/output_summary)
    const { data: run, error: insertErr } = await supa.from('agent_runs').insert({
      agent_id: agent.id,
      agent_name: agent.name,
      triggered_by: 'scheduled',
      trigger_payload: { cadence: agent.cadence },
      input_summary: `Context keys: ${Object.keys(ctx).join(', ')}`,
      output_summary: output.slice(0, 4000),
      status,
      error_message: errMsg,
      duration_ms: duration,
      completed_at: new Date().toISOString(),
    }).select('id').maybeSingle()

    if (insertErr) console.error('agent_runs insert failed:', insertErr)

    if (status === 'success') await persistOutputs(agent, output)

    return new Response(JSON.stringify({
      ok: status === 'success', agent: agent.name, run_id: run?.id,
      duration_ms: duration, output_preview: output.slice(0, 500),
      insert_error: insertErr?.message || null,
    }), { headers: { ...CORS, 'content-type': 'application/json' } })

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } })
  }
})
