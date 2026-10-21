# How double-booking is actually prevented

Verified end to end 2026-10-21. Nothing here is enforced by the app — it is all in the
database, which is why every booking path (atlas-api, calendly-book, cal-import,
book-manual, the Calendly webhook) is safe without each one re-implementing the rule.

## The guard

Two `EXCLUDE` constraints on `bookings`:

```
bookings_trainer_no_overlap   EXCLUDE USING gist (trainer_code =, tstzrange(starts_at, ends_at) &&)
                              WHERE status IN ('booked','confirmed')
                                AND trainer_code IS NOT NULL
                                AND starts_at IS NOT NULL AND ends_at IS NOT NULL

bookings_agent_no_overlap     ...the same, on agent_code
```

A trainer cannot hold two overlapping live bookings. Neither can an agent.

## It is a CHAIN, and it fails silently

    date + time present
        -> BEFORE INSERT trigger `bookings_backfill_trg`
             (function bookings_backfill_from_legacy)
           computes starts_at from date+time AT TIME ZONE timezone,
           then ends_at = starts_at + duration_minutes
        -> the EXCLUDE constraints can finally apply

Break any link and bookings keep inserting happily with **no overlap protection at all**:

* **Insert a booking with a NULL `date` or `time`** and `starts_at` stays NULL, so the
  constraint's WHERE clause excludes the row. Every booking path currently rejects a
  missing date or time, which is the only reason this holds.
* **Disable or drop `bookings_backfill_trg`** and the same thing happens to every new row.
* The trigger also resolves `trainer_code` from `trainer_name` by exact name match. No
  match, no code, and the trainer-side guard does not apply to that row.

## Verified state (2026-10-21)

| | |
|---|---|
| bookings | 1,649 |
| missing date or time | **0** |
| missing starts_at or ends_at | **0** |
| live bookings | 53 |
| live with NEITHER guard applying | **0** |
| actual overlapping live bookings | **0** |

The 26 live rows with no `trainer_code` are all legitimate and all still agent-guarded:
18 are `Personal` calendar blocks, which have no trainer by design, and 8 are
`calendly_import` rows where `trainer_name` holds the **invitee**, not a trainer — that is
cal-import's own shape (`trainer_name: invitee_name || "Client"`), so those names are
clients and correctly have no agent code. The 3 live rows with no `agent_code` are
client-facing appointments; the trainer guard, which is the one that matters there, applies.

## `pending` is deliberately NOT covered

The WHERE clause lists only `booked` and `confirmed`. Two `pending` requests for the same
slot can therefore coexist — the app layer blocks the second from being OFFERED
(atlas-api's availability query includes `pending`), but the database allows both to exist.
Approving the second then fails the constraint. That is the documented
"unapprovable booking": the escape hatch is Decline, not a retry.
