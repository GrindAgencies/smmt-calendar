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
