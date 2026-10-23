# Edge function sources

**The backend had no version control.** All 106 edge functions existed only inside
Supabase. There was nothing to diff against, nothing to roll back to, and no way to
review a change before it went live. On 2026-10-20, patching `newbiz-api` meant first
recovering its source by digging it out of a chat transcript, because that was the only
copy outside the platform.

This directory is the fix. It is **still incomplete** — see below.

## Backed up so far (34 of 106)

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
| `cancel-followups` | v5 |
| `desk` | v2 |
| `ft-tally` | v2 |
| `hub-api` | v21 |
| `hub-files` | v2 |
| `hub-sweep` | v2 |
| `integrity-check` | v2 |
| `leaderboard-api` | v24 |
| `newbiz-api` | v22 |
| `ops-auth` | v1 |
| `ops-directory` | v29 |
| `ops-inforce` | v13 |
| `ops-metrics` | v5 |
| `ops-nbfeed` | v23 |
| `ops-platform` | — |
| `org-api` | v13 |
| `pin` | v11 |
| `profile-api` | v21 |
| `push-register` | v4 |
| `push-send` | v7 |
| `summit-api` | v7 |
| `task-api` | v10 |
| `team-board` | — |
| `tracker-api` | v40 |
| `trainer-scope` | v4 |

**72 functions still have no copy here.**

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

## Four INFORCE lists. Three must agree; the fourth must NOT.

A policy is in exactly one of three places — pipeline, in force, or dead — and three functions
each carry their own copy of what that means. They have drifted before (`ops-nbfeed` v18 is the
standing reminder: a leak happened because two copies disagreed about scope). Verified
2026-10-21, all three identical:

| | INFORCE |
|---|---|
| `ops-inforce` | `["paid"]` |
| `ops-nbfeed` | `["paid"]` |
| `ops-metrics` | `["paid"]` |

`DEAD` is likewise identical in `ops-nbfeed` and `ops-metrics`:
`["declined","cancelled","incomplete","closed","lapsed"]`.

**`leaderboard-api` deliberately disagrees**, and must keep disagreeing:

```
const INFORCE = ["paid", "funds_received", "policy_issued", "premium_drafted"];
```

It is used at exactly one site — the Families Helped calculation — and it answers a different
question. A family has been *helped* once their policy is on the books; whether the carrier has
paid the commission out yet is irrelevant to them. Narrowing this to `["paid"]` to "make the
four match" would silently drop every issued-but-not-yet-paid household out of Families Helped.
Check the use site before touching the list.

## The commission formula lives in four places too

`newbiz-api`'s `expCommOf()` is canonical and says the rule in its own comment: **a missing
partner rate contributes nothing, and must never inherit the writer's**. Verified 2026-10-21
against `ops-nbfeed`, which had the opposite (`pr = partner_contract_pct ?? wr`) and was
corrected in v23. `leaderboard-api` and `ops-metrics` both already treated an absent partner
rate as nothing.

If you touch commission maths, diff all four.

## Who credits a SPLIT policy, and who does not

A split policy has two agents. Any figure that credits a PERSON must divide it; any figure that
totals a BOOK of business must not. Audited 2026-10-21 across every backed-up function that
reads `annual_premium`:

| Function | Per-agent? | Split-aware | |
|---|---|---|---|
| `leaderboard-api` | yes | yes | |
| `newbiz-api` | yes | yes | |
| `ops-metrics` | yes | yes | credits each side to its own baseshop |
| `ops-nbfeed` | yes | yes | fixed in v23 |
| `ops-inforce` | **no** | no | correct — it totals the policies on screen, not people |
| `ops-directory` | yes | yes | fixed in v29 |
| `team-board` | yes | **NO** | **dead code**, see below |

`ops-directory` was the live outlier until v29. Christopher decided it on 2026-10-21 —
"operations tracker, split as normal" — so the Tracker now divides like every other per-agent
figure. Verified against all 137 agents after deploying: zero mismatches.

