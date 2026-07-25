# The Standard — iOS Launch Checklist

Everything that can be done without an Apple account is **DONE**. What's left needs the
$99 Apple enrollment + your Mac. Work top to bottom when you're ready.

## ✅ DONE (Claude — no account needed)
- [x] App project built (`tsfg-ios/`): Capacitor 8, hosted to live tsfg.app.
- [x] App identity: name **The Standard**, bundle ID **app.tsfg.standard**.
- [x] App icon + splash = your gold emblem (all sizes generate from `resources/`).
- [x] Website home-screen icons swapped to the emblem (live).
- [x] Push token capture wired into the site (`device_tokens` table).
- [x] Push **sender** built + deployed (`push-api` edge function), dormant until key.
- [x] **Auto-push**: every in-app alert now also fires a phone push (Postgres trigger).
- [x] Privacy policy live: https://tsfg.app/privacy.html
- [x] App Store listing copy written → `APP_STORE_LISTING.md`
- [x] Marketing screenshots (6.7") → `resources/screenshots/`
- [x] Apple review demo login created: code **APLREVIEW** (approved).
- [x] One-command build script → `build.sh`
- [x] Full build instructions → `RUNBOOK.md`

## ⬜ YOURS — needs the Apple account + Mac
1. [ ] **Install Xcode 26** from the Mac App Store (required since Apr 28 2026).
2. [ ] **Enroll in Apple Developer** — $99/yr — developer.apple.com/programs/enroll.
3. [ ] In this folder on your Mac, run: `./build.sh`  (does everything, opens Xcode).
4. [ ] In Xcode → **Signing & Capabilities** → pick your Team; add **+ Push Notifications**.
5. [ ] Press ▶ to run it on your iPhone and confirm login works (code APLREVIEW or yours).
6. [ ] **Product → Archive → Distribute → App Store Connect → Upload.**
7. [ ] At appstoreconnect.apple.com → New App → paste everything from `APP_STORE_LISTING.md`,
       upload screenshots, set demo code **APLREVIEW** in App Review notes → **Submit.**
8. [ ] Review is typically 1–3 days. You'll get an email.

## ⬜ Turn push ON (after enrollment — 5 min, hand to Claude)
9.  [ ] developer.apple.com → Keys → **+** → Apple Push Notifications service → download **.p8**.
10. [ ] Give Claude: the **.p8** contents, the **Key ID**, and your **Team ID**.
11. [ ] Claude sets the secrets; push goes live. Test:
        `curl -s -X POST https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/push-api -d '{"action":"health"}'`
        → `"configured":true` means alerts now hit phones.

## Notes
- The app loads the live site, so any website change you push appears in the app instantly
  — no re-submission for content updates.
- Android is a later phase; the same project can target it with `npx cap add android`.
