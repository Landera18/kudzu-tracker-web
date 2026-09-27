/* Kudzu Nuzlocke Tracker — Pokédex + Trainer Viewer.
 *
 * Everything shown here is derived from data/*.json, which is extracted from the
 * decomp. There is no vanilla fallback anywhere in this file: if a field is null
 * it renders as "—" rather than as a plausible default, because a wrong-but-
 * plausible number is worse than a visible gap when you are deciding a fight.
 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

// A Pokémon sprite <img>. The URL is derived from the constant, so nothing has
// to be looked up; a species whose sheet the extractor could not produce just
// hides itself rather than showing a broken-image glyph.
const spr = (constant, kind = 'icon') => {
  const img = document.createElement('img');
  img.className = `spr ${kind}`;
  img.alt = '';
  img.loading = 'lazy';
  img.src = `data/sprites/${kind}/${constant}.png`;
  img.addEventListener('error', () => { img.hidden = true; });
  return img;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

/* Type colours. Kudzu's own palettes are 15-bit GBA values meant for sprites,
   not UI, so these are chosen for contrast against the dark panel instead. */
const TYPE_COLOR = {
  TYPE_NORMAL: '#b8b3a5', TYPE_FIGHTING: '#d1614a', TYPE_FLYING: '#a6c0ea',
  TYPE_POISON: '#b48bd8', TYPE_GROUND: '#dbc07a', TYPE_ROCK: '#c4b48b',
  TYPE_BUG: '#b4c44a', TYPE_GHOST: '#8f7bb8', TYPE_STEEL: '#a9b7c6',
  TYPE_FIRE: '#e88b4a', TYPE_WATER: '#6fa8dc', TYPE_GRASS: '#7bc96f',
  TYPE_ELECTRIC: '#e8ce4a', TYPE_PSYCHIC: '#e87ba0', TYPE_ICE: '#8fd8d8',
  TYPE_DRAGON: '#8b7bd8', TYPE_DARK: '#8a7a6d', TYPE_FAIRY: '#e8a8d8',
  TYPE_STELLAR: '#9fe0d0', TYPE_MYSTERY: '#7a8290', TYPE_NONE: '#5a626e',
};
const typeColor = (t) => TYPE_COLOR[t] || '#7a8290';
const typeName = (t) => (D.typeName[t] || String(t || '').replace('TYPE_', ''));

const pretty = (c) => String(c ?? '').replace(/^[A-Z]+_/, '').toLowerCase()
  .replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

/* The ROM's own spelling of an ability. Title-casing the constant gets 22 of
   them wrong - ABILITY_RKS_SYSTEM is "RKS System", not "Rks System", and
   ABILITY_DRAGONS_MAW is "Dragon's Maw" - so the extracted name wins and the
   derived one is only a fallback for a constant the dataset does not carry. */
const abilityName = (c) => {
  if (!c) return null;
  const rec = D.abilityBy[typeof c === 'string' ? c : c.constant];
  return (rec && rec.displayName) || pretty(typeof c === 'string' ? c : c.constant);
};

/**
 * Which ability a Pokémon actually has, from its species and abilityNum.
 *
 * GetAbilityBySpecies in src/pokemon.c, including its fallbacks, which matter:
 * abilityNum is a 2-bit field so it can point at a slot the species leaves
 * empty. A hidden slot that is empty falls through to the other hidden slots,
 * and anything still empty falls back to the first ability the species has at
 * all. Indexing the slot naively instead would report "no ability" for every
 * single-ability species whose abilityNum happens to be 1.
 */
function abilityForSlot(sp, abilityNum) {
  const a = (sp && sp.abilities) || {};
  const slots = [a.primary, a.secondary, a.hidden];   // 2 normal + 1 hidden
  const NORMAL = 2;
  const has = (i) => slots[i] && slots[i].constant && slots[i].constant !== 'ABILITY_NONE';

  const n = Number(abilityNum);
  let pick = Number.isFinite(n) && n >= 0 && n < slots.length && has(n) ? n : -1;
  if (pick < 0 && Number.isFinite(n) && n >= NORMAL) {
    for (let i = NORMAL; i < slots.length; i += 1) if (has(i)) { pick = i; break; }
  }
  if (pick < 0) {
    for (let i = 0; i < slots.length; i += 1) if (has(i)) { pick = i; break; }
  }
  if (pick < 0) return null;
  return {
    constant: slots[pick].constant,
    displayName: abilityName(slots[pick].constant),
    slot: pick,
    isHidden: pick >= NORMAL,
  };
}

/* ── data ─────────────────────────────────────────────────────────── */
const D = {
  species: null, typechart: null, learnsets: null, moves: null,
  trainers: null, encounters: null, maps: null, progression: null,
  byConst: {}, moveBy: {}, typeName: {}, locOf: {}, mapOfTrainer: {}, splitOfMap: {},
  mapsecByValue: {}, foldersOfMapsec: {}, abilityBy: {},
};
const cache = {};
async function load(name) {
  if (cache[name]) return cache[name];
  const r = await fetch(`data/${name}.json`);
  if (!r.ok) throw new Error(`${name}.json — ${r.status}`);
  cache[name] = await r.json();
  return cache[name];
}

/* Defeated trainers are run data (RUN.defeated), read from the save's trainer
   flags by progress.js and tickable by hand. isDefeated / setDefeatedManual
   live there. */

/* Trainer classes in the party file carry a " Frlg" suffix that is a build
   detail, not a title. */
const trainerClassName = (t) => String((t && t.class) || '').replace(/\s+Frlg$/i, '');

