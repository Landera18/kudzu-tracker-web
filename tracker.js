/* Encounter Tracker — the run itself.
 *
 * An "area" is one place that yields one encounter. By default that is a
 * LOCATION as the game names it - Mt. Moon is one area, whatever floor the
 * catch was on - because that is how a nuzlocke counts; a rule switches to one
 * per map for players who count floors. Gifts, statics, trades, eggs and the
 * legendary pools each get their own area, because a nuzlocke counts those
 * separately from the route's slot.
 *
 * The run is the only mutable state in the app. It is one file, runs/<name>.json,
 * written on every edit (debounced), mirrored in localStorage, and flushed on
 * the way out — so closing the window costs nothing and a run is always the
 * file you can hand to someone else.
 *
 * Loads after app.js and shares its globals (D, el, $, pretty, mapLabel …).
 */
'use strict';

const RUN_KEY = 'kudzu.run.v1';
const STATUSES = ['unencountered', 'caught', 'fled', 'fainted', 'skipped', 'gift'];
const STATUS_LABEL = {
  unencountered: 'not yet', caught: 'caught', fled: 'fled',
  fainted: 'died', skipped: 'dupe — skipped', gift: 'gift / static',
};
const DEAD = new Set(['fainted', 'dead']);
const ALIVE = new Set(['caught', 'gift']);

/* Where a Pokémon physically is, which is what decides whether it counts.
   The in-game convention: boxes 1–3 are the living PC, boxes 13–14 are the
   graveyard, and everything between is ignored. A mon in the party or the
   living PC is available; one in the graveyard is not, and must never appear
   in party selection, the calc matrix, or the "available" count. */
const PLACEMENTS = ['party', 'pc', 'graveyard'];
const PLACEMENT_LABEL = {
  party: 'Party',
  pc: 'PC — boxes 1–3',
  graveyard: 'Graveyard — boxes 13–14',
};

/** Placement, falling back to what the status implies for older run data. */
function placementOf(rec) {
  if (!rec) return null;
  if (rec.placement) return rec.placement;
  if (DEAD.has(rec.status)) return 'graveyard';
  if (ALIVE.has(rec.status)) return 'party';
  return null;
}
const isAliveRec = (rec) => (
  (ALIVE.has(rec.status) || DEAD.has(rec.status)) && placementOf(rec) !== 'graveyard'
);
const isDeadRec = (rec) => (
  DEAD.has(rec.status) || placementOf(rec) === 'graveyard'
);

/** Every Pokémon the run has caught, with where it is. */
function roster() {
  return Object.entries(RUN.encounters)
    .filter(([, r]) => r.species || r.speciesRaw)
    .filter(([, r]) => ALIVE.has(r.status) || DEAD.has(r.status))
    .map(([id, r]) => ({ id, rec: r, placement: placementOf(r) }));
}
const rosterLabel = (m) => {
  // Prefer the resolved display name, then whatever was actually typed, and only
  // then the raw constant. Showing an unresolvable SPECIES_ constant back to the
  // user is never the most useful of the three.
  const nm = (m.rec.species && D.byConst[m.rec.species]?.displayName)
    || m.rec.speciesRaw
    || m.rec.species
    || '?';
  return m.rec.nickname ? `${m.rec.nickname} (${nm})` : nm;
};
/** Where a caught Pokémon sits, in words. */
const placementText = (rec) => {
  const p = placementOf(rec);
  if (p === 'party') return 'Party';
  if (p === 'pc') return rec.boxNumber ? `PC box ${rec.boxNumber}` : 'PC';
  if (p === 'graveyard') return rec.boxNumber ? `Graveyard, box ${rec.boxNumber}` : 'Graveyard';
  return '';
};

function newRun() {
  return {
    version: 1,
    name: 'run1',
    fingerprint: null,
    hackVersion: null,        // the ROM build this run was played on
    createdAt: new Date().toISOString(),
    rules: {
      dupes: 'line', shiny: true, species: true, reroll: false,
      mode: 'set', items: false, capSource: 'save', manualCap: 100, splitId: null,
      saveCap: null,
      // Which split the run is in follows the save unless it was picked by hand.
      splitSource: 'save',
      // One encounter per location (Mt. Moon once) or per map (each floor).
      encounterUnit: 'location',
    },
    encounters: {},
    deaths: [],
    defeated: {},          // TRAINER_CONSTANT -> {source, at}; see progress.js
    progress: {},          // what the last save read said; see progress.js
  };
}
let RUN = newRun();

/* The run is written to runs/<name>.json, not just to localStorage.
   localStorage lives in the WebView profile, which is not somewhere a run
   should only exist: closing the window, clearing site data or moving the app
   would all take it with them. The disk copy is debounced so typing a note is
   not one request per keystroke, and flushed synchronously on the way out. */
const AUTOSAVE_MS = 1500;
let autosaveTimer = null;
let autosavePending = false;
let lastSavedAt = null;         // Date.now() of the last write that landed
let lastSaveError = null;
/* Nothing is written to disk until the saved run has been loaded. Until then
   RUN is the blank one newRun() made at script load, and autosaving THAT is how
   a run gets destroyed: the file is replaced by an empty run a second and a
   half after a launch that failed to load, or loaded into a cleared profile.
   The server refuses such a write as well; this stops it being attempted. */
let runLoaded = false;

const runUrl = (name) => `api/run/${encodeURIComponent(name || RUN.name || 'run1')}`;

function autosaveToDisk() {
  autosavePending = false;
  RUN.savedAt = new Date().toISOString();
  renderRunStatus();
  fetch(runUrl(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(RUN),
  }).then(async (r) => {
    if (r.ok) { lastSavedAt = Date.now(); lastSaveError = null; }
    else {
      const j = await r.json().catch(() => ({}));
      lastSaveError = j.reason || j.error || `HTTP ${r.status}`;
    }
    renderRunStatus();
  }).catch((e) => { autosavePending = true; lastSaveError = String(e); renderRunStatus(); });
}

function queueAutosave() {
  if (!runLoaded) return;
  autosavePending = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveToDisk, AUTOSAVE_MS);
}

/** Last chance as the window closes: sendBeacon is the only request that
 *  reliably outlives the page. The server takes POST as well as PUT for it. */
function flushAutosave() {
  clearTimeout(autosaveTimer);
  if (!runLoaded || !autosavePending) return;
  autosavePending = false;
  RUN.savedAt = new Date().toISOString();
  const body = new Blob([JSON.stringify(RUN)], { type: 'application/json' });
  try {
    if (navigator.sendBeacon && navigator.sendBeacon(runUrl(), body)) return;
  } catch { /* fall through */ }
  try {
    const x = new XMLHttpRequest();
    x.open('POST', runUrl(), false);      // sync: the page is going away
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify(RUN));
  } catch { /* nothing further to try */ }
}
window.addEventListener('pagehide', flushAutosave);
window.addEventListener('beforeunload', flushAutosave);
// A native window closing does not always fire pagehide, and hiding does not
// always precede it, so this covers the case where it is dismissed instead.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAutosave();
});

function saveRun() {
  try { localStorage.setItem(RUN_KEY, JSON.stringify(RUN)); } catch { /* private mode */ }
  queueAutosave();
  renderRunStatus();
}

/** The run line in the Encounters sidebar: what it holds and when it was written. */
function renderRunStatus() {
  const s = $('#run-status');
  if (!s) return;
  const all = roster();
  const party = all.filter((m) => m.placement === 'party').length;
  const pc = all.filter((m) => m.placement === 'pc').length;
  const when = lastSaveError ? `not saved: ${lastSaveError}`
    : autosavePending ? 'saving…'
      : lastSavedAt ? `saved ${Math.max(0, Math.round((Date.now() - lastSavedAt) / 1000))}s ago`
        : 'unchanged';
  s.innerHTML = `<b>${esc(RUN.name || 'run')}</b> · ${party} party · ${pc} PC · ${RUN.deaths.length} dead<br>${esc(when)}`;
}

/**
 * Re-render everything that reads the run.
 *
 * Replacing the run - new, load, import - used to be followed by whichever
 * renderers the author of that particular path happened to remember, and the
 * four paths remembered four different subsets. Loading a run therefore left
 * the Box tab, the level-cap badge and the Bottle Cap ledger showing the run
 * you had just switched away from. One list, called from all of them.
 *
 * Guarded by typeof because these live in sibling scripts: a view whose script
 * failed to load must not take the whole refresh down with it.
 */
