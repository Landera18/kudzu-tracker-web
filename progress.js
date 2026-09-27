/* Progress — what the save says about where the run is, and keeping up with it.
 *
 * The tracker used to be told about the game: import a .sav by hand, tick the
 * split you are in, tick the trainers you beat. All of that is in the save
 * already. VAR_LEVEL_CAP says which split the run is in - every cap value is
 * raised inside exactly one split - and SaveBlock1.flags carries the badges and
 * a flag per beaten trainer. So this module watches the save file the server
 * exposes, re-reads it whenever its timestamp moves, and derives the split, the
 * cap, the badges and the defeated list from it. Nothing is asked of the player
 * except to keep playing.
 *
 * Loads after tracker.js and shares its globals (D, RUN, saveRun, ...). The
 * save parser and the roster import live in sav.js / savui.js; this file only
 * decides WHEN to read and WHAT the flags mean.
 */
'use strict';

const SYNC_POLL_MS = 2500;      // how often the file's timestamp is checked
const SYNC_SETTLE_MS = 1500;    // the file must sit unchanged this long before it is read
const SYNC_KEY = 'kudzu.sync.v1';

/* View state for the watcher; not run data. */
const SYNC = {
  status: null,        // last /api/sav/status
  busy: false,
  timer: null,
  lastError: null,
  lastResult: null,    // {at, reason, ...receipt}
  enabled: true,
  everRead: false,     // the page reads once at launch whatever the timestamp says
};

function progressState() {
  RUN.progress ||= {};
  return RUN.progress;
}

const splitById = (id) => (D.progression?.splits || []).find((s) => s.id === id) || null;

/**
 * The split a level cap puts the run in.
 *
 * Walks the splits in order and returns the first whose exit cap is above the
 * value: the player has not yet fired that split's final raise, so they are
 * inside it. A cap EQUAL to a split's exit cap means its leader is beaten and
 * the next split has begun. A split that raises nothing (Victory Road, 96 to
 * 96) is entered when the cap reaches its entry value and cannot be left by
 * the cap alone - the leader check in deriveSplitFromSave handles that.
 */
function splitForCap(cap) {
  const list = D.progression?.splits || [];
  if (cap == null || !list.length) return null;
  for (const s of list) {
    const entry = s.levelCap?.atEntry;
    const exit = s.levelCap?.atExit;
    if (exit == null) continue;
    if (cap < exit) return s;
    if (entry != null && cap === entry && entry === exit) return s;
  }
  return list[list.length - 1];
}

/** cap + beaten leaders -> the split the run is in, with the reasoning. */
function deriveSplitFromSave(sav) {
  const list = D.progression?.splits || [];
  const cap = sav?.levelCap?.level ?? null;
  const defeated = new Set(sav?.flags?.trainersDefeated || []);
  let s = splitForCap(cap);
  const reasons = [];
  if (!s) return null;
  reasons.push(`cap ${cap} puts the run in ${s.label}`);
  // A split's declared leader being beaten means the split is over even when
  // the cap cannot show it (Victory Road raises nothing).
  for (let guard = 0; guard < list.length; guard += 1) {
    const leader = s.endsOn?.declaredLeader;
    const t = leader ? D.trainerBy?.[leader] : null;
    const next = list[s.index + 1];
    if (!t || t.id == null || !defeated.has(t.id) || !next) break;
    reasons.push(`${t.name} is beaten, so ${next.label}`);
    s = next;
  }
  return { splitId: s.id, index: s.index, label: s.label, reasons };
}

/* ── defeated trainers ────────────────────────────────────────────── */
/* RUN.defeated: { TRAINER_CONSTANT: {source: 'save'|'manual', at} }. The save's
   flag is the truth and is never un-set - the game does not clear it - and a
   hand-ticked one is kept too. */

const isDefeated = (c) => !!(RUN.defeated && RUN.defeated[c]);
const defeatedSource = (c) => (RUN.defeated && RUN.defeated[c] && RUN.defeated[c].source) || null;

function setDefeatedManual(c, on) {
  RUN.defeated ||= {};
  if (on) RUN.defeated[c] = { source: 'manual', at: new Date().toISOString() };
  else delete RUN.defeated[c];
  saveRun();
}

