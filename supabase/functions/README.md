# Edge function sources

**The backend had no version control.** All 106 edge functions existed only inside
Supabase. There was nothing to diff against, nothing to roll back to, and no way to
review a change before it went live. On 2026-10-20, patching `newbiz-api` meant first
recovering its source by digging it out of a chat transcript, because that was the only
copy outside the platform.

This directory is the fix. It is **still incomplete** — see below.

## Backed up so far (29 of 106)

| Function | Header says |
|---|---|
| `access-api` | v9 |
| `atlas-api` | v19 |
| `base-brand` | v3 |
| `book-manual` | v1 |
| `booking-purge` | v2 |
| `cal-import` | v5 |
| `calendly-book` | v4 |
| `calendly-sync` | v12 |
| `calendly-webhook` | v3 |
| `desk` | v2 |
| `hub-api` | v21 |
| `hub-files` | v2 |
| `hub-sweep` | v2 |
| `integrity-check` | v2 |
| `leaderboard-api` | v24 |
| `newbiz-api` | v22 |
| `ops-auth` | v1 |
| `ops-directory` | v28 |
| `ops-metrics` | v5 |
| `ops-nbfeed` | v22 |
| `ops-platform` | — |
| `org-api` | v13 |
| `pin` | v11 |
| `profile-api` | v21 |
| `push-register` | v4 |
| `push-send` | v7 |
| `summit-api` | v7 |
| `task-api` | v10 |
| `tracker-api` | v40 |

**77 functions still have no copy here.**

**Two different version numbers, do not confuse them.** The table shows the version in the
file's own header comment — the author's label. Supabase keeps a separate deploy counter,
and they rarely agree (`calendly-book`'s header says v4; Supabase calls the same file
version 5, because the counter increments on every deploy including failed experiments).
When checking whether a backup is current, compare the SUPABASE number from
`list_edge_functions` against the deploy that produced the file — never the header.

## THE TRAP: a stale backup is worse than no backup

Sources can be recovered in bulk two ways, both in the scratchpad: `extract_fns.py` walks
the session transcript, and `extract_persisted.py` walks the `tool-results/` directory,
where any result over ~50KB is written instead of the transcript. The big functions
(hub-api, tracker-api, atlas-api) only ever appear in the second. Both keep the newest
record per function and refuse a Read-tool dump by spotting the `<n>\t` line-number prefix.

A trap inside the trap: in a persisted file the payload is JSON nested inside a JSON
string, so its keys appear ESCAPED (`\"files\"`). A filter looking for the literal
`"files"` silently skips every one of them — which is exactly what happened to
tracker-api on the first run.

**But most of what it recovers is out of date.** On 2026-10-21 it pulled 76 function
sources out of one session; cross-checked against `list_edge_functions`, **59 of them
were behind the deployed version** — some by four releases. Only 17 matched production.

Restoring from one of those would have silently reverted weeks of fixes while looking
completely healthy. So:

> **Never save a recovered source without comparing its version against the DEPLOYED
> version first.** `list_edge_functions` gives the live number; the file header gives
> the recovered one. They must be equal.

That check is the only reason this directory can be trusted at all.

## It has now gone wrong three times

1. The first attempt saved a `Read` tool result with line numbers (`1\t// ...`) baked into
   every line, and the wrong version header. It looked plausible and was completely wrong.
2. The second saved a `summit-api` copy missing its entire 1,858-character "WHO IS CALLING"
   session-auth block. The file parsed, the braces balanced, nothing looked amiss. Deploying
   from it would have removed identity checking from the whole endpoint.
3. The third (2026-10-21) keyed recovered files on their full path. A function's entrypoint is
   sometimes `index.ts` and sometimes `<slug>/index.ts` depending on how it was deployed, so one
   function looked like two and the STALE copy won. Caught only because `calendly-book` and
   `cal-import` were on disk already and could be diffed.

Every one of these was picking the wrong record, not bad parsing. Diff against something
known-good before trusting a recovered file.

## Deploying

Always `verify_jwt: false`. The app sends no auth header; every function does its own
authorisation (a session token via `agent_session_code`, or an Operations token via
`ops_authorize`). Deploying with the default `verify_jwt: true` makes the function
return 401 to the app and look like an outage with no error in the logs.

## What is actually reachable

Of the 106 deployed functions, the front end calls **76** by URL. Of the remaining 30,
some are legitimately driven by cron (`push-send`, `cancel-followups`, `hub-sweep`,
`desk`, `emd-broadcast`) or by an external webhook (`calendly-webhook`).

That leaves a set from two abandoned earlier projects — `twin-*` (9) and `nexus-*` (2) —
which nothing in this app calls. They are still live public endpoints holding
service_role. Probed 2026-10-20 with an empty POST:

| Function | Response | |
|---|---|---|
| `twin-brain` | `400 missing message` | executes if given one |
| `twin-agencypulse` | `200` | executes; leaks a table name in its error |
| `twin-capture` | `200` | would process a transcript |
| `twin-telegram` | `200` | would send messages if configured |
| `twin-health-vision` | `400 photo_id required` | executes if given one |
| `nexus-app` | `200` | serves a full HTML page |
| `twin-cos`, `twin-agent-runner`, `twin-inbox-classify` | `401` | closed |
| `nexus-brain` | `403` | closed |

These were **left alone deliberately**. `personal.config`, "health vision" and Telegram
suggest a personal project rather than TSFG, possibly with its own front end that is not
in this repo. Deleting or locking them is Christopher's call, not an obvious cleanup.

## Schema changes

The project tracks migrations (190+ of them, visible via Supabase's migration history), but
work done through the MCP `execute_sql` tool records **nothing** — same blind spot the edge
functions had. The Road-to-EMD schema went in that way and was back-filled afterwards as
`road_to_emd_20_stage_checks_and_derivation` and `retire_19_stage_ladder_derivation`.

Use `apply_migration` for DDL, not `execute_sql`, and write the SQL so replaying it is a no-op
(`create table if not exists`, `create or replace function`, `add column if not exists`) — the
back-fill above was only safe because every statement was idempotent.