/* ── status + refresh ─────────────────────────────────────────────── */
async function refreshStatus() {
  let s;
  try { s = await (await fetch('api/status')).json(); }
  catch { return setStatus('bad', 'server unreachable'); }

  const man = s.manifest || {};
  D.uiBuild = s.uiBuild || null;
  D.frozen = !!s.frozen;
  D.manifestFingerprint = man.fingerprint || null;
  D.hackVersion = man.config?.hackVersion || null;
  const vb = $('#hackver');
  if (vb && D.hackVersion) {
    vb.hidden = false;
    vb.textContent = `v${D.hackVersion.string}`;
    vb.title = 'The hack version this data was extracted from. Saves written by '
      + 'this build record it too.';
  }
  const src = s.source || {};
  const rom = man.rom || {};
  const msgs = [];

  if (!src.hasData) {
    setStatus('bad', 'no data — press Refresh');
    return showBanner('bad', 'No extracted data yet. Press <b>Refresh data</b> to build it from the ROM source.');
  }
  if (src.stale) {
    msgs.push(`<b>${src.changedCount}</b> ROM source file(s) changed since this data was extracted. Press <b>Refresh data</b>.`);
  }
  if (rom.stale) {
    msgs.push(`Your built ROM (<b>${esc(rom.romBuiltAt || '').slice(0, 10)}</b>) is older than these sources — rebuild with <code>make firered</code> before trusting this against a live save.`);
  }
  // Live-RAM addresses move on every build, and a stale one returns plausible
  // garbage rather than failing, so it has to be said out loud.
  const lua = D.symbols?.luaTable;
  if (lua && (lua.mismatches?.length || lua.stale)) {
    const worst = (lua.mismatches || []).slice(0, 3)
      .map((m) => `${m.symbol} off by 0x${Math.abs(m.deltaBytes).toString(16).toUpperCase()}`)
      .join(', ');
    msgs.push('The mGBA address table is <b>out of date</b>'
      + (worst ? ` — ${esc(worst)}` : '')
      + '. Re-run <code>tools/lua/gen_addresses.py</code> then '
      + '<code>build_autoimport.py</code>. Reading live RAM with these returns '
      + 'plausible garbage. (The .sav path is unaffected.)');
  }

  // localStorage is scoped to the origin, and the origin includes the port, so
  // a fallback port means everything remembered lives somewhere this window
  // cannot see. Silence there looks exactly like "the calc forgot my settings".
  if (s.portWarning) msgs.push(esc(s.portWarning));

  setStatus(src.stale ? 'stale' : 'ok',
    src.stale ? `${src.changedCount} file(s) changed` : `data current · ${man.fingerprint || ''}`);
  msgs.length ? showBanner(src.stale ? '' : 'warn', msgs.join('<br>')) : hideBanner();
}
function setStatus(kind, text) {
  $('#status-dot').className = `dot ${kind}`;
  // "data current · b2db615ea4134ed3" cost the header 190px for a hash nobody
  // reads at a glance. The words stay; the fingerprint moves to the tooltip.
  const [head, ...rest] = String(text).split(' · ');
  $('#status-text').textContent = head;
  $('#status').title = `Dataset status - ${text}`;
}
function showBanner(kind, html) {
  const b = $('#banner');
  b.className = kind === 'bad' ? 'bad' : '';
  b.innerHTML = html; b.hidden = false;
}
const hideBanner = () => { $('#banner').hidden = true; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The extractor runs on a server thread and is polled, rather than awaited on a
// single blocking POST: a full run is tens of seconds and its log only gains a
// line once a dataset has finished, so a plain await sat on "Running extractor…"
// long enough to look crashed.
async function runRefresh() {
  const bar = $('#modal-bar'), step = $('#modal-step'), prog = $('#modal-progress');
  const t0 = Date.now();
  const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  prog.hidden = false;
  bar.style.width = '0%';
  step.textContent = 'starting…';
  $('#modal-log').textContent = '';

  // Every request gets a deadline. A fetch that never settles would otherwise
  // leave this awaiting forever with nothing on screen changing, which is
  // indistinguishable from a crash and is exactly what "it's stuck" looks like.
  const withTimeout = async (url, opts, ms) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return await (await fetch(url, { ...opts, signal: ac.signal })).json();
    } finally {
      clearTimeout(timer);
    }
  };

  const started = await withTimeout('api/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, 15000);
  if (started.started === false && !started.alreadyRunning) {
    throw new Error('the server refused to start an extraction');
  }

  // Consecutive poll failures, not a single one: a dropped request while the
  // extractor has the CPU should not abandon a run that is still going.
  let misses = 0;
  for (;;) {
    await sleep(250);
    let p;
    try {
      p = await withTimeout('api/refresh/progress', {}, 10000);
      misses = 0;
    } catch (e) {
      if (++misses > 8) throw new Error(`lost contact with the server (${e})`);
      continue;
    }
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    bar.style.width = `${pct}%`;
    // The elapsed count is the point of this line as much as the percentage:
    // the first second or two parses the ROM's #defines before any dataset
    // starts, and `species` then holds one number for several seconds. Without
    // a ticking value on screen either of those reads as a hang.
    step.textContent = (!p.total ? 'reading ROM source…'
      : p.current ? `${pct}% · ${p.current}` : `${pct}%`) + ` (${secs()})`;
    if (p.log) {
      const log = $('#modal-log');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
      log.textContent = p.log;
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
    if (!p.running && p.result) {
      bar.style.width = '100%';
      step.textContent = `${p.result.ok ? 'done' : 'failed'} (${secs()})`;
      return p.result;
    }
  }
}

$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  btn.disabled = true; btn.textContent = 'Refreshing…';
  $('#modal').hidden = false;
  $('#modal-title').textContent = 'Rebuilding datasets from ROM source'
    + (D.uiBuild ? `  ·  ui ${D.uiBuild}${D.frozen ? ' (exe)' : ''}` : '');
  try {
    const res = await runRefresh();
    $('#modal-log').textContent = res.log || '(no output)';
    $('#modal-title').textContent = res.ok ? 'Data rebuilt' : 'Extraction FAILED';
    if (res.ok) {
      // The page is reloaded, not booted a second time. boot() runs every tab's
      // init again, and the inits ADD their listeners each time they run, so
      // after one refresh every button in the app had two. Most of those are
      // merely wasteful; "New run" is not - its first handler arms the
      // "Start?" confirmation and its second takes the armed state as the
      // confirmation, so one click started a run. A reload costs the same 14 MB
      // of fetches boot() did, comes back on the same page (kudzu.tab) with the
      // same run (written to localStorage on every change, flushed to its file
      // here), and gives the calculator's frame the rebuilt data as well.
      $('#modal-step').textContent = 'reloading…';
      if (typeof flushAutosave === 'function') flushAutosave();
      location.reload();
      return;
    }
  } catch (e) {
    $('#modal-log').textContent = String(e);
    $('#modal-title').textContent = 'Refresh failed';
    $('#modal-step').textContent = 'failed';
  }
  // Only a failure gets here (success reloaded the page above), and a failure
  // keeps the modal up, because then the log is the point.
  btn.disabled = false; btn.textContent = 'Refresh data';
  await refreshStatus();
});
$('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });

/* ── tabs ─────────────────────────────────────────────────────────── */
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  // showTab (tracker.js) also remembers the choice for the next launch.
  if (typeof showTab === 'function') showTab(b.dataset.tab);
  else {
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${b.dataset.tab}`));
  }
}));

/* ── indexes ──────────────────────────────────────────────────────── */
function buildIndexes() {
  D.byConst = {};
  for (const s of D.species) D.byConst[s.constant] = s;

  D.typeName = {};
  for (const t of D.typechart.types) D.typeName[t.constant] = t.name || pretty(t.constant);

  D.moveBy = {};
  for (const m of D.moves) D.moveBy[m.constant] = m;

  /* species -> where it can be found. Built once; the Pokédex detail and the
     "obtainable" filter both read it. */
  D.locOf = {};
  for (const e of D.encounters.entries) {
    const push = (sp, method, extra) => {
      if (!sp) return;
      (D.locOf[sp] ||= []).push({ map: e.mapName, mapConst: e.mapConstant, kind: e.kind, method, ...extra });
    };
    if (e.methods) {
      for (const [method, m] of Object.entries(e.methods)) {
        const seen = new Set();
        for (const s of m.slots || []) {
          if (seen.has(s.species)) continue;
          seen.add(s.species);
          const all = (m.slots || []).filter((x) => x.species === s.species);
          push(s.species, method, {
            min: Math.min(...all.map((x) => x.minLevel)),
            max: Math.max(...all.map((x) => x.maxLevel)),
            rate: all.reduce((a, x) => a + (x.ratePercent || 0), 0),
          });
        }
      }
    }
    for (const sp of e.species || []) push(sp.species || sp, e.kind, { level: sp.level });
    if (e.species === undefined && e.speciesConstant) push(e.speciesConstant, e.kind, { level: e.level });
  }

  D.mapOfTrainer = {}; D.splitOfMap = {};
  // A save records where a Pokémon was met as a MAPSEC byte, so both directions
  // of that join are indexed: the byte to its in-game name, and the byte to
  // every map folder inside it. A MAPSEC is coarser than a map - MAPSEC_MT_MOON
  // covers all of its floors - so this narrows an encounter down, it does not
  // always pin it to one.
  D.abilityBy = {};
  for (const a of (D.abilities?.abilities || D.abilities || [])) {
    if (a && a.constant) D.abilityBy[a.constant] = a;
  }

  D.mapsecByValue = {}; D.foldersOfMapsec = {};
  for (const s of D.maps.mapSections || []) {
    if (s.value != null) D.mapsecByValue[s.value] = s;
  }
  for (const m of D.maps.maps) {
    if (m.regionMapSectionId != null) {
      (D.foldersOfMapsec[m.regionMapSectionId] ||= []).push(m.folder);
    }
    if (m.split) D.splitOfMap[m.folder] = Object.assign({ source: 'splits', hops: 0 }, m.split);
  }
  // Maps splits.json leaves out are placed by the extractor (progression's
  // derivedLocations): the other floors of a named dungeon, whatever a door
  // leads to, or failing that whatever the wild levels say. splits.json wins
  // wherever it speaks, so the overlay never replaces an explicit entry.
  for (const d of D.progression?.derivedLocations || []) {
    if (D.splitOfMap[d.mapFolder]) continue;
    D.splitOfMap[d.mapFolder] = {
      splitKey: d.splitId, splitLabel: d.splitLabel, splitIndex: d.splitIndex,
      locationIndex: d.locationIndex, locationLabel: d.locationLabel,
      source: 'derived', rule: d.rule, via: d.via, hops: d.hops ?? 1,
      confidence: d.confidence, note: d.note || null, anchorLabel: d.anchorLabel || null,
      opensAfter: d.opensAfter || null,
    };
  }
  D.mapByFolder = {};
  for (const m of D.maps.maps) D.mapByFolder[m.folder] = m;
  for (const m of D.maps.maps) {
    const sp = D.splitOfMap[m.folder] || null;
    for (const t of m.trainers || []) {
      (D.mapOfTrainer[t] ||= []).push({
        folder: m.folder,
        label: m.displayLabel || m.folderDerivedName,
        split: sp ? sp.splitKey : null,
        splitLabel: sp ? sp.splitLabel : null,
        splitIndex: sp ? sp.splitIndex : null,
        locationIndex: sp ? sp.locationIndex : null,
        locationLabel: sp ? sp.locationLabel : null,
        hops: sp ? (sp.hops ?? 0) : 0,
        inferred: !!(sp && sp.source === 'derived'),
        pinned: !!(sp && sp.rule === 'pinned'),
        gauntlet: m.gauntlet || null,
      });
    }
  }
  // A trainer is filed where the run fights it, which is not always the
  // location that owns its map: splits.json `parts` hand the Cerulean rival to
  // the Jasmine split and Route 21's trainers to Blaine's (source "part", a place
  // of its own), and trainerOverrides move one trainer to another split
  // (source "override", kept at the end of that split under its map's name).
  const splitById = {};
  for (const s of D.progression?.splits || []) splitById[s.id] = s;
  for (const [c, cl] of Object.entries(D.progression?.trainerClaims || {})) {
    const sp = splitById[cl.splitId];
    const base = {
      split: cl.splitId, splitLabel: sp ? sp.label : cl.splitId, splitIndex: cl.splitIndex,
      hops: 0, inferred: false, pinned: false, claim: cl.source, claimNote: cl.note || null,
    };
    if (cl.source === 'part') {
      const m = D.mapByFolder[cl.map] || {};
      D.mapOfTrainer[c] = [Object.assign({
        folder: cl.map, label: cl.locationLabel,
        locationIndex: cl.locationIndex, locationLabel: cl.locationLabel,
        gauntlet: m.gauntlet || null,
      }, base)];
    } else {
      D.mapOfTrainer[c] = (D.mapOfTrainer[c] || []).map((p) => Object.assign({}, p, base,
        { locationIndex: 999, locationLabel: p.locationLabel || p.label }));
    }
  }
  // Shops, by the location their map belongs to.
  D.martsByLoc = {};
  for (const m of D.marts?.marts || []) {
    const sp = D.splitOfMap[m.map];
    if (!sp) continue;
    (D.martsByLoc[`${sp.splitKey}|${sp.locationIndex}`] ||= []).push(m);
  }
  D.trainerBy = {}; D.trainerById = {};
  for (const t of D.trainers.trainers) {
    D.trainerBy[t.constant] = t;
    if (t.id != null) D.trainerById[t.id] = t;
  }
}

/* Defensive effectiveness of one attacking type against a defender's types. */
function defMultiplier(atk, defTypes) {
  let mult = 1;
  const seen = new Set();
  for (const t of defTypes) {
    if (seen.has(t)) continue;                 // a dual "Fire/Fire" must not square
    seen.add(t);
    const row = D.typechart.matchups[atk];
    if (row && row[t] !== undefined) mult *= row[t];
  }
  return mult;
}
function effectivenessAgainst(defTypes) {
  const out = [];
  for (const t of D.typechart.battleTypes) {
    const c = typeof t === 'string' ? t : t.constant;
    const m = defMultiplier(c, defTypes);
    if (m !== 1) out.push([c, m]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}
const effClass = (m) => (m === 0 ? 'x0' : m === 0.25 ? 'x25' : m < 1 ? 'x50' : m >= 4 ? 'x4' : 'x2');
const effLabel = (m) => (m === 0 ? '0' : m === 0.25 ? '¼' : m === 0.5 ? '½' : `${m}`);

function typeChips(types) {
  const w = el('span', 'chips');
  for (const t of types) {
    const c = typeof t === 'string' ? t : t.constant;
    const chip = el('span', 't', typeName(c));
    chip.style.background = typeColor(c);
    w.append(chip);
  }
  return w;
}

/* ── Pokédex ──────────────────────────────────────────────────────── */
const dexState = { sel: null, rows: [] };

function dexFilters() {
  const q = $('#dex-q').value.trim().toLowerCase();
  const type = $('#dex-type').value;
  const abil = $('#dex-ability').value;
  const egg = $('#dex-egg').value;
  const stat = $('#dex-stat').value;
  const min = parseInt($('#dex-stat-min').value, 10);
  const obtainable = $('#dex-obtainable').checked;
  const forms = $('#dex-forms').checked;

  return D.species.filter((s) => {
    // Gigantamax forms are never reachable in this hack - no Dynamax - and they
    // carry the base species' name, so they only ever showed up as duplicate rows.
    if (s.isGigantamax) return false;
    if (!forms && s.cosmeticForm) return false;
    if (q && !((s.fullName || s.displayName).toLowerCase().includes(q)
      || s.constant.toLowerCase().includes(q))) return false;
    if (type && !s.types.some((t) => t.constant === type)) return false;
    if (abil) {
      const a = s.abilities || {};
      const has = [a.primary, a.secondary, a.hidden].some((x) => x && x.constant === abil);
      if (!has) return false;
    }
    if (egg && !(s.eggGroups || []).some((g) => g.constant === egg)) return false;
    if (!Number.isNaN(min)) {
      const v = stat === 'bst' ? s.baseStatTotal : (s.baseStats || {})[stat];
      if (!(v >= min)) return false;
    }
    if (obtainable && !(D.locOf[s.constant] || []).length) return false;
    return true;
  });
}

function renderDex() {
  const rows = dexFilters();
  dexState.rows = rows;
  const list = $('#dex-list');
  list.textContent = '';
  $('#dex-count').textContent = `${rows.length} of ${D.species.length} species`;

  const grouped = $('#dex-lines').checked;
  const frag = document.createDocumentFragment();

  if (grouped) {
    const lines = new Map();
    for (const s of rows) {
      if (!lines.has(s.lineId)) lines.set(s.lineId, []);
      lines.get(s.lineId).push(s);
    }
    const ordered = [...lines.entries()].sort((a, b) => {
      const an = Math.min(...a[1].map((x) => x.natDexNum || 9999));
      const bn = Math.min(...b[1].map((x) => x.natDexNum || 9999));
      return an - bn;
    });
    for (const [lineId, members] of ordered) {
      if (members.length > 1) {
        frag.append(el('div', 'line-head', (D.byConst[lineId]?.fullName || D.byConst[lineId]?.displayName || pretty(lineId)) + ' line'));
      }
      members.sort((a, b) => (a.natDexNum || 0) - (b.natDexNum || 0));
      for (const s of members) frag.append(dexRow(s));
    }
  } else {
    rows.sort((a, b) => (a.natDexNum || 0) - (b.natDexNum || 0));
    for (const s of rows) frag.append(dexRow(s));
  }
  list.append(frag);
}

function dexRow(s) {
  const r = el('div', 'row-item');
  r.dataset.k = s.constant;
  if (dexState.sel === s.constant) r.classList.add('on');
  r.append(el('span', 'num', s.natDexNum ? `#${String(s.natDexNum).padStart(3, '0')}` : '—'));
  r.append(spr(s.constant));
  r.append(el('span', 'nm', s.fullName || s.displayName));
  r.append(typeChips(s.types));
  r.addEventListener('click', () => selectSpecies(s.constant));
  return r;
}

function selectSpecies(k) {
  dexState.sel = k;
  $$('#dex-list .row-item').forEach((r) => r.classList.toggle('on', r.dataset.k === k));
  renderSpecies(D.byConst[k]);
}

function renderSpecies(s) {
  const d = $('#dex-detail');
  d.textContent = '';
  if (!s) { d.append(el('div', 'empty', 'Select a Pokémon')); return; }

  const head = el('div', 'spr-head');
  head.append(spr(s.constant, 'front'));
  const title = el('div');
  head.append(title);
  title.append(el('h2', null, s.fullName || s.displayName));
  title.append(typeChips(s.types));
  const c = el('div', 'const', `${s.constant}${s.natDexNum ? ` · #${s.natDexNum}` : ''}`);
  title.append(c);
  if (s.formLabel) title.append(el('span', 'pill', `${s.formLabel} form`));
  if (s.cosmeticForm) title.append(el('span', 'pill', 'cosmetic form'));
  d.append(head);

  /* stats */
  d.append(el('h3', null, `Base stats · ${s.baseStatTotal}`));
  const st = el('div', 'stats');
  const MAX = 200;
  for (const [key, lbl] of [['hp', 'HP'], ['attack', 'Atk'], ['defense', 'Def'],
    ['spAttack', 'SpA'], ['spDefense', 'SpD'], ['speed', 'Spe']]) {
    const v = (s.baseStats || {})[key];
    st.append(el('span', 'lbl', lbl));
    st.append(el('span', 'val', dash(v)));
    const w = el('div', 'barwrap'); const b = el('div', 'bar');
    b.style.width = `${Math.min(100, (v / MAX) * 100)}%`;
    b.style.background = v >= 130 ? '#7bd88f' : v >= 90 ? '#9fd06f' : v >= 60 ? '#dbc07a' : '#c47a7a';
    w.append(b); st.append(w);
  }
  d.append(st);

  /* defensive matchups, from Kudzu's own chart */
  d.append(el('h3', null, 'Defensive matchups'));
  const eff = effectivenessAgainst(s.types.map((t) => t.constant));
  if (!eff.length) d.append(el('div', 'const', 'neutral to everything'));
  else {
    const w = el('div', 'eff');
    for (const [t, m] of eff) {
      const x = el('span', effClass(m), `${typeName(t)} ${effLabel(m)}×`);
      w.append(x);
    }
    d.append(w);
  }

  /* facts */
  d.append(el('h3', null, 'Details'));
  const a = s.abilities || {};
  const kv = el('dl', 'kv');
  const add = (k, v) => { kv.append(el('dt', null, k)); kv.append(el('dd', null, v)); };
  add('Abilities', [a.primary, a.secondary].filter(Boolean).map((x) => abilityName(x.constant)).join(', ') || '—');
  add('Hidden', a.hidden ? abilityName(a.hidden.constant) : '—');
  add('Egg groups', (s.eggGroups || []).map((g) => pretty(g.constant)).join(', ') || '—');
  // {constant, id} since the species extract carries ids; a bare string before.
  add('Growth rate', pretty(s.growthRate?.constant || s.growthRate));
  add('Gender', s.genderRatio?.label ?? dash(s.genderRatio?.raw));
  add('Catch rate', dash(s.catchRate));
  add('EXP yield', dash(s.expYield));
  d.append(kv);

  /* evolution line */
  d.append(el('h3', null, 'Evolution line'));
  const members = (s.lineMembers || []).map((k) => D.byConst[k]).filter(Boolean);
  if (members.length <= 1) d.append(el('div', 'const', 'no evolutions'));
  else {
    const t = el('table', 'grid');
    t.innerHTML = '<tr><th>Pokémon</th><th>Evolves into</th><th>Method</th></tr>';
    for (const m of members.sort((x, y) => (x.natDexNum || 0) - (y.natDexNum || 0))) {
      for (const ev of (m.evolutions || []).length ? m.evolutions : [null]) {
        const tr = el('tr');
        const c1 = el('td'); const link = el('a', 'jump', m.displayName);
        link.addEventListener('click', () => selectSpecies(m.constant));
        c1.append(link); tr.append(c1);
        if (ev) {
          const c2 = el('td'); const l2 = el('a', 'jump', D.byConst[ev.targetSpecies]?.fullName || D.byConst[ev.targetSpecies]?.displayName || pretty(ev.targetSpecies));
          l2.addEventListener('click', () => selectSpecies(ev.targetSpecies));
          c2.append(l2); tr.append(c2);
          tr.append(el('td', 'mono', `${pretty(ev.method)}${ev.param != null && ev.param !== '' ? ` · ${ev.paramConstant ? pretty(ev.paramConstant) : ev.param}` : ''}`));
        } else { tr.append(el('td', null, '—')); tr.append(el('td', null, '—')); }
        t.append(tr);
      }
    }
    d.append(t);
  }

  /* where to find it */
  d.append(el('h3', null, 'Locations'));
  const locs = D.locOf[s.constant] || [];
  if (!locs.length) d.append(el('div', 'const', 'not obtainable from any extracted encounter table'));
  else {
    const t = el('table', 'grid');
    t.innerHTML = '<tr><th>Place</th><th>How</th><th>Levels</th><th>Rate</th></tr>';
    for (const l of locs.slice(0, 40)) {
      const tr = el('tr');
      tr.append(el('td', null, mapLabel(l.map)));
      tr.append(el('td', null, `${l.kind === 'wild' ? '' : l.kind + ' · '}${l.method || ''}`));
      tr.append(el('td', 'mono', l.level != null ? `L${l.level}` : (l.min != null ? `${l.min}–${l.max}` : '—')));
      tr.append(el('td', 'mono', l.rate ? `${Math.round(l.rate)}%` : '—'));
      t.append(tr);
    }
    d.append(t);
    if (locs.length > 40) d.append(el('div', 'const', `+${locs.length - 40} more`));
  }

  /* learnset */
  const ls = D.learnsets.species[s.constant];
  renderLearnsets(d, ls);
  d.scrollTop = 0;
}

/** One move table. `rows` are {move, level?, badge?}. */
function moveTable(rows, withLevel) {
  const t = el('table', 'grid');
  t.innerHTML = `<tr>${withLevel ? '<th>Lv</th>' : ''}<th>Move</th><th>Type</th>`
    + '<th>Cat</th><th>Pow</th><th>Acc</th></tr>';
  for (const r of rows) {
    const mv = D.moveBy[r.move] || {};
    const tr = el('tr');
    if (withLevel) tr.append(el('td', 'mono', r.level === 0 ? '—' : r.level));
    const nameCell = el('td');
    nameCell.append(document.createTextNode(mv.displayName || pretty(r.move)));
    if (r.badge) {
      const b = el('span', 'pill', r.badge);
      b.style.marginLeft = '6px';
      nameCell.append(b);
    }
    tr.append(nameCell);
    const tc = el('td');
    if (mv.type) tc.append(typeChips([mv.type]));
    tr.append(tc);
    tr.append(el('td', null, mv.category
      ? mv.category[0] + mv.category.slice(1).toLowerCase() : '—'));
    tr.append(el('td', 'mono', dash(mv.power || null)));
    tr.append(el('td', 'mono', dash(mv.accuracy || null)));
    t.append(tr);
  }
  return t;
}

/**
 * Every way a species can learn a move, not just levelling.
 *
 * `hm` is a SUBSET of `tm` in the dataset - true for all 1573 species - so the
 * two are shown as one list with the HMs badged. Counting them separately would
 * report a Charizard as knowing 30 TMs when 4 of those are HMs.
 */
function renderLearnsets(d, ls) {
  if (!ls) {
    d.append(el('h3', null, 'Learnset'));
    d.append(el('div', 'const', 'no learnset data for this species'));
    return;
  }

  const hmSet = new Set(ls.hm || []);
  const tmOnly = (ls.tm || []).filter((m) => !hmSet.has(m));

  const sections = [
    ['Level-up', (ls.levelUp || []).map((e) => ({ move: e.move, level: e.level })), true],
    [`TM${hmSet.size ? ' & HM' : ''}`,
      [...tmOnly.map((m) => ({ move: m })),
        ...[...hmSet].map((m) => ({ move: m, badge: 'HM' }))], false],
    ['Tutor', (ls.tutor || []).map((m) => ({ move: m })), false],
    ['Egg', (ls.egg || []).map((m) => ({ move: m })), false],
  ];

  for (const [label, rows, withLevel] of sections) {
    if (!rows.length) continue;
    const count = label.startsWith('TM') && hmSet.size
      ? `${tmOnly.length} TM + ${hmSet.size} HM`
      : `${rows.length}`;
    d.append(el('h3', null, `${label} — ${count}`));
    d.append(moveTable(rows, withLevel));
  }
  if (!sections.some(([, rows]) => rows.length)) {
    d.append(el('h3', null, 'Learnset'));
    d.append(el('div', 'const', 'learns nothing by any method'));
  }
}

const mapLabel = (folder) => {
  const m = (D.maps.maps || []).find((x) => x.folder === folder);
  return m ? (m.displayLabel || m.folderDerivedName || folder) : folder;
};

/**
 * A gauntlet pill for a map folder (or any of several), or null.
 *
 * A gauntlet is a map whose own script switches the Multimenu off on the way
 * in: several trainers back to back with no Pokemon Center and no box until
 * the far end. It decides what team walks in, so every view that names the
 * place says so.
 */
function gauntletOf(folders) {
  for (const f of [].concat(folders || [])) {
    const m = D.mapByFolder && D.mapByFolder[f];
    if (m && m.gauntlet) return m;
  }
  return null;
}
function gauntletPill(folders) {
  const m = gauntletOf(folders);
  if (!m) return null;
  const n = m.gauntlet.trainerCount;
  const p = el('span', 'pill gauntlet', n ? `gauntlet · ${n}` : 'gauntlet');
  p.title = `Gauntlet: ${n || 'several'} trainers back to back. The Multimenu is switched off on entry`
    + ` - no Pokémon Center and no box until the far end${m.gauntlet.endsOnThisMap ? '' : ', which is on a later map'}.`
    + ' Build the team before going in.';
  return p;
}

/* ── Trainers ─────────────────────────────────────────────────────── */
const trState = { sel: null };

/* How a trainer is fought, from trainers.json `battleFormat` / `battles` /
   `sightPairs` (the extractor reads them off the reachable map scripts):
   'tag' - a multi battle: you and an ally against it (and maybe a second trainer);
   'twoTrainers' - it and another trainer at once; 'double' - it alone, two out;
   a stationary sight pair - two single trainers that both see you from one tile
   and so fight you together. */
const FORMAT_LABEL = { tag: 'Tag battle', twoTrainers: 'Two trainers', double: 'Double battle' };

const trainerName = (c) => {
  const t = D.trainerBy[c];
  return t ? (t.name || pretty(c)) : pretty(c);
};

const partnerOf = (c) => (D.trainers.partners || []).find((p) => p.constant === c) || null;

/** The trainers fought in the same battle as `t` (scripted fights only). */
function coOpponents(t) {
  const out = [];
  for (const b of t.battles || []) {
    if (b.kind !== 'twoTrainers' && b.kind !== 'multi') continue;
    for (const o of b.with) if (!out.includes(o)) out.push(o);
  }
  return out;
}

/** The ally in a tag battle, as a partners record, or null. */
function tagPartner(t) {
  const b = (t.battles || []).find((x) => x.kind === 'multi' && x.partner);
  return b ? partnerOf(b.partner) : null;
}

/** Single trainers that can both see you from the same tile (stationary ones). */
const sightPartners = (t) => (t.sightPairs || []).filter((p) => !p.moving);

const isAnyDouble = (t) => (t.battleFormat && t.battleFormat !== 'single') || !!t.doubleBattle
  || sightPartners(t).length > 0;

/**
 * Everyone fought in the same battle as `t`, `t` included, in party-file order:
 * the other side of a scripted two-trainer or tag battle, or the other half of
 * a sight double. That is one fight, so the lists show it as one entry, named
 * by its first trainer (the "lead"). In this ROM every such fight is a pair and
 * the links run both ways, so the group is the same whichever member asks.
 */
function fightGroup(t) {
  if (!t) return [];
  const out = [t];
  for (const c of [...coOpponents(t), ...sightPartners(t).map((p) => p.with)]) {
    const o = D.trainerBy[c];
    if (o && o.reachable !== false && !out.includes(o)) out.push(o);
  }
  return out.sort((a, b) => (a.sourceLine || 0) - (b.sourceLine || 0));
}
const fightLead = (c) => (fightGroup(D.trainerBy[c])[0] || {}).constant || c;
const fightNames = (g) => g.map((o) => o.name || pretty(o.constant)).join(' & ');
const fightClasses = (g) => [...new Set(g.map(trainerClassName).filter(Boolean))].join(' & ');

/** Trainers grouped into fights, keeping the order the trainers came in. */
function groupFights(trainers) {
  const seen = new Set();
  const out = [];
  for (const t of trainers) {
    const g = fightGroup(t);
    const lead = g[0].constant;
    if (seen.has(lead)) continue;
    seen.add(lead);
    out.push(g);
  }
  return out;
}

/** "Tag battle", "Two trainers", "Double battle", or "May pair up" - one short tag. */
function formatPill(t) {
  const f = t.battleFormat && t.battleFormat !== 'single' ? t.battleFormat : (t.doubleBattle ? 'double' : null);
  if (f) {
    const p = el('span', 'pill', FORMAT_LABEL[f]);
    const co = coOpponents(t).map(trainerName);
    const ally = tagPartner(t);
    p.title = f === 'tag'
      ? `You${ally ? ` and ${ally.name}` : ''} against ${[t.name, ...co].join(' & ')}`
      : f === 'twoTrainers' ? `Fought together with ${co.join(', ')}` : 'Two of its Pokémon are out at once';
    return p;
  }
  const sp = sightPartners(t);
  if (sp.length) {
    const p = el('span', 'pill', 'Pairs up');
    p.title = `A separate trainer who fights you together with ${sp.map((x) => trainerName(x.with)).join(', ')}: both see you from the same tile`;
    return p;
  }
  return null;
}

/** The detail panel's Battle section. */
function battleSection(t) {
  const wrap = el('div');
  const f = t.battleFormat && t.battleFormat !== 'single' ? t.battleFormat : (t.doubleBattle ? 'double' : null);
  const sp = t.sightPairs || [];
  const mg = t.guardsMega || [];
  if (!f && !sp.length && !mg.length) return null;
  wrap.append(el('h3', null, 'Battle'));
  for (const g of mg) {
    wrap.append(el('div', null, g.how === 'reward'
      ? `Guards a mega stone: beating it gives ${g.itemName}.`
      : `Guards a mega stone: ${g.how === 'beside' ? 'stands right beside' : 'watches the way to'} the ${g.itemName}${g.with.length ? ` (with ${g.with.map(trainerName).join(', ')})` : ''}.`));
  }
  const co = coOpponents(t);
  if (f === 'tag') {
    const ally = tagPartner(t);
    wrap.append(el('div', null, co.length
      ? `Tag battle: you and ${ally ? ally.name : 'an ally'} against ${t.name} and ${co.map(trainerName).join(', ')}.`
      : `Tag battle, 2 on 1: you and ${ally ? ally.name : 'an ally'} against ${t.name}, who has two Pokémon out.`));
    wrap.append(el('div', 'const', 'You pick which of your Pokémon go in; the ally brings its own team.'));
    if (ally && ally.party?.length) {
      const g = el('div', 'slotgrid');
      for (const m of ally.party) {
        const r = el('div', 's');
        r.append(spr(m.speciesConstant));
        r.append(speciesLink(m.speciesConstant, '', m.nickname ? ` (${m.nickname})` : ''));
        r.append(el('span', 'l', `L${m.level ?? '?'}${m.heldItem ? ` @ ${m.heldItem}` : ''}`));
        g.append(r);
      }
      wrap.append(el('div', 'const', `${ally.name}'s team`));
      wrap.append(g);
    }
  } else if (f === 'twoTrainers') {
    wrap.append(el('div', null, `Fought together with ${co.map(trainerName).join(', ')}: one double battle, one trainer on each side.`));
  } else if (f === 'double') {
    wrap.append(el('div', null, 'Double battle: two of its Pokémon are out at once.'));
  }
  for (const c of co) {
    const a = el('a', 'jump', `Open ${trainerName(c)}`);
    a.addEventListener('click', () => selectTrainer(c));
    wrap.append(el('div', null)).append(a);
  }
  if (sp.length) {
    const lines = el('div');
    for (const p of sp) {
      const row = el('div');
      const a = el('a', 'jump', trainerName(p.with));
      a.addEventListener('click', () => selectTrainer(p.with));
      row.append(document.createTextNode('Fights you together with '), a,
        document.createTextNode(p.seenTogether
          ? ` - two separate trainers who both see you from ${p.tiles} tile${p.tiles === 1 ? '' : 's'}, so the game starts one double against both.`
          : ' - listed as a double, but as they stand now their sight lines never reach the same tile, so the game starts them one at a time.'));
      if (!p.seenTogether) row.classList.add('warn-text');
      lines.append(row);
    }
    wrap.append(lines);
  }
  return wrap;
}

/** "Guards Raichunite X": the mega stones a fight stands between you and. */
function megaPills(t) {
  return (t.guardsMega || []).map((g) => {
    const p = el('span', 'pill mega', `guards ${g.itemName}`);
    p.title = g.how === 'reward' ? `Beating this fight gives ${g.itemName}`
      : g.how === 'beside' ? `Stands right beside the ${g.itemName}`
        : `Watches the tile you pick the ${g.itemName} up from`;
    return p;
  });
}

/**
 * Where a trainer is fought, in run order.
 *
 * The earliest split and location of any map whose scripts start the battle
 * (a trainer on several maps is listed under the first). Elite Four and
 * Champion battles are started from C rather than a map script, so they take
 * the last split. A trainer no script starts at all - 42 leftovers in the
 * party file - has no place and cannot be fought.
 */
function trainerPlace(t) {
  const places = D.mapOfTrainer[t.constant] || [];
  const keyOf = (p) => [p.splitIndex ?? 998, p.locationIndex ?? 998, p.hops ?? 0];
  const before = (a, b) => {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  let best = null;
  for (const p of places) if (!best || before(keyOf(p), keyOf(best))) best = p;
  if (best) return Object.assign({ kind: 'map' }, best);
  if (t.bossKind === 'eliteFour' || t.bossKind === 'champion') {
    const last = (D.progression?.splits || []).slice(-1)[0];
    return {
      kind: 'league', folder: null, label: 'Indigo Plateau',
      split: last ? last.id : null, splitLabel: last ? last.label : 'Pokémon League',
      splitIndex: last ? last.index : 998, locationIndex: 999,
      locationLabel: 'Indigo Plateau', hops: 0, inferred: false,
    };
  }
  return null;
}

function trFilters() {
  const q = $('#tr-q').value.trim().toLowerCase();
  const kind = $('#tr-kind').value;
  const klass = $('#tr-class').value;
  const split = $('#tr-split').value;
  const bosses = $('#tr-bosses').checked;
  const dbl = $('#tr-double').checked;
  const incUnreachable = $('#tr-unreachable').checked;
  const incUnplaced = $('#tr-unplaced') ? $('#tr-unplaced').checked : false;
  const hideDefeated = $('#tr-undefeated').checked;

  return D.trainers.trainers.filter((t) => {
    if (!incUnreachable && t.reachable === false) return false;
    if (hideDefeated && isDefeated(t.constant)) return false;
    if (bosses && !t.isBoss) return false;
    if (dbl && !isAnyDouble(t)) return false;
    if (kind && t.bossKind !== kind) return false;
    if (klass && t.class !== klass) return false;
    const place = trainerPlace(t);
    if (!incUnplaced && !place) return false;
    if (split && !(place && place.split === split)) return false;
    if (q) {
      const hay = `${t.name} ${t.class || ''} ${t.constant} ${place ? `${place.label || ''} ${place.locationLabel || ''}` : ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTrainers() {
  const rows = trFilters();
  const list = $('#tr-list');
  list.textContent = '';

  // Run order: split, then location, then the party file's own order within a
  // location (it follows the route), with the unplaced last.
  const placed = rows.map((t) => ({ t, p: trainerPlace(t) }));
  const keyOf = (x) => (x.p ? [x.p.splitIndex ?? 998, x.p.locationIndex ?? 998, x.p.hops ?? 0] : [9999, 0, 0]);
  placed.sort((a, b) => {
    const ka = keyOf(a); const kb = keyOf(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return (a.t.sourceLine || 0) - (b.t.sourceLine || 0);
  });
  const next = typeof nextBoss === 'function' ? nextBoss() : null;

  // Two trainers fought in one battle are one row, at the place of whichever
  // of them the filters let through first.
  const fights = groupFights(placed.map((x) => x.t))
    .map((g) => ({ g, p: placed.find((x) => g.includes(x.t)).p }));
  $('#tr-count').textContent = `${rows.length} of ${D.trainers.trainers.length} trainers`
    + (fights.length !== rows.length ? ` · ${fights.length} fights` : '');

  const frag = document.createDocumentFragment();
  let lastHead = null;
  for (const { g, p } of fights) {
    const headText = p
      ? `${p.splitLabel || 'Unordered'} · ${p.locationLabel || p.label || ''}`
      : 'Not on any map — never fought';
    if (headText !== lastHead) {
      lastHead = headText;
      const h = el('div', 'line-head', headText);
      if (p && p.pinned) h.title = 'Placed by config.json placements.';
      else if (p && p.inferred) h.title = 'This place is not in splits.json; its split was inferred.';
      const gp = p && p.folder ? gauntletPill(p.folder) : null;
      if (gp) h.append(' ', gp);
      frag.append(h);
    }
    frag.append(g.length > 1 ? fightRow(g, p, next) : trainerRow(g[0], p, next));
  }
  list.append(frag);
}

/** One list row for a battle against two trainers: both names, both teams. */
function fightRow(g, p, next) {
  const lead = g[0];
  const r = el('div', 'row-item fight');
  r.dataset.k = lead.constant;
  if (trState.sel === lead.constant) r.classList.add('on');
  if (g.every((o) => isDefeated(o.constant))) r.classList.add('dim');
  const isNext = next && g.some((o) => o.constant === next.trainer.constant);
  if (isNext) r.classList.add('next');
  r.append(el('span', 'num', g.some((o) => o.isBoss) ? '★' : ''));
  const nm = el('span', 'nm', fightNames(g));
  nm.title = `${g.map((o) => `${o.name || ''} — ${trainerClassName(o)}`).join('\n')}${p && p.label ? `\n${p.label}` : ''}`;
  r.append(nm);
  r.append(el('span', 'cls', fightClasses(g)));
  const fp = fightPill(g);
  if (fp) r.append(fp);
  const seen = new Set();
  for (const o of g) {
    for (const mp of megaPills(o)) {
      if (!seen.has(mp.textContent)) { seen.add(mp.textContent); r.append(mp); }
    }
  }
  if (isNext) {
    const np = el('span', 'pill next', 'next');
    np.title = 'The first boss in run order the save has not beaten';
    r.append(np);
  }
  const strip = el('span', 'party-strip');
  g.forEach((o, i) => {
    if (i) strip.append(el('span', 'strip-sep', '|'));
    for (const m of (o.party || []).slice(0, 6)) strip.append(spr(m.speciesConstant));
  });
  strip.title = g.map((o) => `${o.name}: ${(o.party || []).map((m) => `${m.species} L${m.level ?? '?'}`).join(', ')}`).join('\n');
  r.append(strip);
  r.addEventListener('click', () => selectTrainer(lead.constant));
  return r;
}

/** The format tag for a fight row: what kind of battle the pair makes. */
function fightPill(g) {
  const lead = g[0];
  const f = lead.battleFormat;
  if (f === 'tag') return formatPill(lead);
  const sight = sightPartners(lead).some((x) => g.some((o) => o.constant === x.with));
  const p = el('span', 'pill', 'Two trainers');
  p.title = sight
    ? 'Two separate trainers who both see you from the same tile: the game starts one double battle against both'
    : 'One double battle, one trainer on each side';
  return p;
}

/** One list row for a trainer fought on their own. */
function trainerRow(t, p, next) {
  const r = el('div', 'row-item');
  r.dataset.k = t.constant;
  if (trState.sel === t.constant) r.classList.add('on');
  if (isDefeated(t.constant)) r.classList.add('dim');
  if (next && next.trainer.constant === t.constant) r.classList.add('next');
  r.append(el('span', 'num', t.gymNumber ? `GYM${t.gymNumber}` : (t.isBoss ? '★' : '')));
  const nm = el('span', 'nm', t.name || pretty(t.constant));
  nm.title = `${t.name || ''} — ${trainerClassName(t)}${p && p.label ? ` · ${p.label}` : ''}`;
  r.append(nm);
  r.append(el('span', 'cls', trainerClassName(t)));
  if (t.reachable === false) r.append(el('span', 'pill bad', 'unreachable'));
  else if (t.isPool) r.append(el('span', 'pill warn', 'pool'));
  const fp = formatPill(t);
  if (fp) r.append(fp);
  for (const mp of megaPills(t)) r.append(mp);
  if (next && next.trainer.constant === t.constant) {
    const np = el('span', 'pill next', 'next');
    np.title = 'The first boss in run order the save has not beaten';
    r.append(np);
  }
  const strip = el('span', 'party-strip');
  for (const m of t.party.slice(0, 6)) strip.append(spr(m.speciesConstant));
  strip.title = `${t.party.length} Pokémon`;
  r.append(strip);
  r.addEventListener('click', () => selectTrainer(t.constant));
  return r;
}

/** Open a trainer - or, for one half of a pair, the fight they are part of. */
function selectTrainer(k) {
  k = fightLead(k);
  trState.sel = k;
  $$('#tr-list .row-item').forEach((r) => r.classList.toggle('on', r.dataset.k === k));
  renderTrainer(D.trainers.trainers.find((t) => t.constant === k));
}

function renderTrainer(t) {
  const d = $('#tr-detail');
  d.textContent = '';
  if (!t) { d.append(el('div', 'empty', 'Select a trainer')); return; }
  const group = fightGroup(t);
  if (group.length > 1) { renderFight(group, d); return; }

  const head = el('div');
  head.append(el('h2', null, `${t.name || pretty(t.constant)}${t.class ? ` — ${trainerClassName(t)}` : ''}`));
  head.append(el('div', 'const', t.constant));
  d.append(head);

  const tags = el('div', 'chips');
  if (t.gymNumber) tags.append(el('span', 'pill good', `Gym ${t.gymNumber}`));
  if (t.bossKind && t.bossKind !== 'normal') tags.append(el('span', 'pill', pretty(t.bossKind)));
  const fp = formatPill(t);
  if (fp) tags.append(fp);
  for (const mp of megaPills(t)) tags.append(mp);
  if (t.isPool) tags.append(el('span', 'pill warn', `Random pool — ${t.partySize} of ${t.poolSize}`));
  if (t.reachable === false) tags.append(el('span', 'pill bad', 'Unreachable'));
  d.append(tags);

  const chk = el('label', 'chk');
  const box = el('input'); box.type = 'checkbox'; box.checked = isDefeated(t.constant);
  box.addEventListener('change', () => {
    setDefeatedManual(t.constant, box.checked);
    renderTrainers(); renderTrainer(t);
    if (typeof renderProgressSummary === 'function') renderProgressSummary();
  });
  chk.append(box, document.createTextNode(' Defeated'));
  if (defeatedSource(t.constant) === 'save') {
    const p = el('span', 'pill good', 'from save');
    p.title = 'The save\'s trainer flag says this battle is won';
    p.style.marginLeft = '6px';
    chk.append(p);
  }
  chk.style.marginTop = '10px';
  d.append(chk);

  if (!trainerPlace(t)) {
    const n = el('div', 'note');
    n.textContent = 'No map script starts this battle, so it cannot be fought in this '
      + 'build. It is in the party file only.';
    n.style.marginTop = '10px';
    d.append(n);
  }

  if (t.reachable === false && t.unreachableReason) {
    const r = t.unreachableReason;
    const n = el('div', 'note');
    n.innerHTML = `<b>The player can never fight this trainer.</b><br>${esc(r.reason || '')}<br>
      <span class="const">${esc(r.evidence || '')}</span>`;
    n.style.marginTop = '10px';
    d.append(n);
  }

  const bs = battleSection(t);
  if (bs) d.append(bs);

  /* where */
  const where = D.mapOfTrainer[t.constant] || [];
  d.append(el('h3', null, 'Location'));
  if (!where.length) d.append(el('div', 'const', 'no map script references this trainer'));
  else {
    const w = el('div');
    for (const m of where) {
      w.append(el('div', null, `${m.label || m.folder}${m.splitLabel ? ` · ${m.splitLabel}` : ''}`));
    }
    d.append(w);
  }

  appendTeam(d, t);
  d.scrollTop = 0;
}

/** One trainer's team read-out, AI and party, appended to `d`. */
function appendTeam(d, t) {
  /* computed team read-out — the thing you actually want before a fight */
  const party = t.party || [];
  const teamTypes = new Set();
  let fastest = null;
  for (const m of party) {
    const sp = D.byConst[m.speciesConstant];
    if (!sp) continue;
    for (const ty of sp.types) teamTypes.add(ty.constant);
    const spe = sp.baseStats?.speed ?? 0;
    if (!fastest || spe > fastest.spe) fastest = { name: m.species, spe, level: m.level };
  }
  d.append(el('h3', null, 'Team read-out'));
  const ro = el('dl', 'kv');
  const addro = (k, node) => { ro.append(el('dt', null, k)); const dd = el('dd'); dd.append(node); ro.append(dd); };
  addro('Types present', typeChips([...teamTypes]));
  addro('Fastest', document.createTextNode(fastest ? `${fastest.name} — base ${fastest.spe} Spe at L${fastest.level}` : '—'));
  const lv = party.map((m) => m.level).filter((x) => x != null);
  addro('Levels', document.createTextNode(lv.length ? `${Math.min(...lv)}–${Math.max(...lv)}` : '—'));
  d.append(ro);

  if (t.startingStatus?.length) {
    const n = el('div', 'note');
    n.innerHTML = `<b>Starting status:</b> ${esc([].concat(t.startingStatus).join(', '))}`;
    d.append(n);
  }

  /* AI, in English */
  d.append(el('h3', null, 'AI'));
  const flags = t.aiFlagsExpanded?.length ? t.aiFlagsExpanded : (t.aiFlags || []);
  if (!flags.length) d.append(el('div', 'const', 'no AI flags — behaves randomly'));
  else {
    const ul = el('div');
    for (const f of flags) {
      // Entries are {bit, gloss, composite, expands}; an older extract had bare strings.
      const entry = D.trainers.aiFlagGlossary?.[f];
      const gloss = typeof entry === 'string' ? entry : entry?.gloss;
      const row = el('div');
      row.innerHTML = `<span class="pill">${esc(f.replace('AI_FLAG_', ''))}</span> <span style="color:var(--ink-dim)">${esc(gloss || '')}</span>`;
      ul.append(row);
    }
    d.append(ul);
  }

  /* party */
  d.append(el('h3', null, t.isPool ? `Pool — ${party.length} possible, ${t.partySize} appear` : `Party (${party.length})`));
  for (const m of party) {
    const sp = D.byConst[m.speciesConstant];
    const card = el('div', 'mon');
    const top = el('div', 'top');
    top.append(spr(m.speciesConstant));
    const b = el('b'); const link = el('a', 'jump', m.species || pretty(m.speciesConstant));
    link.addEventListener('click', () => {
      // Through showTab like every other jump: it used to flip the classes by
      // hand, which left the remembered tab - and now the section row - behind.
      showTab('dex');
      selectSpecies(m.speciesConstant);
    });
    b.append(link); top.append(b);
    top.append(el('span', 'const', `L${dash(m.level)}`));
    if (sp) top.append(typeChips(sp.types));
    if (m.heldItem) top.append(el('span', 'pill', m.heldItem));
    card.append(top);

    const meta = el('div', 'const');
    meta.textContent = [
      m.ability ? `Ability: ${m.ability}` : null,
      m.nature ? `${m.nature} nature` : null,
      m.ivsExplicit?.length ? `IVs ${JSON.stringify(m.ivs)}` : null,
      m.teraType ? `Tera ${m.teraType}` : null,
    ].filter(Boolean).join(' · ');
    card.append(meta);

    const mv = el('div', 'mv');
    for (const mvc of m.moveConstants || []) {
      const info = D.moveBy[mvc] || {};
      const s = el('span');
      const pow = info.category === 'STATUS' ? 'status' : `${info.power || '—'} BP`;
      s.textContent = `${info.displayName || pretty(mvc)} — ${typeName(info.type)} ${pow}`;
      mv.append(s);
    }
    card.append(mv);
    d.append(card);
  }
}

/**
 * The detail panel for a battle against two trainers: the fight once - its
 * kind, where, whether it is won - then each trainer's team in turn.
 */
function renderFight(g, d) {
  const lead = g[0];
  const head = el('div');
  head.append(el('h2', null, fightNames(g)));
  for (const o of g) head.append(el('div', 'const', `${trainerClassName(o)} ${o.name} · ${o.constant}`));
  d.append(head);

  const tags = el('div', 'chips');
  if (g.some((o) => o.bossKind && o.bossKind !== 'normal')) {
    tags.append(el('span', 'pill', pretty(g.find((o) => o.bossKind && o.bossKind !== 'normal').bossKind)));
  }
  tags.append(fightPill(g));
  const seen = new Set();
  for (const o of g) {
    for (const mp of megaPills(o)) {
      if (!seen.has(mp.textContent)) { seen.add(mp.textContent); tags.append(mp); }
    }
  }
  d.append(tags);

  // One battle, so one box: beating it sets both trainers' flags in the game.
  const chk = el('label', 'chk');
  const box = el('input'); box.type = 'checkbox';
  box.checked = g.every((o) => isDefeated(o.constant));
  box.addEventListener('change', () => {
    for (const o of g) setDefeatedManual(o.constant, box.checked);
    renderTrainers(); renderTrainer(lead);
    if (typeof renderProgressSummary === 'function') renderProgressSummary();
  });
  chk.append(box, document.createTextNode(' Defeated'));
  if (g.every((o) => defeatedSource(o.constant) === 'save')) {
    const p = el('span', 'pill good', 'from save');
    p.title = 'The save\'s trainer flags say this battle is won';
    p.style.marginLeft = '6px';
    chk.append(p);
  }
  chk.style.marginTop = '10px';
  d.append(chk);

  /* the battle */
  d.append(el('h3', null, 'Battle'));
  const others = fightNames(g.slice(1));
  if (lead.battleFormat === 'tag') {
    const ally = tagPartner(lead);
    d.append(el('div', null, `Tag battle: you and ${ally ? ally.name : 'an ally'} against ${fightNames(g)}.`));
    d.append(el('div', 'const', 'You pick which of your Pokémon go in; the ally brings its own team.'));
    if (ally && ally.party?.length) {
      const sg = el('div', 'slotgrid');
      for (const m of ally.party) {
        const r = el('div', 's');
        r.append(spr(m.speciesConstant));
        r.append(speciesLink(m.speciesConstant, '', m.nickname ? ` (${m.nickname})` : ''));
        r.append(el('span', 'l', `L${m.level ?? '?'}${m.heldItem ? ` @ ${m.heldItem}` : ''}`));
        sg.append(r);
      }
      d.append(el('div', 'const', `${ally.name}'s team`));
      d.append(sg);
    }
  } else {
    const pair = sightPartners(lead).find((x) => g.some((o) => o.constant === x.with));
    if (pair) {
      const line = el('div', null, pair.seenTogether
        ? `Two separate trainers who both see you from ${pair.tiles} tile${pair.tiles === 1 ? '' : 's'}, so the game starts one double battle against both - ${lead.name}'s team on one side, ${others}'s on the other.`
        : `Listed as a double, but as they stand now their sight lines never reach the same tile, so the game starts them one at a time.`);
      if (!pair.seenTogether) line.classList.add('warn-text');
      d.append(line);
    } else {
      d.append(el('div', null, `One double battle, one trainer on each side: ${lead.name} and ${others}.`));
    }
  }
  const lines = [];
  for (const o of g) {
    for (const mg of o.guardsMega || []) {
      lines.push(mg.how === 'reward' ? `Beating it gives ${mg.itemName}.`
        : `Guards a mega stone: ${o.name} ${mg.how === 'beside' ? 'stands right beside' : 'watches the way to'} the ${mg.itemName}.`);
    }
  }
  for (const s of [...new Set(lines)]) d.append(el('div', null, s));

  /* where */
  const where = D.mapOfTrainer[lead.constant] || [];
  d.append(el('h3', null, 'Location'));
  if (!where.length) d.append(el('div', 'const', 'no map script references this trainer'));
  else {
    const w = el('div');
    for (const m of where) {
      w.append(el('div', null, `${m.label || m.folder}${m.splitLabel ? ` · ${m.splitLabel}` : ''}`));
    }
    d.append(w);
  }

  /* each side's team */
  for (const o of g) {
    const sec = el('div', 'fight-member');
    sec.append(el('h2', null, `${o.name || pretty(o.constant)}${o.class ? ` — ${trainerClassName(o)}` : ''}`));
    appendTeam(sec, o);
    d.append(sec);
  }
  d.scrollTop = 0;
}

/* ── boot ─────────────────────────────────────────────────────────── */
function fillSelect(sel, values, labeller = (x) => x) {
  const cur = sel.value;
  sel.textContent = '';
  sel.append(el('option', null, 'any'));
  sel.firstChild.value = '';
  for (const v of values) {
    const o = el('option', null, labeller(v));
    o.value = v; sel.append(o);
  }
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

async function boot(isRefresh) {
  try {
    const names = ['species', 'typechart', 'learnsets', 'moves', 'trainers',
      'encounters', 'maps', 'progression', 'items', 'itemlocations', 'bottlecaps', 'monlayout', 'savelayout', 'symbols', 'natures', 'experience', 'abilities', 'manifest', 'kudzucalc'];
    const loaded = await Promise.all(names.map(load));
    names.forEach((n, i) => { D[n] = loaded[i]; });
    // Optional: a data folder extracted before marts existed must still boot.
    D.marts = await load('marts').catch(() => null);
  } catch (e) {
    setStatus('bad', 'data missing');
    showBanner('bad', `Could not load datasets: ${esc(e.message)}. Press <b>Refresh data</b>.`);
    return;
  }
  buildIndexes();

  fillSelect($('#dex-type'), D.typechart.battleTypes.map((t) => (typeof t === 'string' ? t : t.constant)), typeName);
  const abilities = [...new Set(D.species.flatMap((s) => {
    const a = s.abilities || {};
    return [a.primary, a.secondary, a.hidden].filter(Boolean).map((x) => x.constant);
  }))].sort((a, b) => abilityName(a).localeCompare(abilityName(b)));
  fillSelect($('#dex-ability'), abilities, abilityName);
  const eggs = [...new Set(D.species.flatMap((s) => (s.eggGroups || []).map((g) => g.constant)))].sort();
  fillSelect($('#dex-egg'), eggs, pretty);

  fillSelect($('#tr-kind'), D.trainers.bossKinds || [], pretty);
  fillSelect($('#tr-class'), [...new Set(D.trainers.trainers.map((t) => t.class).filter(Boolean))].sort());
  fillSelect($('#tr-split'), (D.progression.splits || []).map((s) => s.id), (id) =>
    (D.progression.splits.find((s) => s.id === id) || {}).label || id);

  // Each tab's init runs in isolation. They used to be a bare sequence, so a
  // throw in one (a bad saved run tripping the caps tab, say) silently skipped
  // every init after it - the calc aside came up empty with nothing to say why.
  // Failures are logged and kept where the self-test and a banner can see them.
  window.__bootErrors = [];
  // The run must be in hand before any initialiser renders from it. It comes
  // from localStorage or from runs/autosave.json, whichever was written last -
  // so this is awaited here rather than done inside initEncounters, which the
  // loop below cannot await.
  await loadRunBest();

  const safeInit = (name, fn) => {
    try { fn(); }
    catch (e) {
      console.error(`${name} failed during boot:`, e);
      window.__bootErrors.push({ name, error: String(e && e.stack || e) });
    }
  };
  safeInit('renderDex', renderDex);
  safeInit('renderTrainers', renderTrainers);
  for (const name of ['initNav', 'initEncounters', 'initItems', 'initCaps', 'initSplits', 'initFrags',
    'initCalc', 'initSav', 'initRuns', 'initBox', 'initHome', 'initSandbox', 'initProgress']) {
    // A missing init used to be skipped in silence, which is exactly how the
    // Calc tab came up blank without a single error to point at. Every name
    // here is expected to exist; say so when one does not.
    if (window[name]) safeInit(name, window[name]);
    else window.__bootErrors.push({ name, error: 'not defined - its script did not load' });
  }
  if (window.__bootErrors.length) {
    showBanner('bad', 'Part of the app failed to start: '
      + window.__bootErrors.map((b) => `<b>${esc(b.name)}</b>`).join(', ')
      + '. Details are in the browser console.');
  }
  if (!isRefresh) {
    await refreshStatus();
    restoreLastPage();
  }
}

/** Open where you left off; the Overview the first time. */
function restoreLastPage() {
  let last = null;
  try { last = localStorage.getItem('kudzu.tab'); } catch { /* ignore */ }
  // The page's own button is clicked rather than showTab() called: the Calc
  // page loads its frame from that click, and reopening on Calc used to show
  // an empty stage until the tab was clicked a second time.
  const lastBtn = last && document.getElementById(`tab-${last}`)
    ? document.querySelector(`#tabs button[data-tab="${last}"]`) : null;
  if (!lastBtn) return;
  // Flagged, because nav.js records a click on a page as the user's choice for
  // that section, and this one is the app's. click() dispatches synchronously.
  if (typeof initNav === 'function') initNav.restoring = true;
  try { lastBtn.click(); } finally { if (typeof initNav === 'function') initNav.restoring = false; }
}

/* filter wiring */
for (const id of ['#dex-q', '#dex-type', '#dex-ability', '#dex-egg', '#dex-stat',
  '#dex-stat-min', '#dex-obtainable', '#dex-forms', '#dex-lines']) {
  $(id).addEventListener('input', renderDex);
}
for (const id of ['#tr-q', '#tr-kind', '#tr-class', '#tr-split', '#tr-bosses',
  '#tr-double', '#tr-unreachable', '#tr-undefeated', '#tr-unplaced']) {
  const node = $(id);
  if (node) node.addEventListener('input', renderTrainers);
}

/* Every tab's init lives in a later <script>, and boot() reaches its init loop
   as soon as its fetches resolve. When that happened before the last file had
   executed, window.initCalc did not exist yet and the Calc tab came up empty -
   with no error, because the loop skips whatever is missing. Waiting for
   DOMContentLoaded guarantees every script has run before boot begins. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot(false));
} else {
  boot(false);
}