/** Beaten-trainer flags from the save -> RUN.defeated. Returns how many were new. */
function applyDefeatedFromSave(ids) {
  if (!Array.isArray(ids)) return 0;
  if (!RUN.defeated || Array.isArray(RUN.defeated)) RUN.defeated = {};
  const at = new Date().toISOString();
  let added = 0;
  for (const id of ids) {
    const t = D.trainerById?.[id];
    if (!t) continue;
    if (!RUN.defeated[t.constant]) {
      RUN.defeated[t.constant] = { source: 'save', at };
      added += 1;
    }
  }
  return added;
}

/* Trainers used to be ticked into localStorage under a per-browser key. Bring
   that list into the run once, as hand-marked, then drop the key. */
function migrateLegacyDefeated() {
  const KEY = 'kudzu.defeated.v1';
  let list = [];
  try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return; }
  if (!Array.isArray(list) || !list.length) return;
  if (!RUN.defeated || Array.isArray(RUN.defeated)) RUN.defeated = {};
  const at = new Date().toISOString();
  for (const c of list) if (!RUN.defeated[c]) RUN.defeated[c] = { source: 'manual', at };
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  saveRun();
}

/** The first boss in run order the save has not beaten - what to prepare for. */
function nextBoss() {
  const list = D.progression?.splits || [];
  for (const s of list) {
    const leader = s.endsOn?.declaredLeader;
    const t = leader ? D.trainerBy?.[leader] : null;
    if (t && !isDefeated(t.constant)) return { trainer: t, split: s };
  }
  return null;
}

/* ── split timeline ───────────────────────────────────────────────── */

/**
 * Stamp the Splits tab when the save moves the run to a new split.
 *
 * Every split before the new one is closed and the new one opened. A split
 * that was never opened by hand and is being closed here gets both stamps at
 * once, marked inferred, so the timeline reads in order rather than showing
 * a badge the save says is won as still to do.
 */
function stampSplitTransition(fromId, toId) {
  const list = D.progression?.splits || [];
  const to = splitById(toId);
  if (!to) return;
  RUN.splits ||= {};
  const now = new Date().toISOString();
  const team = typeof captureTeam === 'function' ? captureTeam() : [];
  for (const s of list) {
    if (s.index >= to.index) break;
    const rec = (RUN.splits[s.id] ||= {});
    if (!rec.enteredAt) { rec.enteredAt = now; rec.inferred = true; }
    if (!rec.exitedAt) {
      rec.exitedAt = now;
      rec.teamAtExit = rec.teamAtExit || team;
      if (s.id !== fromId) rec.inferred = true;
    }
  }
  const cur = (RUN.splits[to.id] ||= {});
  if (!cur.enteredAt) { cur.enteredAt = now; cur.teamAtEntry = team; }
  // Coming back to an earlier split (a save from before) reopens it.
  for (const s of list) {
    if (s.index > to.index && RUN.splits[s.id]?.inferred) delete RUN.splits[s.id];
  }
}

/* ── applying a parsed save to the run's progress ─────────────────── */

/**
 * Everything the save says about progress, written into the run.
 * Returns the list of changes for the receipt. Roster changes (catches,
 * deaths, levels) are savui.js's job; this is cap, badges, trainers, split.
 */
