/* ═══════════════════════════════════════════════════════════════════════════
   COSMODEX LITE — folder storage (File System Access API)
   Gives the browser build a real home on disk, so data outlives the browser
   profile. You pick a folder once (a OneDrive-synced one is ideal); the handle
   is kept in IndexedDB, so the choice persists — Chrome only re-asks for
   permission, never for the folder.

   Layout inside the folder you choose:
       data/cosmodex.json     every record, rewritten on change (debounced)
       notes/YYYY-MM-DD.md    daily notes, plain markdown
       notes/_template.md     seed used when creating a new day
       notes/_captures.md     the running capture inbox

   The notes half also backs the daily-note panel: build.sh repoints that
   module's _invoke() at CDX_FILES_INVOKE below, so the editor, preview and
   template flow work unchanged — with files on disk instead of an iCloud vault.

   Requires Chrome or Edge (Firefox and Safari have no File System Access API)
   and an http/https origin — file:// cannot use it.
   ═══════════════════════════════════════════════════════════════════════════ */
(function cosmodexLocalFiles() {
  'use strict';

  var CFG_DB = 'cosmodex-lite-fs', CFG_STORE = 'config', CFG_KEY = 'root';
  var SAVE_DEBOUNCE = 1500;

  var root = null, dirData = null, dirNotes = null;
  var saveTimer = null, needsGesture = false;

  var supported = typeof window.showDirectoryPicker === 'function';

  /* ── handle persistence ──────────────────────────────────────────────── */
  function cfgDB() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(CFG_DB, 1);
      rq.onupgradeneeded = function () {
        if (!rq.result.objectStoreNames.contains(CFG_STORE)) rq.result.createObjectStore(CFG_STORE);
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function saveHandle(h) {
    return cfgDB().then(function (db) {
      // FileSystemDirectoryHandle is structured-cloneable, so IndexedDB can hold
      // it directly — this is what makes "configure once" possible.
      db.transaction(CFG_STORE, 'readwrite').objectStore(CFG_STORE).put(h, CFG_KEY);
    });
  }
  function loadHandle() {
    return cfgDB().then(function (db) {
      return new Promise(function (res) {
        var rq = db.transaction(CFG_STORE, 'readonly').objectStore(CFG_STORE).get(CFG_KEY);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }
  function forgetHandle() {
    return cfgDB().then(function (db) {
      db.transaction(CFG_STORE, 'readwrite').objectStore(CFG_STORE).delete(CFG_KEY);
    }).catch(function () {});
  }

  /* ── file helpers ────────────────────────────────────────────────────── */
  function subdir(name) { return root.getDirectoryHandle(name, { create: true }); }

  function readText(dir, name) {
    return dir.getFileHandle(name).then(function (fh) { return fh.getFile(); })
      .then(function (f) { return f.text(); })
      .catch(function () { return null; });       // missing file reads as null
  }
  function writeText(dir, name, text) {
    return dir.getFileHandle(name, { create: true })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) { return w.write(text).then(function () { return w.close(); }); });
  }

  /* ── record mirror ───────────────────────────────────────────────────── */
  function saveRecords() {
    if (!dirData) return Promise.resolve();
    var payload = { version: 1, savedAt: new Date().toISOString(), docs: window.__cdxLiteDump() };
    return writeText(dirData, 'cosmodex.json', JSON.stringify(payload, null, 2))
      .then(function () { status('Saved to folder', true); })
      .catch(function (e) { status('Folder write failed', false); console.error('cosmodex-lite: folder write failed', e); });
  }
  function scheduleSave() {
    if (!dirData) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveRecords, SAVE_DEBOUNCE);
  }

  function loadRecords() {
    return readText(dirData, 'cosmodex.json').then(function (txt) {
      if (!txt) return saveRecords();           // first run — seed the file
      var docs;
      try { docs = (JSON.parse(txt) || {}).docs || {}; }
      catch (e) { console.error('cosmodex-lite: cosmodex.json is not valid JSON — leaving it alone.', e); return; }
      // Only adopt the file wholesale if this session hasn't written anything;
      // otherwise a late reconnect would clobber work done before connecting.
      var replace = window.__cdxLiteWrites() === 0;
      var n = window.__cdxLiteLoad(docs, replace);
      status('Loaded ' + n + ' records from folder', true);
      if (!replace) scheduleSave();
    });
  }

  /* ── connect ─────────────────────────────────────────────────────────── */
  function attach(handle) {
    root = handle;
    return subdir('data').then(function (d) { dirData = d; return subdir('notes'); })
      .then(function (n) { dirNotes = n; return loadRecords(); })
      .then(function () {
        needsGesture = false;
        render();
        if (window._dashRenderNote) window._dashRenderNote();
      });
  }

  function choose() {
    if (!supported) {
      alert('This browser has no File System Access API. Use Chrome or Edge.');
      return Promise.resolve();
    }
    return window.showDirectoryPicker({ mode: 'readwrite' })
      .then(function (h) { return saveHandle(h).then(function () { return attach(h); }); })
      .then(function () { if (window.showToast) showToast('Folder connected', 'success'); })
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;   // user cancelled the picker
        console.error('cosmodex-lite: folder connect failed', e);
        if (window.showToast) showToast('Could not connect that folder', 'error');
      });
  }

  function reconnect() {
    if (!supported) return Promise.resolve();
    return loadHandle().then(function (h) {
      if (!h) return;
      return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
        if (p === 'granted') return attach(h);
        // Chrome requires a user gesture to re-grant — surface a button.
        needsGesture = true;
        render();
      });
    }).catch(function (e) { console.warn('cosmodex-lite: reconnect failed', e); });
  }

  function regrant() {
    return loadHandle().then(function (h) {
      if (!h) return choose();
      return h.requestPermission({ mode: 'readwrite' }).then(function (p) {
        if (p === 'granted') return attach(h);
        if (window.showToast) showToast('Folder access denied', 'error');
      });
    });
  }

  function disconnect() {
    clearTimeout(saveTimer);
    root = dirData = dirNotes = null;
    needsGesture = false;
    return forgetHandle().then(render);
  }

  /* ── daily notes — the five commands 17-daily-note.js calls ──────────── */
  function noteName(date) { return date + '.md'; }
  window.CDX_FILES_INVOKE = function (cmd, args) {
    args = args || {};
    if (!dirNotes) return Promise.reject(new Error('No folder connected'));
    switch (cmd) {
      case 'read_daily_note':    return readText(dirNotes, noteName(args.date));
      case 'write_daily_note':   return writeText(dirNotes, noteName(args.date), args.content || '');
      case 'read_daily_template':return readText(dirNotes, '_template.md').then(function (t) { return t || ''; });
      case 'read_capture_file':  return readText(dirNotes, '_captures.md').then(function (t) { return t || ''; });
      case 'write_capture_file': return writeText(dirNotes, '_captures.md', args.content || '');
      default: return Promise.reject(new Error('Unsupported command: ' + cmd));
    }
  };
  // 17-daily-note.js tests this for truthiness to decide filesystem vs hint.
  window.CDX_FILES_READY = function () { return dirNotes ? window.CDX_FILES_INVOKE : null; };

  /* ── settings UI ─────────────────────────────────────────────────────── */
  function status(text, ok) {
    var l = document.getElementById('cdx-fs-status');
    if (l) { l.textContent = text; l.style.color = ok === false ? 'var(--neon)' : 'var(--muted)'; }
  }
  function render() {
    var dot = document.getElementById('cdx-fs-dot');
    var label = document.getElementById('cdx-fs-label');
    var pick = document.getElementById('cdx-fs-pick');
    var drop = document.getElementById('cdx-fs-disconnect');
    if (!label) return;
    if (root) {
      label.textContent = 'Connected — ' + root.name + '/';
      if (dot) dot.style.background = '#ffffff';
      if (pick) pick.textContent = '📁 Change folder…';
      if (drop) drop.style.display = '';
    } else if (needsGesture) {
      label.textContent = 'Folder saved — click to restore access';
      if (dot) dot.style.background = 'var(--neon)';
      if (pick) pick.textContent = '🔓 Reconnect folder';
      if (drop) drop.style.display = '';
    } else {
      label.textContent = supported ? 'Not connected — data lives only in this browser'
                                    : 'Not supported in this browser (use Chrome or Edge)';
      if (dot) dot.style.background = 'var(--gold-dim)';
      if (pick) pick.textContent = '📁 Choose folder…';
      if (drop) drop.style.display = 'none';
    }
  }

  function wire() {
    var pick = document.getElementById('cdx-fs-pick');
    if (pick) pick.onclick = function () { return needsGesture ? regrant() : choose(); };
    var save = document.getElementById('cdx-fs-save');
    if (save) save.onclick = function () { saveRecords(); };
    var drop = document.getElementById('cdx-fs-disconnect');
    if (drop) drop.onclick = function () {
      cdxConfirm('Disconnect the folder? Files already written stay where they are.')
        .then(function (ok) { if (ok) disconnect(); });
    };
    render();
  }

  function boot() {
    wire();
    window.__cdxLiteOnChange(scheduleSave);
    // Last-moment flush: a debounced save must not be lost on tab close.
    window.addEventListener('pagehide', function () { if (dirData) saveRecords(); });
    reconnect();
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
