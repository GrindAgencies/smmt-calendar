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
