# tsfg.app — platform audit, 29 Sep 2026

Audited against **production** (138 people, 214 policies, ~100 edge functions, 24 pages).
Everything below was verified by probing the live system or querying the live database, not inferred
from code. Where I state a number, I ran it.

Read this before adding features. Items P0-1 to P0-3 get worse, not better, with more surface area.

---

## P0 — Close these before building anything else

### 1. The string `2026` is still a master key, and it is published in the app

Sending `{"token":"2026"}` to a live endpoint — **no sign-in, no session, no PIN, from anywhere on
the internet** — currently returns:

| Endpoint | What it hands over |
|---|---|
| `ops-directory` | all 138 people: name, **phone, personal email**, state |
| `hub-roster` | all 138 with upline structure |
| `ops-inforce` | the entire book of business ($540,228 AP) |
| `ops-newbiz`, `ops-nbfeed` | every New Business ticket, client names, statuses |
| `org-api` | full org tree, 189 incl. departed, `can_edit_hierarchy: true` |
| `task-api` | everyone's tasks |
| `hub-ops` | Operations access to Team Hub (`role: ops`, `mod: true`) |
| `summit-api` | `can_manage: true`, `can_set_standards: true` |
| `bot-admin` | `can_edit: true` |
| `team-fields` | `can_define: true`, `admin: true` |
| `ops-fieldtraining`, `leaderboard-api`, `desk`, `integrity-check`, `base-brand`, `present-api`, `ops-statecolors` | read |

`bots-cron` also **executed** an announcement run for me, and `push-api` attempted a send.

It is not even a guess: the token is written into pages people download.
- `teamhub.html:351` — `?ops=1` in the URL sets `OPSTOKEN = '2026'`
- `roadmap-builder.html:114` — typing `0000` or `2026` at the gate sets `TOKEN = '2026'`

**Why it is still on:** `ops_authorize()` accepts it only while
`app_settings.legacy_ops_token_allowed = true`. That is the whole gate — one row.

**Fix.** Flipping the flag closes all of it with no redeploys, but it breaks the two callers above.
So do it in this order:
1. `ops.html` already holds a real Operations session (`opsTok()`). Hand that to the Team Hub iframe
   via `sessionStorage` — **not** the query string, which ends up in logs and history — and have
   `teamhub.html` read it when `?ops=1`. Both pages are same-origin, so the iframe shares it.
2. Give `roadmap-builder.html` the same Ops sign-in as the other Ops pages.
3. Set `legacy_ops_token_allowed = false`.
4. Re-run the probe table above and confirm every row returns `unauthorized`.

Correctly protected already, for reference: `ops-import`, `profile-api`, `emblem-api`,
`emd-broadcast`, `goals-api`, `ops-platform`.

### 2. 98 of 133 active accounts can be claimed by anyone who knows the code

`pin_set(code, pin)` requires three things: the code exists, the account is not `denied`, and **no
PIN is set yet**. It never checks that you are that person.

- **98 active agents have no PIN** — including **2 MDs/EMDs**. Only 35 are protected.
- Agent codes are not secret: they are on the org chart, the roster and the leaderboard — and
  finding #1 hands out all 138 of them to an anonymous caller.
- First person to set a PIN becomes that agent. The real agent then gets
  *"A PIN is already set. Ask Operations to reset it."*

This lands hardest on exactly the people onboarding at launch, who have never signed in.

**Fix — pick one:**
- Require a second fact at first PIN-set that only the real person knows and that is already on
  their record (phone last-4 or date of birth), or
- have Ops issue a one-time setup code (the upline-approval flow already exists — reuse it), or
- at minimum, require `access_status = 'approved'` **and** a matching phone/email to set a first PIN.

Whatever you choose, the 98 open accounts need a decision now, not after launch.

### 3. The API accepts an agent code as proof of identity

Sending someone else's `code` with no PIN and no session returns, as them:

| Endpoint | Result |
|---|---|
| `tracker-api` `load` | their full tracker and progress |
| `goals-api` `get` | their goals, with **`can_edit: true`** |
| `task-api` `list` | their tasks |
| `summit-api` `board` | their Road to EMD ladder |
| `org-api` `tree` | their org scope |

I confirmed the reads. I did **not** exercise a write against a real person's record — but
`can_edit: true` is the server telling the caller it would accept one.

**The good news:** scoping still holds. An ELEVATE code got ELEVATE scope only, with
`can_edit_hierarchy: false`. The baseshop walls are sound; it is the identity layer that is missing.

**Fix.** Issue a signed session token at sign-in and require it on every endpoint that takes a
`code`. The pattern already exists for Operations seats (`ops_sessions`, `ops_authorize`) — extend
the same shape to agents rather than inventing a second one.

---

## P1 — Money and data correctness

| # | Finding | Count | Consequence |
|---|---|---|---|
| 4 | Paid policies with no `paid_out_date` | **38** | invisible to Points Paid and every by-period metric |
| 5 | `split_flag` set, no partner named | **12** | partner credited nothing |
| 5b | Partner named, `split_flag` not set | **4** | split not recognised |
| 5c | `split_pct` set with no partner | **14** | percentage without a person — the exact mismatch that has misattributed commission before |
| 6 | No premium recorded | **16** | cannot earn commission; deliberately left null rather than zeroed |
| 7 | Duplicate policy numbers | **6** | incl. `TBD` ×3, `9855486`, `LB30027300`, `LB09350487`, `LB09342246`, `4260101243` |
| 8 | Upline that does not exist (`H4421`) | **2** | `H7584`, `H8345` — they read as placed but dangle |