function applyProgressFromSave(sav, meta) {
  const P = progressState();
  const changes = [];
  const cap = sav?.levelCap?.level ?? null;
  const flags = sav?.flags || null;

  if (cap != null) {
    if (P.cap !== cap) {
      changes.push({ kind: 'cap', label: `Level cap ${P.cap != null ? `${P.cap} → ` : ''}${cap}` });
      P.cap = cap;
    }
    RUN.rules.saveCap = cap;
    // The save is the finest source there is; only an explicit manual or off
    // setting is respected over it.
    if (RUN.rules.capSource !== 'manual' && RUN.rules.capSource !== 'off') {
      RUN.rules.capSource = 'save';
    }
  }

  if (flags) {
    const n = flags.badgeCount;
    if (P.badgeCount !== n) {
      changes.push({ kind: 'badges', label: `${n} badge${n === 1 ? '' : 's'}` });
    }
    P.badgeCount = n;
    P.badges = flags.badges;
    const added = applyDefeatedFromSave(flags.trainersDefeated);
    if (added) changes.push({ kind: 'trainers', label: `${added} trainer${added === 1 ? '' : 's'} marked beaten` });
    P.defeatedCount = (flags.trainersDefeated || []).length;
    P.system = flags.system || null;
    // The rival comes in one variant per starter; the first one beaten says
    // which variant this run fights everywhere else.
    if (!P.rivalVariant) {
      for (const id of flags.trainersDefeated || []) {
        const t = D.trainerById?.[id];
        const m = t && t.bossKind === 'rival' ? /_(SQUIRTLE|BULBASAUR|CHARMANDER)$/.exec(t.constant) : null;
        if (m) { P.rivalVariant = m[1]; break; }
      }
    }
  }

  if (typeof applyBagFromSave === 'function') {
    const bagChange = applyBagFromSave(sav);
    if (bagChange) changes.push(bagChange);
  }

  const d = deriveSplitFromSave(sav);
  P.derivedSplitId = d ? d.splitId : null;
  P.derivedSplitReasons = d ? d.reasons : [];
  if (d && RUN.rules.splitSource !== 'manual') {
    const from = RUN.rules.splitId;
    const moved = from !== d.splitId;
    RUN.rules.splitId = d.splitId;
    RUN.rules.splitSource = 'save';
    // A run's first read lands in whatever split the save is in; that split
    // is opened on the timeline then too, not only on a later transition.
    const opened = !!(RUN.splits && RUN.splits[d.splitId] && RUN.splits[d.splitId].enteredAt);
    if (moved || !opened) stampSplitTransition(moved ? from : null, d.splitId);
    if (moved) changes.push({ kind: 'split', label: `Now in ${d.label}`, detail: d.reasons.join('; ') });
  } else if (d && !RUN.rules.splitSource) {
    RUN.rules.splitSource = 'save';
  }

  P.syncedAt = new Date().toISOString();
  if (meta) {
    if (meta.mtimeMs != null) P.saveMtimeMs = meta.mtimeMs;
    if (meta.path) P.savePath = meta.path;
    P.saveManual = !!meta.manual;
  }
  P.saveSlot = sav?.slot ?? null;
  P.trainerName = sav?.trainer?.name ?? null;
  P.playTime = sav?.trainer?.playTime ?? null;
  P.hasFlags = !!flags;
  return changes;
}

/* ── the watcher ──────────────────────────────────────────────────── */

async function fetchSyncStatus() {
  const r = await fetch('api/sav/status');
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

/**
 * Read the configured save now and put it through the import.
 * `reason` is for the receipt: 'launch', 'changed', or 'manual'.
 */
async function syncNow(reason) {
  if (SYNC.busy) return null;
  SYNC.busy = true;
  SYNC.lastError = null;
  renderSync();
  try {
    const st = await fetchSyncStatus();
    SYNC.status = st;
    if (!st.exists) throw new Error(st.path ? `save not found at ${st.path}` : 'no save file set');
    const r = await fetch('api/sav');
    if (!r.ok) throw new Error(`could not read the save (${r.status})`);
    const bytes = await r.arrayBuffer();
    const mtimeMs = Number(r.headers.get('X-Sav-Mtime-Ms')) || st.mtimeMs || null;
    if (typeof ingestSave !== 'function') throw new Error('save import is not loaded');
    const receipt = ingestSave(bytes, { path: st.path, mtimeMs, reason, manual: false });
    SYNC.lastResult = Object.assign({ at: new Date().toISOString(), reason }, receipt);
    if (receipt && receipt.error) SYNC.lastError = receipt.error;
    return receipt;
  } catch (e) {
    SYNC.lastError = String((e && e.message) || e);
    return null;
  } finally {
    SYNC.busy = false;
    renderSync();
  }
}

/** One poll: has the file changed since the run last read it? */
async function syncTick() {
  if (!SYNC.enabled || SYNC.busy || !runLoaded) return;
  let st;
  try { st = await fetchSyncStatus(); } catch (e) {
    SYNC.lastError = String((e && e.message) || e);
    renderSync();
    return;
  }
  SYNC.status = st;
  const P = progressState();
  const changed = st.exists && st.mtimeMs != null && st.mtimeMs !== P.saveMtimeMs;
  // The first look after the page opens always reads: a launch costs one
  // 128 KB parse, and it means a run recorded by an older build catches up
  // with anything this one derives differently.
  const first = st.exists && !SYNC.everRead;
  const settled = (st.ageMs ?? Infinity) >= SYNC_SETTLE_MS;
  if ((changed || first) && settled) {
    SYNC.everRead = true;
    await syncNow(first ? 'launch' : 'changed');
  } else renderSync();
}

function startSyncLoop() {
  clearInterval(SYNC.timer);
  SYNC.timer = setInterval(() => { syncTick().catch(() => {}); }, SYNC_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncTick().catch(() => {});
  });
  // Kept, so that whatever needs the launch read to have landed can wait for
  // it (the calculator picking "the next boss" does - see calcui.js).
  SYNC.firstRead = syncTick().catch(() => {});
}

