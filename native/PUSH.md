# Push notifications — setup & usage

The `push-send` edge function is **deployed and live** (dormant until you add
keys). It reads the `device_tokens` table (the app registers each device
automatically via `notif.js`) and delivers to **APNs** (iOS) and **FCM**
(Android). It's token-gated, so Operations and other edge functions can call it.

Check status any time:
```bash
curl -s -X POST https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/push-send \
  -H 'Content-Type: application/json' -d '{"action":"config"}'
```
Returns which providers are configured.

---

## 1. Get the keys

**Apple (iOS):**
1. developer.apple.com → **Certificates, IDs & Profiles → Keys → +**
2. Enable **Apple Push Notifications service (APNs)**, create, **download the `.p8`** (you can only download it once).
3. Note the **Key ID** (on the key) and your **Team ID** (top-right of the membership page).

**Firebase (Android):**
1. console.firebase.google.com → create a project (or reuse one).
2. Add an **Android app** with package name **`app.tsfg.standard`** → download **`google-services.json`** → put it in `android/app/` in the Capacitor project.
3. Project settings → **Service accounts → Generate new private key** → download the **service-account JSON**.

---

## 2. Set the secrets (once)

From the repo, with the Supabase CLI (`supabase login` first):
```bash
supabase secrets set --project-ref bmfqxtocxkjhsgfnndlo \
  APNS_KEY_P8="$(cat AuthKey_XXXXXX.p8)" \
  APNS_KEY_ID="XXXXXXXXXX" \
  APNS_TEAM_ID="YYYYYYYYYY" \
  APNS_BUNDLE_ID="app.tsfg.standard" \
  APNS_PRODUCTION="true" \
  FCM_SERVICE_ACCOUNT="$(cat firebase-service-account.json)"
```
(Or paste them in the Supabase dashboard → Project → Edge Functions → Secrets.)

- `APNS_PRODUCTION="true"` for TestFlight / App Store builds; `"false"` for a
  plain `npx cap run ios` dev build on a device.

After setting them, `config` will show `apns:true` / `fcm:true` — no redeploy needed.

---

## 3. Send a push

```bash
curl -s -X POST https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/push-send \
  -H 'Content-Type: application/json' -d '{
    "token":"2026",
    "to":"C1991",                     // one code, ["C1991","E3850"], or "all"
    "title":"New booking",
    "body":"Cassandra booked you for Field Training at 3:00 PM",
    "url":"https://tsfg.app/calendar.html"
  }'
```
Returns `{ sent, failed, skipped, pruned }`. Dead tokens are auto-removed.
Add `"dry_run":true` to see who would be targeted without sending.

## 4. Fire pushes from events (optional, later)

Any edge function can notify a broker by POSTing to `push-send` with
`token:"2026"`. Natural hooks:
- **task-api** → when a task is assigned to an agent
- **atlas-api / calendly-webhook** → booking confirmed / cancelled
- **hub-api** → @mention or DM
- **roadmap-api** → milestone verified, rank-up

Say the word and I'll wire these in once push is live on real devices.

---

## Notes
- Nothing sends until devices register tokens — that only happens **inside the
  installed native app** (not the browser PWA). So: build the app (see
  `README.md`), install it on a phone, sign in → a `device_tokens` row appears →
  test a send to your own code.
- The Apple `.p8`, Team/Key IDs, and the Firebase service-account JSON are
  **secrets** — set them via Supabase secrets, never commit them.
