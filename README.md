# Cosmodex Lite

Cosmodex without Firebase. A small Python server stores everything in a SQLite
file and writes your daily notes as real markdown. No sign-in, no cloud, no
install — Python's standard library already contains SQLite and a web server.

Built for a locked-down work laptop: no admin rights, no approved-library
request, no Google login.

## What it is

`cosmodex-server.py` serves the app *and* owns its data. Serving both from one
origin avoids cross-origin rules, mixed-content rules and Chrome's
private-network preflight — three places corporate policy can say no.

`sqlite-store.js` reimplements the slice of the Firestore API Cosmodex uses (18
functions) against that server. Every call in the app goes through one
`window.CDX_FB` object, so ~118 call sites across 11 modules are untouched.

## Where things live

    data/cosmodex.db        every record
    notes/2026-08/2026-08-21.md   daily notes, one folder per month
    notes/_template.md      seeds a new day, if present
    notes/_captures.md      the running capture inbox
    backups/                dated copies, written on every start

Override with environment variables before launching:

    COSMODEX_DB      COSMODEX_NOTES      COSMODEX_BACKUPS      COSMODEX_PORT

Keep the live database on a local disk, not inside OneDrive — SQLite writes
`-wal` and `-shm` files alongside it and a sync client can upload them out of
step. Point `COSMODEX_BACKUPS` at OneDrive instead; those copies are made with
SQLite's own backup API and are safe to sync.

## Running it

**GitHub Pages** — serve this repo's root. Nothing to build on their side; the
generated files are committed.

**On Windows** — double-click `start-cosmodex.bat` (see below).

**By hand:**

```bash
python3 cosmodex-server.py
```

then open `http://localhost:8765`.

**Do not open `index.html` with `file://`.** Chrome treats file URLs as an
opaque origin, so IndexedDB is unavailable and nothing will save. The app will
appear to work and then lose everything.

## Moving to another machine

Copy the whole folder — `data/cosmodex.db` and `notes/` come with it. Start the
server on the new machine and everything is there, preferences included.

The JSON Backup button still works and is a reasonable belt-and-braces export,
but the database file is the real answer now.

Data left in the old browser-only build is migrated automatically the first
time the server starts with an empty database.

## Starting it

`start-cosmodex.bat` on Windows, `start-cosmodex.command` on macOS. Both find
Python, serve this folder on port 8765, and open the browser.

## start-cosmodex.bat (Windows)

Put the folder anywhere and double-click the batch file. It finds Python
(`py`, `python` or `python3`), serves this folder on port 8765, and opens the
browser at `http://localhost:8765/`. Close the window to stop it.

To get an icon: right-click the .bat -> Send to -> Desktop (create shortcut),
then right-click the shortcut -> Properties, set **Run: Minimized**, and use
**Change Icon...** to pick something. Pin it to the taskbar from there.

To start it at login, press Win+R, run `shell:startup`, and drop the shortcut
in that folder.

Change `PORT` at the top of the .bat if 8765 is taken.

## Backing up

Bottom-right of the window: **⤓ Backup** downloads every record as JSON,
**⤒ Restore** loads one back. Also available as `cosmodexLiteExport()` and
`cosmodexLiteImport(file)` in the console.

Use it. IndexedDB is per-browser-profile and corporate IT can wipe it without
warning. This is also the only bridge between this build and the Firebase one —
there is no sync.

## Rebuilding

Source of truth is `../Cosmodex-v2`. Edit there, then:

```bash
./build.sh
```

which concatenates `src/*.js` into `app.js`, copies `styles.css`, and rewrites
`cosmodex-v2.html` into `index.html` — replacing the Firebase ESM bootstrap with
`local-store.js`, dropping the service-worker registration, and tightening the
CSP. Commit the regenerated files.

## What does not work here

- **No folder storage.** The File System Access API is blocked by enterprise
  policy on the target machine (`NotAllowedError` from `showDirectoryPicker`),
  so writing records or markdown notes to a real folder is not possible from
  the browser here. Backup/Restore below is the durability story instead.
- **No daily notes.** They are files, so the same block applies. The panel shows
  its desktop-only hint.

- No sync of any kind. This install and the Firebase one are separate worlds.
- No iCloud Reminders / calendar sync (that runs server-side against Firestore).
- No service worker, so no offline shell caching. The page still works offline
  once loaded; it just isn't installed as a PWA.
- Data is per-browser-profile. A different browser is a different Cosmodex.
