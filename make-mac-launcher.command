#!/bin/bash
# ===========================================================================
#  Cosmodex Office — build a Mac app you can keep in the Dock.   (macOS)
#
#  Double-click this file once. It compiles "Cosmodex Office.app" from the
#  source in mac/, puts it in your Applications folder and shows it to you in
#  Finder. Drag it onto the Dock. From then on:
#
#      click the icon   → Cosmodex starts and opens in your browser
#      click it again   → the page comes back (if you closed the tab)
#      Quit (⌘Q)        → Cosmodex stops
#
#  It is BUILT HERE, on this Mac, not downloaded: no app is kept in the
#  repository. That is the version a managed work laptop is most likely to
#  allow. If yours still refuses it, you do not need it — drag
#  start-cosmodex.command onto the right-hand end of the Dock instead (beside
#  the Bin). One click on that starts Cosmodex too; it just keeps a Terminal
#  window open while it runs.
#
#  Run this again if you move the folder: the app remembers where it was.
#  Optional: pass a folder to build the app there instead of Applications.
# ===========================================================================
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
NAME="Cosmodex Office"

say()  { printf '\n  %s\n' "$1"; }
fail() { say "$1"; printf '\n'; [ -t 0 ] && read -r -p "  Press Return to close."; exit 1; }

[ -f "$DIR/cosmodex-server.py" ]        || fail "This file must sit in the Cosmodex folder, next to cosmodex-server.py."
[ -f "$DIR/mac/CosmodexOffice.swift" ]  || fail "mac/CosmodexOffice.swift is missing. Run 'git pull' in this folder and try again."

# --- The compiler -----------------------------------------------------------
# Part of Apple's free command-line developer tools. Many Macs have them;
# a locked-down one may not, and that is what the Dock alternative is for.
SWIFTC="$(xcrun -f swiftc 2>/dev/null || command -v swiftc 2>/dev/null)"
if [ -z "$SWIFTC" ]; then
  fail "Building the app needs Apple's developer tools, which this Mac does not have.

  To install them, run this in Terminal:   xcode-select --install

  If your laptop will not allow that, skip the app: drag start-cosmodex.command
  onto the right-hand end of the Dock. One click on it starts Cosmodex."
fi

# --- Python -----------------------------------------------------------------
# An app opened from the Dock does not see Terminal's PATH, so find Python
# now, where we can, and write the full path into the app.
PY=""
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 "$(command -v python3 2>/dev/null)" /usr/bin/python3; do
  if [ -n "$p" ] && [ -x "$p" ] && "$p" -c 'import http.server' >/dev/null 2>&1; then PY="$p"; break; fi
done
[ -n "$PY" ] || fail "Python 3 was not found. Open Terminal, run:  python3 --version  — and accept if macOS offers to install developer tools."

# --- Where to put it --------------------------------------------------------
# /Applications if we may write there; otherwise your own Applications folder,
# which the Dock, Spotlight and Launchpad treat the same way.
if [ -n "$1" ]; then
  DEST="$1"; mkdir -p "$DEST" || fail "Could not create $DEST."
else
  DEST="/Applications"
  if ! [ -w "$DEST" ]; then DEST="$HOME/Applications"; mkdir -p "$DEST" || fail "Could not create $DEST."; fi
fi
APP="$DEST/$NAME.app"

# --- Build ------------------------------------------------------------------
say "Building $NAME — this takes about half a minute…"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
# Name the target outright. Left to itself the compiler targets the running
# macOS, and a Mac on a newer system than its developer tools fails with
# "unable to load standard library" — which this one did. macOS 11 is the
# floor; the app uses nothing newer.
ARCH="$(uname -m)"
SDK="$(xcrun --show-sdk-path 2>/dev/null)"
"$SWIFTC" -O -target "$ARCH-apple-macos11" ${SDK:+-sdk "$SDK"} \
  -o "$BUILD/launcher" "$DIR/mac/CosmodexOffice.swift" 2> "$BUILD/errors.txt" \
  || fail "The build failed:
$(sed 's/^/    /' "$BUILD/errors.txt" | head -20)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" || fail "Could not write to $DEST."
cp "$BUILD/launcher" "$APP/Contents/MacOS/launcher"
[ -f "$DIR/mac/CosmodexOffice.icns" ] && cp "$DIR/mac/CosmodexOffice.icns" "$APP/Contents/Resources/"

# Values go into the plist through plutil, never by pasting them into XML:
# a folder name with an ampersand or angle bracket in it would break the file.
PL="$APP/Contents/Info.plist"
cat > "$PL" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict/></plist>
PLIST
plutil -insert CFBundleName               -string "$NAME"                 "$PL"
plutil -insert CFBundleDisplayName        -string "$NAME"                 "$PL"
plutil -insert CFBundleIdentifier         -string "local.cosmodex.office" "$PL"
plutil -insert CFBundleExecutable         -string "launcher"              "$PL"
plutil -insert CFBundleIconFile           -string "CosmodexOffice"        "$PL"
plutil -insert CFBundlePackageType        -string "APPL"                  "$PL"
plutil -insert CFBundleShortVersionString -string "1.0"                   "$PL"
plutil -insert LSMinimumSystemVersion     -string "11.0"                  "$PL"
plutil -insert NSHighResolutionCapable    -bool   true                    "$PL"
plutil -insert CosmodexDir                -string "$DIR"                  "$PL"
plutil -insert CosmodexPython             -string "$PY"                   "$PL"

# A local signature, the kind macOS gives anything built on the machine. Apple
# silicon will not run an unsigned app at all.
codesign --force --deep -s - "$APP" >/dev/null 2>&1

touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1

say "Made: $APP"
if [ -z "$1" ]; then
  say "Finder is showing it now. Drag it onto the Dock — then one click starts Cosmodex."
  open -R "$APP"
  sleep 1
fi