None of these are new code defects; they are data that needs an owner. Operations can clear 4-7 from
the existing screens. #8 needs an upline set.

---

## P2 — Reliability

**9. Stuart's 10-minute reminder can never fire.** `bots-cron` matches offsets 60/30/10/0 minutes
within ±2 minutes, but the cron job runs every **30** minutes, so it only ever ticks at :00 and :30.
A 6 PM session gets the 60-minute, 30-minute and live reminders and never the 10-minute one.
Three job names also contradict their schedules — `stuart-announce-5min` runs every 30 min,
`task-automations-15min` every 30, `cancel-followups-15min` hourly. Either run the job every 5
minutes as its name claims, or drop the 10-minute offset so the schedule and the code agree.

**10. Unguarded DOM writes, confirmed hitting real users.** From `app_errors`:
- `profile.html` — `$('profBody').innerHTML` at lines 170 and 204 with no null check: **14 recorded
  errors**. Line 755 does guard it, so the pattern is known, just not applied consistently.
- `calendar.html` — same shape, 3 errors.
- `teamhub.html` — unhandled promise rejection on a failed fetch, 5 errors.

**11. The Scheduler's realtime has never worked — fixed today.** `calendar.html`'s anon key had a
corrupted signature, so Supabase answered *"Invalid API key"* and the realtime channel never
connected. It failed silently inside a `try/catch` and fell back to a 60-second poll. Corrected
against the project's real key (commit `0fa0d67`).

**12. Every AI feature is silently degraded.** `hub-api ai_ping` returns *"Your credit balance is
too low to access the Anthropic API."* Bob, Coach's replies, the training tutor and the PFR advisor
are all falling back to canned text. You said you are topping this up.

---

## P3 — Hygiene, worth doing before the surface grows

- **~100 edge functions deployed, many dead:** `twin-*` (9), `nexus-*` (2), `fix-org`,
  `smmt-calendar`, `integrity-check`, `team-priority-sweep`, `agent-activity-sync`. Every one is
  attack surface and something to mislead the next person reading the project. Three `twin-*`
  functions are also deployed with `verify_jwt: true`, unlike every app function.
- **30 backup tables** (`*_bak_*`, `*_backup_*`, 1.5 MB) holding copies of agent and policy
  personal data. Small, but it is 30 extra copies of people's details.
- **RLS is enabled with zero policies on 107 tables.** That is *deny-all*, and it is correct given
  the lockdown — but it is safe only because `anon` grants are revoked. I verified `anon` cannot read
  `tracker_agents`, `policies` or `agent_pins`, and cannot execute `pin_set`. If anyone ever
  re-grants `anon`, there are no policies underneath to catch it.
- **One fact, three copies.** The training schedule lived in `calendar.html`, `bots-cron` **and**
  `hub-api`, and two had drifted (fixed today). `app_settings.help_knowledge` holds a fourth copy as
  prose. Zoom room IDs sit in 2 files, baseshop literals in 3. Before adding more, decide that a
  schedule is data in `app_settings`, not a constant in code.
- **`smmt_pages` serves a live public page** at `/functions/v1/smmt-calendar` that nothing links to
  and that drifts from the app. Retire it or point it at the real Scheduler.
- Two functions have a mutable `search_path` (`family_surname`, `summit_step_done`). Both run as
  *invoker*, not `SECURITY DEFINER`, so the risk is low — but 59 functions here *are*
  `SECURITY DEFINER`, so keep the habit of pinning it.

---

## What is genuinely solid

Worth knowing what not to spend time on:

- **The backend lockdown holds.** `anon` can read no table and execute no privileged function.
  Everything goes through edge functions with the service role, as designed.
- **Baseshop isolation holds under probing.** Out-of-scope people come back `limited`, scope is
  computed server-side, and a foreign code could not widen it.
- **No page has a handler calling a function that does not exist** — the bug class that blanked the
  New Business board. I checked every inline handler on all 24 pages against every definition,
  including handlers assembled inside JS strings. Zero.
- **All 24 pages parse.**
- **Client polling is disciplined.** Every network poller is ≥30 s and gated on `document.hidden`;
  the 1-second timers are local DOM work only, and typing polling short-circuits when the socket is
  live. The runaway-poller problem that caused the quota outage has stayed fixed.
- **The service worker is network-first** with `no-store`/`no-cache`, so there is no stale-HTML risk
  and no cached-half-file failure mode.
- **No secrets in client code** beyond the anon key, which is meant to be public. The cron machine
  token appears in no page.
- **The JavaScript is ES5-safe** — no optional chaining, nullish coalescing or logical assignment
  anywhere. That matters for older iOS WebViews and the App Store build.
- **Contract rates, status lists and the US state list are single-source.** Rates live in
  `app_settings.contract_rates`, not in the pages.
- **Cron load is ~2,140 invocations/day (~64k/month)** — comfortable inside the Pro allowance.

---

## Suggested order

1. #1 legacy token — hours, and it is the one a stranger can use today.
2. #2 PIN claiming — decide the rule, then backfill the 98.
3. #3 agent sessions — the biggest change, and #1 and #2 are its prerequisites anyway.
4. #4-#8 data cleanup — Operations can do most of it from existing screens.
5. #9-#10 — small, contained code fixes.
6. P3 — do the dead-function sweep before the next build, not after.
