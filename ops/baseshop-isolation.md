# Baseshop isolation — how it actually works, and the one trap in it

Audited 2026-10-21. Shops today: **SUMMIT 71, ELEVATE 58, TITANS 6, SCAPED 2** (137 active).

## Two separate mechanisms, and they agree

| Mechanism | Used by | How it decides |
|---|---|---|
| `agent_scope(code)` / `ops_scope(token, code)` | ops-directory, ops-inforce, ops-metrics, ops-nbfeed, calendly-sync, org-api, summit-api | `baseshop_group()` on the caller's own shop |
| a private `accessibleBases()` walk | profile-api, hub-api | walks `app_settings.baseshops` parent/`also` links to the root |

Two implementations of one idea is normally how drift starts (ops-nbfeed v18 is the
standing example — a private copy let the ELEVATE seat read the whole company's book).
Checked here, and today they agree in effect:

* The `baseshops` config gives every shop `parent: STANDARD` and **no `also` arrays**, so
  the private walk returns `[own shop, STANDARD]` and can never reach a sibling. A SUMMIT
  agent cannot reach ELEVATE, TITANS or SCAPED through it.
* `baseshop_group('SUMMIT')` returns `[SMMT, GRIND, SUMMIT]`, which looks wider but
  reaches **71 agents — exactly the SUMMIT headcount**. SMMT and GRIND hold nobody.

`hub-api` additionally hides `#operations` from every agent, leader and base owner; it is
served only through `hub-ops` to Operations seats.

## THE TRAP: `baseshop_groups` still fuses GRIND into SUMMIT

```
app_settings.baseshop_groups = [["SMMT", "GRIND", "SUMMIT"]]
```

SMMT is the old name for SUMMIT; **GRIND was retired on 2026-10-02** and its branding
folded into SUMMIT (per the `baseshops` config note). The group was correct when GRIND was
Christopher's pre-EMD sub-base — `agent_scope`'s own comment says "SMMT+GRIND are one shop
until Christopher takes EMD".

It is harmless today because nobody is in either name. But the fusion is **bidirectional
and automatic**:

```
baseshop_group('GRIND')  -> [SMMT, GRIND, SUMMIT]
baseshop_group('SUMMIT') -> [SMMT, GRIND, SUMMIT]
```

The `baseshops` config also says Ops seat **0005 GRIND is "deliberately kept, unused and
without a PIN, for a future base launch"**. So the day anyone is assigned
`baseshop = 'GRIND'`:

* every GRIND agent immediately sees all 71 SUMMIT people, and
* every SUMMIT agent immediately sees the new base,

with no deploy, no migration and nothing in any log.

**DECIDED 2026-10-21 — Christopher: "share grind with SUMMIT".** The fusion stays. GRIND and
SUMMIT are one shop for visibility, so when GRIND launches its agents and SUMMIT's see each
other from day one, and no change is needed: `baseshop_groups` is already correct for that
intent. This is now a recorded decision rather than a leftover — if a FUTURE base is ever
meant to be independent, it must be given a name that is NOT in this group, or be removed
from it before anyone is assigned.

TITANS, ELEVATE and SCAPED each form a group of one and are correctly isolated.

## Booking across baseshops is INTENDED — do not "fix" it

Audited 2026-10-21. The Scheduler shows your own shop's trainers by default
(`SHOPONLY = true` in calendar.html) but ships a visible **"Whole hierarchy"**
button — `setShopScope(false)` — and when your shop has no connected trainer it
actively offers *"Show the whole hierarchy"*. Any signed-in agent can see and book
any baseshop's trainers.

So the absence of a baseshop check in the booking path is correct, not an oversight:

* `atlas-api` contains **no** `baseshop` reference at all.
* `calendly-book`'s `bookableTrainers()` returns every connected trainer, and its
  `book` action validates trainer, meeting type and time — never the caller's shop.

**`trainer-scope` disagrees with all of this, and nothing calls it.** Its header states
a stricter rule — *"Certified Field Trainers are bookable inside your own baseshop. MDs
and EMDs can be booked across baseshops"* — and its own v4 note already records that no
page in the app calls it. It is a dormant endpoint encoding a rule the shipped product
deliberately does not follow.

If anyone ever wires `trainer-scope` into the Scheduler, it will start refusing bookings
the UI is currently inviting people to make, and the symptom will be "the trainer list went
empty for half the company". Either delete it, or change its rule to match the product
first. It is session-gated as of v4, so it leaks nothing while it sits there.

Note this is a different question from DATA isolation, which IS enforced: see the table
above. Seeing a trainer's name in order to book them is not the same as reading another
shop's book of business.
