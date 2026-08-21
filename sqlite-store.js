/* ═══════════════════════════════════════════════════════════════════════════
   COSMODEX LITE — SQLite store
   A drop-in replacement for the Firebase layer. Implements the exact slice of
   the Firestore API that Cosmodex uses (18 functions) against the local Python
   server, and fakes an always-signed-in user.

   The working set is held in memory for synchronous queries (as Firestore's
   cache does); every write is mirrored to cosmodex-server.py, which owns the
   SQLite file. IndexedDB is no longer the system of record — it is read once,
   at first run, to migrate anything left over from the browser-only build.

   WHY this shape: every Firestore call in the app goes through the single
   frozen object window.CDX_FB. Replace that object and ~118 call sites across
   11 modules keep working untouched. Same trick as src/00-tauri-shim.js.

   Boot contract the app expects (see cosmodex-v2.html's ESM block):
     1. window.CDX_DB / CDX_AUTH / CDX_FB exist
     2. window.CDX_USER = { uid }
     3. window dispatches 'cdx-auth-ready'

   Data lives in a real SQLite file on disk, so clearing the browser changes
   nothing. The server also takes a dated backup copy on every start.
   ═══════════════════════════════════════════════════════════════════════════ */
(function cosmodexLocalStore() {
  'use strict';

  var DB_NAME = 'cosmodex-lite', DB_VER = 1, STORE = 'docs', UID = 'local';

  var MEM = new Map();      // full path -> plain data object (the working set)
  var LISTENERS = [];       // { path, isColl, fire }
  var idb = null;

  /* ── Firestore Timestamp lookalike ───────────────────────────────────────
     20-backup.js and others read .seconds / .toDate(), so match that shape. */
  function TS(d) {
    d = d || new Date();
    var ms = d.getTime();
    return {
      seconds: Math.floor(ms / 1000), nanoseconds: 0,
      toDate: function () { return new Date(ms); },
      toMillis: function () { return ms; },
    };
  }
  function isTsLike(v) { return v && typeof v === 'object' && v.seconds !== undefined && typeof v.toMillis === 'function'; }
  function isStoredTs(v) { return v && typeof v === 'object' && typeof v.__ts === 'number'; }
  function tsMillis(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (isStoredTs(v)) return v.__ts;
    if (typeof v === 'string') return Date.parse(v) || 0;
    if (v.toMillis) return v.toMillis();
    if (v.seconds) return v.seconds * 1000;
    if (v instanceof Date) return v.getTime();
    return 0;
  }

  /* ── write sentinels ─────────────────────────────────────────────────── */
  function serverTimestamp() { return { __cdx: 'ts' }; }
  function deleteField()     { return { __cdx: 'del' }; }
  function arrayUnion()      { return { __cdx: 'union',  items: [].slice.call(arguments) }; }
  function arrayRemove()     { return { __cdx: 'remove', items: [].slice.call(arguments) }; }
  function isSentinel(v)     { return v && typeof v === 'object' && typeof v.__cdx === 'string'; }

  // Everything entering MEM must survive structured clone (IndexedDB), so a
  // Timestamp collapses to {__ts}. Anything with methods would throw on put()
  // and the write would be lost silently — which is exactly what happened.
  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return new Date(v.getTime());
    if (isTsLike(v)) return { __ts: v.toMillis() };
    if (Array.isArray(v)) return v.map(clone);
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = clone(v[k]);
    return o;
  }

  // The reverse, applied only when handing data back to the app.
  function hydrate(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return new Date(v.getTime());
    if (isStoredTs(v)) return TS(new Date(v.__ts));
    if (Array.isArray(v)) return v.map(hydrate);
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = hydrate(v[k]);
    return o;
  }

  // Resolve sentinels against the value already stored at that key.
  function resolve(val, prev) {
    if (!isSentinel(val)) return clone(val);
    if (val.__cdx === 'ts') return { __ts: Date.now() };
    if (val.__cdx === 'del') return undefined;
    var arr = Array.isArray(prev) ? prev.slice() : [];
    if (val.__cdx === 'union') {
      val.items.forEach(function (it) {
        var s = JSON.stringify(it);
        if (!arr.some(function (x) { return JSON.stringify(x) === s; })) arr.push(clone(it));
      });
      return arr;
    }
    if (val.__cdx === 'remove') {
      return arr.filter(function (x) {
        return !val.items.some(function (it) { return JSON.stringify(it) === JSON.stringify(x); });
      });
    }
    return clone(val);
  }

  // updateDoc accepts dotted paths: { 'completions.abc': deleteField() }
  function setDeep(obj, dotted, val) {
    var parts = dotted.split('.'), cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    var last = parts[parts.length - 1];
    var out = resolve(val, cur[last]);
    if (out === undefined) delete cur[last]; else cur[last] = out;
  }

  function mergeInto(target, data) {
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      var out = resolve(data[k], target[k]);
      if (out === undefined) delete target[k]; else target[k] = out;
    }
    return target;
  }
  function resolveAll(data) { return mergeInto({}, data); }

  /* ── refs ────────────────────────────────────────────────────────────── */
  function collection(_db) {
    var segs = [].slice.call(arguments, 1);
    return { __coll: true, path: segs.join('/') };
  }
  function doc(a) {
    var segs = [].slice.call(arguments, 1);
    var base = (a && a.__coll) ? a.path : null;
    var path = base ? base + '/' + segs.join('/') : segs.join('/');
    if (base && !segs.length) path = base + '/' + newId();
    var parts = path.split('/');
    return { __doc: true, path: path, id: parts[parts.length - 1] };
  }
  function newId() {
    var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', s = '';
    for (var i = 0; i < 20; i++) s += c.charAt(Math.floor(Math.random() * c.length));
    return s;
  }
  function collPathOf(docPath) { return docPath.split('/').slice(0, -1).join('/'); }

  /* ── query constraints ───────────────────────────────────────────────── */
  function where(field, op, value) { return { __c: 'where', field: field, op: op, value: value }; }
  function orderBy(field, dir)     { return { __c: 'order', field: field, dir: dir || 'asc' }; }
  function limit(n)                { return { __c: 'limit', n: n }; }
  function query(src) {
    var cs = [].slice.call(arguments, 1).filter(Boolean);
    return { __query: true, path: src.path, constraints: (src.constraints || []).concat(cs) };
  }

  function fieldVal(data, field) {
    return field.split('.').reduce(function (o, k) { return (o == null ? undefined : o[k]); }, data);
  }
  function cmp(a, b) {
    var am = (isStoredTs(a) || isTsLike(a) || a instanceof Date) ? tsMillis(a) : a;
    var bm = (isStoredTs(b) || isTsLike(b) || b instanceof Date) ? tsMillis(b) : b;
    if (am === undefined || am === null) return (bm === undefined || bm === null) ? 0 : 1;
    if (bm === undefined || bm === null) return -1;
    return am < bm ? -1 : am > bm ? 1 : 0;
  }
  function passes(data, c) {
    var v = fieldVal(data, c.field);
    switch (c.op) {
      case '==':  return v === c.value;
      case '!=':  return v !== c.value;
      case '>':   return cmp(v, c.value) > 0;
      case '>=':  return cmp(v, c.value) >= 0;
      case '<':   return cmp(v, c.value) < 0;
      case '<=':  return cmp(v, c.value) <= 0;
      case 'in':  return Array.isArray(c.value) && c.value.indexOf(v) !== -1;
      case 'array-contains': return Array.isArray(v) && v.indexOf(c.value) !== -1;
      default:    return true;
    }
  }

  function docsIn(collPath, constraints) {
    var depth = collPath.split('/').length + 1, out = [];
    MEM.forEach(function (data, path) {
      if (path.indexOf(collPath + '/') !== 0) return;
      if (path.split('/').length !== depth) return;      // direct children only
      if (constraints && !constraints.every(function (c) {
        return c.__c !== 'where' || passes(data, c);
      })) return;
      out.push({ path: path, id: path.split('/').pop(), data: data });
    });
    (constraints || []).forEach(function (c) {
      if (c.__c === 'order') {
        out.sort(function (x, y) {
          var r = cmp(fieldVal(x.data, c.field), fieldVal(y.data, c.field));
          return c.dir === 'desc' ? -r : r;
        });
      }
    });
    var lim = (constraints || []).filter(function (c) { return c.__c === 'limit'; })[0];
    if (lim) out = out.slice(0, lim.n);
    return out;
  }

  /* ── snapshots ───────────────────────────────────────────────────────── */
  function docSnap(path) {
    var data = MEM.get(path);
    return {
      id: path.split('/').pop(),
      ref: { __doc: true, path: path, id: path.split('/').pop() },
      exists: function () { return data !== undefined; },
      data: function () { return data === undefined ? undefined : hydrate(data); },
    };
  }
  function collSnap(collPath, constraints) {
    var rows = docsIn(collPath, constraints);
    var docs = rows.map(function (r) {
      return {
        id: r.id,
        ref: { __doc: true, path: r.path, id: r.id },
        exists: function () { return true; },
        data: function () { return hydrate(r.data); },
      };
    });
    return {
      docs: docs, size: docs.length, empty: docs.length === 0,
      forEach: function (fn) { docs.forEach(fn); },
    };
  }

  /* ── persistence ─────────────────────────────────────────────────────── */
  /* ── server persistence ───────────────────────────────────────────────── */
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status);
      return r.json();
    });
  }

  // Writes are fire-and-forget so the UI stays instant, but a failure must be
  // loud: silently dropping a write is how people lose a day's work.
  var _failed = 0;
  function pushDoc(path) {
    var p = MEM.has(path)
      ? api('PUT', '/api/doc', { path: path, data: MEM.get(path) })
      : api('DELETE', '/api/doc?path=' + encodeURIComponent(path));
    p.catch(function (e) {
      _failed++;
      console.error('cosmodex: save failed', e);
      if (window.showToast) showToast('Not saved — is the Cosmodex window still open?', 'error', 8000);
    });
  }

  function openIDB() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'path' });
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  // The server owns the data now; IndexedDB is only read at migration time.
  function persist(path) { pushDoc(path); }

  /* ── change notification ─────────────────────────────────────────────── */
  function notify(path) {
    var cp = collPathOf(path);
    LISTENERS.slice().forEach(function (l) {
      if (l.isColl ? l.path === cp : l.path === path) {
        try { l.fire(); } catch (e) { console.warn('cosmodex-lite listener:', e); }
      }
    });
  }

  /* ── writes ──────────────────────────────────────────────────────────── */
  function writeDoc(path, data, opts) {
    var prev = MEM.get(path);
    var next = (opts && opts.merge && prev) ? mergeInto(clone(prev), data) : resolveAll(data);
    MEM.set(path, next);
    persist(path); notify(path);
  }
  function updateDocAt(path, data) {
    var cur = clone(MEM.get(path) || {});
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      if (k.indexOf('.') !== -1) setDeep(cur, k, data[k]);
      else {
        var out = resolve(data[k], cur[k]);
        if (out === undefined) delete cur[k]; else cur[k] = out;
      }
    }
    MEM.set(path, cur);
    persist(path); notify(path);
  }
  function deleteDocAt(path) { MEM.delete(path); persist(path); notify(path); }

  /* ── the public API — same names and shapes as firebase/firestore ────── */
  function setDoc(ref, data, opts)   { writeDoc(ref.path, data, opts);  return Promise.resolve(); }
  function updateDoc(ref, data)      { updateDocAt(ref.path, data);     return Promise.resolve(); }
  function deleteDoc(ref)            { deleteDocAt(ref.path);           return Promise.resolve(); }
  function addDoc(collRef, data) {
    var path = collRef.path + '/' + newId();
    writeDoc(path, data);
    return Promise.resolve({ __doc: true, path: path, id: path.split('/').pop() });
  }
  function getDoc(ref)  { return Promise.resolve(docSnap(ref.path)); }
  function getDocs(src) { return Promise.resolve(collSnap(src.path, src.constraints)); }

  function onSnapshot(src, cb, errCb) {
    var isColl = !src.__doc;
    var fire = isColl
      ? function () { cb(collSnap(src.path, src.constraints)); }
      : function () { cb(docSnap(src.path)); };
    var entry = { path: src.path, isColl: isColl, fire: fire };
    LISTENERS.push(entry);
    Promise.resolve().then(function () {
      try { fire(); } catch (e) { if (errCb) errCb(e); else console.warn(e); }
    });
    return function unsubscribe() {
      var i = LISTENERS.indexOf(entry);
      if (i !== -1) LISTENERS.splice(i, 1);
    };
  }

  function runTransaction(_db, fn) {
    // Single-threaded and local: no contention, so run the body directly.
    return Promise.resolve(fn({
      get:    function (ref) { return Promise.resolve(docSnap(ref.path)); },
      set:    function (ref, data, opts) { writeDoc(ref.path, data, opts); return this; },
      update: function (ref, data) { updateDocAt(ref.path, data); return this; },
      delete: function (ref) { deleteDocAt(ref.path); return this; },
    }));
  }

  function writeBatch() {
    var ops = [];
    return {
      set:    function (ref, data, opts) { ops.push(function () { writeDoc(ref.path, data, opts); }); return this; },
      update: function (ref, data) { ops.push(function () { updateDocAt(ref.path, data); }); return this; },
      delete: function (ref) { ops.push(function () { deleteDocAt(ref.path); }); return this; },
      commit: function () { ops.forEach(function (o) { o(); }); ops = []; return Promise.resolve(); },
    };
  }

  /* ── auth stubs — always signed in as one local user ─────────────────── */
  var noAuth = function () { return Promise.reject(new Error('Cosmodex Lite runs local-only — there is no sign-in.')); };

  /* ── backup / restore ────────────────────────────────────────────────────
     IndexedDB is per-browser-profile and IT can wipe it without warning, so a
     one-click export is not optional here. */
  // Records live in IndexedDB, but preferences live in localStorage — categories,
  // people, settings, consolidation config. A backup without them restores every
  // task while losing the labels and colours those tasks refer to, so both go in.
  function collectSettings() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/^(cdx_|cosmodex)/.test(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }

  function exportJson() {
    var out = {};
    MEM.forEach(function (data, path) { out[path] = data; });
    var blob = new Blob([JSON.stringify({
      version: 2, exportedAt: new Date().toISOString(),
      docs: out, settings: collectSettings(),
    }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cosmodex-lite-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function importJson(file) {
    return file.text().then(function (txt) {
      var parsed = JSON.parse(txt);
      var docs = parsed.docs || parsed;           // version 1 had no wrapper
      Object.keys(docs).forEach(function (path) { MEM.set(path, docs[path]); persist(path); });
      // Preferences too, when the backup is version 2 or later.
      var settings = parsed.settings || {};
      Object.keys(settings).forEach(function (k) {
        try { localStorage.setItem(k, settings[k]); } catch (e) {}
      });
      LISTENERS.slice().forEach(function (l) { try { l.fire(); } catch (e) {} });
      return { docs: Object.keys(docs).length, settings: Object.keys(settings).length };
    });
  }
  window.cosmodexLiteExport = exportJson;
  window.cosmodexLiteImport = importJson;

  function mountBackupControl() {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:9998;display:flex;gap:6px;opacity:.35;transition:opacity .2s';
    wrap.onmouseenter = function () { wrap.style.opacity = '1'; };
    wrap.onmouseleave = function () { wrap.style.opacity = '.35'; };
    var btn = 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);color:#fff;' +
              'border-radius:7px;padding:5px 11px;font-family:"DM Mono",monospace;font-size:10px;' +
              'letter-spacing:.1em;text-transform:uppercase;cursor:pointer';
    var ex = document.createElement('button'); ex.textContent = '⤓ Backup'; ex.style.cssText = btn;
    ex.onclick = exportJson;
    var im = document.createElement('button'); im.textContent = '⤒ Restore'; im.style.cssText = btn;
    var picker = document.createElement('input');
    picker.type = 'file'; picker.accept = 'application/json'; picker.style.display = 'none';
    picker.onchange = function () {
      if (!picker.files[0]) return;
      importJson(picker.files[0]).then(function (n) {
        var msg = 'Restored ' + n.docs + ' records and ' + n.settings + ' settings — reloading…';
        if (window.showToast) showToast(msg, 'success');
        // Categories, people and settings are read into memory at startup, so
        // reload rather than leave half the app on the old values.
        setTimeout(function () { location.reload(); }, 1200);
      }).catch(function (e) { alert('Restore failed: ' + e.message); });
    };
    im.onclick = function () { picker.click(); };
    wrap.appendChild(ex); wrap.appendChild(im); wrap.appendChild(picker);
    document.body.appendChild(wrap);
  }

  /* ── preference mirroring ─────────────────────────────────────────────
     Categories, people and app settings are localStorage-shaped throughout the
     app. Rather than rewrite every caller, snapshot them and push when they
     change, so the SQLite file is a complete picture of the setup. */
  var _lastSettings = '';
  function syncSettings() {
    var snap = collectLocalSettings(), json = JSON.stringify(snap);
    if (json === _lastSettings) return;
    _lastSettings = json;
    api('PUT', '/api/settings', { settings: snap })
      .catch(function (e) { console.warn('cosmodex: settings not saved', e); });
  }
  setInterval(syncSettings, 15000);
  window.addEventListener('pagehide', syncSettings);

  /* ── daily notes ──────────────────────────────────────────────────────
     The note editor already exists; it only ever needed somewhere to write.
     These are the five calls it makes — the build points its _invoke() here. */
  window.CDX_NOTES_INVOKE = function (cmd, args) {
    args = args || {};
    if (cmd === 'read_daily_note') {
      return api('GET', '/api/note?date=' + encodeURIComponent(args.date))
        .then(function (r) { return r.content; });          // null when absent
    }
    if (cmd === 'write_daily_note') {
      return api('PUT', '/api/note', { date: args.date, content: args.content });
    }
    if (cmd === 'read_daily_template') {
      return api('GET', '/api/template').then(function (r) { return r.content || ''; });
    }
    if (cmd === 'read_capture_file') {
      return api('GET', '/api/captures').then(function (r) { return r.content || ''; });
    }
    if (cmd === 'write_capture_file') {
      return api('PUT', '/api/captures', { content: args.content });
    }
    return Promise.reject(new Error('unknown note command: ' + cmd));
  };

  /* ── boot ────────────────────────────────────────────────────────────── */
  window.CDX_DB = { __localdb: true };
  window.CDX_AUTH = { __localauth: true, currentUser: { uid: UID } };
  window.CDX_FB = Object.freeze({
    doc: doc, collection: collection, addDoc: addDoc, getDoc: getDoc, getDocs: getDocs,
    setDoc: setDoc, updateDoc: updateDoc, deleteDoc: deleteDoc, onSnapshot: onSnapshot,
    writeBatch: writeBatch, serverTimestamp: serverTimestamp, query: query, orderBy: orderBy,
    where: where, limit: limit, deleteField: deleteField, arrayUnion: arrayUnion,
    arrayRemove: arrayRemove, runTransaction: runTransaction,
    GoogleAuthProvider: function () {}, signInWithPopup: noAuth, signInWithRedirect: noAuth,
    getRedirectResult: function () { return Promise.resolve(null); },
    onAuthStateChanged: function (_a, cb) { cb({ uid: UID }); return function () {}; },
    signOut: function () { return Promise.resolve(); },
    signInWithCredential: noAuth,
  });

  // Anything still sitting in the browser-only build's IndexedDB, moved across
  // once. Non-destructive: the old copy is left alone, so this can be retried.
  function readLegacyIDB() {
    return openIDB().then(function (db) {
      idb = db;
      return new Promise(function (res) {
        var tx = idb.transaction(STORE, 'readonly'), rq = tx.objectStore(STORE).getAll();
        rq.onsuccess = function () {
          var out = {};
          (rq.result || []).forEach(function (row) { out[row.path] = row.data; });
          res(out);
        };
        rq.onerror = function () { res({}); };
      });
    }).catch(function () { return {}; });
  }

  function collectLocalSettings() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/^(cdx_|cosmodex)/.test(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }

  api('GET', '/api/docs').then(function (payload) {
    var docs = payload.docs || {}, settings = payload.settings || {};
    window.__cdxServerSettings = settings;
    var serverEmpty = !Object.keys(docs).length;

    // Settings the server knows about win — that is what makes a new machine
    // come up with your categories intact.
    Object.keys(settings).forEach(function (k) {
      try { localStorage.setItem(k, settings[k]); } catch (e) {}
    });

    if (!serverEmpty) {
      Object.keys(docs).forEach(function (p) { MEM.set(p, docs[p]); });
      return null;
    }
    return readLegacyIDB().then(function (legacy) {
      var n = Object.keys(legacy).length;
      if (!n) return null;
      Object.keys(legacy).forEach(function (p) { MEM.set(p, legacy[p]); });
      return api('POST', '/api/import', { docs: legacy, settings: collectLocalSettings() })
        .then(function () { return n; });
    });
  }).catch(function (e) {
    console.error('cosmodex: could not reach the local server.', e);
    alert('Cosmodex could not reach its local server.\n\n'
        + 'Make sure the Cosmodex window (the black one) is still open, then reload this page.');
    return null;
  }).then(function (migrated) {
    window.__cdxMigrated = migrated;
    // This script sits in <head>; app.js is at the end of <body>. IndexedDB
    // opens fast enough that firing 'cdx-auth-ready' here would beat app.js
    // registering its listener — and initData() would never run. Wait for the
    // document to finish parsing before announcing the session.
    return new Promise(function (res) {
      if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', function () { res(); });
      } else { res(); }
    });
  }).then(function () {
    window.CDX_USER = { uid: UID, displayName: 'Local', email: 'local@cosmodex' };
    console.log('Cosmodex — SQLite store ready, ' + MEM.size + ' records.');
    window.dispatchEvent(new Event('cdx-auth-ready'));
    mountBackupControl();
    // app.js reads categories and people out of localStorage while it parses,
    // which can happen before the server's copy lands. On a fresh browser that
    // leaves the app running with no categories until the next load — so if we
    // can see that has happened, reload once. Guarded so it cannot loop.
    try {
      var wanted = JSON.parse(window.__cdxServerSettings?.cdx_categories || 'null');
      var live = (typeof CATEGORIES !== 'undefined') ? CATEGORIES : null;
      if (wanted && Object.keys(wanted).length && live && !Object.keys(live).length
          && !sessionStorage.getItem('cdx_settings_reload')) {
        sessionStorage.setItem('cdx_settings_reload', '1');
        location.reload();
        return;
      }
    } catch (e) {}

    var moved = window.__cdxMigrated;
    if (moved) {
      setTimeout(function () {
        if (window.showToast) showToast('Moved ' + moved + ' records from the browser into SQLite.', 'success', 9000);
      }, 1500);
    }
  });
})();
