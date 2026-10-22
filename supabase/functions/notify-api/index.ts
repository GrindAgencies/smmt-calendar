// notify-api v5 (2026-09-30) — the bell: read your notifications, and mark them read.
//
// WHOSE BELL. v1 built its recipient filter straight from a `name` and `code` in the request, so
// anybody could read anybody's notifications by typing their name — and names are on the org chart.
// That is not a trivial feed: it carries sale alerts with client names and commission figures,
// booking details, approval decisions and message notifications. `read` and `readall` could also
// silently mark a colleague's whole bell as read, so they would never see it.
//
// Identity is now the session token minted at PIN entry. The recipient filter still matches on
// NAME or CODE, because notifications are addressed both ways depending on which trigger wrote
// them — but both halves are now derived from the verified session, not from the request.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

// Build the recipient-match OR filter. Name match is case-insensitive exact
// (ilike with no wildcards); code is a secondary exact match.
function recipientFilter(name: string, code: string): string | null {
  const parts: string[] = [];
  const n = (name || '').trim().replace(/[,()*]/g, '');
  const c = (code || '').trim().replace(/[,()*]/g, '');
  if (n) parts.push(`recipient_name.ilike.${n}`);
  if (c) parts.push(`recipient_code.eq.${c}`);
  return parts.length ? parts.join(',') : null;
}

/* Proof of identity, and the name that goes with it. A session token is proof; a typed name is not. */
async function whoAmI(session: unknown, opsToken: unknown, askedCode: unknown, askedName: unknown) {
  const t = String(opsToken ?? '').trim();
  if (t) {
    const { data: az } = await sb.rpc('ops_authorize', { p_token: t });
    if (az && (az as any).ok) {
      // Operations may look at a named person's bell, for support.
      return { code: String(askedCode ?? '').trim().toUpperCase(), name: String(askedName ?? '').trim(), ops: true };
    }
  }
  const s = String(session ?? '').trim().slice(0, 120);
  if (!s) return { code: '', name: '', ops: false };
  const { data: got } = await sb.rpc('agent_session_code', { p_token: s });
  const code = (typeof got === 'string') ? got.trim().toUpperCase() : '';
  if (!code) return { code: '', name: '', ops: false };
  const { data: rows } = await sb.from('tracker_agents').select('first_name,last_name').eq('code', code).limit(1);
  const a = (rows || [])[0] as any;
  const name = a ? `${a.first_name || ''} ${a.last_name || ''}`.trim() : '';
  return { code, name, ops: false };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let p: any = {};
  try { p = await req.json(); } catch (_e) { p = {}; }
  const action = String(p.action || 'list');

  try {
    const me = await whoAmI(p.session, p.token, p.code, p.name);
    if (!me.ops && !me.code) return j({ needs_session: true, error: 'Please sign in again.', items: [], unread: 0 }, 401);
    const filter = recipientFilter(me.name, me.code);
    if (!filter) return j({ items: [], unread: 0 });

    if (action === 'list' || action === 'unread') {
      const { count } = await sb
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .or(filter)
        .is('read_at', null);
      if (action === 'unread') return j({ unread: count || 0 });

      const { data, error } = await sb
        .from('notifications')
        .select('*')
        .or(filter)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return j({ error: error.message }, 400);
      return j({ items: data || [], unread: count || 0 });
    }

    if (action === 'read') {
      const id = Number(p.id || 0);
      if (!id) return j({ error: 'missing id' }, 400);
      const { error } = await sb
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .or(filter);
      if (error) return j({ error: error.message }, 400);
      return j({ ok: true });
    }

    if (action === 'readall') {
      const { error } = await sb
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .is('read_at', null)
        .or(filter);
      if (error) return j({ error: error.message }, 400);
      return j({ ok: true });
    }

    return j({ error: 'unknown action' }, 400);
  } catch (e) {
    return j({ error: String(e && (e as Error).message || e) }, 500);
  }
});
