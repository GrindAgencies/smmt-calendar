# Laptop Handoff — The Standard platform (tsfg.app)

This file lets you and Claude Code pick up on your **laptop** exactly where the desktop left off.
**GitHub is the source of truth** — your laptop just clones this repo and reads this file.

_Last updated: 2026-08-15._

---

## 1. One-time laptop setup

1. **Install Claude Code** on the laptop (same as the desktop).
2. **Install GitHub Desktop** and sign in to the GitHub account that owns `GrindAgencies/smmt-calendar`.
3. **Clone the repo once** to a clean folder — e.g. `~/Documents/GitHub/smmt-calendar`.
   - ⚠️ Keep **only ONE clone**. A second, stale clone on the desktop caused repeated "my push didn't land" problems. One clone, and make sure GitHub Desktop is pointed at it.
4. **Open that folder in Claude Code** and start with: _"read LAPTOP-HANDOFF.md"_.

That's it — you're set up to keep working.

---

## 2. How the app + deploys work (unchanged)

- The site is **static HTML on GitHub Pages** at **tsfg.app**. The backend is **Supabase** (edge functions + Postgres; project ref `bmfqxtocxkjhsgfnndlo`, already public in the site's code).
- **Deploy flow:** Claude edits files and commits locally → **you click "Push origin" in GitHub Desktop** → GitHub Pages redeploys (CDN takes ~1–2 min) → Claude verifies it's live.
- **Edge functions** are deployed by Claude through the Supabase tools (always with `verify_jwt:false` — the app sends no auth header).

---

## 3. Where things stand

### 📱 iOS App Store — in progress, waiting on Apple
- **The app is ALREADY usable today** as an installable web app. On any phone: open **tsfg.app** → **iPhone:** Safari → Share → *Add to Home Screen*; **Android:** Chrome → ⋮ menu → *Install app*.
- **Apple Developer enrollment** = a **Company** account for **Grind Agencies Inc.** — **SUBMITTED, "pending verification."** Apple verifies the company over a few days; **watch admin@grindagencies.com (and answer the phone)** — responding promptly is what keeps it moving. (Your D-U-N-S is in the Dun & Bradstreet email from Aug 3 if needed again.)
- **Native build = Capacitor** wrapper that loads tsfg.app (not PWABuilder). **Full Xcode 26.6 is installed on the DESKTOP only** — a native build needs Xcode + ~40 GB free, so that step stays on the desktop for now.
- **Push notifications:** backend is **fully built and tested** (device registration + Apple/Android sender + a database trigger that fires a push on every new in‑app notification). It's **dormant until the Apple push key (.p8) + secrets are set**. The web side (notif.js) already wires it up.
- **Apple reviewer demo login** exists (isolated sample data) — the exact code is in Claude's memory / the earlier chat. Remove it after approval.
- **privacy.html** is live (required for submission).
- A complete **step‑by‑step App Store submission kit** (Capacitor build, push setup, ready‑to‑paste listing copy, privacy answers) was saved as a **Claude artifact** — ask Claude for "the App Store submission kit link."

### 🧾 PFR recovery — open item
- **Kelly Leslie's PFR was hard‑deleted** (not in the live database; the app has no trash/undo). The other 38 PFRs are all intact.
- Recoverable from **Supabase Pro daily backups (~7 days)** via the Supabase dashboard. To do it, Claude needs: **roughly when it was deleted** and **which agent's client she was.**

### ✅ Recently shipped (all live)
- **New Business tab:** status‑routed — active pipeline only in the main tab; **Paid Out → In Force** tab; **Declined/Cancelled → Archived**. New 19‑status list. Client profiles show phone/email; tasks are client‑specific.
- **Ops Tasks:** Operations now sees only Operations‑created/assigned tasks (the auto‑task flood was archived and the automations turned off).
- **Supabase health:** on the Pro plan, no more outages, usage comfortably within limits.

---

## 4. Good to know
- Keep **one clone only**, with GitHub Desktop pointed at it (avoids the "push didn't land" trap).
- The Ops admin token the edge functions use is the **same one already embedded in the site's client code** — not a new secret.
- **Optional:** Claude's detailed working memory lives on the desktop under `~/.claude`. This handoff covers the essentials, but if you want 100% fidelity you can AirDrop that folder to the laptop.
