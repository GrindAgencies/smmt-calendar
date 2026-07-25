# The Standard — iOS App Build Runbook

This folder is a complete **Capacitor** project that turns the live tsfg.app platform
into a real iPhone app for the App Store. The app loads your live site, so all data
stays live and any website change you push shows up instantly — no re-submission needed
for content changes.

**What Claude already built for you (done):**
- The full app project (this folder): config, icons, splash screen, offline fallback.
- App identity: name **The Standard**, bundle ID **app.tsfg.standard**.
- Push-notification plumbing on the website side (registers each device, stores its
  token in Supabase `device_tokens`).

**What only YOU can do (by Apple's rules):** enroll in Apple's program (account + payment)
and run the final build in Xcode on your Mac. Everything below walks you through it.

---

## Before you start — the 3 things you need
1. **A Mac** (you have this).
2. **Xcode 26 or newer** — free from the Mac App Store. *Required:* since April 28 2026,
   Apple only accepts apps built with Xcode 26. Open the App Store app → search "Xcode" →
   Install/Update. It's a big download (~10 GB), so start it first.
3. **An Apple Developer account — $99/year.** (Next step.)

---

## PART 1 — Enroll in the Apple Developer Program  (~15 min + payment)
1. Go to **developer.apple.com/programs/enroll** and sign in with your Apple ID
   (use the company Apple ID if you have one).
2. Enroll as your business/organization if you can (you'll be asked for a legal entity
   name and a D-U-N-S number) — or as an Individual if that's faster. Either publishes to
   the public App Store.
3. Pay the **$99**. Approval is usually minutes to a day.

> Claude cannot do this step — it's an account + payment action. It's yours.

---

## PART 2 — One-time Mac setup  (~15 min, copy/paste each line into Terminal)
Open **Terminal** (Cmd-Space, type "Terminal").

Install Homebrew (skip if you have it):
```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
Install Node and CocoaPods:
```
brew install node cocoapods
```
Check they worked (each should print a version number):
```
node -v ; pod --version
```

---

## PART 3 — Build the app project  (~10 min)
In Terminal, go into this folder (drag the folder onto the Terminal window to paste its
path, or type it):
```
cd "/Users/christopherlorenz/Grind Agencies Inc./tsfg-ios"
```
Install the app's building blocks:
```
npm install
```
Add the iPhone project and generate all the icons/splash sizes:
```
npx cap add ios
npx capacitor-assets generate --ios
npx cap sync ios
```
Open it in Xcode:
```
npx cap open ios
```

---

## PART 4 — Sign it and run it on your own iPhone  (~10 min)
Xcode is now open.
1. In the left sidebar click the blue **App** icon at the top.
2. Open the **Signing & Capabilities** tab.
3. **Team:** pick your name / company (this appears once Part 1 is approved).
   Check **"Automatically manage signing."**
3b. *(optional, for push)* Click **+ Capability** (top-left of that tab) and add
   **Push Notifications**. This lets the app register phones for alerts.
4. Plug your iPhone into the Mac with a cable. At the top of Xcode, choose your iPhone
   from the device dropdown.
5. Press the **▶ Play** button. First time, your iPhone will ask you to trust the
   developer (Settings → General → VPN & Device Management → trust). Then the app opens.

If it opens to The Standard and you can log in with a GFI code — the app works. 🎉

---

## PART 5 — Submit to the App Store  (~30 min + Apple review)
1. In Xcode's device dropdown choose **"Any iOS Device (arm64)."**
2. Menu bar: **Product → Archive.** Wait for it to build.
3. The Organizer window opens → **Distribute App → App Store Connect → Upload.**
4. Go to **appstoreconnect.apple.com** → **My Apps → +** → **New App.**
   - Platform: iOS. Name: **The Standard**. Bundle ID: **app.tsfg.standard**.
   - Fill in: category (Business), description, a support URL (https://tsfg.app),
     a privacy policy URL, and screenshots (take them from your iPhone: iPhone 6.7"
     screenshots are required — just screenshot the app on your phone).
5. Pick the build you uploaded, answer the privacy questions, and **Submit for Review.**
6. Review typically takes **1–3 days.** You'll get an email when it's approved.

> **One heads-up on Apple's review:** Apple's rule 4.2 rejects apps that are "just a
> website in a shell." Ours is protected because it has real native features — push
> notifications and native login. If a reviewer ever pushes back, the fix is to lean
> harder on native features (we can add Face ID login and camera-based policy capture);
> tell Claude and it'll wire them.

---

## PHASE 2 — Turn push notifications ON  (after Part 1 is approved)
The app already asks each phone for push permission and saves its token. To actually
SEND pushes (sale alerts, Kyle's nudges) you need one file from Apple that only you can
create:
1. In **developer.apple.com → Certificates, Identifiers & Profiles → Keys → +**,
   create an **Apple Push Notifications service (APNs) key**. Download the **.p8** file
   (you can only download it once — keep it safe).
2. Note the **Key ID** and your **Team ID**.
3. The send function is **already built and deployed** (`push-api`). To turn it on, the
   .p8 contents + Key ID + Team ID get saved as Supabase secrets:
   **APNS_KEY_P8**, **APNS_KEY_ID**, **APNS_TEAM_ID** (Supabase → Edge Functions → Secrets).
   Hand them to Claude and it'll set them for you. Test anytime:
   `curl -s -X POST https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/push-api -d '{"action":"health"}'`
   — when it says `"configured":true`, push is live. Until then, in-app alerts still work.

---

## Quick reference
| Thing | Value |
|---|---|
| App name | The Standard |
| Bundle ID | app.tsfg.standard |
| Loads | https://tsfg.app/app.html (live) |
| Apple cost | $99/year |
| Must build with | Xcode 26+ (Apple rule since Apr 28 2026) |
| Token store | Supabase table `device_tokens` |

Stuck on any line? Paste the exact error to Claude and it'll get you unstuck.
