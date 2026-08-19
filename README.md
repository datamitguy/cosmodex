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

**Locally** — anything that serves over http will do:

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000`.

**Do not open `index.html` with `file://`.** Chrome treats file URLs as an
opaque origin, so IndexedDB is unavailable and nothing will save. The app will
appear to work and then lose everything.

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

- No sync of any kind. This install and the Firebase one are separate worlds.
- No iCloud Reminders / calendar sync (that runs server-side against Firestore).
- No service worker, so no offline shell caching. The page still works offline
  once loaded; it just isn't installed as a PWA.
- Data is per-browser-profile. A different browser is a different Cosmodex.
