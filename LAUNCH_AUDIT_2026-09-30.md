# Pre-launch audit — Apple App Store & Google Play
**The Standard · 30 September 2026 · audited against the live system**

Everything here was checked against the real project and the live backend. Where I state a number,
I ran it.

---

## Read this first: the 9am launch

**The app cannot be live on either store at 9am tomorrow.** Not because of anything broken — because
of how the two stores work. Please plan around this rather than against it.

| | Reality |
|---|---|
| **Apple** | Review takes **24 hours to a few days** for a first submission. You cannot submit tonight and be live at 9am. **TestFlight is the same-day path** — a build can be in your team's hands within hours of upload, before review completes. |
| **Google Play** | If your Play developer account is **personal/individual and was created after November 2023**, Google requires **12 testers opted into a closed test for 14 continuous days** before you may even apply for production access. If that applies, **Android production is at least two weeks out**, and nothing in the code changes that. An **organization** account is exempt. |
| **The PWA** | **Already live at tsfg.app right now.** Every agent can install it today from Safari or Chrome — add to home screen, full screen, their own icon. This is the thing that can actually launch at 9am. |

**My recommendation for 9am:** launch on the PWA, which is real and working, and run the store
submissions in parallel. TestFlight for iOS the same day. Announce the stores when they clear.

---

## Blockers — must be cleared before submitting

### 1. Three authentication holes are still open · **I consider these launch-blocking**

From the 29 September audit, all three re-verified open tonight:

- **The string `2026` is still a master key.** With no credentials at all, it returns all 138 people
  with phone numbers and personal email addresses. It is also printed inside pages people download.
- **98 of 133 active accounts can be claimed** by anyone who knows the agent code, because setting a
  first PIN never checks it is really you. Codes are on the org chart.
- **The API accepts a bare agent code as identity** — it will hand over another person's tracker,
  tasks and goals, marked editable.

This matters more at launch, not less: you are about to put this in two public stores with 138 real
people's data and their clients' dates of birth inside. If a reviewer or anyone else pokes at it,
the finding is not a bug report, it is a data-protection incident.

**Fix time: roughly a day.** #1 is an hour (one database flag plus rewiring two callers).

### 2. Things only you can do — I have no access

| What | Where | Note |
|---|---|---|
| **Apple Developer Program** — confirm enrolment is active | developer.apple.com | Memory says Individual, "status unconfirmed". Nothing ships until this is live. |
| **Google Play Console** — account + the 12-tester question above | play.google.com/console | $25 one-off. Confirm whether it is personal or organization; it decides your Android timeline. |
| **Android keystore** — create and **back up permanently** | `keytool` (command in `native/android/keystore.properties.example`) | Google identifies the app by this key forever. Lose it and you can never update the listing. |
| **google-services.json** — Firebase project for Android push | console.firebase.google.com | Android push cannot work without it. iOS push is already live. |
| **The submissions themselves** | App Store Connect / Play Console | Yours to click. |

---

## Ready — verified tonight

| Item | State |
|---|---|
| **iOS project** | Capacitor 8, bundle `app.tsfg.standard`, team `A483Q9QFKT`, v1.0 build 2, deployment target iOS 15 |
| **Android project** | Same bundle, compile/target **SDK 36**, min SDK 24 — meets Play's current requirement |
| **iOS push** | **Live.** APNs key in the vault, production mode, correct team and bundle. The old blocker is cleared. |
| **App icons** | iOS 1024×1024 present; Android launcher icons all densities; PWA 192/512/maskable all serving |
| **Reviewer account** | `DEMO2026` / PIN `2026` — signs in, confirmed tonight |
| **Encryption declaration** | `ITSAppUsesNonExemptEncryption = false` already set — saves you the export-compliance questions |
| **Privacy policy URL** | tsfg.app/privacy.html — live, and updated tonight |
| **PWA** | Manifest valid, standalone, service worker network-first (no stale-page risk), safe-area insets handled |

## Fixed tonight

- **Account deletion** — was missing entirely; a hard rejection on **both** stores. Now in the app
  (My Profile → Danger zone) *and* on the web at `tsfg.app/delete-account.html`, which Play requires
  to work without the app. Identity is proven by the PIN — deliberately stricter than the rest of
  the platform. Tested end to end on a throwaway account.
- **`PrivacyInfo.xcprivacy`** — was missing; automatic upload rejection (ITMS-91053). Written from
  what the code actually does and registered in the Xcode target so it ships in the bundle.
- **Privacy policy** — described agents only. The app also holds **client** data: 214 policies with
  names, phones, emails and **145 dates of birth**, plus 638 client records. Now disclosed, along
  with push tokens and the deletion route.
- **Android release signing** — there was no signing config at all; a release build would have been
  unsigned and refused. Added, reading a gitignored `keystore.properties`.

---

## Two risks worth your judgement

### The "is it just a website?" risk — Apple guideline 4.2
`capacitor.config.json` sets `server.url = https://tsfg.app`, so the app loads the live site rather
than bundling it. This is a known rejection reason: *"your app should include features, content and
UI that elevate it beyond a repackaged website."*

You are **not** defenceless here — the app has real native push notifications, it is an
authenticated internal business tool rather than a public website, and it is not a storefront. Most
apps in this shape do get through. But if it is rejected, this will be why, and the answer is to
lean harder on native capability (push is already there; biometric unlock or native camera would
settle it).

### Your screenshots are out of date
`~/Desktop/appstore-screenshots` has correct-size images (1320×2868, 6.9"), but they show
**"My Journey"**, which no longer exists, and the **old Book-a-Trainer screen**, which I replaced
yesterday. Apple expects screenshots to match the app.

They also show **real agents' names and faces**. For an internal app that is a judgement call worth
making deliberately, not by default — consider capturing from the `DEMO2026` account instead.

Say the word and I will regenerate all of them from the live app at the right size.

---

## Suggested order

1. **Tonight** — confirm the Apple and Play account status. Everything else waits on those two facts.
2. **Tonight** — create and back up the Android keystore. Five minutes, and it is unrecoverable if lost.
3. **Tomorrow morning** — launch the **PWA** to the team at 9am. It is live and it works.
4. **Tomorrow** — close authentication hole #1 (about an hour), then submit to Apple and upload to TestFlight.
5. **This week** — holes #2 and #3, regenerate screenshots, Firebase for Android push.
6. **When Play allows** — Android production, once the testing requirement is satisfied.
