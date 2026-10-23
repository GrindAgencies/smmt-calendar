-- prevent_upline_cycle() + prevent_upline_cycle_trg — applied to Supabase 2026-10-23.
--
-- THE HOLE. profile-api's save_contact lets any signed-in agent set their OWN direct_to to any
-- code that resolves, and resolve_agent_ref's p_exclude rules out only the caller themselves.
-- Nothing ruled out a DESCENDANT, so an agent could point their upline at someone already below
-- them and close a loop in the org chart. direct_to is the single source of truth that every
-- team, baseshop and downline query walks, so a loop is not a cosmetic data error.
--
-- The two existing triggers did not cover it:
--   validate_upline_exists    only checks the upline EXISTS, and explicitly early-returns on a
--                             self-upline (`if up = btrim(new.code) then return new`)
--   protect_org_root_upline   only guards the hierarchy root
--
-- WHAT A LOOP BROKE. is_in_downline() was an unguarded `WITH RECURSIVE ... UNION ALL`. Measured
-- on a synthetic 3-cycle: 500,000 rows and still going, stopped only by an explicit LIMIT. And
-- because the body is `select exists(...)` the failure was asymmetric — a target inside the
-- cycle short-circuited to true at once, a target outside it was cancelled by statement_timeout.
-- It hung on the DENY path, in the function that authorises pin, summit-api, org-archive,
-- team-fields, booking-purge, ops_contacts_for and summit_signals.
-- See is_in_downline.sql for that half of the fix.
--
-- VERIFIED BEFORE APPLYING: 0 cycles and 0 self-uplines across all 203 roster rows, deepest
-- chain 6. So this rejects no existing row, and no existing row becomes un-editable.
--
-- VERIFIED AFTER, inside a transaction that was rolled back (chain H1619 -> H3511 -> H4719):
--   self-upline              refused
--   direct child as upline   refused
--   grandchild as upline     refused   (the multi-hop walk works)
--   legitimate re-parent     allowed   (grandchild moved up under the leader)
--   phone-only edit          allowed   (UPDATE OF direct_to, so ordinary edits never pay for it)

create or replace function public.prevent_upline_cycle()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  me   text := upper(btrim(coalesce(new.code, '')));
  up   text := upper(btrim(coalesce(new.direct_to, '')));
  cur  text;
  hops int := 0;
  nm   text;
begin
  if up = '' or me = '' then return new; end if;

  if up = me then
    raise exception
      'Refusing to make % their own upline. Every team and baseshop is worked out by walking direct_to upward, so a person cannot be their own leader.', me
      using errcode = 'check_violation';
  end if;

  -- Walk upward from the PROPOSED upline. Reaching this person means the new edge closes a loop.
  -- hops is a backstop only: if the data above `up` is already cyclic this exits rather than
  -- spinning, and the org_cycles health check is what reports that separately.
  cur := up;
  while cur is not null and cur <> '' and hops < 200 loop
    if cur = me then
      select btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
        into nm from tracker_agents where upper(btrim(code)) = up limit 1;
      raise exception
        'Refusing to set %''s upline to % (%): that person is already BELOW them in the org chart, so this would close a loop. Scoping walks direct_to upward, so a loop makes team, baseshop and downline checks recurse until they time out. Move the other person first if this is a real restructure.',
        me, up, coalesce(nullif(nm, ''), 'name unknown')
        using errcode = 'check_violation';
    end if;
    select upper(btrim(coalesce(direct_to, ''))) into cur
      from tracker_agents where upper(btrim(code)) = cur limit 1;
    hops := hops + 1;
  end loop;

  return new;
end
$function$;

drop trigger if exists prevent_upline_cycle_trg on public.tracker_agents;
create trigger prevent_upline_cycle_trg
before insert or update of direct_to on public.tracker_agents
for each row execute function public.prevent_upline_cycle();

-- STILL OPEN, deliberately: profile-api's save_contact reports this as a bare {ok:false} with no
-- message, because it returns the PATCH's ok flag and nothing reads the trigger's text. The save
-- is correctly refused — the person just is not told why. Fold the message in on the next
-- functional deploy of profile-api rather than retyping 30KB for a wording fix.
