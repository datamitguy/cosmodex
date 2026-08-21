#!/usr/bin/env python3
"""
Cosmodex — local server.

Serves the app AND stores its data, so the browser never has to. Standard
library only: sqlite3 and http.server both ship with Python, so there is
nothing to install and nothing to get approved.

Why one process for both: if the page came from somewhere else and called this
server, you would hit cross-origin rules, mixed-content rules and Chrome's
private-network preflight. Serving the page from the same origin as its own API
makes all three disappear.

Where things live (override with environment variables):

    COSMODEX_DB      records      default:  ./data/cosmodex.db
    COSMODEX_NOTES   markdown     default:  ./notes
    COSMODEX_PORT    port         default:  8765

Notes are real markdown files, one per day, in a folder per month:

    notes/2026-08/2026-08-21.md
    notes/2026-09/2026-09-01.md
    notes/_template.md          seeds a new day
    notes/_captures.md          the running inbox

Keep the database on a local disk, not inside OneDrive: SQLite writes
cosmodex.db-wal and -shm alongside the main file and a sync client can upload
them out of step. Backups are written to COSMODEX_BACKUPS (default ./backups)
using SQLite's own backup API, which is safe to copy anywhere.
"""

import json
import os
import re
import sqlite3
import sys
import threading
from datetime import datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("COSMODEX_DB", os.path.join(HERE, "data", "cosmodex.db"))
NOTES_ROOT = os.environ.get("COSMODEX_NOTES", os.path.join(HERE, "notes"))
BACKUP_DIR = os.environ.get("COSMODEX_BACKUPS", os.path.join(HERE, "backups"))
PORT = int(os.environ.get("COSMODEX_PORT", "8765"))

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_lock = threading.Lock()


# ── storage ────────────────────────────────────────────────────────────────
def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, data TEXT NOT NULL)")
    con.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
    con.commit()
    return con


DB = connect()


def all_docs():
    with _lock:
        rows = DB.execute("SELECT path, data FROM docs").fetchall()
    return {p: json.loads(d) for p, d in rows}


def put_doc(path, data):
    with _lock:
        DB.execute("INSERT INTO docs(path, data) VALUES(?,?) "
                   "ON CONFLICT(path) DO UPDATE SET data=excluded.data",
                   (path, json.dumps(data)))
        DB.commit()


def delete_doc(path):
    with _lock:
        DB.execute("DELETE FROM docs WHERE path=?", (path,))
        DB.commit()


def all_settings():
    with _lock:
        rows = DB.execute("SELECT key, value FROM settings").fetchall()
    return dict(rows)


def put_settings(mapping):
    with _lock:
        DB.executemany("INSERT INTO settings(key, value) VALUES(?,?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       list(mapping.items()))
        DB.commit()


def backup():
    """A consistent single-file copy, safe to put in OneDrive."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    dest = os.path.join(BACKUP_DIR, "cosmodex-%s.db" % datetime.now().strftime("%Y-%m-%d"))
    with _lock, sqlite3.connect(dest) as out:
        DB.backup(out)
    return dest


# ── notes ──────────────────────────────────────────────────────────────────
def note_path(date_str):
    """notes/YYYY-MM/YYYY-MM-DD.md — one folder per month."""
    if not DATE_RE.match(date_str or ""):
        raise ValueError("bad date")
    return os.path.join(NOTES_ROOT, date_str[:7], date_str + ".md")


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def write_text(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Write beside the target then replace, so an interrupted save cannot
    # truncate a day's note to nothing.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.replace(tmp, path)


# ── http ───────────────────────────────────────────────────────────────────
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *args):
        if "/api/" not in (self.path or ""):
            return
        sys.stderr.write("  %s\n" % (fmt % args))

    # -- helpers --
    def _send(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    # -- routes --
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not u.path.startswith("/api/"):
            # Never serve the database or the notes over http.
            if u.path.startswith(("/data", "/backups")):
                self.send_error(404)
                return
            return super().do_GET()

        if u.path == "/api/docs":
            return self._send({"docs": all_docs(), "settings": all_settings()})

        if u.path == "/api/config":
            return self._send({"db": DB_PATH, "notes": NOTES_ROOT, "backups": BACKUP_DIR})

        if u.path == "/api/note":
            try:
                content = read_text(note_path((q.get("date") or [""])[0]))
            except ValueError:
                return self._send({"error": "bad date"}, 400)
            return self._send({"content": content})

        if u.path == "/api/template":
            return self._send({"content": read_text(os.path.join(NOTES_ROOT, "_template.md"))})

        if u.path == "/api/captures":
            return self._send({"content": read_text(os.path.join(NOTES_ROOT, "_captures.md")) or ""})

        return self._send({"error": "unknown route"}, 404)

    def do_PUT(self):
        u = urlparse(self.path)
        try:
            body = self._body()
        except Exception:
            return self._send({"error": "bad json"}, 400)

        if u.path == "/api/doc":
            put_doc(body["path"], body["data"])
            return self._send({"ok": True})

        if u.path == "/api/settings":
            put_settings({k: str(v) for k, v in (body.get("settings") or {}).items()})
            return self._send({"ok": True})

        if u.path == "/api/note":
            try:
                write_text(note_path(body.get("date")), body.get("content") or "")
            except ValueError:
                return self._send({"error": "bad date"}, 400)
            return self._send({"ok": True})

        if u.path == "/api/captures":
            write_text(os.path.join(NOTES_ROOT, "_captures.md"), body.get("content") or "")
            return self._send({"ok": True})

        return self._send({"error": "unknown route"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self._body()
        except Exception:
            return self._send({"error": "bad json"}, 400)

        # One-shot import: the IndexedDB migration and JSON restore both land here.
        if u.path == "/api/import":
            docs = body.get("docs") or {}
            with _lock:
                DB.executemany(
                    "INSERT INTO docs(path, data) VALUES(?,?) "
                    "ON CONFLICT(path) DO UPDATE SET data=excluded.data",
                    [(p, json.dumps(d)) for p, d in docs.items()])
                DB.commit()
            put_settings({k: str(v) for k, v in (body.get("settings") or {}).items()})
            return self._send({"ok": True, "docs": len(docs)})

        if u.path == "/api/backup":
            return self._send({"ok": True, "path": backup()})

        return self._send({"error": "unknown route"}, 404)

    def do_DELETE(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/doc":
            delete_doc((q.get("path") or [""])[0])
            return self._send({"ok": True})
        return self._send({"error": "unknown route"}, 404)


def main():
    os.makedirs(NOTES_ROOT, exist_ok=True)
    try:
        made = backup()
    except Exception as exc:                      # never block startup on a backup
        made = "skipped (%s)" % exc
    counts = all_docs()
    print()
    print("  Cosmodex is running at http://localhost:%d/" % PORT)
    print()
    print("  records   %d  in  %s" % (len(counts), DB_PATH))
    print("  notes         %s" % NOTES_ROOT)
    print("  backup        %s" % made)
    print()
    print("  Keep this window open. Close it to stop.")
    print()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