function renderAll() {
  for (const name of ['renderEnc', 'renderItems', 'renderBox', 'renderCap', 'renderCaps',
    'renderSplits', 'renderFrags', 'renderCalc', 'renderTrainers', 'renderSav', 'renderHome',
    'sandboxFollowSave']) {
    const fn = window[name];
    if (typeof fn !== 'function') continue;
    try { fn(); } catch (e) { console.error(`${name} failed after a run change:`, e); }
  }
  renderRunStatus();
  // Two async ones, fired and forgotten: each is a single local request, and
  // only user-initiated run changes get here.
  //
  // refreshRuns redraws the Runs tab, which names the run you are on.
  // refreshStatus redraws the banner, where a run played against a different
  // extraction is flagged.
  for (const name of ['refreshRuns', 'refreshStatus']) {
    const fn = window[name];
    if (typeof fn === 'function') Promise.resolve().then(fn).catch(() => {});
  }
}

function adoptRun(doc) {
  RUN = Object.assign(newRun(), doc);
  RUN.rules = Object.assign(newRun().rules, doc.rules || {});
  if (!RUN.defeated || Array.isArray(RUN.defeated)) RUN.defeated = {};
  RUN.progress ||= {};
  if (typeof buildAreas === 'function' && D.encounters) buildAreas();   // the unit rule may differ
}

function loadRunLocal() {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    if (raw) { adoptRun(JSON.parse(raw)); return true; }
  } catch { /* keep the fresh run */ }
  return false;
}

/**
 * The run to open: the file behind the cached run, or the most recently
 * written file when there is no cache.
 *
 * The cache and the file can disagree in both directions: localStorage is
 * lost if the WebView profile is cleared or the app is moved, and the file is
 * behind if the last write did not get out before the window closed. Comparing
 * `savedAt` rather than preferring one source means neither failure loses a run.
 */
async function loadRunBest() {
  const hadLocal = loadRunLocal();
  const localAt = RUN.savedAt || '';
  let name = RUN.name;
  try {
    if (!hadLocal) {
      const list = (await (await fetch('api/runs')).json()).runs || [];
      list.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      if (list.length) name = list[0].name;
    }
    const r = await fetch(runUrl(name));
    if (r.ok) {
      const doc = await r.json();
      if (doc && !doc.error && (!hadLocal || (doc.savedAt || '') > localAt)) {
        adoptRun(doc);
        try { localStorage.setItem(RUN_KEY, JSON.stringify(RUN)); } catch { /* ignore */ }
      }
    }
  } catch { /* the local copy stands */ }
  runLoaded = true;
  lastSavedAt = RUN.savedAt ? Date.parse(RUN.savedAt) : null;
}

/** Starting fresh on purpose - the one time an empty run may be written. */
function markRunReplaced() {
  runLoaded = true;
  RUN.savedAt = new Date().toISOString();
  return fetch(runUrl() + '?allowEmpty=1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(RUN),
  }).then(() => { lastSavedAt = Date.now(); }).catch(() => {});
}

/* ── areas ────────────────────────────────────────────────────────── */
const areaId = (e) => (e.kind === 'wild'
  ? `wild:${e.mapConstant}:${e.variantIndex || 0}`
  : `${e.kind}:${e.mapConstant}:${e.scriptLabel || e.category || ''}`);

let AREAS = [];

/** The key under which this area's record lives, if it has one. A location
 *  area accepts a record on any of its floors. */
function areaRecordId(a) {
  if (RUN.encounters[a.id]) return a.id;
  for (const id of a.memberIds || []) if (RUN.encounters[id]) return id;
  return null;
}
const areaRecord = (a) => {
  const id = areaRecordId(a);
  return id ? RUN.encounters[id] : null;
};

/** "B1F", "Room 11", "Summit Path 2F": the floor part of a map folder name,
 *  with the place's own name dropped. */
function floorLabel(folder, secName) {
  const secKey = String(secName || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const toks = String(folder || '').replace(/_Frlg$/i, '').split('_');
  const rest = toks.slice(1).filter((t) => t.replace(/[^a-z0-9]/gi, '').toLowerCase() !== secKey);
  const words = (rest.length ? rest : toks.slice(1)).map((t) => t
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/^(B?) (\d+F)$/, '$1$2'));
  return words.join(' ').trim() || mapLabel(folder) || folder;
}

