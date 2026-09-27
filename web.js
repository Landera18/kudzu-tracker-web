/* Kudzu tracker - web edition.
 *
 * The desktop tracker is a page plus a small local server (app.py). On a static
 * host there is no server, so this file stands in for it inside the browser:
 * every fetch to api/... is answered here instead of going over the network.
 *
 *   save file   the player picks their emulator's .sav. Chrome and Edge on a
 *               computer keep a handle to it and re-read it whenever it
 *               changes, exactly like the desktop app's watcher; other browsers
 *               read the file once per pick.
 *   runs        kept in this browser's IndexedDB with the same rules the server
 *               applies - an empty run never replaces one with Pokemon in it, a
 *               rolling backup every ten minutes of play and before any shrink.
 *   refresh,    need the ROM source or write the save, so they stay in the
 *   sandbox     desktop app.
 *
 * It must load before app.js: the page's own scripts call fetch at load time.
 * tools/build_web.py injects it and writes webbuild.json beside it.
 */
(function () {
  'use strict';

  window.KUDZU_WEB = true;
  document.documentElement.classList.add('web');

  const BASE = new URL('.', location.href);
  const API = new URL('api/', BASE).pathname;
  const DATA = new URL('data/', BASE).pathname;
  const BUILD = (document.currentScript && document.currentScript.dataset.build) || '';
  const realFetch = window.fetch.bind(window);

  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200, headers: { 'Content-Type': 'application/json' },
  });

  /* ── storage: one small key/value store in IndexedDB ──────────────── */
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('kudzu-web', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const kv = {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
    keys: () => tx('readonly', (s) => s.getAllKeys()),
  };

  /* ── runs (mirrors app.py's /api/run*) ────────────────────────────── */
  const BACKUP_EVERY_MS = 10 * 60 * 1000;
  const BACKUP_KEEP = 40;
  const safeName = (name) => (String(name).replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'run').slice(0, 64);
  const runKey = (name) => `run:${safeName(name)}`;
  const pad = (n) => String(n).padStart(2, '0');
  const stampNow = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
      + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };
  const count = (doc, k) => (k === 'encounters'
    ? Object.keys((doc && doc.encounters) || {}).length
    : ((doc && doc[k]) || []).length);

  async function backupsFor(name) {
    const prefix = `bak:${safeName(name)}:`;
    const keys = (await kv.keys()).filter((k) => typeof k === 'string' && k.startsWith(prefix));
    return keys.map((k) => ({ key: k, stamp: k.slice(prefix.length) }))
      .sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  }

  async function backupRun(name, current, reason) {
    const existing = await backupsFor(name);
    if (reason === 'routine' && existing.length) {
      const last = await kv.get(existing[0].key);
      if (last && Date.now() - (last._backedUpAt || 0) < BACKUP_EVERY_MS) return;
    }
    let stamp = stampNow();
    while (existing.some((b) => b.stamp === stamp)) stamp += '_';
    await kv.set(`bak:${safeName(name)}:${stamp}`, Object.assign({}, current, { _backedUpAt: Date.now() }));
    for (const b of existing.slice(BACKUP_KEEP - 1)) await kv.del(b.key);
  }

  async function runs(method, parts, url, body) {
    if (parts.length === 0 && method === 'GET') {
      const keys = (await kv.keys()).filter((k) => typeof k === 'string' && k.startsWith('run:'));
      const out = [];
      for (const k of keys.sort()) {
        const doc = await kv.get(k);
        if (!doc || typeof doc !== 'object') continue;
        const name = k.slice(4);
        out.push({
          name, savedAt: doc.savedAt || null, fingerprint: doc.fingerprint || null,
          encounters: count(doc, 'encounters'), deaths: count(doc, 'deaths'),
          backups: (await backupsFor(name)).length,
          ending: doc.ending && typeof doc.ending === 'object' ? doc.ending : null,
        });
      }
      return json({ runs: out });
    }
    const name = decodeURIComponent(parts[0] || '');
    const sub = parts[1] || '';
    if (!sub && method === 'GET') {
      const doc = await kv.get(runKey(name));
      return doc ? json(doc) : json({ error: 'not found' }, 404);
    }
    if (!sub && (method === 'PUT' || method === 'POST')) {
      let doc;
      try { doc = JSON.parse(body || 'null'); } catch (e) { return json({ error: `body was not JSON: ${e.message}` }, 400); }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return json({ error: 'expected a JSON object' }, 400);
      const old = await kv.get(runKey(name));
      const held = count(old, 'encounters');
      const now = count(doc, 'encounters');
      if (!now && held && url.searchParams.get('allowEmpty') !== '1') {
        return json({ error: 'refused', reason: `would replace ${held} encounter(s) with an empty run`, kept: held }, 409);
      }
      if (old) await backupRun(name, old, now < held ? 'shrink' : 'routine');
      await kv.set(runKey(name), doc);
      return json({ ok: true, name: safeName(name), bytes: JSON.stringify(doc).length,
                    backups: (await backupsFor(name)).length });
    }
    if (!sub && method === 'DELETE') {
      await kv.del(runKey(name));
      return json({ ok: true });
    }
    if (sub === 'backups') {
      const out = [];
      for (const b of await backupsFor(name)) {
        const doc = (await kv.get(b.key)) || {};
        out.push({ file: `${safeName(name)}.${b.stamp}.json`, stamp: b.stamp, savedAt: doc.savedAt || null,
                   encounters: count(doc, 'encounters'), deaths: count(doc, 'deaths') });
      }
      return json({ backups: out });
    }
    if (sub === 'restore') {
      const wanted = String((JSON.parse(body || '{}') || {}).file || '');
      const hit = (await backupsFor(name)).find((b) => `${safeName(name)}.${b.stamp}.json` === wanted);
      if (!hit) return json({ error: 'no such backup' }, 404);
      const doc = Object.assign({}, await kv.get(hit.key));
      delete doc._backedUpAt;
      const cur = await kv.get(runKey(name));
      if (cur) await backupRun(name, cur, 'restore');
      await kv.set(runKey(name), doc);
      return json({ ok: true, run: doc });
    }
    if (sub === 'rename') {
      const to = safeName((JSON.parse(body || '{}') || {}).to || '');
      if (!to) return json({ error: 'a name is needed' }, 400);
      const src = runKey(name), dst = runKey(to);
      if (dst !== src && await kv.get(dst)) return json({ error: `a run called ${to} already exists` }, 409);
      const doc = await kv.get(src);
      if (doc && dst !== src) { await kv.set(dst, doc); await kv.del(src); }
      return json({ ok: true, name: to });
    }
    return json({ error: 'not found' }, 404);
  }

  /* ── the save file ────────────────────────────────────────────────── */
  const canWatch = typeof window.showOpenFilePicker === 'function';
  const sav = { handle: null, bytes: null, meta: null, needsPermission: false };
  const savReady = canWatch
    ? kv.get('savHandle').then((h) => { if (h) sav.handle = h; }).catch(() => {})
    : Promise.resolve();

  function fill(out, f) {
    out.exists = true;
    out.size = f.size;
    out.mtimeMs = f.lastModified;
    out.mtime = new Date(f.lastModified).toISOString();
    out.ageMs = Math.max(0, Date.now() - f.lastModified);
  }

  async function savStatus() {
    await savReady;
    const out = { path: null, source: null, configured: null, exists: false, browseAvailable: true,
                  web: true, canWatch };
    sav.needsPermission = false;
    if (sav.handle) {
      out.path = out.configured = sav.handle.name;
      out.source = 'web';
      let perm = 'granted';
      try { perm = await sav.handle.queryPermission({ mode: 'read' }); } catch { /* older engines */ }
      if (perm !== 'granted') {
        sav.needsPermission = out.needsPermission = true;
        updateReconnect();
        return out;
      }
      try { fill(out, await sav.handle.getFile()); } catch (e) { out.error = String((e && e.message) || e); }
    } else if (sav.meta) {
      out.path = out.configured = sav.meta.name;
      out.source = 'web-once';
      fill(out, sav.meta);
      // Nothing more will change without a new pick, so it always counts as settled.
      out.ageMs = Math.max(out.ageMs, 60000);
    }
    updateReconnect();
    return out;
  }

  async function savBytes() {
    await savReady;
    if (sav.handle) {
      const f = await sav.handle.getFile();
      return { bytes: await f.arrayBuffer(), mtimeMs: f.lastModified };
    }
    if (sav.bytes) return { bytes: sav.bytes, mtimeMs: sav.meta.lastModified };
    return null;
  }

  const SAV_TYPES = [{ description: 'Save files', accept: { 'application/octet-stream': ['.sav', '.sa1', '.sa2', '.srm', '.fla'] } }];

  function pickOnce() {
    // The plain file input: every browser has it, but what it hands back is a
    // snapshot, so the bytes are read now and a newer save needs a new pick.
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.sav,.sa1,.sa2,.srm,.fla,application/octet-stream';
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return resolve(false);
        sav.bytes = await f.arrayBuffer();
        sav.meta = { name: f.name, size: f.size, lastModified: f.lastModified || Date.now() };
        resolve(true);
      });
      input.addEventListener('cancel', () => resolve(false));
      input.click();
    });
  }

  async function browse() {
    await savReady;
    if (!canWatch) {
      const picked = await pickOnce();
      return json({ available: true, picked, sav: await savStatus() });
    }
    // A remembered file that only needs the browser's say-so again (it asks
    // once per visit) is reconnected rather than picked afresh.
    if (sav.handle && sav.needsPermission) {
      try {
        if (await sav.handle.requestPermission({ mode: 'read' }) === 'granted') {
          return json({ available: true, picked: true, sav: await savStatus() });
        }
      } catch { /* fall through to the picker */ }
    }
    try {
      const opts = { types: SAV_TYPES, excludeAcceptAllOption: false, multiple: false };
      if (sav.handle) opts.startIn = sav.handle;
      const [h] = await window.showOpenFilePicker(opts);
      sav.handle = h;
      await kv.set('savHandle', h).catch(() => {});
      return json({ available: true, picked: true, sav: await savStatus() });
    } catch (e) {
      if (e && e.name === 'AbortError') return json({ available: true, picked: false });
      return json({ available: true, error: String((e && e.message) || e) }, 500);
    }
  }

  /* ── the router ───────────────────────────────────────────────────── */
  let manifestP = null;
  const manifest = () => (manifestP = manifestP
    || realFetch(`${DATA}manifest.json?v=${BUILD}`).then((r) => r.json()).catch(() => ({})));

  const DESKTOP_ONLY = 'The save editor is only in the desktop app.';

  async function route(method, url, body) {
    const parts = url.pathname.slice(API.length).split('/').filter(Boolean);
    const head = parts[0];
    if (head === 'status') {
      const man = await manifest();
      return json({
        manifest: man, warnings: man.warnings || [],
        source: { hasData: !!man.fingerprint, stale: false, changed: [], changedCount: 0 },
        uiBuild: BUILD, frozen: false, web: true,
      });
    }
    if (head === 'refresh') {
      return parts[1] === 'progress' ? json({ running: false })
        : json({ started: false, web: true, error: 'Refresh needs the ROM source; it only runs in the desktop app.' });
    }
    if (head === 'calc' && parts[1] === 'status') {
      const man = await manifest();
      return json({ available: true, dataset: true, datasetWrittenAt: man.generatedAt || null,
                    url: 'calc/index.html?data=kudzu&gen=9&dmgGen=9&view=calculator' });
    }
    if (head === 'config') {
      if (method === 'GET') return json({ sav_path: sav.handle ? sav.handle.name : null });
      return json({ ok: true, sav: await savStatus() });
    }
    if (head === 'sav') {
      const sub = parts[1];
      if (sub === 'status') return json(await savStatus());
      if (sub === 'browse') return browse();
      if (sub === 'backups') return json({ backups: [] });
      if (sub === 'write' || sub === 'restore') return json({ error: DESKTOP_ONLY }, 400);
      const got = await savBytes().catch((e) => ({ error: e }));
      if (!got || got.error) return json({ error: 'no save file is chosen yet' }, 404);
      return new Response(got.bytes, { status: 200, headers: {
        'Content-Type': 'application/octet-stream', 'X-Sav-Mtime-Ms': String(got.mtimeMs) } });
    }
    if (head === 'runs') return runs(method, [], url, body);
    if (head === 'run') return runs(method, parts.slice(1), url, body);
    return json({ error: `not in the web edition: ${url.pathname}` }, 404);
  }

  const isApi = (u) => u.origin === location.origin && u.pathname.startsWith(API);

  async function bodyText(b) {
    if (b == null) return null;
    if (typeof b === 'string') return b;
    if (b instanceof Blob) return b.text();
    if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
    return String(b);
  }

  window.fetch = function (input, init) {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const u = new URL(raw, location.href);
    if (isApi(u)) {
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return bodyText(init && init.body)
        .then((b) => route(method, u, b))
        .catch((e) => json({ error: String((e && e.message) || e) }, 500));
    }
    // The datasets change with every update; the version stamp keeps a host's
    // cache from handing out yesterday's JSON next to today's page.
    if (u.origin === location.origin && u.pathname.startsWith(DATA) && !u.searchParams.has('v')) {
      u.searchParams.set('v', BUILD);
      return realFetch(u.href, init);
    }
    return realFetch(input, init);
  };

  const realBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  navigator.sendBeacon = function (url, data) {
    const u = new URL(String(url), location.href);
    if (!isApi(u)) return realBeacon ? realBeacon(url, data) : false;
    bodyText(data).then((b) => route('POST', u, b)).catch(() => {});
    return true;
  };

  /* ── page adjustments ─────────────────────────────────────────────── */
  function reconnectBar() {
    let bar = document.getElementById('web-reconnect');
    if (!bar && document.body) {
      bar = document.createElement('div');
      bar.id = 'web-reconnect';
      bar.hidden = true;
      const text = document.createElement('span');
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Reconnect';
      btn.addEventListener('click', async () => {
        await window.fetch('api/sav/browse', { method: 'POST' });
        if (typeof progressState === 'function') progressState().saveMtimeMs = null;
        if (typeof renderSavSettings === 'function') renderSavSettings();
        if (typeof syncTick === 'function') syncTick().catch(() => {});
      });
      bar.append(text, btn);
      const header = document.getElementById('bar');
      (header ? header.parentNode : document.body).insertBefore(bar, header ? header.nextSibling : document.body.firstChild);
    }
    return bar;
  }

  function updateReconnect() {
    const bar = reconnectBar();
    if (!bar) return;
    bar.hidden = !sav.needsPermission;
    if (sav.needsPermission) {
      bar.firstChild.textContent = `The browser needs your OK again to read ${sav.handle.name}. `
        + 'It asks once per visit.';
    }
  }

  function describeSave() {
    const pathEl = document.getElementById('sav-path');
    const st = typeof SYNC !== 'undefined' ? SYNC.status : null;
    if (!pathEl || !st) return;
    if (st.needsPermission) {
      pathEl.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = st.path;
      pathEl.append(b, document.createElement('br'),
        'Press Browse… to let the page read it again - the browser asks once per visit.');
    } else if (!st.path) {
      pathEl.innerHTML = '<b>No save file chosen.</b> Press Browse… and pick your emulator\'s '
        + '<code>.sav</code>. '
        + (canWatch ? 'This browser keeps following the file as you play.'
          : 'This browser reads it once per pick - Chrome or Edge on a computer can follow it as you play.');
    } else if (st.source === 'web-once') {
      const note = document.createElement('div');
      note.className = 'web-note';
      note.textContent = 'Read once. After saving in the game, press Browse… again to read the new save.';
      pathEl.append(note);
    }
  }

  // updateCheck: the host is updated by pushing a new build, and a tab left open
  // for an evening would otherwise keep running the old one.
  async function updateCheck() {
    if (!BUILD) return;
    try {
      const r = await realFetch(`${BASE.pathname}webbuild.json`, { cache: 'no-store' });
      const j = await r.json();
      if (j.build && j.build !== BUILD) {
        let bar = document.getElementById('web-update');
        if (!bar) {
          bar = document.createElement('div');
          bar.id = 'web-update';
          bar.append('A newer version of the tracker is up' + (j.builtAt ? ` (${j.builtAt.slice(0, 16).replace('T', ' ')} UTC)` : '') + '. ');
          const btn = document.createElement('button');
          btn.className = 'btn';
          btn.textContent = 'Reload';
          btn.addEventListener('click', () => {
            if (typeof flushAutosave === 'function') flushAutosave();
            location.reload();
          });
          bar.append(btn);
          document.body.prepend(bar);
        }
      }
    } catch { /* offline for a moment; try again later */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    reconnectBar();
    if (typeof window.renderSavSettings === 'function') {
      const orig = window.renderSavSettings;
      window.renderSavSettings = function () {
        const r = orig.apply(this, arguments);
        describeSave();
        return r;
      };
    }
    setInterval(updateCheck, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') updateCheck();
    });
  });

  // Hand the shim a save without the picker - a File (read once) or a file
  // handle (followed). Used by tests; the picker paths above end in the same state.
  async function useFile(f) {
    sav.handle = null;
    sav.bytes = await f.arrayBuffer();
    sav.meta = { name: f.name, size: f.size, lastModified: f.lastModified || Date.now() };
    return savStatus();
  }
  async function useHandle(h) {
    sav.handle = h;
    sav.bytes = sav.meta = null;
    return savStatus();
  }

  window.kudzuWeb = { canWatch, build: BUILD, kv, useFile, useHandle };
})();
