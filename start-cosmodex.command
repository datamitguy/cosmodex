#!/bin/bash
# ===========================================================================
#  Cosmodex — start a local server and open the app.  (macOS)
#
#  Double-click this file in Finder. The Terminal window that opens IS the
#  server — leave it open, close it to stop.
#
#  Serving over http://localhost matters: opening index.html directly gives a
#  file:// page, where the browser refuses to store anything and no work saves.
#
#  If double-clicking does nothing, open Terminal and run once:
#      chmod +x "/path/to/start-cosmodex.command"
# ===========================================================================
cd "$(dirname "$0")" || exit 1

PORT=8765

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo
  echo "  Python was not found."
  echo "  Open Terminal, run:  python3 --version"
  echo "  If macOS offers to install developer tools, accept."
  echo
  read -r -p "  Press Return to close."
  exit 1
fi

# Open the browser once the server has had a moment to bind.
( sleep 2; open "http://localhost:${PORT}/" ) &

COSMODEX_PORT="$PORT" "$PY" cosmodex-server.py || {
  echo
  echo "  The server stopped. Port ${PORT} may be in use —"
  echo "  edit this file and change PORT to 8766."
  echo
  read -r -p "  Press Return to close."
}