**An empty string is not a partner.** Three agents appeared to disagree in that check until the
cause was found: `split_agent_code` is sometimes `''` rather than NULL, and SQL's `IS NOT NULL`
treats empty as a real partner while the functions' `norm()` test treats it as absent. The
FUNCTIONS are right and consistent — leaderboard-api and ops-directory both credit the writer in
full when no partner is recorded. Any query written to audit this must test for a non-empty
code, not merely a non-null one.

`team-board` is **retired**. `index.html` stopped calling it (its comment: it "duplicated the
ranking and capped it at 10 without zeros, so it drifted from the other tabs") and the dead `TB`
constant has now been removed so nothing can be re-wired to it by accident. The endpoint is still
deployed and still split-blind; deleting it is Christopher's call, like the `twin-*` set.

## Booking status and "what counts as a field training" — audited, no drift

`bookings.status` has exactly ONE spelling of each value in live data (checked 2026-10-21):
`completed` 1161, `canceled` 425 (one L), `booked` 39, `confirmed` 14, `no_show` 5,
`declined` 4, `pending` 1. `cancel-followups` querying `in.(canceled,cancelled)` is harmless
belt-and-braces, not evidence of a second spelling.

The functions filter that vocabulary differently, and every difference checked out as
deliberate rather than drift:

| Function | Filter | Why it is right |
|---|---|---|
| `atlas-api` reminders | `in.(booked,confirmed)` | never remind about a booking the trainer has not approved |
| `atlas-api` availability | `in.(booked,confirmed,pending)` | a pending booking still blocks the slot |
| `leaderboard-api` | skips canceled/declined/no_show/pending | a competition counts trainings that happened |
| `ops-directory` | hides canceled/declined only | an Ops seat wants to see its own no-shows |

**"Field training" is defined twice, and they agree — for now.** `leaderboard-api` matches
`category ILIKE '%field%training%'` (both words, in order); `ft-tally` matches
`field` OR `training`. Across all 512 field-training bookings the two select exactly the same
rows, so there is no divergence today — but a future category called "Phone Zone Training" or
"Onboarding Training" would be counted by `ft-tally` and not by the leaderboard. Worth knowing
before adding a category with the word "training" in it.

Both lists also carry a `"transferred"` status that has never existed in the data; harmless.

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

## All 106 backed up — 2026-10-21

Every edge function deployed to bmfqxtocxkjhsgfnndlo now has its source here,
and each copy was version-checked against what is actually running before it
was written. 98 matched their fetched version exactly; the other 8 are files
edited and redeployed during the sweep itself, where the repo copy is the newer
source (i18n-api v4, ops-bot v6, ops-import v4, plus newbiz-api v22,
ops-directory v29, ops-nbfeed v23, summit-api v7, cal-import v5 from earlier).

### The trap this sweep walked into

A later pass of the recovery script wrote the PRE-FIX fetched source back over
three functions that had just been patched and deployed. Production kept the
fix; the repo silently lost it, and a restore from here would have reopened two
auth holes. It was only caught by auditing the saved copies against the live
version list rather than trusting that a file existed.

The script now refuses to overwrite any function directory with uncommitted
local changes, and reports them as PROTECTED. The rule is the same one that
governs the whole exercise: **a backup that is quietly older than production is
worse than no backup**, and that includes being older than your own working
tree.

### Multi-file functions

Four functions are more than one file and must be restored whole:
nexus-app (index.ts, shell.ts, icons.ts), plus atlas-api, hub-api and
tracker-api whose entrypoints sit under a nested path.

### Where the large sources come from

A `get_edge_function` result over ~50KB is written to the SESSION-scoped
tool-results directory as a .txt, not to the project-level one. The extractor
has to scan both; nexus-app and nexus-brain were invisible until it did.

## The one bug class — and a scanner for it (2026-10-21)

Every auth hole found on this platform is the same mistake: deciding WHOSE data to
serve or write from a value that arrived in the request. A GFI agent code is printed
on the org chart; a four-digit Ops seat code is typed on a sign-in screen every
morning. Neither is a credential. The only proofs are `agent_session_code(p_token)`,
`ops_authorize(p_token)`, and the PIN checked server-side (`pin_verify`).

`ops/scan-identity.py` sweeps all 106 backed-up sources for it. Run it after adding
any endpoint. It strips comments first — every fix here is documented above the code
it fixed, so without that every *fixed* function reports as broken.

**It is a review aid, not a verdict.** It cannot see which branch guards which read,
so every OPEN / OPS-ONLY row must be read by a person and probed live before anything
changes. It was validated against five fixtures with known answers before being
trusted: the pre-fix ops-import (OPEN), ops-bot and roadmap-outcome (OPS-ONLY), and
mktg-team and pfr-api (OK). The first attempt at that validation silently fetched
whole-commit diffs instead of sources and "passed" all five — the scanner had never
actually been tested. Check your fixtures.

### Closed tonight
| function | was | damage |
|---|---|---|
| i18n-api v4 | literal `"2026"` | rewrite any UI label for every Spanish-speaking agent |
| ops-import v4 | bare seat code | replace a seat's whole ticket board |
| ops-bot v6 | bare seat code | whole book of business; create tasks; kill automations |
| roadmap-outcome v5 | nothing at all | read any broker's history; slide their tracker backwards |
| book-manual v2 | nothing at all | plant appointments on anyone's calendar, and block their slots |
| cal-feed v6 | any non-empty string | 2000 company bookings incl. client emails and phones |

### A server fix can break a client that has not shipped yet
cal-feed v5 required a session the LIVE client does not send, because the other half
of the fix is in `session.js` — a client file served from GitHub Pages, which runs
whatever was last pushed. Every request answered 401 + `needs_session`, and session.js
reacts to that by clearing the session AND `tsfg_code` and redirecting to sign-in. For
a few minutes, opening the Scheduler signed you out.

v6 is the shim: no session gets an empty, successful answer — never a 401 — so nobody
is bounced and no data leaves. **Remove the shim once session.js is pushed.** The
lesson generalises: before tightening a function, check whether the matching client
change is already live, and if it is not, fail SOFT rather than with the flag that
logs people out.

### Still open, on purpose
- **avatar** — unauthenticated by design; an `<img src>` cannot carry a token and the
  exposure is one profile photo. Reasoning is recorded in the file and expires if it
  ever returns more than the photo.
- **ops-bot's leader branch** — a typed EMD code still works, because it mirrors
  ops.html's own code+name leader login. Closing it means leaders use a PIN.
- **cal-feed's breadth** — every signed-in agent still receives every shop's bookings
  with client contact fields; calendar.html filters client-side. Scoping it changes
  what the dashboard shows, so it needs a decision.
- **11 OPS-ONLY rows** from the scanner, unreviewed.

## The identity sweep is finished (2026-10-22)

`ops/scan-identity.py` started at 5 OPEN / 12 OPS-ONLY. Every row is now resolved:

**Closed** — each verified open before the change and refused after, with the data checked
afterwards to confirm the probes wrote and deleted nothing:

| function | what a typed code bought you |
|---|---|
| i18n-api v4 | rewrite any UI label, for every Spanish-speaking agent |
| ops-import v4 | replace an Ops seat's whole ticket board |
| ops-bot v6→v7 | the whole book of business; create tasks; kill automations |
| roadmap-outcome v5 | read any broker's history; slide their tracker backwards |
| book-manual v2 | plant appointments on anyone's calendar, and block their slots |
| cal-feed v6→v8 | 2000 company bookings incl. client emails and phones |
| booking-purge v5→v6 | permanently delete anyone's appointment; read any appointment |
| coaching v5 | read anyone's private feedback; write under a trainer's byline |
| bots-cron v9 | rewrite what the bots post into every team's channel |
| calendly-sync v15 | **repoint someone's public booking link at your own calendar** |
| google-oauth v5 | **link your Google account to someone else's trainer record** |

**Reviewed and correct, left as they are** — the scanner flags these because they read a
request identifier somewhere, not because it is trusted:

- `cancel-followups`, `ft-tally`, `ops-tracker` — one `ops_authorize` gate at the top, before
  anything. The identifiers they read afterwards are internal, not callers.
- `push-api` — only `health` is open, and it reveals just whether push is configured.
- `ops-platform` — only `login` is open. It is an enumeration oracle and the file now says so,
  but a seat code opens nothing any more, so what it leaks is a label rather than a key.
- `avatar` — unauthenticated by design: an `<img src>` cannot carry a token and the response is
  one profile photo. The reasoning is in the file and expires if it ever returns more.

### Two of these had never been used
`coaching_notes` and `google_connections` are both empty. Those holes were real and live, but
nothing had flowed through them — they were closed before the features were used. Say that
plainly rather than counting them alongside cal-feed, which was leaking real client contact
details at the moment it was found.

### Closing the breadth, not just the door (cal-feed v8)

The first seven versions of `cal-feed` fixed *who may call it*. v8 fixes *what the caller gets*,
which is the half I had twice flagged and left alone:

- **Scoped by baseshop.** `agent_scope()` is the platform's one answer to "which shops may this
  person see", and the feed now uses it. A row survives when the caller is a party to it, or when
  **either** side's baseshop is in their scope — either side, because cross-baseshop bookings are
  deliberate and both participants must keep seeing them.
- **Client email and phone only on your own rows.** Exactly one consumer reads them,
  `clientBookings()` in `calendar.html`, and it already filters to your own bookings first. Every
  other row was carrying a client's contact details for no reader at all.

**Measured both ways before deploying, because a narrowing fix can break a screen as easily as a
widening one.** The two accounts that resolve to `all:true` keep the full company view, unchanged.
A TITANS agent went from receiving all 12 October SUMMIT bookings — 7 of them carrying a client
email — to 0 rows. A real scoped session returns `scoped:true` with zero client emails; the probe
session was deleted afterwards and the table re-checked.

Checked first, and the reason the filter matches on **code OR name**: 7 of the 1,120 bookings that
carry a client email have a `trainer_name` but no `trainer_code`. Matching on code alone would
have silently emptied those from that trainer's own Clients tab — a fix that quietly deletes
someone's client list is worse than the leak.

Also checked before narrowing: **nothing uses this feed for conflict detection**, so it cannot
cause a double-booking. Its four consumers are the month/day grid, a lookup by an id already on
screen, the Calendly-overlay dedupe and the Clients tab. That audit turned up a separate dead
line — `bookedCalendlyUuids()` matches `calendly_event_uuid`, which the function never selected,
so half that dedupe had always compared `undefined` to `undefined`. The column is in the select
list now.

### ACCEPTED, so that OPEN means something

`ops/scan-identity.py` reported `avatar` as OPEN on every run, correctly and permanently. A known
hole that never clears is how a new one hides, so a function that cannot carry a session **by
construction** may now declare itself with the phrase `ACCEPTED AS UNAUTHENTICATED, DELIBERATELY`
above its reasoning, and is reported as ACCEPTED instead.

Accepted is not hidden: those rows print in their own section every run, to be re-read beside the
new findings rather than fading into a passing count. The phrase is searched in the raw source
rather than the comment-stripped code — the one place in that script where the distinction is
deliberate instead of the bug it was the first time.

The scanner now reads: **OPEN=0, OPS-ONLY=5, ACCEPTED=1, OK=57, n/a=43** across all 106 functions,
and `ops/verify-ops-endpoints.sh` holds 25 live probes, including that the dead `2026` master key
buys nothing from the company feed and that **public booking still works**.

### booking-purge v6 — the flag understated the bug

v5 closed the typed-identity hole and then flagged what it had left: *"any MD or EMD may delete
any appointment in the company, not only one belonging to their own team."* That was true and
also too kind to the code. The test was `contract_level IN ('MD','EMD')` — an **exact** match on
an abbreviation, against a **free-text commission field** whose values are not written
consistently. So it over-granted and under-granted simultaneously:

| person | field | could delete |
|---|---|---|
| Edgar Zavala | `contract_level "MD"`, no title | **all 1,653 appointments** |
| Elijah Cox | the **org root**, EMD by title, `contract_level "National Vice President"` | **none** |
| Christopher | `contract_level "Marketing Director"` | none — only `platform_admin` rescued him |

The standing rule is that `title` is the **leadership** rank and `contract_level` is what somebody
is **paid** at, and the two must never be conflated. This function conflated them, which is how
the org root ended up with no delete rights while an MD held rights over every baseshop.

The fix is **not** swapping one field for the other — 126 of 203 records have no `title`, so
`title` alone would have stripped a real MD. v6 reads both, tolerantly, and makes the **downline
test mandatory**. Generous about who counts as a leader, strict about whose appointments they may
touch: the strictness that matters lives in `is_in_downline()`, and nothing skips it.

Who may delete now: Operations; `platform_admin`; anyone `agent_scope()` answers `all:true` for
(which is how the org root qualifies — by the one scoping rule, not a special case); either party
to the appointment; and a leader, over their **own downline**.

**Preview is gated identically**, because per-appointment it was gated by nothing: any signed-in
person holding an id could read that appointment's agent, trainer, category, date and time. You
may preview what you could delete — preview exists only as the confirm step before deleting, so
the two rights are one right.

Measured before changing, which is what made it safe to change: all 1,653 appointments resolve to
a real agent code on at least one side, so the rule can always be evaluated and no fail-open
clause was needed — the v5 worry that narrowing "would refuse deletions that work today" was
unfounded. Each of the 8 leaders could delete all 1,653; under the downline rule they hold between
0 and 8. The feature has been used **once in its life**, by an Associate, through the pre-v2 hole.

Verified live with `preview` only, never `delete`:

| probe | result |
|---|---|
| no session | `needs_session` |
| a signed-in non-party, someone else's appointment | **403, refused** (was readable) |
| `platform_admin` / org root, same appointment | `ok:true` — not locked out |
| the dead `2026` master key | `needs_session` |

Afterwards: 1,653 bookings still present, 1 tombstone (the historical one), the probe target
intact, every minted verification session deleted. A probe against a destructive endpoint has to
prove it destroyed nothing.

### email-sender v5 — the queue was a loaded gun aimed at clients

Appointment email/SMS has been "queued until a provider is wired" since July. The queue was not
dormant, it was **rotting**, and `email-sender` sent whatever was `queued`, oldest first, with no
check that the message was still true. Setting `RESEND_API_KEY` was the only thing standing
between real clients and a mailshot about meetings that already happened.

Measured on 2026-10-22, 28 messages queued:

| messages | what they say | reality |
|---|---|---|
| 7 | "your appointment is tomorrow" | appointment already past |
| 7 | "your appointment is in an hour" | appointment already past |
| 8 | confirmations | appointment already past |
| 2 | more reminders | appointment already past |
| 4 | still in the future | **the booking was CANCELLED** |

The last row is the one a time check alone would have missed, and it is the worst: two of those
four are "your appointment is tomorrow" reminders for a meeting that was called off, which would
have arrived next to the cancellation notice for the same meeting. **Of 28 queued messages the
correct number to send is 2** — the two cancellation notices.

So v5 adds a staleness guard, which runs *before* the provider is consulted and therefore applies
on the very first drain:

- appointment already started → `stale`
- appointment cancelled / declined / no-showed → `stale` (matched on both `cancelled` and
  `canceled`, because this table spells it with one L and trusting one spelling is how this class
  of bug survives)
- no appointment attached and older than 7 days → `stale`
- **cancellations are exempt from all of it** — "that meeting is off" does not expire the way "it
  is tomorrow" does, and it is the one message a cancelled booking *should* still send

Marked, not deleted: the next person needs to see that 26 messages were suppressed and why, which
an empty table would not tell them. `isStale()` takes a message rather than being inlined, because
the SMS sender that does not exist yet needs this same test and must not reinvent it.

`{"action":"status"}` now reports the split before anything is sent, verified live:

```
queued 28  ·  email 21 / sms 7  ·  stale 26  ·  would_send 2
"26 of 28 queued messages are no longer true and would be marked stale, not sent."
```

Still true, and still the blocker: **this function is on no cron schedule**, so the queue is never
drained even once the key exists. Both halves are needed, and the header says exactly how.
