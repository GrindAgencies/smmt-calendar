// twin-cos v3 — FIXED agent_runs schema columns + larger context window for COS routing
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const CLAUDE_API_KEY = Deno.env.get('CLAUDE_API_KEY') || Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { db: { schema: 'personal' }, auth: { persistSession: false, autoRefreshToken: false } })
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const MODEL = 'claude-sonnet-4-6'

async function loadIdentityContext() {
  const [{ data: identity }, { data: agents }, { data: recentEvents }] = await Promise.all([
    supa.from('identity').select('*').limit(1).maybeSingle(),
    supa.from('agents').select('id,name,purpose,decision_authority,cadence').eq('active', true),
    supa.from('event_stream').select('event_type,pillar,source,actor,payload,occurred_at').order('occurred_at', { ascending: false }).limit(40)
  ])
  return { identity, agents, recentEvents }
}

async function callClaude(systemPrompt: string, userMessage: string, opts: { max_tokens?: number } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CLAUDE_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: opts.max_tokens ?? 2000, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(json)}`)
  return (json.content?.[0]?.text || '').trim()
}

async function logEvent(event_type: string, pillar: string, payload: unknown, actor = 'twin-cos') {
  await supa.from('event_stream').insert({ event_type, pillar, source: 'agent', actor, payload }).then(() => {}).catch((e) => console.error('event_stream insert failed', e))
}

async function runSpecialist(agents: any[], agentName: string, userMessage: string, sharedContext: string) {
  const agent = agents.find(a => a.name === agentName)
  if (!agent) {
    const { data } = await supa.from('agents').select('*').eq('name', agentName).maybeSingle()
    if (!data) return { agent: agentName, error: 'agent_not_found', text: '', status: 'error' }
    return _runSpecialistInner(data, userMessage, sharedContext)
  }
  const { data: fullAgent } = await supa.from('agents').select('*').eq('id', agent.id).maybeSingle()
  return _runSpecialistInner(fullAgent, userMessage, sharedContext)
}

async function _runSpecialistInner(agent: any, userMessage: string, sharedContext: string) {
  const runStart = Date.now()
  const sys = `${agent.system_prompt}\n\n# Shared context from Chief of Staff:\n${sharedContext}\n\n# Constraints\n- decision_authority: ${agent.decision_authority}\n- Speak as a specialist. Lead with the take. Cite specific data when you have it.\n- Hold the line on Chris's stated constitution.`

  let text = ''
  let status = 'success'
  let errMsg: string | null = null
  try { text = await callClaude(sys, userMessage, { max_tokens: 1500 }) }
  catch (e) { status = 'error'; errMsg = (e as Error).message; text = `${agent.name} failed: ${errMsg}` }

  const duration = Date.now() - runStart

  // FIXED schema columns
  const { data: run, error: insertErr } = await supa.from('agent_runs').insert({
    agent_id: agent.id,
    agent_name: agent.name,
    triggered_by: 'cos_routing',
    trigger_payload: { user_message: userMessage.slice(0, 500) },
    input_summary: `COS routing | shared_context: ${sharedContext.slice(0, 200)}`,
    output_summary: text.slice(0, 4000),
    status,
    error_message: errMsg,
    duration_ms: duration,
    completed_at: new Date().toISOString(),
  }).select('id').maybeSingle()

  if (insertErr) console.error('cos agent_runs insert failed:', insertErr)

  await logEvent('specialist_run', 'mind', { agent: agent.name, run_id: run?.id, duration_ms: duration, status }, agent.name)

  return { agent: agent.name, text, run_id: run?.id, status }
}

async function planRouting(userMessage: string, ctx: any) {
  const agentNames = ctx.agents.map((a: any) => a.name).join(', ')
  const sys = `You are the Chief of Staff for Chris Lorenz's Nexus Brain. Decide which specialists to invoke.\n\nAvailable specialists: ${agentNames}.\n\nReturn STRICT JSON only, no prose:\n{\n  \"reasoning\": \"<one sentence>\",\n  \"specialists\": [\"<agent_name>\", ...],   // 1-4 specialists max\n  \"shared_context\": \"<2-3 sentences of compressed context>\"\n}\n\nDo NOT include the Chief of Staff in the specialists list. Pick the smallest set. If purely conversational, route to CEO Agent.`

  const userBlock = `User message:\n${userMessage}\n\nIdentity:\n${JSON.stringify(ctx.identity, null, 2).slice(0, 1500)}\n\nRecent events:\n${(ctx.recentEvents||[]).slice(0,15).map((e:any)=>`- ${e.event_type} [${e.pillar||'-'}] ${JSON.stringify(e.payload).slice(0,80)}`).join('\n')}`

  const raw = await callClaude(sys, userBlock, { max_tokens: 800 })
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`COS routing returned non-JSON: ${raw}`)
  return JSON.parse(match[0])
}

async function synthesize(userMessage: string, routing: any, specialistOutputs: any[]) {
  const sys = `You are Chris Lorenz's Chief of Staff. Synthesize multiple specialist reports into a single coherent response.\n\nVoice: strategic peer, framework-first, blunt about scorecard vs goal. No coaching softness. No \"great job.\" Lead with the take. Pick a side.\n\nThe specialists are extensions of you. Do not say \"the Health Agent says...\" — just speak as one voice.`
  const userBlock = `Chris asked:\n${userMessage}\n\nRouting reasoning: ${routing.reasoning}\nShared context: ${routing.shared_context}\n\nSpecialist reports:\n${specialistOutputs.map(s=>`## ${s.agent}\n${s.text}`).join('\n\n')}\n\nSynthesize a single response, max 350 words. Lead with the take.`
  return await callClaude(sys, userBlock, { max_tokens: 1500 })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const body = await req.json().catch(() => ({}))
    const userMessage: string = body.message || body.userMessage || ''
    if (!userMessage) return new Response(JSON.stringify({ error: 'missing message' }), { status: 400, headers: { ...CORS, 'content-type': 'application/json' } })

    const cosStart = Date.now()
    await logEvent('cos_request', 'mind', { message: userMessage.slice(0, 500) })

    const ctx = await loadIdentityContext()
    const routing = await planRouting(userMessage, ctx)
    await logEvent('cos_routing', 'mind', { routing })

    const outputs = await Promise.all(
      (routing.specialists || []).slice(0, 4).map((name: string) => runSpecialist(ctx.agents, name, userMessage, routing.shared_context || ''))
    )

    const synthesis = await synthesize(userMessage, routing, outputs)
    const duration = Date.now() - cosStart

    await logEvent('cos_response', 'mind', {
      routing, specialists: outputs.map(o => ({ agent: o.agent, status: o.status })),
      duration_ms: duration, synthesis_preview: synthesis.slice(0, 200)
    })

    return new Response(JSON.stringify({
      response: synthesis, routing,
      specialists: outputs.map(o => ({ agent: o.agent, status: o.status, preview: o.text.slice(0, 150) })),
      duration_ms: duration,
    }), { headers: { ...CORS, 'content-type': 'application/json' } })
  } catch (e) {
    await logEvent('cos_error', 'mind', { error: (e as Error).message })
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } })
  }
})
