-- ======================================================================
-- OPERATIONS SIGN-IN HEALTH CHECK
--
-- Run this BEFORE and AFTER any backend change. Operations losing the
-- ability to sign in has happened before: on 2026-10-14 a shared settings
-- key was emptied to close an auth hole, and four functions read that one
-- list to recognise people, so tickets vanished and the master seat could
-- not get in. Nothing about that outage looked like an auth change.
--
-- Every query here is READ-ONLY. It sets no PIN, mints no session and
-- unlocks nobody. Tokens never leave the server.
-- ======================================================================

-- 1. THE SEATS. Every row must be present; none should be locked.
--    A seat with has_pin=false AND can_enroll=false cannot sign in at all
--    — that is the anti-takeover design, not a fault, but it means nobody
--    can claim that seat until an enrolment window is opened for it.
select code, label, bases, is_master,
       (pin_hash is not null)                                as has_pin,
       (pin_enroll_until is not null and pin_enroll_until > now()) as can_enroll,
       pin_fails,
       (locked_until is not null and locked_until > now())   as locked_now
from ops_accounts
order by code;

-- 2. THE FUNCTIONS behind sign-in. All nine must exist and be SECURITY DEFINER.
select p.proname, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname in ('ops_pin_status','ops_pin_set','ops_login','ops_session_ok',
                    'ops_logout','ops_authorize','ops_scope',
                    'agent_session_code','agent_session_new')
order by p.proname;

-- 3. IS ANYONE ACTUALLY GETTING IN? Recent sign-ins are the real proof.
--    A sudden drop to zero across all seats is the outage signature.
select s.code, a.label,
       count(*)                                                        as sessions_ever,
       max(s.issued_at)                                                as last_signed_in,
       count(*) filter (where s.issued_at > now() - interval '7 day')  as last_7d
from ops_sessions s right join ops_accounts a on a.code = s.code
group by s.code, a.label
order by last_signed_in desc nulls last;

-- 4. THE OTHER DOOR. Christopher reaches Operations as a platform_admin
--    with his ordinary agent session, NOT through an ops_accounts seat.
--    If this returns no row with a PIN set, he is locked out of Ops too.
select a.code, trim(a.first_name||' '||a.last_name) as name, a.platform_admin,
       (p.pin_hash is not null) as agent_pin_set,
       (p.pin_locked_until is not null and p.pin_locked_until > now()) as locked,
       (select count(*) from agent_sessions s
         where s.code = a.code and s.revoked_at is null and s.expires_at > now()) as live_sessions
from tracker_agents a left join agent_pins p on p.code = a.code
where a.platform_admin = true;
