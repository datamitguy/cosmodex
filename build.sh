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
<script src="local-store.js"></script>
<script src="local-files.js"></script>''' + src[end:]

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

# Folder storage lives in Settings → Data & Sync, above the Firebase leftovers,
# whose copy is corrected below so the pane does not claim a cloud sync.
src = src.replace('<div class="settings-content-panel" id="st-pane-data">',
  '''<div class="settings-content-panel" id="st-pane-data">
            <div class="settings-section">
              <div class="settings-section-title">Storage Folder</div>
              <div class="settings-desc">Records live in this browser by default, which corporate IT can clear without warning. Connect a folder — a OneDrive-synced one is ideal — and Cosmodex also writes <code style="font-family:var(--font-mono);font-size:11px">data/cosmodex.json</code> plus your daily notes as markdown in <code style="font-family:var(--font-mono);font-size:11px">notes/</code>. The folder is remembered; Chrome may ask to confirm access once per session. Chrome or Edge only.</div>
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                <span id="cdx-fs-dot" style="width:8px;height:8px;border-radius:50%;background:var(--gold-dim);display:inline-block"></span>
                <span id="cdx-fs-label" style="font-size:12px;color:var(--muted)">Not connected</span>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                <button class="btn-secondary" id="cdx-fs-pick" style="font-size:11px;padding:8px 16px">Choose folder…</button>
                <button class="btn-secondary" id="cdx-fs-save" style="font-size:11px;padding:8px 16px">Save now</button>
                <button class="btn-secondary" id="cdx-fs-disconnect" style="font-size:11px;padding:8px 16px;color:var(--gold);display:none">Disconnect</button>
                <span id="cdx-fs-status" style="font-size:11px;color:var(--muted);font-family:var(--font-mono)"></span>
              </div>
            </div>''')
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

# ── app.js: give the daily-note module a browser filesystem ──────────────────
python3 - <<'PY2'
needle = "  function _invoke() { const t = window.__TAURI__; return t && t.core && t.core.invoke; }"
src = open('app.js').read()
assert src.count(needle) == 1, "daily-note _invoke() not found exactly once — check src/17-daily-note.js"
src = src.replace(needle,
  "  function _invoke() { return (window.CDX_FILES_READY && window.CDX_FILES_READY()) || null; }")
open('app.js', 'w').write(src)
print('  app.js: daily notes repointed at the folder backend')
PY2

echo "Built cosmodex-lite: $(wc -c < app.js | tr -d ' ') bytes of app.js"
