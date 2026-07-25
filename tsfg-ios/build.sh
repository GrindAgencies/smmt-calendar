#!/bin/bash
# The Standard — one-shot iOS project build (run on your Mac, in this folder).
# Prereqs: Node + CocoaPods installed, Xcode 26 installed. See RUNBOOK.md.
set -e
echo "==> Installing app dependencies…"
npm install
echo "==> Adding the iOS project…"
npx cap add ios || echo "(iOS platform already added — continuing)"
echo "==> Generating icons + splash from resources/…"
npx capacitor-assets generate --ios
echo "==> Syncing web + native config…"
npx cap sync ios
echo "==> Opening in Xcode. Set your Team under Signing & Capabilities, then press Play."
npx cap open ios