function buildAreas() {
  // maps.json carries a rich split object per map - splitKey/splitIndex/
  // locationIndex/locationLabel - so ordering comes from the extractor rather
  // than from re-deriving it here. Identity must be the KEY: comparing the
  // objects themselves compares references, which made every area start a new
  // heading.
  const unit = (RUN.rules && RUN.rules.encounterUnit) || 'location';
  const mapBy = {};
  for (const m of D.maps.maps || []) mapBy[m.folder] = m;

  // A map with several wild tables reaches only its first in this build
  // (GetCurrentMapWildMonHeaderId returns the first match), so the other
  // variants are places the player can never encounter anything.
  const entries = D.encounters.entries.filter((e) => !(e.kind === 'wild' && (e.variantIndex || 0) > 0));

  // splits.json `parts`: a location that does not own a map can take pieces of
  // it - Kindle Road's land and Surf tables in the Janine split while its
  // fishing and Rock Smash stay with Kindle Road in the Falkner split, either
  // Snorlax in the Janine split. The piece that stays with the owner keeps the
  // map's plain id, so a record made before the split existed stays where it
  // was; a moved piece is `<id>:<methods>` unless it took the whole table.
  const splitById = {};
  for (const s of D.progression?.splits || []) splitById[s.id] = s;
  const claimSplit = (c) => ({
    splitKey: c.splitId, splitLabel: splitById[c.splitId]?.label || c.splitId,
    splitIndex: c.splitIndex, locationIndex: c.locationIndex, locationLabel: c.locationLabel,
    hops: 0, source: 'part', rule: 'part',
  });
  const scriptClaim = {};
  const wildClaims = {};
  for (const c of D.progression?.encounterClaims || []) {
    for (const s of c.scriptLabels || []) scriptClaim[`${c.mapFolder}|${s}`] = c;
    if ((c.wild || []).length) (wildClaims[c.mapFolder] ||= []).push(c);
  }
  const pieces = [];   // [entry, split, id, claim, methods-if-divided]
  for (const e of entries) {
    const own = D.splitOfMap[e.mapName] || null;
    if (e.kind !== 'wild') {
      const c = e.scriptLabel ? scriptClaim[`${e.mapName}|${e.scriptLabel}`] : null;
      pieces.push([e, c ? claimSplit(c) : own, areaId(e), c, null]);
      continue;
    }
    const cs = wildClaims[e.mapName];
    if (!cs) { pieces.push([e, own, areaId(e), null, null]); continue; }
    const methods = e.methods || {};
    const taken = new Set();
    const moved = [];
    for (const c of cs) {
      const ms = c.wild.filter((m) => methods[m] && !taken.has(m));
      ms.forEach((m) => taken.add(m));
      if (ms.length) moved.push([c, ms]);
    }
    const rest = Object.keys(methods).filter((m) => !taken.has(m));
    const only = (ms) => Object.assign({}, e, { methods: Object.fromEntries(ms.map((m) => [m, methods[m]])) });
    if (rest.length) pieces.push([only(rest), own, areaId(e), null, moved.length ? rest : null]);
    for (const [c, ms] of moved) {
      const whole = !rest.length && moved.length === 1;
      pieces.push([only(ms), claimSplit(c), whole ? areaId(e) : `${areaId(e)}:${ms.join('+')}`, c,
        whole ? null : ms]);
    }
  }

  let areas = pieces.map(([e, sp, id, claim, divided]) => {
    const species = new Set();
    for (const m of Object.values(e.methods || {})) {
      for (const s of m.slots || []) species.add(s.species);
    }
    for (const o of e.options || []) species.add(o.species);
    for (const m of e.members || []) species.add(m.species);
    if (e.species) species.add(e.species);

    return {
      id, entry: e, folder: e.mapName, folders: [e.mapName],
      claim: claim || null,
      // Set when this map's wild table is divided between two locations.
      methodsHere: divided,
      split: sp ? sp.splitKey : null,
      splitLabel: sp ? sp.splitLabel : null,
      order: sp ? (sp.splitIndex ?? 999) : 999,
      locOrder: sp ? (sp.locationIndex ?? 0) : 0,
      // Maps the extractor placed by inference sort after the location they
      // were inherited from, nearest first.
      hops: sp ? (sp.hops ?? 0) : 0,
      inferred: !!(sp && sp.source === 'derived'),
      // A pin is a stated fact (config.json placements), not an inference.
      pinned: !!(sp && sp.rule === 'pinned'),
      opensAfter: sp ? (sp.opensAfter || null) : null,
      pinNote: sp && sp.rule === 'pinned' ? (sp.note || null) : null,
      inferredNote: sp && sp.source === 'derived'
        ? (sp.note || (sp.rule === 'sameSection'
          ? `another floor of ${sp.anchorLabel || sp.locationLabel || 'a listed place'}`
          : `a door leads to ${sp.anchorLabel || 'a listed place'}`))
        : null,
      // One legendary-pool entry has no map at all, so this can come back
      // undefined. It must still be a string: an undefined here makes
      // localeCompare throw *inside the sort comparator*, which aborts
      // Array.sort halfway and silently leaves the list partially ordered.
      label: String((sp && sp.locationLabel) || mapLabel(e.mapName)
        || e.mapConstant || e.scriptLabel || e.kind || 'Unknown'),
      species: [...species].filter(Boolean),
      floors: null, members: null, memberIds: null,
    };
  });

  if (unit === 'location') {
    // The floors of one place - the same region-map section, in the same split -
    // are one area. The first floor (a named one, or the nearest) is the head;
    // its id is the key new records are written under, and a record on any
    // floor counts for the whole place.
    const groups = new Map();
    for (const a of areas) {
      if (a.entry.kind !== 'wild') continue;
      const m = mapBy[a.folder];
      const sec = m && m.regionMapSection;
      if (!sec) continue;
      const key = `${sec}|${a.split || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const drop = new Set();
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      members.sort((x, y) => x.hops - y.hops || x.folder.localeCompare(y.folder));
      const head = members[0];
      const secName = (mapBy[head.folder] || {}).regionMapSectionName || head.label;
      head.members = members.slice();
      head.memberIds = members.map((x) => x.id);
      head.folders = members.map((x) => x.folder);
      head.label = String(secName);
      head.floors = members.map((x) => ({
        id: x.id, folder: x.folder, label: floorLabel(x.folder, secName),
        entry: x.entry, species: x.species,
      }));
      head.species = [...new Set(members.flatMap((x) => x.species))];
      for (const x of members.slice(1)) drop.add(x.id);
    }
    areas = areas.filter((a) => !drop.has(a.id));
  }

  // A location marked oneEncounter in splits.json ("Snorlax on Route 12 or
  // 16") is one encounter whatever it spans: the first area heads it and a
  // record on any of them counts for all.
  // Per-map mode keeps them apart, as it keeps floors apart.
  const oneOf = new Map();
  for (const a of unit === 'location' ? areas : []) {
    if (!a.claim || !a.claim.oneEncounter) continue;
    const key = `${a.claim.splitId}|${a.claim.locationIndex}`;
    if (!oneOf.has(key)) oneOf.set(key, []);
    oneOf.get(key).push(a);
  }
  const dropOne = new Set();
  for (const members of oneOf.values()) {
    if (members.length < 2) continue;
    const head = members[0];
    head.members = members.slice();
    head.memberIds = members.map((x) => x.id);
    head.folders = members.map((x) => x.folder);
    head.oneOf = true;
    head.floors = members.map((x) => ({
      id: x.id, folder: x.folder, label: mapLabel(x.folder) || x.folder,
      entry: x.entry, species: x.species,
    }));
    head.species = [...new Set(members.flatMap((x) => x.species))];
    for (const x of members.slice(1)) dropOne.add(x.id);
  }
  areas = areas.filter((a) => !dropOne.has(a.id));

  AREAS = areas;
  AREAS.sort((a, b) => a.order - b.order || a.locOrder - b.locOrder
    || a.hops - b.hops || a.label.localeCompare(b.label));
}

/* ── rules ────────────────────────────────────────────────────────── */
const lineOf = (sp) => (D.byConst[sp]?.lineId || sp);

/** What the dupes clause already considers claimed. */
function claimedKeys() {
  const keys = new Set();
  if (RUN.rules.dupes === 'off') return keys;
  for (const rec of Object.values(RUN.encounters)) {
    if (!rec.species) continue;
    // A death still burns the species: you met it, so the clause still applies.
    if (!ALIVE.has(rec.status) && !DEAD.has(rec.status)) continue;
    keys.add(RUN.rules.dupes === 'line' ? lineOf(rec.species) : rec.species);
  }
  return keys;
}
const isDupe = (sp, claimed) => (
  !!sp && RUN.rules.dupes !== 'off'
  && claimed.has(RUN.rules.dupes === 'line' ? lineOf(sp) : sp)
);

/**
 * The cap in force, and where the number came from.
 *
 * A split's entry cap is not the cap for most of that split: VAR_LEVEL_CAP is
 * raised mid-split too - Falkner's alone goes 0 -> 18 -> 24 -> 30 -> 33 - so
 * the split boundary is the coarsest possible reading of it and is wrong for
 * most of a run. The save carries the live value, so it wins whenever there is
 * one.
 */
function capInfo() {
  const r = RUN.rules;
  if (r.capSource === 'off') return { cap: null, from: 'off' };
  if (r.capSource === 'manual') return { cap: r.manualCap || null, from: 'manual' };
  if (r.capSource === 'save') {
    if (r.saveCap != null) return { cap: r.saveCap, from: 'save' };
    // Asked for the save's cap and there is not one yet - say so rather than
    // silently falling back to a number from somewhere else.
    return { cap: null, from: 'save-missing' };
  }
  const splits = D.progression.splits || [];
  const s = splits.find((x) => x.id === r.splitId) || splits[0];
  return { cap: s ? (s.levelCap?.atEntry ?? null) : null, from: 'split' };
}

function currentCap() { return capInfo().cap; }

function renderCap() {
  const box = $('#cap');
  const { cap, from } = capInfo();
  renderProgressSummary();
  // A cap of 0 is what the split chain reads before the first raise, and a
  // save that has not been read gives nothing at all. Neither is a cap, and
  // showing "cap 0" flagged every Pokemon on the team as over it.
  if (from === 'save-missing' || (from === 'split' && !cap)) {
    box.hidden = false;
    box.className = 'cap';
    box.textContent = 'cap ?';
    box.title = from === 'save-missing'
      ? 'The level cap comes from the save, and none has been read yet. Point the '
        + 'Save file page (under Run) at the emulator\'s .sav and the cap follows the game.'
      : 'No cap is known yet: the split chain reads 0 before the first raise. '
        + 'Reading the save gives the real value.';
    return;
  }
  if (cap == null) { box.hidden = true; return; }
  const over = Object.values(RUN.encounters)
    .filter((r) => isAliveRec(r) && Number(r.currentLevel) > cap);
  box.hidden = false;
  box.className = `cap${over.length ? ' over' : ''}`;
  box.textContent = over.length ? `cap ${cap} — ${over.length} over` : `cap ${cap}`;
  const src = from === 'save' ? 'read from the save'
    : from === 'manual' ? 'set by hand'
      : "the current split's entry cap, which a mid-split raise will outrun";
  box.title = (over.length
    ? `Over the cap: ${over.map((r) => `${r.species || '?'} L${r.currentLevel}`).join(', ')}`
    : 'Every team member is within the level cap') + ` · ${src}`;
}

/* ── views ────────────────────────────────────────────────────────── */
let encMode = 'tracker';

function renderEnc() {
  const main = $('#enc-main');
  if (!main || !D.encounters) return;
  main.textContent = '';
  renderCap();
  if (encMode === 'grave') return renderGraveyard(main);

  const q = $('#enc-q').value.trim().toLowerCase();
  const split = $('#enc-split').value;
  const todo = $('#enc-todo').checked;
  const nonwild = $('#enc-nonwild').checked;
  const claimed = claimedKeys();

  const rows = AREAS.filter((a) => {
    if (!nonwild && a.entry.kind !== 'wild') return false;
    if (split && a.split !== split) return false;
    const rec = areaRecord(a);
    if (todo && rec && rec.status && rec.status !== 'unencountered') return false;
    if (q) {
      const hay = `${a.label} ${a.folders.join(' ')} ${a.species.map((s) => D.byConst[s]?.displayName || s).join(' ')}`
        + (rec ? ` ${rec.nickname || ''} ${rec.species ? D.byConst[rec.species]?.displayName || '' : ''}` : '');
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const done = rows.filter((a) => {
    const r = areaRecord(a);
    return r && r.status && r.status !== 'unencountered';
  }).length;
  $('#enc-count').textContent = `${rows.length} areas · ${done} resolved · ${AREAS.length} total`;

  // The mart pill goes on the first card of each location that has one.
  const martSeen = new Set();
  for (const a of rows) {
    const k = `${a.split}|${a.locOrder}`;
    a.martKey = !martSeen.has(k) && martsAt(a.split, a.locOrder).length ? k : null;
    if (a.martKey) martSeen.add(k);
  }

  const frag = document.createDocumentFragment();
  if (encMode === 'tracker' && !split && !q) renderUnfiled(frag);
  let lastSplit = '__init__';
  for (const a of rows) {
    if (a.split !== lastSplit) {
      lastSplit = a.split;
      const sp = (D.progression.splits || []).find((s) => s.id === a.split);
      const h = el('div', 'split-head');
      h.append(el('b', null, sp ? sp.label : (a.splitLabel || 'Anywhere / optional')));
      if (sp) h.append(el('span', 'sub', `cap ${sp.levelCap?.atEntry ?? '—'} → ${sp.levelCap?.atExit ?? '—'}`));
      if (sp && sp.id === RUN.rules.splitId) h.append(el('span', 'pill good', 'current'));
      frag.append(h);
    }
    frag.append(encMode === 'tracker' ? trackerCard(a, claimed) : viewerCard(a));
  }
  main.append(frag);
}

function speciesLink(sp, extraClass, suffix) {
  const a = el('a', `jump${extraClass ? ' ' + extraClass : ''}`,
    (D.byConst[sp]?.displayName || pretty(sp)) + (suffix || ''));
  a.addEventListener('click', () => { showTab('dex'); selectSpecies(sp); });
  return a;
}

/** A species row for the possible-encounters grid: icon, name, extras. */
function speciesRow(sp, opts) {
  const row = el('div', 's');
  if (opts && opts.rate != null) row.append(el('span', 'r', `${Math.round(opts.rate)}%`));
  if (D.byConst[sp]) row.append(spr(sp));
  const dup = !!(opts && opts.dupe);
  const link = speciesLink(sp, dup ? 'dupe' : '', dup ? ' ✕' : '');
  if (dup) link.title = `Dupe — ${RUN.rules.dupes === 'line' ? pretty(lineOf(sp)) + ' line' : 'species'} already claimed`;
  row.append(link);
  if (opts && opts.levels) row.append(el('span', 'l', opts.levels));
  return row;
}

const METHOD_NAME = { land: 'Grass', water: 'Surf', fishing: 'Fishing', rock_smash: 'Rock Smash' };
const methodName = (m) => METHOD_NAME[m] || pretty(m);

/* ── marts ────────────────────────────────────────────────────────────
   What a location's shops sell, from data/marts.json: every `pokemart` list a
   map script opens, placed at the location its map belongs to. */
const showMart = new Set();

const martsAt = (splitId, locIndex) => (D.martsByLoc || {})[`${splitId}|${locIndex}`] || [];

/** "Celadon City · Department Store 2F", or just "Pewter City · Mart". */
function martPlace(folder) {
  const m = D.mapByFolder?.[folder] || {};
  const sec = m.regionMapSectionName || mapLabel(folder) || folder;
  const floor = floorLabel(folder, sec);
  return floor && floor !== sec ? `${sec} · ${floor}` : sec;
}

/** Every mart list of one location, grouped per shop map. */
function martBlock(splitId, locIndex) {
  const rows = martsAt(splitId, locIndex);
  const wrap = el('div', 'marts');
  const byMap = new Map();
  for (const m of rows) {
    if (!byMap.has(m.map)) byMap.set(m.map, []);
    byMap.get(m.map).push(m);
  }
  for (const [folder, lists] of byMap) {
    const shop = el('div', 'mart');
    shop.append(el('div', 'mart-head', martPlace(folder)));
    for (const m of lists) {
      const line = el('div', 'mart-list');
      if (m.kind === 'stage' || m.kind === 'counter') {
        const tag = el('span', 'pill', m.kind === 'stage' ? (m.when || `stage ${m.stage}`) : `counter ${m.stage}`);
        tag.title = m.kind === 'stage'
          ? `Stock ${m.stage} of ${m.stages}; read from ${m.script}`
          : `One of ${m.stages} counters in this shop`;
        line.append(tag);
      } else if (m.when) {
        line.append(el('span', 'pill', m.when));
      }
      for (const it of m.items) {
        const chip = el('span', 'mart-item');
        chip.append(el('span', null, it.name));
        if (it.price != null) chip.append(el('span', 'price', `₽${it.price}`));
        line.append(chip);
      }
      if (!m.items.length) line.append(el('span', 'const', 'nothing listed'));
      shop.append(line);
    }
    wrap.append(shop);
  }
  return wrap;
}

/** A "mart" pill on the first area card of a location that has a shop. */
function martPill(a) {
  if (!a.martKey) return null;
  const n = martsAt(a.split, a.locOrder).reduce((t, m) => t + m.items.length, 0);
  const p = el('a', `pill mart-pill${showMart.has(a.id) ? ' on' : ''}`, `mart · ${n}`);
  p.title = showMart.has(a.id) ? 'Hide what the mart sells' : 'Show what the mart here sells';
  p.addEventListener('click', (ev) => {
    ev.stopPropagation();
    showMart.has(a.id) ? showMart.delete(a.id) : showMart.add(a.id);
    renderEnc();
  });
  return p;
}

function areaPills(a, head) {
  if (a.entry.kind !== 'wild') head.append(el('span', 'pill', a.entry.kind));
  if (a.floors && a.floors.length > 1) {
    const p = el('span', 'pill', a.oneOf ? `one of ${a.floors.length}` : `${a.floors.length} floors`);
    p.title = a.oneOf
      ? `One encounter between them: ${a.floors.map((f) => f.label).join(' or ')}`
      : `One encounter for the whole place: ${a.floors.map((f) => f.label).join(', ')}`;
    head.append(p);
  }
  if (a.methodsHere) {
    const p = el('span', 'pill', a.methodsHere.map(methodName).join(' & '));
    p.title = 'This map\'s wild encounters are split between two points in the run; '
      + 'only these methods count here (splits.json parts).';
    head.append(p);
  }
  const mp = martPill(a);
  if (mp) head.append(mp);
  const gp = typeof gauntletPill === 'function' ? gauntletPill(a.folders) : null;
  if (gp) head.append(gp);
  if (a.pinned) {
    const p = el('span', 'pill gate', a.opensAfter ? `opens after ${a.opensAfter}` : 'placed by hand');
    p.title = `${a.pinNote ? a.pinNote[0].toUpperCase() + a.pinNote.slice(1) : 'Placed by hand'}`
      + ' - stated in config.json placements, because a door cannot say when it unlocks.';
    head.append(p);
  } else if (a.inferred) {
    const p = el('span', 'pill', 'split inferred');
    p.title = `splits.json does not list this map; ${a.inferredNote}. Add it there to override.`;
    head.append(p);
  }
}

function viewerCard(a) {
  const card = el('div', 'area');
  const head = el('header');
  head.append(el('span', 'nm', a.label));
  areaPills(a, head);
  head.append(el('div', 'grow'));
  head.append(el('span', 'sub', `${a.species.length} species`));
  card.append(head);

  const body = el('div', 'body');
  if (a.martKey && showMart.has(a.id)) body.append(martBlock(a.split, a.locOrder));
  const floors = a.floors || [{ label: null, entry: a.entry }];
  for (const floor of floors) {
    const methods = floor.entry.methods || {};
    if (floors.length > 1) body.append(el('div', 'floor', floor.label));
    if (a.oneOf && !Object.keys(methods).length) {
      const g = el('div', 'slotgrid');
      for (const sp of floor.species || []) g.append(speciesRow(sp));
      body.append(g);
    }
    for (const [method, m] of Object.entries(methods)) {
      body.append(el('div', 'const', `${method} · encounter rate ${m.encounterRate ?? '—'}`));
      const g = el('div', 'slotgrid');
      // Slots repeat the same species; aggregate so a route reads as a species
      // list with real percentages rather than twelve near-identical rows.
      const agg = new Map();
      for (const s of m.slots || []) {
        const cur = agg.get(s.species) || { min: 999, max: 0, rate: 0 };
        cur.min = Math.min(cur.min, s.minLevel);
        cur.max = Math.max(cur.max, s.maxLevel);
        cur.rate += s.ratePercent || 0;
        agg.set(s.species, cur);
      }
      for (const [sp, v] of [...agg.entries()].sort((x, y) => y[1].rate - x[1].rate)) {
        g.append(speciesRow(sp, { rate: v.rate, levels: `L${v.min}–${v.max}` }));
      }
      body.append(g);
    }
  }
  const methods = a.entry.methods || {};
  if (!Object.keys(methods).length && !a.floors) {
    const g = el('div', 'slotgrid');
    for (const sp of a.species) g.append(speciesRow(sp));
    body.append(g);
    if (a.entry.options?.length) body.append(el('div', 'const', 'the player chooses one of these'));
    if (a.entry.kind === 'pool') body.append(el('div', 'const', 'one random member, re-rolled until caught'));
  }
  card.append(body);
  return card;
}

/* Which cards have their detail panel open, and which resolved cards show
   their possible encounters. Kept outside RUN because it is view state, not
   run data — it should not travel with an exported run. */
const expanded = new Set();
const showSlots = new Set();

function trackerCard(a, claimed) {
  const recId = areaRecordId(a) || a.id;
  const rec = RUN.encounters[recId] || {};
  const resolved = rec.status && rec.status !== 'unencountered';
  const caught = !!(rec.species || rec.speciesRaw) && (ALIVE.has(rec.status) || DEAD.has(rec.status));
  const dead = caught && isDeadRec(rec);
  const card = el('div', `area${resolved ? ' done' : ''}${caught ? (dead ? ' has-dead' : ' has-mon') : ''}`);

  const stClass = dead ? 'dead'
    : ALIVE.has(rec.status) ? 'caught'
      : rec.status === 'fled' ? 'fled'
        : rec.status === 'skipped' ? 'skipped' : '';

  const head = el('header');
  head.append(el('span', `st ${stClass}`));
  head.append(el('span', 'nm', a.label));
  areaPills(a, head);
  head.append(el('div', 'grow'));
  head.append(el('span', 'sub', caught ? STATUS_LABEL[rec.status] || ''
    : resolved ? (STATUS_LABEL[rec.status] || rec.status)
      : `${a.species.length} possible`));
  card.append(head);

  const body = el('div', 'body');
  if (a.martKey && showMart.has(a.id)) body.append(martBlock(a.split, a.locOrder));

  const upd = (patch) => {
    const before = RUN.encounters[recId] || {};
    const next = Object.assign(
      { areaId: recId, area: a.label, splitId: a.split }, before, patch);
    // A death belongs to the split you were IN when it happened, not to the
    // split of the route where you originally caught it. Stamp it once, on the
    // transition, so later edits do not silently move a death down the timeline.
    if (isDeadRec(next) && !isDeadRec(before) && !next.diedInSplit) {
      next.diedInSplit = RUN.rules.splitId || a.split || null;
    }
    if (!isDeadRec(next)) delete next.diedInSplit;
    RUN.encounters[recId] = next;
    syncDeaths();
    renderEnc();
  };

  // ── the Pokémon this area gave, front and centre ──
  if (caught) {
    const strip = el('div', 'caught');
    const pic = el('div', 'pic');
    if (rec.species) pic.append(spr(rec.species, 'front'));
    strip.append(pic);
    const info = el('div', 'info');
    const spName = rec.species ? (D.byConst[rec.species]?.fullName || D.byConst[rec.species]?.displayName) : (rec.speciesRaw || '?');
    const nameRow = el('div', 'name');
    nameRow.append(el('b', null, rec.nickname || spName));
    if (rec.nickname) nameRow.append(el('span', 'const', spName));
    if (rec.species && D.byConst[rec.species]) nameRow.append(typeChips(D.byConst[rec.species].types));
    info.append(nameRow);
    const meta = [
      rec.currentLevel != null ? `L${rec.currentLevel}` : null,
      rec.hatched ? 'hatched' : (rec.levelCaught ? `caught at L${rec.levelCaught}` : null),
      placementText(rec),
      rec.frags ? `${rec.frags} KO${rec.frags === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    info.append(el('div', 'const', meta.join(' · ')));
    if (dead && (rec.cause || rec.diedInSplit)) {
      const sp = (D.progression.splits || []).find((s) => s.id === rec.diedInSplit);
      info.append(el('div', 'const', `died${sp ? ` in ${sp.label}` : ''}${rec.cause ? ` — ${rec.cause}` : ''}`));
    }
    strip.append(info);

    const actions = el('div', 'actions');
    const box = el('button', 'btn ghost', 'Box');
    box.title = 'Open this Pokémon in the Box';
    box.addEventListener('click', () => {
      if (typeof boxSelected !== 'undefined') boxSelected = recId;
      showTab('box');
      if (typeof renderBox === 'function') renderBox();
    });
    actions.append(box);
    if (dead) {
      const undo = el('button', 'btn ghost', 'Revive');
      undo.title = 'Put this Pokémon back in the party and clear its death';
      undo.addEventListener('click', () => upd({
        status: 'caught', placement: 'party', cause: null,
        diedInSplit: null, deathSource: null,
      }));
      actions.append(undo);
    } else {
      const kill = el('button', 'btn danger', 'Mark dead');
      kill.title = 'Record this as dead now, whether or not you have moved it '
        + 'into boxes 13–14 in game';
      kill.addEventListener('click', () => {
        expanded.add(a.id);
        upd({ status: 'fainted', placement: 'graveyard', deathSource: 'manual' });
      });
      actions.append(kill);
    }
    const more = el('button', 'btn ghost', expanded.has(a.id) ? 'hide details' : 'details');
    more.addEventListener('click', () => {
      expanded.has(a.id) ? expanded.delete(a.id) : expanded.add(a.id);
      renderEnc();
    });
    actions.append(more);
    strip.append(actions);
    body.append(strip);
    if (dead) {
      const row = el('div', 'entry');
      const cause = el('input');
      cause.placeholder = 'cause of death';
      cause.style.width = '240px';
      cause.value = rec.cause || '';
      cause.addEventListener('change', () => upd({ cause: cause.value }));
      row.append(cause);
      if (rec.deathSource === 'manual') {
        const p = el('span', 'pill warn', 'marked by hand');
        p.title = 'Recorded in the app, not read from a save. A later sync will not '
          + 'undo this on its own.';
        row.append(p);
      }
      body.append(row);
    }
  }

  // ── the record's controls: inline for an open area, behind "details" for a caught one ──
  const e = el('div', 'entry');

  const sel = el('select');
  for (const s of STATUSES) {
    const o = el('option', null, STATUS_LABEL[s]); o.value = s; sel.append(o);
  }
  sel.value = rec.status || 'unencountered';
  sel.addEventListener('change', () => upd({ status: sel.value }));
  e.append(sel);

  const sp = el('input', 'sp');
  sp.placeholder = 'species';
  sp.setAttribute('list', 'species-list');
  sp.value = rec.species ? (D.byConst[rec.species]?.displayName || rec.species) : (rec.speciesRaw || '');
  sp.addEventListener('change', () => {
    const v = sp.value.trim();
    const hit = D.species.find((x) => x.displayName.toLowerCase() === v.toLowerCase()) || D.byConst[v];
    upd({ species: hit ? hit.constant : null, speciesRaw: v });
  });
  e.append(sp);

  const nick = el('input', 'nick');
  nick.placeholder = 'nickname';
  nick.value = rec.nickname || '';
  nick.addEventListener('change', () => upd({ nickname: nick.value }));
  e.append(nick);

  for (const [k, ph] of [['levelCaught', 'caught'], ['currentLevel', 'now']]) {
    const i = el('input', 'lv');
    i.type = 'number'; i.min = '1'; i.max = '100'; i.placeholder = ph;
    i.value = rec[k] ?? '';
    i.addEventListener('change', () => upd({ [k]: i.value ? Number(i.value) : null }));
    e.append(i);
  }

  // Placement is what decides "alive", not the status word: a caught mon sitting
  // in boxes 13–14 is dead, and a party member is available.
  if (ALIVE.has(rec.status) || DEAD.has(rec.status)) {
    const pl = el('select');
    for (const p of PLACEMENTS) {
      const o = el('option', null, PLACEMENT_LABEL[p]); o.value = p; pl.append(o);
    }
    pl.value = placementOf(rec) || 'party';
    pl.addEventListener('change', () => upd({ placement: pl.value }));
    e.append(pl);
  }
  if (!caught && (rec.species || rec.speciesRaw)) {
    const more = el('button', 'btn ghost', expanded.has(a.id) ? 'hide details' : 'details');
    more.addEventListener('click', () => {
      expanded.has(a.id) ? expanded.delete(a.id) : expanded.add(a.id);
      renderEnc();
    });
    e.append(more);
  }
  if (!caught || expanded.has(a.id)) body.append(e);

  if (expanded.has(a.id)) body.append(monDetail(a, rec, upd, recId));

  if (rec.species && isDupe(rec.species, dupesExcluding(recId))) {
    body.append(el('div', 'note', 'This species is already claimed elsewhere in the run.'));
  }

  // ── what the area can give ──
  if (a.species.length) {
    const show = !resolved || showSlots.has(a.id);
    if (resolved) {
      const t = el('a', 'jump slots-toggle', show ? 'hide possible encounters' : `possible encounters (${a.species.length})`);
      t.addEventListener('click', () => {
        showSlots.has(a.id) ? showSlots.delete(a.id) : showSlots.add(a.id);
        renderEnc();
      });
      body.append(t);
    }
    if (show) {
      const g = el('div', 'slotgrid');
      for (const s of a.species.slice(0, 40)) g.append(speciesRow(s, { dupe: isDupe(s, claimed) }));
      body.append(g);
      const blocked = a.species.filter((s) => isDupe(s, claimed)).length;
      if (blocked && blocked === a.species.length && !resolved) {
        body.append(el('div', 'note', RUN.rules.reroll
          ? 'Every species here is a dupe — reroll the encounter.'
          : 'Every species here is a dupe under the current clause.'));
      }
    }
  }
  card.append(body);
  return card;
}

const SNAPSHOT_FIELDS = [
  ['nature', 'Nature'], ['ability', 'Ability'], ['heldItem', 'Held item'],
  ['ivs', 'IVs'], ['evs', 'EVs'], ['ot', 'OT'],
];

/**
 * The per-Pokémon panel: a snapshot of its attributes, free-text notes, and a
 * read-out of the bottle caps spent on it.
 *
 * The snapshot is deliberately free text rather than validated fields. It is a
 * note to yourself about a mon you are looking at in-game, and a strict form
 * would just make it slower to jot "31 after 2 caps" — which is the thing you
 * actually want to remember. Save reads fill these in properly; until then,
 * typing beats not recording.
 */
function monDetail(a, rec, upd, recId) {
  const wrap = el('div', 'mondetail');
  const snap = rec.snapshot || {};
  const id = recId || a.id;

  const grid = el('div', 'snapgrid');
  for (const [key, label] of SNAPSHOT_FIELDS) {
    const f = el('label', 'f');
    f.append(el('span', null, label));
    const i = el('input');
    i.value = snap[key] || '';
    i.placeholder = key === 'ivs' ? '31/0/31/31/31/31' : '';
    i.addEventListener('change', () => upd({
      snapshot: Object.assign({}, rec.snapshot, { [key]: i.value.trim() || null }),
    }));
    f.append(i);
    grid.append(f);
  }
  wrap.append(grid);

  const mvWrap = el('div', 'snapgrid');
  for (let n = 0; n < 4; n += 1) {
    const f = el('label', 'f');
    f.append(el('span', null, `Move ${n + 1}`));
    const i = el('input');
    i.setAttribute('list', 'move-list');
    i.value = (snap.moves || [])[n] || '';
    i.addEventListener('change', () => {
      const moves = [...(rec.snapshot?.moves || [])];
      moves[n] = i.value.trim() || null;
      upd({ snapshot: Object.assign({}, rec.snapshot, { moves }) });
    });
    f.append(i);
    mvWrap.append(f);
  }
  wrap.append(mvWrap);

  // KOs live on the record rather than in the snapshot: the game keeps a real
  // counter for this, so save reads overwrite it with truth.
  const ff = el('label', 'f');
  ff.append(el('span', null, 'Frags (KOs)'));
  const fi = el('input');
  fi.type = 'number'; fi.min = '0'; fi.max = '255';
  fi.value = rec.frags ?? '';
  fi.addEventListener('change', () => upd({
    frags: fi.value === '' ? null : Number(fi.value),
    fragsSource: fi.value === '' ? null : 'manual',
  }));
  ff.append(fi);
  wrap.append(ff);

  const nf = el('label', 'f');
  nf.append(el('span', null, 'Notes'));
  const ta = el('textarea');
  ta.rows = 3;
  ta.placeholder = 'e.g. Used 3 bottle caps — two to hyper train, one to relearn a move';
  ta.value = rec.notes || '';
  ta.addEventListener('change', () => upd({ notes: ta.value }));
  nf.append(ta);
  wrap.append(nf);

  // Caps spent on this mon, taken from the ledger rather than retyped.
  const spends = (RUN.caps?.spends || []).filter((s) => s.monId === id);
  if (spends.length) {
    const total = spends.reduce((x, s) => x + (Number(s.cost) || 0), 0);
    const by = {};
    for (const s of spends) by[s.label] = (by[s.label] || 0) + 1;
    const line = Object.entries(by).map(([k, n]) => `${n}× ${k}`).join(', ');
    wrap.append(el('div', 'note', `${total} bottle cap${total === 1 ? '' : 's'} spent here — ${line}`));
  }
  return wrap;
}

/** Claimed keys ignoring one area, so a record does not flag itself as a dupe. */
function dupesExcluding(id) {
  const keys = new Set();
  if (RUN.rules.dupes === 'off') return keys;
  for (const [k, rec] of Object.entries(RUN.encounters)) {
    if (k === id || !rec.species) continue;
    if (!ALIVE.has(rec.status) && !DEAD.has(rec.status)) continue;
    keys.add(RUN.rules.dupes === 'line' ? lineOf(rec.species) : rec.species);
  }
  return keys;
}

/** RUN.deaths is derived from the encounter records, never edited directly. */
function syncDeaths() {
  const next = [];
  for (const [id, r] of Object.entries(RUN.encounters)) {
    if (!isDeadRec(r)) continue;
    const prev = RUN.deaths.find((d) => d.areaId === id);
    next.push({
      areaId: id,
      area: r.area,
      species: r.species || null,
      speciesRaw: r.speciesRaw || null,
      nickname: r.nickname || null,
      level: r.currentLevel ?? r.levelCaught ?? null,
      cause: r.cause || null,
      diedInSplit: r.diedInSplit || null,
      deathSource: r.deathSource || null,
      notes: r.notes || null,
      snapshot: r.snapshot || null,
      splitId: r.diedInSplit || r.splitId || null,
      caughtInSplit: r.splitId || null,
      at: prev?.at || new Date().toISOString(),
    });
  }
  RUN.deaths = next;
  saveRun();
}

function renderGraveyard(main) {
  syncDeaths();
  const alive = roster().filter((m) => m.placement !== 'graveyard');
  main.append(el('h3', null, `Graveyard — ${RUN.deaths.length} dead, ${alive.length} alive`));

  if (!RUN.deaths.length) {
    main.append(el('div', 'empty', 'Nothing has died yet.'));
  } else {
    const t = el('table', 'grid');
    t.innerHTML = '<tr><th>Pokémon</th><th>Lv</th><th>Where</th><th>Split</th><th>Cause</th><th>Notes</th></tr>';
    for (const d of RUN.deaths) {
      const tr = el('tr');
      const nm = d.species ? (D.byConst[d.species]?.displayName || d.species) : (d.speciesRaw || '—');
      const nameCell = el('td');
      if (d.species) nameCell.append(spr(d.species));
      nameCell.append(document.createTextNode(d.nickname ? `${d.nickname} (${nm})` : nm));
      tr.append(nameCell);
      tr.append(el('td', 'mono', dash(d.level)));
      tr.append(el('td', null, dash(d.area)));
      const sp = (D.progression.splits || []).find((s) => s.id === d.splitId);
      tr.append(el('td', null, sp ? sp.label : dash(d.splitId)));
      const cause = el('td');
      cause.append(document.createTextNode(dash(d.cause)));
      if (d.deathSource === 'manual') {
        const p = el('span', 'pill warn', 'by hand');
        p.style.marginLeft = '6px';
        p.title = 'Recorded in the app, not read from a save';
        cause.append(p);
      }
      tr.append(cause);
      tr.append(el('td', null, dash(d.notes)));
      t.append(tr);
    }
    main.append(t);
  }

  // The living roster with a kill switch on each row. This is the screen you
  // want open mid-run: marking something dead should not mean hunting for the
  // route card it was caught on.
  main.append(el('h3', null, `Living roster — ${alive.length}`));
  if (!alive.length) {
    main.append(el('div', 'empty', 'Nothing caught yet.'));
  } else {
    // Losing a run is the one time the tracker has the MOST to record and the
    // least patience for it: a wipe is six deaths at once, all with the same
    // cause, in the same split. One at a time is why it does not get logged.
    const bar = el('div', 'wipebar');
    const boxes = [];
    const selected = () => boxes.filter((b) => b.checked).map((b) => b._mon);

    const cause = el('input');
    cause.type = 'text';
    cause.placeholder = 'Cause — applied to all selected';
    cause.className = 'wipecause';

    const count = el('span', 'sub');
    const refreshCount = () => {
      const n = selected().length;
      count.textContent = n ? `${n} selected` : 'none selected';
      go.disabled = !n;
      // Not the bare "Mark dead" of the per-row buttons: two controls with the
      // same label, one acting on a row and one on a selection, is a mistake
      // waiting to be made.
      go.textContent = n ? `Mark ${n} dead` : 'Mark selected dead';
    };

    const pick = (fn) => () => {
      for (const b of boxes) b.checked = fn(b._mon);
      refreshCount();
    };
    const btn = (label, title, fn) => {
      const b = el('button', 'btn ghost', label);
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };

    const go = el('button', 'btn danger', 'Mark selected dead');
    go.addEventListener('click', () => {
      const picked = selected();
      if (!picked.length) return;
      const why = cause.value.trim();
      const split = RUN.rules.splitId || null;
      for (const m of picked) {
        m.rec.status = 'fainted';
        m.rec.placement = 'graveyard';
        m.rec.deathSource = 'manual';
        m.rec.diedInSplit = split || m.rec.splitId || null;
        if (why) m.rec.cause = why;
      }
      syncDeaths();
      renderEnc();
      if (typeof renderBox === 'function') renderBox();
      if (typeof renderCap === 'function') renderCap();
    });

    bar.append(btn('All', 'Select every living Pokémon', pick(() => true)));
    bar.append(btn('Party', 'Select what is in the party — a wipe, usually',
      pick((m) => m.placement === 'party')));
    bar.append(btn('None', 'Clear the selection', pick(() => false)));
    bar.append(cause);
    bar.append(count);
    bar.append(go);
    main.append(bar);

    const t = el('table', 'grid');
    t.innerHTML = '<tr><th></th><th>Pokémon</th><th>Lv</th><th>Where</th><th>Caught at</th><th></th></tr>';
    for (const m of alive) {
      const tr = el('tr');
      const tick = el('input');
      tick.type = 'checkbox';
      tick._mon = m;
      tick.addEventListener('change', refreshCount);
      boxes.push(tick);
      const tickCell = el('td');
      tickCell.append(tick);
      tr.append(tickCell);
      const nameCell = el('td');
      if (m.rec.species) nameCell.append(spr(m.rec.species));
      nameCell.append(document.createTextNode(rosterLabel(m)));
      tr.append(nameCell);
      tr.append(el('td', 'mono', dash(m.rec.currentLevel)));
      const place = el('select');
      for (const p of PLACEMENTS) {
        const o = el('option', null, PLACEMENT_LABEL[p]); o.value = p; place.append(o);
      }
      place.value = m.placement || 'party';
      place.addEventListener('change', () => {
        m.rec.placement = place.value;
        if (place.value === 'graveyard') {
          m.rec.status = 'fainted';
          m.rec.deathSource = 'manual';
          m.rec.diedInSplit = m.rec.diedInSplit || RUN.rules.splitId || m.rec.splitId || null;
        }
        syncDeaths(); renderEnc();
      });
      const c2 = el('td'); c2.append(place); tr.append(c2);
      tr.append(whereCell(m.id, m.rec, false));

      const c4 = el('td');
      const kill = el('button', 'btn danger', 'Mark dead');
      kill.addEventListener('click', () => {
        m.rec.status = 'fainted';
        m.rec.placement = 'graveyard';
        m.rec.deathSource = 'manual';
        m.rec.diedInSplit = RUN.rules.splitId || m.rec.splitId || null;
        syncDeaths(); renderEnc();
      });
      c4.append(kill); tr.append(c4);
      t.append(tr);
    }
    main.append(t);
    refreshCount();          // sets the button's label and disabled state
  }

  const n = el('div', 'note');
  n.innerHTML = 'In game, <b>boxes 13–14 are the graveyard</b> and <b>boxes 1–3 are the living PC</b>. '
    + 'You can mark something dead here without having moved it in game — a death '
    + 'recorded by hand is tagged <b>marked by hand</b>, and a later save read will '
    + 'not quietly undo it.';
  n.style.marginTop = '14px';
  main.append(n);
}

/* ── filing a save-imported Pokemon into an encounter area ────────── */

/**
 * Move a record onto an encounter area's key.
 *
 * Records the save created for a Pokemon whose met section holds several
 * areas are keyed `save:<personality>:<otId>` and sit outside the route cards.
 * Filing one renames its key to the area's, which is what the tracker cards,
 * the dupes clause and the split attribution all read - so the bottle-cap
 * ledger and the split snapshots that pointed at the old key are moved too.
 */
function refileRecord(oldId, areaId, opts) {
  const quiet = !!(opts && opts.quiet);
  const a = AREAS.find((x) => x.id === areaId);
  const rec = RUN.encounters[oldId];
  if (!a || !rec) return false;
  const taken = areaRecordId(a);
  if (taken && taken !== oldId) return false;
  delete RUN.encounters[oldId];
  rec.areaId = a.id;
  rec.area = a.label;
  rec.splitId = a.split || rec.splitId || null;
  rec.metCandidates = null;
  rec.metAreaSource = (opts && opts.source) || 'manual';
  RUN.encounters[a.id] = rec;
  for (const s of (RUN.caps && RUN.caps.spends) || []) if (s.monId === oldId) s.monId = a.id;
  for (const st of Object.values(RUN.splits || {})) {
    for (const key of ['teamAtEntry', 'teamAtExit']) {
      for (const m of st[key] || []) if (m.areaId === oldId) m.areaId = a.id;
    }
  }
  if (typeof boxSelected !== 'undefined' && boxSelected === oldId) boxSelected = a.id;
  if (quiet) return true;
  syncDeaths();
  renderAll();
  return true;
}

/** The "where" of a roster row: plain text, or a picker when it is unfiled. */
function whereCell(id, rec, bare) {
  const cell = bare ? el('span') : el('td');
  if (!Array.isArray(rec.metCandidates)) { cell.textContent = dash(rec.area); return cell; }
  const sel = el('select');
  const first = el('option', null, rec.metCandidates.length
    ? `pick an area (${rec.metCandidates.length})` : 'pick an area');
  first.value = '';
  sel.append(first);
  const cands = rec.metCandidates.length
    ? rec.metCandidates.map((cid) => AREAS.find((x) => x.id === cid || (x.memberIds || []).includes(cid))).filter(Boolean)
    : AREAS;
  const seen = new Set();
  for (const a of cands) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const holder = areaRecordId(a);
    const taken = !!holder && holder !== id;
    const o = el('option', null,
      `${a.label}${a.splitLabel ? ` · ${a.splitLabel}` : ''}${taken ? ' (taken)' : ''}`);
    o.value = a.id;
    o.disabled = taken;
    sel.append(o);
  }
  sel.title = rec.metLocationName
    ? `Met at ${rec.metLocationName}, which has more than one encounter area`
    : 'The save did not say where this was met';
  sel.addEventListener('change', () => { if (sel.value) refileRecord(id, sel.value); });
  cell.append(sel);
  return cell;
}

/** Save-imported Pokemon that still need an area, at the top of the tracker. */
function renderUnfiled(frag) {
  const rows = Object.entries(RUN.encounters).filter(([, r]) => Array.isArray(r.metCandidates));
  if (!rows.length) return;
  const h = el('div', 'split-head');
  h.append(el('b', null, `Needs an area — ${rows.length}`));
  h.append(el('span', 'sub', 'the save says where each was met, but that place has more than one encounter area'));
  frag.append(h);
  for (const [id, rec] of rows) {
    const card = el('div', 'area unfiled');
    const head = el('header');
    head.append(el('span', `st ${isDeadRec(rec) ? 'dead' : 'caught'}`));
    if (rec.species) head.append(spr(rec.species));
    head.append(el('span', 'nm', rosterLabel({ rec })));
    head.append(el('span', 'sub', `L${rec.currentLevel ?? '?'} · met at ${rec.metLocationName || 'an unknown place'}`));
    head.append(el('div', 'grow'));
    head.append(whereCell(id, rec, true));
    card.append(head);
    frag.append(card);
  }
}

/** The Progress block in the Encounters sidebar. */
function renderProgressSummary() {
  const box = $('#prog-summary');
  if (!box) return;
  const P = RUN.progress || {};
  const s = (D.progression?.splits || []).find((x) => x.id === RUN.rules.splitId);
  const parts = [];
  parts.push(`<b>${esc(s ? s.label : '—')}</b>`
    + (RUN.rules.splitSource === 'manual' ? ' (set by hand)'
      : P.derivedSplitId ? ' (from the save)' : ''));
  const { cap } = capInfo();
  parts.push(cap ? `cap ${cap}` : 'cap unknown');
  if (P.badgeCount != null) parts.push(`${P.badgeCount} badge${P.badgeCount === 1 ? '' : 's'}`);
  const beaten = Object.keys(RUN.defeated || {}).length;
  if (beaten) parts.push(`${beaten} trainers beaten`);
  const nb = typeof nextBossFight === 'function' ? nextBossFight() : null;
  if (nb) parts.push(`next: ${esc(nb.trainer.name)}`);
  box.innerHTML = parts.join(' · ');
}

const TAB_KEY = 'kudzu.tab';
const showTab = (name) => {
  // An unknown page used to blank the whole window and store "undefined" as
  // the tab to reopen on.
  if (!document.getElementById(`tab-${name}`)) return;
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  $$('.tab').forEach((x) => x.classList.toggle('on', x.id === `tab-${name}`));
  // The section row and the page row follow whoever changed the page (nav.js).
  if (typeof navSync === 'function') navSync(name);
  try { localStorage.setItem(TAB_KEY, name); } catch { /* ignore */ }
  // The calculator has no page row above it, so the stage is a different
  // height from the page just left, and a fitted zoom has to be re-taken.
  if (name === 'calc' && typeof refitCalcIfAuto === 'function') {
    try { refitCalcIfAuto(); requestAnimationFrame(refitCalcIfAuto); } catch { /* frame not loaded yet */ }
  }
};

/** Change the Encounters view from anywhere, keeping its switch in step. The
 *  Overview used to set `encMode` directly, which showed the Graveyard under a
 *  switch that still said Tracker. */
function setEncMode(mode) {
  encMode = mode;
  $$('#enc-mode button').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
  renderEnc();
}

/* ── rules <-> UI ─────────────────────────────────────────────────── */
function syncRulesToUI() {
  const r = RUN.rules;
  $('#rule-dupes').value = r.dupes;
  $('#rule-shiny').checked = !!r.shiny;
  $('#rule-species').checked = !!r.species;
  $('#rule-reroll').checked = !!r.reroll;
  $('#rule-mode').value = r.mode;
  $('#rule-items').checked = !!r.items;
  $('#rule-capsrc').value = r.capSource;
  $('#rule-cap').value = r.manualCap ?? 100;
  if ($('#rule-unit')) $('#rule-unit').value = r.encounterUnit || 'location';
  if (r.splitId) $('#rule-split').value = r.splitId;
  const fw = $('#prog-follow-wrap');
  if (fw) fw.hidden = r.splitSource !== 'manual';
  applyCapSourceVisibility();
  renderRunStatus();
}

function readRulesFromUI() {
  // Merged, not replaced: saveCap, splitId and splitSource are not on this
  // form, and rebuilding the object used to throw them away on every tick.
  const unitBefore = RUN.rules.encounterUnit || 'location';
  Object.assign(RUN.rules, {
    dupes: $('#rule-dupes').value,
    shiny: $('#rule-shiny').checked,
    species: $('#rule-species').checked,
    reroll: $('#rule-reroll').checked,
    mode: $('#rule-mode').value,
    items: $('#rule-items').checked,
    capSource: $('#rule-capsrc').value,
    manualCap: Number($('#rule-cap').value) || null,
    encounterUnit: $('#rule-unit') ? $('#rule-unit').value : unitBefore,
  });
  applyCapSourceVisibility();
  saveRun();
  if ((RUN.rules.encounterUnit || 'location') !== unitBefore) {
    buildAreas();
    renderAll();
  } else {
    renderEnc();
  }
}

/** Picking a split by hand pins it; the save stops moving it until "follow". */
function pickSplitByHand() {
  const id = $('#rule-split').value || null;
  if (!id) return;
  RUN.rules.splitId = id;
  RUN.rules.splitSource = (RUN.progress && RUN.progress.derivedSplitId === id) ? 'save' : 'manual';
  syncRulesToUI(); saveRun(); renderAll();
}

function followSaveSplit() {
  RUN.rules.splitSource = 'save';
  if (RUN.progress && RUN.progress.derivedSplitId) RUN.rules.splitId = RUN.progress.derivedSplitId;
  syncRulesToUI(); saveRun(); renderAll();
}

function applyCapSourceVisibility() {
  const src = $('#rule-capsrc').value;
  $('#rule-manual-wrap').hidden = src !== 'manual';
}

/* ── init ─────────────────────────────────────────────────────────── */
function initEncounters() {
  // The run is already loaded by boot(), which can await the disk copy.
  buildAreas();

  // Species autocomplete for manual entry.
  let dl = $('#species-list');
  if (!dl) {
    dl = el('datalist'); dl.id = 'species-list'; document.body.append(dl);
  }
  dl.textContent = '';
  for (const s of D.species) {
    if (s.cosmeticForm) continue;
    const o = el('option'); o.value = s.displayName; dl.append(o);
  }

  let ml = $('#move-list');
  if (!ml) { ml = el('datalist'); ml.id = 'move-list'; document.body.append(ml); }
  ml.textContent = '';
  for (const m of D.moves) {
    if (!m.isRegularMove || !m.displayName) continue;
    const o = el('option'); o.value = m.displayName; ml.append(o);
  }

  const splits = D.progression.splits || [];
  fillSelect($('#enc-split'), splits.map((s) => s.id),
    (id) => (splits.find((s) => s.id === id) || {}).label || id);
  $('#enc-split').firstChild.textContent = 'all';

  const rs = $('#rule-split');
  rs.textContent = '';
  for (const s of splits) {
    const o = el('option', null, `${s.label} — cap ${s.levelCap?.atEntry ?? '?'}`);
    o.value = s.id; rs.append(o);
  }
  if (!RUN.rules.splitId && splits.length) RUN.rules.splitId = splits[0].id;

  syncRulesToUI();

  $$('#enc-mode button').forEach((b) => b.addEventListener('click', () => {
    encMode = b.dataset.mode;
    $$('#enc-mode button').forEach((x) => x.classList.toggle('on', x === b));
    renderEnc();
  }));

  for (const id of ['#enc-q', '#enc-split', '#enc-todo', '#enc-nonwild']) {
    $(id).addEventListener('input', renderEnc);
  }
  for (const id of ['#rule-dupes', '#rule-shiny', '#rule-species', '#rule-reroll',
    '#rule-mode', '#rule-items', '#rule-capsrc', '#rule-cap', '#rule-unit']) {
    const node = $(id);
    if (node) node.addEventListener('input', readRulesFromUI);
  }
  $('#rule-split').addEventListener('change', pickSplitByHand);
  const follow = $('#prog-follow');
  if (follow) follow.addEventListener('click', followSaveSplit);
  const manage = $('#run-manage');
  if (manage) manage.addEventListener('click', () => showTab('runs'));
  // Keep "saved 3s ago" honest.
  setInterval(renderRunStatus, 15000);

  saveRun();
  renderEnc();
}
window.initEncounters = initEncounters;
