# Cosmodex Lite

Cosmodex with the Firebase layer removed. No sign-in, no network, no backend —
everything lives in the browser's IndexedDB on the machine you open it on.

Built for a locked-down work laptop: no install, no admin rights, no Google
login. Open a URL, use the app.

## What it is

`local-store.js` reimplements the exact slice of the Firestore API Cosmodex
uses (18 functions) on top of IndexedDB, and fakes an always-signed-in local
user. Because every Firestore call in the app goes through the single
`window.CDX_FB` object, swapping that object leaves ~118 call sites across 11
modules working untouched.

The Content-Security-Policy in `index.html` is narrowed to `connect-src 'self'`
— the policy is the proof that nothing leaves the machine.

## Running it

**GitHub Pages** — serve this repo's root. Nothing to build on their side; the
generated files are committed.

**On Windows** — double-click `start-cosmodex.bat` (see below).

**Locally, by hand** — anything that serves over http will do:

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000`.

**Do not open `index.html` with `file://`.** Chrome treats file URLs as an
opaque origin, so IndexedDB is unavailable and nothing will save. The app will
appear to work and then lose everything.

## Moving to another machine

Backup carries everything: records *and* preferences (categories, people,
settings). Restore on the new machine, which reloads once it lands.

The two machines are separate stores — there is no sync. Whichever you export
from last is the one that wins, so export on the old machine the same day you
import on the new one.

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
