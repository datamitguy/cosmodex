#!/bin/bash
# ===========================================================================
#  Cosmodex — start a local server and open the app.  (macOS)
#
#  Double-click this file in Finder, or keep it in the Dock (right-hand end,
#  beside the Bin) and click it there. The Terminal window that opens IS the
#  server — leave it open, close it to stop.
#
#  Click it again while Cosmodex is running and it just brings the page back,
#  then closes the extra window. A fast double-click starts one server, not
#  two. If another program already holds port 8765, it uses the next free one;
#  your preferences live in Cosmodex's own database, so they come along.
#
#  It also gives itself the Cosmodex icon, so it looks like Cosmodex in the
#  Dock rather than like a document.
#
#  Serving over http://localhost matters: opening index.html directly gives a
#  file:// page, where the browser refuses to store anything and no work saves.
#
#  If double-clicking does nothing, open Terminal and run once:
#      chmod +x "/path/to/start-cosmodex.command"
# ===========================================================================
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
SELF="$HERE/$(basename "$0")"
FIRST_PORT=8765
LAST_PORT=8774
LOCK="${TMPDIR:-/tmp}/cosmodex-start.lock"

pause() { echo; read -r -p "  Press Return to close."; }

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo
  echo "  Python was not found."
  echo "  Open Terminal, run:  python3 --version"
  echo "  If macOS offers to install developer tools, accept."
  pause
  exit 1
fi

# Is Cosmodex — not just anything — answering on this port?
ours()  { curl -s --max-time 1 "http://localhost:$1/" 2>/dev/null | grep -q "Cosmodex"; }
taken() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
running_port() {
  for p in $(seq $FIRST_PORT $LAST_PORT); do ours "$p" && { echo "$p"; return 0; }; done
  return 1
}

# Give this file the Cosmodex icon, so it does not sit in the Dock looking like
# a document. A custom icon is metadata git does not carry, so a pull that
# updates this file loses it — which is why it is checked on every run rather
# than set once. Done with the scripting bridge every Mac already has: no
# compiler, nothing installed.
give_icon() {
  local icns="$HERE/mac/CosmodexOffice.icns"
  [ -f "$icns" ] || return 0
  xattr -p com.apple.ResourceFork "$SELF" >/dev/null 2>&1 && return 0
  osascript -l JavaScript - "$icns" "$SELF" >/dev/null 2>&1 <<'JS'
function run(argv) {
  ObjC.import('AppKit');
  var img = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  $.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, argv[1], 0);
}
JS
}

# A second click opens a second Terminal window. Once it has done its job —
# bringing the page back — it should not linger. It is closed a moment AFTER
# this script ends, because closing a window with something still running in
# it makes Terminal ask whether to kill it. nohup, because the end of this
# script hangs up everything still attached to its window.
close_window() {
  local me; me="$(tty 2>/dev/null)" || return 0
  nohup osascript \
    -e 'on run argv' \
    -e '  delay 0.6' \
    -e '  tell application "Terminal"' \
    -e '    repeat with w in windows' \
    -e '      if (tty of tabs of w) contains (item 1 of argv) then close w' \
    -e '    end repeat' \
    -e '  end tell' \
    -e 'end run' "$me" >/dev/null 2>&1 &
}

give_icon

# --- 1. Already running? Bring it back. ------------------------------------
if P="$(running_port)"; then
  echo
  echo "  Cosmodex is already running — opening it."
  open "http://localhost:$P/"
  close_window
  exit 0
fi

# --- 2. Only one start at a time. ------------------------------------------
# A double-click launches this twice within a fraction of a second, before
# either copy's server is up for the other to see. Without this, the second
# finds 8765 taken by the first — still starting — and either fails or starts
# a rival server on the next port against the same database. mkdir is atomic:
# exactly one copy gets the lock, and the other waits for it.
take_lock() { mkdir "$LOCK" 2>/dev/null && echo $$ > "$LOCK/pid"; }
drop_lock() { [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"; }

if ! take_lock; then
  OTHER="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$OTHER" ] && kill -0 "$OTHER" 2>/dev/null; then
    # Another click is starting it right now. It will open the page itself.
    for _ in $(seq 1 75); do
      if running_port >/dev/null; then close_window; exit 0; fi
      sleep 0.2
    done
    echo
    echo "  Cosmodex is still starting in another Terminal window."
    pause
    exit 1
  fi
  # The lock was left by a start that never finished. Take it over.
  rm -rf "$LOCK"
  take_lock || { echo; echo "  Could not start Cosmodex — please try again."; pause; exit 1; }
fi
trap drop_lock EXIT

# --- 3. A free port. --------------------------------------------------------
PORT=""
for p in $(seq $FIRST_PORT $LAST_PORT); do taken "$p" || { PORT=$p; break; }; done
if [ -z "$PORT" ]; then
  echo
  echo "  Every port from $FIRST_PORT to $LAST_PORT is in use by other programs."
  pause
  exit 1
fi
if [ "$PORT" != "$FIRST_PORT" ]; then
  echo
  echo "  Port $FIRST_PORT is in use by another program, so Cosmodex is using $PORT."
fi

# Once the server answers: open the page, and let the next click through.
(
  for _ in $(seq 1 75); do ours "$PORT" && break; sleep 0.2; done
  drop_lock
  ours "$PORT" && open "http://localhost:$PORT/"
) &

COSMODEX_PORT="$PORT" "$PY" cosmodex-server.py || {
  echo
  echo "  The server stopped. The message above says why."
  pause
}