/** Resolves when the launch read of the save has finished, or after `ms`. */
function firstSaveRead(ms) {
  const first = (typeof SYNC !== 'undefined' && SYNC.firstRead) || Promise.resolve();
  return Promise.race([first, new Promise((r) => setTimeout(r, ms || 4000))]);
}

/* ── the header pill ──────────────────────────────────────────────── */

const ago = (iso) => {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m ago`;
};

function renderSync() {
  const pill = $('#sync');
  if (!pill) return;
  const st = SYNC.status;
  const P = RUN.progress || {};
  pill.hidden = false;
  pill.className = 'cap sync';
  let text;
  let title;
  if (!SYNC.enabled) {
    text = 'save: paused';
    title = 'Automatic reading of the save is paused (Run › Save file).';
  } else if (!st && !SYNC.lastError) {
    text = 'save: checking…';
    title = 'Looking for the save file';
  } else if (SYNC.lastError && !(st && st.exists)) {
    pill.classList.add('warn');
    text = st && st.path ? 'save: not found' : 'save: not set';
    title = SYNC.lastError + (st && st.path ? '' : ' - choose the .sav under Run › Save file');
  } else if (SYNC.busy) {
    text = 'save: reading…';
    title = 'Reading the save file';
  } else if (P.syncedAt) {
    text = `save ${ago(P.syncedAt)}`;
    if (SYNC.lastError) { pill.classList.add('warn'); text += ' · error'; }
    title = `Last read ${P.syncedAt.slice(0, 19).replace('T', ' ')}`
      + (P.savePath ? ` from ${P.savePath}` : '')
      + (SYNC.lastError ? `\n${SYNC.lastError}` : '')
      + '\nThe file is checked every few seconds; a change is read on its own.';
  } else if (st && st.exists) {
    text = 'save: waiting';
    title = 'A save file is set; it has not been read yet.';
  } else {
    pill.classList.add('warn');
    text = 'save: not set';
    title = 'No save file is set. Choose the emulator save (.sav) under Run › Save file and the run will follow the game.';
  }
  pill.textContent = text;
  pill.title = title;
  if (typeof renderSavSettings === 'function') renderSavSettings();
}

function initProgress() {
  migrateLegacyDefeated();
  const pill = $('#sync');
  if (pill) pill.addEventListener('click', () => showTab('sav'));
  try { SYNC.enabled = localStorage.getItem(SYNC_KEY) !== 'off'; } catch { /* default on */ }
  renderSync();
  // Every few seconds, forever. Nothing is read unless the timestamp moves.
  startSyncLoop();
  // Keep the "2m ago" honest without a poll.
  setInterval(() => { if (!SYNC.busy) renderSync(); }, 30000);
}

function setSyncEnabled(on) {
  SYNC.enabled = !!on;
  try { localStorage.setItem(SYNC_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
  if (on) syncTick().catch(() => {});
  renderSync();
}
window.initProgress = initProgress;
