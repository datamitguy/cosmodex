#!/usr/bin/env bash
# Build the local-only (no Firebase, no login) Cosmodex from the main source.
#
# Produces index.html + app.js + styles.css in this directory, ready to serve
# from GitHub Pages or any static server. The generated files ARE committed —
# GitHub Pages serves this directory as-is, there is no build step on their end.
#
# Source of truth stays ../Cosmodex-v2. Edit there, re-run this.
set -euo pipefail
cd "$(dirname "$0")"
SRC="../Cosmodex-v2"

[ -d "$SRC/src" ] || { echo "Cannot find $SRC/src — is Cosmodex-v2 alongside this repo?"; exit 1; }

# 1. app.js — same concatenation as the main build
cat "$SRC"/src/*.js > app.js

# 2. styles.css — verbatim
cp "$SRC/styles.css" styles.css

# 3. index.html — the main HTML with the Firebase ESM block swapped for the shim
python3 - "$SRC/cosmodex-v2.html" <<'PY'
import re, sys
src = open(sys.argv[1]).read()

# Drop the entire Firebase ESM bootstrap (imports, config, auth listeners).
start = src.index('<!-- Firebase (ESM CDN)')
end   = src.index('</script>', src.index('onAuthStateChanged(auth, user =>')) + len('</script>')
src = src[:start] + '''<!-- Cosmodex Lite: Firebase replaced by a local IndexedDB store. No network, no login. -->
<script src="local-store.js"></script>''' + src[end:]

# The service worker pre-caches './cosmodex-v2.html', which does not exist in
# this build. Offline shell caching is not worth a broken fetch handler here.
src = re.sub(r"\n\s*navigator\.serviceWorker\.register\('sw\.js'\)[^\n]*\n",
             "\n      /* service worker intentionally not registered in the lite build */\n", src)

# Lock the CSP down to what this build actually uses. No Google, no Firebase,
# no websockets — the policy itself is now the proof that nothing leaves.
src = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*/>',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; '
  'script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\' '
  'https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; '
  'connect-src \'self\'; img-src \'self\' data:; object-src \'none\';" />', src)

# The Firebase copy in this pane would otherwise claim a cloud sync that does
# not exist in this build.
src = src.replace('Your data is stored anonymously in Firebase Firestore under this user ID.',
                  'This build has no account. Records are keyed to a single local user.')
src = src.replace('Live connection to Firebase Firestore.',
                  'There is no cloud sync in this build — the folder above is your durability.')
src = src.replace('Connected — real-time sync active', 'Local only — no cloud sync')
src = src.replace('<div class="settings-section-title">Firebase Account</div>',
                  '<div class="settings-section-title">Local Account</div>')
src = src.replace('<div class="settings-section-title">Sync Status</div>',
                  '<div class="settings-section-title">Sync</div>')
# Neon is the exception colour; "local only" is a normal state, not a fault.
src = src.replace('id="settings-fb-dot2" style="width:8px;height:8px;border-radius:50%;background:var(--neon)',
                  'id="settings-fb-dot2" style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.55)')

# The sign-in overlay is dismissed by 'cdx-auth-ready' (the shim fires it), but
# hide it up front so there is no flash of a Google button that does nothing.
src = src.replace('<div id="signin-overlay">', '<div id="signin-overlay" style="display:none">')

open('index.html', 'w').write(src)
print('  index.html written')
PY

echo "Built cosmodex-lite: $(wc -c < app.js | tr -d ' ') bytes of app.js"
