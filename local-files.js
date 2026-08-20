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
      return new Promise(function (res, rej) {
        // FileSystemDirectoryHandle is structured-cloneable, so IndexedDB can
        // hold it directly — this is what makes "configure once" possible.
        var tx = db.transaction(CFG_STORE, 'readwrite');
        tx.objectStore(CFG_STORE).put(h, CFG_KEY);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error || new Error('Could not remember the folder')); };
      });
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
    return subdir('data')
      .catch(function (e) { var w = new Error('subdir'); w.__step = 'subdir'; w.__e = e; throw w; })
      .then(function (d) { dirData = d; return subdir('notes')
        .catch(function (e) { var w = new Error('subdir'); w.__step = 'subdir'; w.__e = e; throw w; }); })
      .then(function (n) { dirNotes = n; return loadRecords(); })
      .then(function () {
        needsGesture = false;
        render();
        if (window._dashRenderNote) window._dashRenderNote();
      });
  }

  // Turn a DOMException into something that says what to do about it. The
  // failures here are all environmental, so a generic message is useless.
  function explain(step, e) {
    var name = (e && e.name) || 'Error', msg = (e && e.message) || String(e);
    if (name === 'SecurityError') {
      return 'Blocked by browser policy. Managed Chrome/Edge can switch file access off for every site '
           + '(DefaultFileSystemWriteGuardSetting). No app-side fix exists — ' + name + ': ' + msg;
    }
    if (name === 'NotAllowedError' && step === 'pick') {
      return 'The browser refused to open the folder picker — usually enterprise policy, sometimes a '
           + 'blocked pop-up. Check chrome://policy for FileSystem settings. ' + name + ': ' + msg;
    }
    if (step === 'permission') {
      return 'Folder access was not granted. Re-pick it and choose "Edit files" in the prompt. ' + name + ': ' + msg;
    }
    if (name === 'NotAllowedError' && step === 'subdir') {
      return 'The folder was opened read-only. Re-pick it and choose "Edit files" (not "View files") '
           + 'in Chrome\'s permission prompt.';
    }
    if (name === 'NotAllowedError') return 'Permission was not granted — ' + name + ': ' + msg;
    if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') {
      return 'The folder is locked or syncing. A OneDrive folder set to "Free up space" can do this — '
           + 'try a normal local folder first. ' + name + ': ' + msg;
    }
    if (name === 'TypeMismatchError') return 'That is a file, not a folder. Pick a folder.';
    return name + ': ' + msg;
  }

  function fail(step, e) {
    console.error('cosmodex-lite: folder connect failed at step "' + step + '"', e);
    var why = explain(step, e);
    status(why, false);
    if (window.showToast) showToast(why, 'error', 9000);
    window.__cdxFsLastError = { step: step, name: e && e.name, message: e && e.message, explain: why };
  }

  function choose() {
    if (!supported) {
      var m = 'This browser has no File System Access API — use Chrome or Edge over http/https (not file://).';
      status(m, false);
      if (window.showToast) showToast(m, 'error', 9000);
      return Promise.resolve();
    }
    var picked = null;
    return window.showDirectoryPicker({ mode: 'readwrite' })
      .catch(function (e) { if (e && e.name === 'AbortError') { picked = 'abort'; return null; } throw { step: 'pick', e: e }; })
      .then(function (h) {
        if (!h) return null;
        picked = h;
        // Ask explicitly: the picker can hand back a read-only grant, and we
        // only find out later when creating a subfolder fails.
        return h.requestPermission({ mode: 'readwrite' })
          .catch(function (e) { throw { step: 'permission', e: e }; })
          .then(function (p) {
            if (p !== 'granted') throw { step: 'permission', e: { name: 'NotAllowedError', message: 'permission is "' + p + '"' } };
            return h;
          });
      })
      .then(function (h) {
        if (!h) return null;
        return saveHandle(h).catch(function (e) { throw { step: 'remember', e: e }; }).then(function () { return h; });
      })
      .then(function (h) {
        if (!h) return null;
        return attach(h).catch(function (e) { throw { step: e && e.__step ? e.__step : 'attach', e: e && e.__e ? e.__e : e }; });
      })
      .then(function (h) {
        if (h === null && picked === 'abort') return;      // user cancelled
        status('Connected', true);
        if (window.showToast) showToast('Folder connected', 'success');
      })
      .catch(function (w) { fail((w && w.step) || 'connect', (w && w.e) || w); });
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

  // Paste-able environment report for debugging a refusal.
  window.cosmodexLiteDiag = function () {
    return {
      origin: location.origin,
      secureContext: window.isSecureContext,
      hasPicker: typeof window.showDirectoryPicker === 'function',
      hasIndexedDB: typeof indexedDB !== 'undefined',
      userAgent: navigator.userAgent,
      connected: !!root,
      lastError: window.__cdxFsLastError || null,
    };
  };

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
