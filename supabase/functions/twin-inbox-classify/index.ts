// twin-inbox-classify — takes a batch of email envelopes, runs Inbox Agent classifier on each,
// writes results to personal.email_intel. Idempotent on gmail_message_id.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const CLAUDE_API_KEY = Deno.env.get('CLAUDE_API_KEY') || Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
  db: { schema: 'personal' },
  auth: { persistSession: false, autoRefreshToken: false }
})

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function loadAgent() {
  const { data } = await supa.from('agents').select('*').eq('name', 'Inbox Agent').maybeSingle()
  if (!data) throw new Error('Inbox Agent not found in personal.agents')
  return data
}

async function callClaude(system: string, user: string, max_tokens = 1500) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CLAUDE_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`Claude API: ${JSON.stringify(json).slice(0, 500)}`)
  return (json.content?.[0]?.text || '').trim()
}

function parseJson(raw: string): any {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

async function classifyOne(agent: any, email: any) {
  const userBlock = `Classify this email:\n\nFrom: ${email.from || ''}\nSubject: ${email.subject || ''}\nReceived: ${email.received_at || ''}\nSnippet: ${(email.snippet || '').slice(0, 600)}\n\nReturn STRICT JSON only.`

  let parsed: any = null
  let raw = ''
  try {
    raw = await callClaude(agent.system_prompt, userBlock, 1200)
    parsed = parseJson(raw)
  } catch (e) {
    return { ok: false, error: (e as Error).message, gmail_message_id: email.gmail_message_id }
  }
  if (!parsed || !parsed.priority_bucket) {
    return { ok: false, error: 'classifier returned non-JSON', gmail_message_id: email.gmail_message_id, raw: raw.slice(0, 200) }
  }

  const row = {
    gmail_message_id: email.gmail_message_id,
    gmail_thread_id: email.gmail_thread_id || null,
    from_email: email.from_email || null,
    from_name: email.from_name || null,
    subject: email.subject || null,
    snippet: email.snippet || null,
    received_at: email.received_at || null,
    priority_bucket: parsed.priority_bucket,
    confidence_score: typeof parsed.confidence_score === 'number' ? parsed.confidence_score : null,
    extracted_entities: parsed.extracted_entities || {},
    suggested_actions: parsed.suggested_actions || [],
    reply_draft: parsed.reply_draft || null,
    status: 'classified',
  }

  // Upsert on gmail_message_id
  const { error } = await supa.from('email_intel').upsert(row, { onConflict: 'gmail_message_id' })
  if (error) return { ok: false, error: error.message, gmail_message_id: email.gmail_message_id }

  return {
    ok: true,
    gmail_message_id: email.gmail_message_id,
    priority_bucket: parsed.priority_bucket,
    confidence: parsed.confidence_score,
    entities: parsed.extracted_entities,
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const body = await req.json().catch(() => ({}))
    const emails: any[] = Array.isArray(body.emails) ? body.emails : []
    if (!emails.length) {
      return new Response(JSON.stringify({ error: 'missing emails array' }), { status: 400, headers: { ...CORS, 'content-type': 'application/json' } })
    }

    const agent = await loadAgent()
    const cap = (agent.budget?.classifications_per_run as number) || 200
    const batch = emails.slice(0, cap)

    // Process serially to avoid hammering Claude API
    const results = []
    let p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, spam = 0, info = 0, uncat = 0, err = 0
    for (const e of batch) {
      const r = await classifyOne(agent, e)
      results.push(r)
      if (!r.ok) { err++; continue }
      switch (r.priority_bucket) {
        case 'P1_REVENUE_CRITICAL': p1++; break
        case 'P2_ICA_MANAGEMENT': p2++; break
        case 'P3_NEW_TEAM_MEMBER': p3++; break
        case 'P4_CARRIER_PARTNER': p4++; break
        case 'P5_PERSONAL_CRITICAL': p5++; break
        case 'LIKELY_SPAM': spam++; break
        case 'INFORMATIONAL': info++; break
        default: uncat++; break
      }
    }

    // Log a summary event
    await supa.from('event_stream').insert({
      event_type: 'inbox_sweep',
      pillar: 'wealth',
      source: 'agent',
      actor: 'Inbox Agent',
      payload: { processed: batch.length, p1, p2, p3, p4, p5, spam, info, uncat, errors: err }
    }).then(() => {}).catch(() => {})

    return new Response(JSON.stringify({
      ok: true,
      processed: batch.length,
      summary: { p1, p2, p3, p4, p5, spam, info, uncat, errors: err },
      results,
    }), { headers: { ...CORS, 'content-type': 'application/json' } })

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } })
  }
})
