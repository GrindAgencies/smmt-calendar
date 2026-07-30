# The Standard — iOS & Android app (Capacitor)

This folder turns the live platform at **https://tsfg.app** into real iOS and
Android apps using [Capacitor](https://capacitorjs.com). It's a **thin native
shell that loads the live site**, so:

- **Content updates need NO app-store resubmission.** When you push the website,
  the app shows the change instantly (it loads tsfg.app live).
- You only rebuild/resubmit the app for **native** changes (new plugins, icons,
  push config, OS version bumps).
- Native **push notifications** work (groundwork is already in `notif.js`, which
  registers each device and stores its token in the `device_tokens` table).

> **appId is `app.tsfg.standard`** (in `capacitor.config.json`). This becomes the
> permanent App Store / Play Store bundle ID — **change it now if you want a
> different one** (e.g. `com.grindagencies.thestandard`). It can't change after
> your first store submission.

---

## What you need (this is the part only you can provide)

| For | You need |
|-----|----------|
| Both | A **Mac** with **[Node.js LTS](https://nodejs.org)** installed |
| iOS | **Xcode** (Mac App Store) + **CocoaPods** (`sudo gem install cocoapods`) + an **Apple Developer account** ($99/yr) |
| Android | **[Android Studio](https://developer.android.com/studio)** + a **Google Play Developer account** ($25 one-time) |

I scaffolded the project + wrote these steps, but the builds are **signed and
submitted on your Mac with your accounts** — that can't happen from a server.

---

## 1. One-time setup

```bash
cd native
npm install                 # installs Capacitor + plugins
npx cap add ios             # generates the ios/ Xcode project
npx cap add android         # generates the android/ Android Studio project
npx cap sync                # wires the config + plugins into both
```

## 2. App icon & splash screen

Put a square **1024×1024** PNG at `native/assets/icon.png` (you can start from
the existing `icon-512.png` in the repo root, upscaled) and optionally a
`native/assets/splash.png` (2732×2732, logo centered on `#0b0f1a`). Then:

```bash
npm run assets              # generates every icon/splash size for iOS + Android
npx cap sync
```

## 3. Test it on a device first

```bash
npx cap run ios             # pick a simulator or a plugged-in iPhone
npx cap run android         # pick an emulator or a plugged-in Android phone
```

You should see the full-screen app load tsfg.app. Sign in as usual.

---

## 4. iOS — build & submit

```bash
npx cap open ios            # opens ios/App/App.xcworkspace in Xcode
```

In Xcode:
1. Select the **App** target → **Signing & Capabilities** → set your **Team**
   (your Apple Developer account) and confirm the **Bundle Identifier**.
2. Add capability **Push Notifications**, and **Background Modes → Remote
   notifications** (for push).
3. Set a version + build number.
4. **Product → Archive** → **Distribute App** →
   - **TestFlight & App Store Connect** for public App Store, or
   - **TestFlight** only for internal testers (recommended first — see §7).

## 5. Android — build & submit

```bash
npx cap open android        # opens android/ in Android Studio
```

In Android Studio:
1. **Build → Generate Signed Bundle / APK → Android App Bundle (.aab)**.
   First time, create an **upload keystore** and **keep it safe** — you need the
   same key for every future update.
2. Upload the `.aab` to the **Google Play Console** →
   - **Internal testing** track (recommended first), or
   - **Production** for the public Play Store.
3. For nicer deep-linking, host `assetlinks.json` at
   `https://tsfg.app/.well-known/assetlinks.json` (Play Console → App integrity
   gives you the JSON). Optional.

---

## 6. Push notifications (phase 2)

The app already **registers** for push and saves device tokens. To actually
**send** pushes you still need:

- **iOS:** an **APNs Auth Key (.p8)** from
  developer.apple.com → Keys, plus your Key ID + Team ID.
- **Android:** a **Firebase project**; drop its `google-services.json` into
  `android/app/`, and use FCM to send.
- A small **send function** (Supabase edge function) that reads `device_tokens`
  and calls APNs/FCM. Say the word and I'll build it once you have the keys.

---

## 7. How to distribute (recommendation)

For an **internal tool** (~69 brokers), you usually do **not** need the public
app stores — and Apple sometimes rejects "just a website" wrappers under
guideline 4.2. Easier, faster options:

- **iOS:** **TestFlight** (invite up to 10,000 users by email — no public review
  hassle), or **Apple Business Manager** custom apps for fully private
  distribution.
- **Android:** Play Console **Internal testing / Closed testing** (invite by
  email), or share the signed `.aab`/`.apk` directly.

Go public later if you want a store listing; the same build works.

---

## 8. Updating the app

- **Website/content change** → just push tsfg.app. The app updates instantly. **No rebuild.**
- **Native change** (new plugin, icon, push, OS bump) → bump the version, rebuild
  in Xcode / Android Studio, resubmit.

---

## Files here

- `capacitor.config.json` — app id/name, `server.url = https://tsfg.app`, splash/status-bar/push config
- `package.json` — Capacitor + plugin dependencies and helper scripts
- `www/index.html` — offline fallback shell (normally unused; the app loads tsfg.app live)
- `assets/` — put your `icon.png` (1024²) and optional `splash.png` here
- `ios/`, `android/`, `node_modules/` — generated locally (git-ignored)
