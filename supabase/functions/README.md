# Edge function sources

**The backend had no version control.** All 106 edge functions existed only inside
Supabase. There was nothing to diff against, nothing to roll back to, and no way to
review a change before it went live. On 2026-10-20, patching `newbiz-api` meant first
recovering its source by digging it out of a chat transcript, because that was the only
copy outside the platform.

This directory is the fix. It is **incomplete** — see below.

## Backed up so far

| Function | Version | Verified |
|---|---|---|
| `newbiz-api` | v22 | byte-identical to deployed |
| `hub-sweep`  | v2  | byte-identical to deployed |

**104 functions still have no copy here.**

## Adding one

There is no Supabase CLI on this machine, so the source has to come back through the
MCP `get_edge_function` call and be written out. Two things will bite you:

1. **Verify what you saved is what is deployed.** Do not assume. Compare byte counts
   and diff. The first attempt at this directory silently saved a *different* file —
   a `Read` tool result that had line numbers (`1\t// ...`) baked into every line, and
   the wrong version header. It looked plausible and was completely wrong.
2. **Check the header line and the closing brace.** A truncated source will still look
   fine at a glance. `braces {n}/{n}` balanced and a trailing `});` are quick tells.

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
