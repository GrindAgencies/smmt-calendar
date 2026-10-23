-- is_in_downline(p_leader, p_target) — made cycle-proof on Supabase 2026-10-23.
--
-- This is the authorisation check for pin (who may vouch for somebody's first PIN), summit-api,
-- org-archive, team-fields, booking-purge, and the DB functions ops_contacts_for and
-- summit_signals. It used to be a `WITH RECURSIVE ... UNION ALL` with no depth cap and no cycle
-- check, so on a cyclic direct_to graph it never terminated.
--
-- The failure was asymmetric, which is what makes it worth writing down. The body is
-- `select exists(...)`:
--   target INSIDE the cycle    exists() short-circuits, answers true immediately
--   target OUTSIDE the cycle   exists() must exhaust an infinite set -> statement timeout
-- So it hung on the DENY path. Measured on a synthetic 3-cycle (X->Y->Z->X) before the change:
-- the recursion produced 500,000 rows and stopped only at an explicit LIMIT; the reachable
-- target returned true at once; the unreachable target was cancelled by statement_timeout.
--
-- THE FIX is UNION instead of UNION ALL — which is what nb_scope_codes already did, and the
-- reason that one was safe. A code can enter the working set only once, so the recursion
-- terminates after at most one pass over the roster however the graph is shaped.
--
-- Results are IDENTICAL on acyclic data: direct_to is single-valued so no code is reachable by
-- two paths, and duplicates cannot change the answer to an exists() anyway. Verified by
-- comparing against an independently written downward walk with an explicit visited-path guard,
-- across every pair involving the six largest leaders: 1,218 pairs, 0 disagreements.
--
-- THE SIGNATURE IS BYTE-IDENTICAL ON PURPOSE. CREATE OR REPLACE with a changed signature adds
-- an OVERLOAD and leaves the old body live and reachable — that has bitten this project before.
--
-- Loops are now also refused at the source by prevent_upline_cycle_trg, and reported by the
-- org_cycles check in health_check(). This function no longer depends on either being present.

create or replace function public.is_in_downline(p_leader text, p_target text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  with recursive dl as (
    select upper(btrim(a.code)) as code
      from tracker_agents a
     where upper(coalesce(a.direct_to,'')) = upper(btrim(coalesce(p_leader,'')))
    union
    select upper(btrim(b.code))
      from tracker_agents b
      join dl d on upper(btrim(coalesce(b.direct_to,''))) = d.code
  )
  select exists (
    select 1 from dl where code = upper(btrim(coalesce(p_target,'')))
  );
$function$;
