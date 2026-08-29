#!/bin/bash
# Build a new App Store / TestFlight binary for The Standard.
#
#   ./release.sh              -> new build of the same version (1.0 build 2, 3, 4...)
#   ./release.sh 1.1          -> new version number as well
#
# REMINDER: you only need this for icon / app name / splash / native-capability
# changes. Normal feature and content changes go live through GitHub Pages with
# no rebuild at all — the app loads tsfg.app directly.
#
# When it finishes, the archive is in Xcode's Organizer, ready to upload.

set -euo pipefail
cd "$(dirname "$0")"

PROJ="ios/App/App.xcodeproj/project.pbxproj"
ARCHIVE_DIR="$HOME/Library/Developer/Xcode/Archives/$(date +%Y-%m-%d)"
STAMP="$(date +%Y-%m-%d) $(date +%H.%M)"
ARCHIVE="$ARCHIVE_DIR/The Standard $STAMP.xcarchive"
EXPORT_DIR="$HOME/Desktop/TheStandard-upload"

# --- version numbers -------------------------------------------------------
# Apple rejects a build number it has already seen, so this always increments.
CUR_BUILD=$(grep -m1 "CURRENT_PROJECT_VERSION" "$PROJ" | sed 's/[^0-9]//g')
NEW_BUILD=$((CUR_BUILD + 1))
sed -i '' "s/CURRENT_PROJECT_VERSION = $CUR_BUILD;/CURRENT_PROJECT_VERSION = $NEW_BUILD;/g" "$PROJ"

if [ $# -ge 1 ]; then
  CUR_VER=$(grep -m1 "MARKETING_VERSION" "$PROJ" | sed 's/.*= *//;s/;//')
  sed -i '' "s/MARKETING_VERSION = $CUR_VER;/MARKETING_VERSION = $1;/g" "$PROJ"
  VERSION="$1"
else
  VERSION=$(grep -m1 "MARKETING_VERSION" "$PROJ" | sed 's/.*= *//;s/;//')
fi

echo "==> Building The Standard $VERSION (build $NEW_BUILD)"

# --- refresh the web assets bundled as the offline fallback ----------------
npx cap sync ios >/dev/null 2>&1 || true

# --- archive ---------------------------------------------------------------
# Signs with the Apple Development identity; -exportArchive re-signs it for
# distribution below. Forcing "Apple Distribution" here fails under automatic
# signing ("conflicting provisioning settings"), so don't try.
mkdir -p "$ARCHIVE_DIR"
echo "==> Archiving (a few minutes)..."
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates archive \
  2>&1 | grep -E "error:|ARCHIVE (SUCCEEDED|FAILED)" || true

if [ ! -d "$ARCHIVE" ]; then
  echo "!! Archive failed. Full log above. Nothing was uploaded."
  exit 1
fi

# --- export a distribution .ipa -------------------------------------------
echo "==> Exporting signed .ipa..."
rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist ExportOptions.plist -exportPath "$EXPORT_DIR" \
  -allowProvisioningUpdates \
  2>&1 | grep -E "error:|EXPORT (SUCCEEDED|FAILED)" || true

echo
echo "============================================================"
echo " The Standard $VERSION (build $NEW_BUILD) is ready to upload."
echo
echo " Archive : $ARCHIVE"
echo " IPA     : $EXPORT_DIR/App.ipa"
echo
echo " To send it to TestFlight:"
echo "   open \"$ARCHIVE\""
echo "   then click Distribute App -> App Store Connect -> Upload"
echo "============================================================"
