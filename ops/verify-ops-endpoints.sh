#!/bin/sh
# Every Operations endpoint must answer 401 to a bad token.
# A 400 "unknown action" is NOT an auth failure — it means the token was
# accepted and only the action name was wrong. A 200 to a bad token would be
# the real alarm.
U=https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1
for f in ops-nbfeed ops-directory ops-inforce ops-metrics ops-newbiz ops-fieldtraining ops-auth; do
  printf '  %-20s ' "$f"
  curl -s -o /dev/null -w '%{http_code}' -X POST "$U/$f" \
    -H 'Content-Type: application/json' \
    -d '{"action":"nb_list","token":"not-a-real-token"}' --max-time 20
  printf '  <- expect 401 (ops-auth: 400, it has no token action)\n'
done

# ---- bare-code doors, closed 2026-10-21 (ops-import v4, ops-bot v6) --------
# These two took a four-digit seat code straight out of the request as proof of
# identity. There are six seat codes and staff type theirs every morning, so a
# regression here is not a theoretical one. Every seat must be refused.
echo
echo "Bare seat-code doors (must all be REFUSED):"
for c in 0000 0001 0002 0003 0004 0005; do
  r=$(curl -s -X POST "$U/ops-bot" -H 'Content-Type: application/json' \
        -d "{\"action\":\"get_knowledge\",\"code\":\"$c\"}")
  case "$r" in
    *'"ok":true'*) echo "  ops-bot    $c  *** OPEN — REGRESSION ***" ;;
    *)             echo "  ops-bot    $c  refused" ;;
  esac
done
r=$(curl -s -X POST "$U/ops-import" -H 'Content-Type: application/json' -d '{"action":"preview","code":"0002"}')
case "$r" in
  *'Sign in to Operations'*) echo "  ops-import 0002  refused" ;;
  *)                         echo "  ops-import 0002  *** OPEN — REGRESSION *** $r" ;;
esac

# ---- unauthenticated endpoints closed 2026-10-21 ---------------------------
# Four functions decided WHOSE data to serve or write from a value in the request
# body, with no credential at all. Each was verified open before the fix and
# refused after; these checks stop any of them regressing silently.
echo
echo "Unauthenticated-access doors (must all be REFUSED / EMPTY):"
chk() {  # chk <label> <curl-output> <pattern-that-means-SAFE>
  case "$2" in
    *"$3"*) echo "  $1  ok" ;;
    *)      echo "  $1  *** REGRESSION *** $2" ;;
  esac
}
chk "roadmap-outcome record " "$(curl -s -X POST "$U/roadmap-outcome" -H 'Content-Type: application/json' -d '{"action":"record","code":"C1991","level":"x","choice":"y"}')" 'needs_session'
chk "roadmap-outcome events " "$(curl -s -X POST "$U/roadmap-outcome" -H 'Content-Type: application/json' -d '{"action":"events","code":"C1991"}')" 'needs_session'
chk "book-manual create     " "$(curl -s -X POST "$U/book-manual" -H 'Content-Type: application/json' -d '{"action":"create","code":"C1991","title":"t","date":"2026-12-31","time":"9:00 AM"}')" 'needs_session'
chk "book-manual delete     " "$(curl -s -X POST "$U/book-manual" -H 'Content-Type: application/json' -d '{"action":"delete","code":"C1991","id":"x"}')" 'needs_session'
# cal-feed must answer EMPTY (not 401 — a 401 here signs people out; see cal-feed v6).
CF=$(curl -s "$U/cal-feed?action=company_events&code=x&from=2026-10-01&to=2026-10-31")
case "$CF" in
  *'"events":[]'*) echo "  cal-feed company_events  ok (empty, no client PII, no sign-out)" ;;
  *'client_email'*) echo "  cal-feed company_events  *** REGRESSION — LEAKING CLIENT PII ***" ;;
  *'needs_session'*) echo "  cal-feed company_events  *** WRONG SHAPE — a 401 here signs agents out ***" ;;
  *) echo "  cal-feed company_events  unexpected: $CF" ;;
esac
# i18n-api's content override must stay Ops-only.
chk "i18n-api set_override  " "$(curl -s -X POST "$U/i18n-api" -H 'Content-Type: application/json' -d '{"action":"set_override","token":"2026","en":"x","es":"y"}')" 'unauthorized'
