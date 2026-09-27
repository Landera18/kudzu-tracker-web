/* Damage calculator tab.
 *
 * This used to be a hand-rolled matrix. It is now Kudzu Calc - a Showdown-calc
 * fork carrying this ROM's species, moves, abilities, items and trainer sets -
 * served by app.py under /calc/ on the same origin and shown in an iframe. The
 * data it loads (backups/kudzu.js) is written by the kudzucalc extractor on
 * every Refresh, so it can never drift from the tracker's own datasets again.
 *
 * The aside on the left is a hand-off: choosing a trainer writes the calc's
 * own "remembered opposing set" key in localStorage (shared, same origin) and
 * reloads the frame, which restores it on boot exactly as if it had been picked
 * inside the calculator.
 */
'use strict';

let calcTrainer = null;
let calcCell = null;            // kept for callers that reset it
let calcFrameLoaded = false;
let calcStatus = null;
let calcSets = null;            // parsed backup_data.formatted_sets

// The version tag defeats any copy of index.html the WebView cached from an
// older tracker session; the calc ignores parameters it does not know.
const CALC_URL = 'calc/index.html?data=kudzu&gen=9&dmgGen=9&view=calculator&v=' + Date.now();

/** The player's usable team as engine combatants. The graveyard is excluded by
 *  construction. The embedded calc does its own maths now; this stays because
 *  the self-test exercises the graveyard rule through it, and calc.js remains
 *  the engine behind those checks. */
function playerTeam() {
  return roster()
    .filter((m) => m.placement !== 'graveyard')
    .map((m) => toCombatant(m.rec))
    .filter(Boolean);
}

function trainerTeam() {
  if (!calcTrainer) return [];
  const t = D.trainers.trainers.find((x) => x.constant === calcTrainer);
  return t ? (t.party || []).map((p) => toCombatant(p)).filter(Boolean) : [];
}

async function loadCalcStatus() {
  try { calcStatus = await (await fetch('api/calc/status')).json(); }
  catch { calcStatus = { available: false, searched: [] }; }
  return calcStatus;
}

async function loadCalcSets() {
  if (calcSets) return calcSets;
  try {
    const text = await (await fetch('data/kudzu.js')).text();
    const json = text.slice(text.indexOf('{'));
    calcSets = JSON.parse(json).formatted_sets || {};
  } catch (e) {
    calcSets = {};
  }
  return calcSets;
}

// "Species (Lvl N Trainer )" - the calc's id for a set, and the value it
// restores from localStorage["right"]. The lead is the sub_index-0 set carrying
// this trainer's id.
async function leadSetIdFor(trainerId) {
  const sets = await loadCalcSets();
  for (const [species, byLabel] of Object.entries(sets)) {
    for (const [label, set] of Object.entries(byLabel)) {
      if (set.tr_id === trainerId && set.sub_index === 0) return `${species} (${label})`;
    }
  }
  return null;
}

async function showCalcFrame() {
  const frame = $('#calc-frame'), missing = $('#calc-missing'), note = $('#calc-data-note');
  const st = calcStatus || await loadCalcStatus();
  if (!st.available) {
    const paths = (st.searched || []).map((x) => `<code>${esc(x)}</code>`).join('<br>');
    missing.innerHTML = 'Kudzu Calc was not found. Check it out beside this app at one of these '
      + 'paths, or set <code>calc_path</code> in <code>config.json</code>:<br><br>' + paths;
    missing.hidden = false; frame.hidden = true;
    return false;
  }
  missing.hidden = true;
  if (note) {
    note.textContent = st.dataset
      ? `Calc data written ${(st.datasetWrittenAt || '').slice(0, 16).replace('T', ' ')} UTC by Refresh.`
      : 'No backups/kudzu.js yet - press Refresh data to generate it.';
  }
  // Stage the team BEFORE the frame loads, because the injected bootstrap only
  // looks for a pending import during its own boot.
  const staged = autoStageTeam();
  if (!calcFrameLoaded) {
    frame.src = CALC_URL;
    frame.hidden = false;
    calcFrameLoaded = true;
  } else if (staged) {
    // Already loaded, so its boot has been and gone; the pending import is only
    // read during boot, and a reload is the one thing that runs it again.
    frame.src = CALC_URL;
  }
  return true;
}

const CALC_SENT_KEY = 'kudzu.calc.sent';
const CALC_TRAINER_KEY = 'kudzu.calc.trainer';

/* The opponent chosen in the aside, kept across a reload. "Refresh data" now
   reloads the page, and a launch that ends on the Calc page opens it straight
   away; without this, both found `calcTrainer` empty, loaded the next boss and
   overwrote the opponent the calculator itself remembers. */
function rememberCalcTrainer(constant) {
  try {
    if (constant) localStorage.setItem(CALC_TRAINER_KEY, constant);
    else localStorage.removeItem(CALC_TRAINER_KEY);
  } catch { /* private mode */ }
}

/**
 * Put the run's team in the calculator without being asked.
 *
 * The calculator keeps its imported sets in `customsets`, so once a team is in
 * it normally stays. It can still be missing - a first run on this origin, a
 * cleared profile - and opening the Calc tab to an empty My Box after the run
 * plainly has a team is just the app not doing its job.
 *
 * It re-stages only when the box is empty or the team has actually changed,
 * compared against the exact text last sent. Re-importing unconditionally
 * would throw away edits made inside the calculator every time the tab was
 * opened.
 */
function autoStageTeam() {
  const text = rosterToShowdown();
  if (!text) return false;

  let boxEmpty = true;
  try {
    const cs = JSON.parse(localStorage.getItem('customsets') || '{}');
    boxEmpty = !Object.keys(cs).some((k) => cs[k] && cs[k]['My Box']);
  } catch { /* treat as empty */ }

  let last = null;
  try { last = localStorage.getItem(CALC_SENT_KEY); } catch { /* ignore */ }
  if (!boxEmpty && last === text) return false;

  try {
    localStorage.setItem('kudzu.calc.import', text);
    localStorage.setItem(CALC_SENT_KEY, text);
  } catch { return false; }
  return true;
}

/* The calc does not simulate a trainer's starting field effect (Magnetic Field,
   Trick Room, hazards on your side...), so say what the chosen fight starts
   with, and what it does, where the fight is picked. */
function renderCalcFieldNote() {
  const box = $('#calc-field-note');
  if (!box) return;
  const t = calcTrainer && D.trainerBy && D.trainerBy[calcTrainer];
  const fx = t && typeof fieldEffectsOf === 'function' ? fieldEffectsOf(fightGroup(t)) : [];
  box.textContent = '';
  box.hidden = !fx.length;
  if (!fx.length) return;
  box.append(el('div', 'calc-field-head', 'Starts with - not in the calc:'));
  for (const e of fx) {
    const row = el('div', 'calc-field-row');
    row.append(el('b', null, fieldName(e)));
    const when = fieldWhen(e);
    if (when) row.append(el('span', 'fx-when', ` ${when}`));
    if (e.text) row.append(el('div', 'fx-text', e.text));
    box.append(row);
  }
}

async function handoffTrainer(constant) {
  const frame = $('#calc-frame');
  const t = constant && D.trainers.trainers.find((x) => x.constant === constant);
  if (!t) return;
  const setId = await leadSetIdFor(t.id);
  if (!setId) return;
  try { localStorage.setItem('right', setId); } catch { /* private mode */ }
  // Reloading is the one reliable way to make the calc apply it: its restore
  // runs during boot, and the select2 picker is not scriptable from outside.
  if (calcFrameLoaded && !frame.hidden) frame.src = CALC_URL;
}

function renderCalc() { /* the calculator renders itself now */ }

/** Open the Calc tab with this trainer's team loaded, from anywhere. */
async function openCalcFor(constant) {
  constant = fightLead(constant);
  const loc = $('#calc-location');
  const sel = $('#calc-trainer');
  if (loc && loc.value) { loc.value = ''; fillCalcTrainers(null); }
  if (sel && [...sel.options].some((o) => o.value === constant)) sel.value = constant;
  calcTrainer = constant;
  rememberCalcTrainer(constant);
  renderCalcFieldNote();
  showTab('calc');
  try { await handoffTrainer(constant); } catch { /* the calc opens without it */ }
  showCalcFrame();
}

// Trainers grouped by where they are fought. maps.json already joins each map
// to the trainer constants its scripts start, and carries the label the game
// shows for it; a trainer on several maps (23 of them) is listed under each.
function calcLocations() {
  const groups = new Map();
  const maps = (D.maps?.maps || D.maps || []);
  const list = Array.isArray(maps) ? maps : Object.values(maps);
  for (const m of list) {
    if (!m.inBuild || !m.isKanto || !(m.trainers || []).length) continue;
    const label = m.displayLabel || m.regionMapSectionName || m.name;
    if (!groups.has(label)) groups.set(label, new Set());
    for (const t of m.trainers) groups.get(label).add(t);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

function fillCalcTrainers(allowed) {
  const sel = $('#calc-trainer');
  sel.textContent = '';
  const none = el('option', null, '— pick a trainer —');
  none.value = '';
  sel.append(none);

  // A battle against two trainers is one entry, named for both and keyed by its
  // lead; the calc loads the other as the lead's partner (Doubles) by itself.
  const fights = groupFights(D.trainers.trainers.filter((t) => t.reachable !== false
    && (!allowed || allowed.has(t.constant))));
  const rank = (g) => (g[0].gymNumber ? 0 : g.some((t) => t.isBoss) ? 1 : 2);
  fights.sort((x, y) => rank(x) - rank(y)
    || (x[0].gymNumber || 0) - (y[0].gymNumber || 0)
    || fightNames(x).localeCompare(fightNames(y)));
  for (const g of fights) {
    const t = g[0];
    const tag = t.gymNumber ? `Gym ${t.gymNumber} — ` : g.some((x) => x.isBoss) ? '★ ' : '';
    const cls = g.length > 1 ? fightClasses(g) : t.class;
    const o = el('option', null, `${tag}${fightNames(g)}${cls ? ` (${cls})` : ''}`);
    o.value = t.constant;
    sel.append(o);
  }
  // Keep the selection if it survived the filter; otherwise clear it so the
  // matrix does not keep showing a trainer the list no longer offers.
  if (calcTrainer) calcTrainer = fightLead(calcTrainer);
  if (calcTrainer && fights.some((g) => g[0].constant === calcTrainer)) sel.value = calcTrainer;
  else { calcTrainer = null; calcCell = null; }
}


/* ── handing the tracker's own team to the calc ───────────────────── */

/** The key Kudzu Calc uses for a species constant, from its own data file. */
function calcSpeciesKey(constant) {
  const keys = D.kudzucalc && D.kudzucalc.keyByConstant;
  return (keys && constant && keys[constant]) || null;
}

/* Showdown text is the calc's supported import format, and it has a parser for
   it already. Building its internal set objects by hand would mean
   reimplementing buildDexObject and re-deriving it whenever the calc changes. */
function rosterToShowdown() {
  const out = [];
  for (const m of roster()) {
    if (m.placement === 'graveyard') continue;     // the dead never go in
    const rec = m.rec;
    const sp = D.byConst[rec.species];
    // The calc's own key for the species, so a regional form goes across as
    // the form: "Linoone-Galar", not the "Linoone" every form shares as a
    // display name and which the calc reads as the Hoenn one.
    const name = calcSpeciesKey(rec.species) || (sp ? sp.displayName : (rec.speciesRaw || null));
    if (!name) continue;

    const snap = rec.snapshot || {};
    const head = rec.nickname && rec.nickname !== name
      ? `${rec.nickname} (${name})` : name;
    const lines = [snap.heldItem ? `${head} @ ${snap.heldItem}` : head];
    if (snap.ability) lines.push(`Ability: ${snap.ability}`);
    if (rec.currentLevel) lines.push(`Level: ${rec.currentLevel}`);
    if (snap.nature) lines.push(`${snap.nature} Nature`);

    // IVs come through as "31/0/31/31/31/31" in the snapshot, or as an object
    // from save ingestion. Showdown wants them named, and only the ones that
    // are not 31 need saying.
    const iv = ivParts(snap.ivs, snap.hyperTrained);
    if (iv) lines.push(iv);

    for (const mv of (snap.moves || []).filter(Boolean)) lines.push(`- ${mv}`);
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

const IV_LABELS = ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'];
/* The same six, as the snapshot names them - for reading `hyperTrained`. */
const IV_KEYS = ['hp', 'attack', 'defense', 'spAttack', 'spDefense', 'speed'];

/**
 * The six IVs as numbers, in HP/Atk/Def/SpA/SpD/Spe order, or null.
 *
 * `exact` refuses to fill a gap with 31. That is fine for the Showdown export,
 * where an unstated IV means 31 anyway, but not for anything computed FROM the
 * IVs - Hidden Power's type turns on their low bits, so inventing one produces
 * a confidently wrong answer rather than no answer.
 */
function ivValues(ivs, exact) {
  const fill = exact ? null : 31;
  if (typeof ivs === 'string') {
    const parts = ivs.split(/[^0-9x]+/i).filter(Boolean);
    if (parts.length !== 6) return null;
    const vals = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : fill));
    return vals.some((v) => v == null || !Number.isFinite(v)) ? null : vals;
  }
  if (ivs && typeof ivs === 'object') {
    const vals = [ivs.hp, ivs.attack ?? ivs.atk, ivs.defense ?? ivs.def,
      ivs.spAttack ?? ivs.spa, ivs.spDefense ?? ivs.spd, ivs.speed ?? ivs.spe]
      .map((v) => (v == null ? fill : Number(v)));
    return vals.some((v) => v == null || !Number.isFinite(v)) ? null : vals;
  }
  return null;
}

/**
 * The Showdown `IVs:` line, or null when every value is the default 31.
 *
 * `hyper` is the snapshot's Hyper Training flags. Hyper Training does not touch
 * the stored IV - the game just computes the STAT as though it were 31 - and
 * the calculator has no such concept, so the effective value is what goes
 * across. Hidden Power is left alone: it reads the raw IVs in the ROM
 * (GetMoveEffect EFFECT_HIDDEN_POWER, off gBattleMons' own IV fields), which is
 * what box.js does with `ivsByStat`.
 */
function ivParts(ivs, hyper) {
  const vals = ivValues(ivs, false);
  if (!vals) return null;
  const eff = hyper ? vals.map((v, i) => (hyper[IV_KEYS[i]] ? 31 : v)) : vals;
  const named = eff.map((v, i) => (v === 31 ? null : `${v} ${IV_LABELS[i]}`)).filter(Boolean);
  return named.length ? `IVs: ${named.join(' / ')}` : null;
}

/**
 * Hand the run's living team to the calculator.
 *
 * `quiet` is for the automatic call after a save import: it still stages the
 * team, but does not reload a frame the user is not looking at - the bootstrap
 * picks the team up whenever the calc is next opened.
 */
function sendTeamToCalc(opts) {
  const quiet = !!(opts && opts.quiet);
  const note = $('#calc-team-note');
  const say = (msg) => { if (note) note.textContent = msg; };
  const text = rosterToShowdown();
  const n = text ? text.split('\n\n').length : 0;
  if (!n) {
    if (!quiet) say('Nothing to send - no living Pokemon in the run yet.');
    return;
  }
  try {
    localStorage.setItem('kudzu.calc.import', text);
    localStorage.setItem(CALC_SENT_KEY, text);
  } catch { if (!quiet) say('Could not write to storage.'); return; }
  // The injected bootstrap picks it up on load, so the frame has to reload.
  const frame = $('#calc-frame');
  if (calcFrameLoaded && frame && !frame.hidden) frame.src = CALC_URL;
  say(`Sent ${n} Pokemon. They appear under "My Box" in the calc.`);
}

/* ── fit ──────────────────────────────────────────────────────────── */

/* The calc's own layout is around 1384px wide and taller than the window, so at
   100% it always needs scrolling in both directions. `zoom` on its body is what
   shrinks it, because it reflows the layout rather than just scaling pixels. */

/* Fitting the HEIGHT as well is what made this unusable: the calc is about
   1519px tall against a stage nearer 780px, so both-axes fitting lands at ~41%
   - unreadable, and it wastes half the width, because once the document is
   that small its layout has already reached its natural max width and stops
   spreading. Fitting the width alone keeps the text legible and fills the
   stage; the page then scrolls vertically, which is what a calculator this
   tall has to do in a window this short. */
const CALC_ZOOM_FLOOR = 0.55;

/** Natural size of the calc document, in its own (pre-zoom) pixels. */
function calcContentSize(doc) {
  const b = doc.body;
  const e = doc.documentElement;
  return {
    w: Math.max(b.scrollWidth, e.scrollWidth, b.offsetWidth),
    h: Math.max(b.scrollHeight, e.scrollHeight, b.offsetHeight),
  };
}

/**
 * Scale the calculator so its full width is on screen.
 *
 * `mode` is 'width' (the default) or 'all'. Width-fitting iterates rather than
 * dividing once because the zoom feeds back into the layout: a smaller zoom
 * widens the CSS viewport in the document's own units, so the page reflows and
 * may report a different natural width. Each pass can only shrink, so it
 * settles rather than oscillating.
 *
 * 'all' additionally fits the height, which is honest but tiny - see the note
 * on CALC_ZOOM_FLOOR.
 */
function fitCalcZoom(mode) {
  const frame = $('#calc-frame');
  if (!frame) return null;
  const stage = frame.parentElement;
  let doc;
  try { doc = frame.contentDocument; } catch { return null; }
  if (!doc || !doc.body) return null;

  const availW = stage.clientWidth;
  const availH = stage.clientHeight;
  if (!availW || !availH) return null;

  doc.body.style.zoom = 1;
  const nat = calcContentSize(doc);
  if (!nat.w || !nat.h) return null;

  const both = mode === 'all';
  let z = Math.min(1, availW / nat.w);
  for (let i = 0; i < 4; i += 1) {
    doc.body.style.zoom = z;
    const m = calcContentSize(doc);
    const needW = m.w * z;
    const needH = m.h * z;
    if (needW <= availW + 1 && (!both || needH <= availH + 1)) break;
    const shrink = both
      ? Math.min(availW / needW, availH / needH)
      : availW / needW;
    const next = Math.max(both ? 0.3 : CALC_ZOOM_FLOOR, z * shrink * 0.995);
    if (next >= z) break;          // already at the floor; stop rather than spin
    z = next;
  }
  doc.body.style.zoom = z;
  return z;
}

function applyCalcZoom(value) {
  try { localStorage.setItem('kudzu.calc.zoom', String(value)); } catch { /* private mode */ }
  if (value === 'fit' || value === 'fit-all') {
    const z = fitCalcZoom(value === 'fit-all' ? 'all' : 'width');
    const out = $('#calc-zoom-actual');
    if (out) out.textContent = z ? `fitted to ${Math.round(z * 100)}%` : '';
    return;
  }
  const out = $('#calc-zoom-actual');
  if (out) out.textContent = '';
  // Same-origin, so reach into the frame directly rather than reloading it -
  // reloading would throw away whatever is set up in the calculator.
  const frame = $('#calc-frame');
  try {
    const doc = frame.contentDocument;
    if (doc && doc.body) doc.body.style.zoom = value;
  } catch { /* not loaded yet; the bootstrap applies it on load */ }
}

/** Re-fit after anything that changes how much room the frame has. */
function refitCalcIfAuto() {
  const zoom = $('#calc-zoom');
  if (zoom && (zoom.value === 'fit' || zoom.value === 'fit-all')) applyCalcZoom(zoom.value);
}

function setCalcWide(on) {
  $('#tab-calc').classList.toggle('wide', on);
  $('#calc-unhide').hidden = !on;
  try { localStorage.setItem('kudzu.calc.wide', on ? '1' : ''); } catch { /* ignore */ }
  // The stage just changed width, so a fitted zoom is now the wrong one. The
  // frame reflows first, hence the deferral.
  requestAnimationFrame(refitCalcIfAuto);
}

function initCalc() {
  if (!D.trainers) return;
  // "Refresh data" runs every init again. The lists below are refilled each
  // time; the listeners are added once - a second click listener on the Calc
  // page button reloaded the frame twice per click, and every section button
  // inherits whatever hangs on that button.
  const first = !initCalc.wired;
  initCalc.wired = true;
  const on = (node, type, fn) => { if (first && node) node.addEventListener(type, fn); };

  const loc = $('#calc-location');
  loc.textContent = '';
  const all = el('option', null, 'all locations');
  all.value = '';
  loc.append(all);
  const groups = calcLocations();
  for (const [label, set] of groups) {
    const o = el('option', null, `${label} (${set.size})`);
    o.value = label;
    loc.append(o);
  }
  // Looked up at change time, so a refreshed location list is the one used.
  initCalc.byLabel = new Map(groups);
  on(loc, 'change', () => {
    fillCalcTrainers(loc.value ? initCalc.byLabel.get(loc.value) : null);
  });

  fillCalcTrainers(null);
  const sel = $('#calc-trainer');
  on(sel, 'change', () => {
    calcTrainer = sel.value || null;
    rememberCalcTrainer(calcTrainer);
    renderCalcFieldNote();
    handoffTrainer(calcTrainer);
  });
  // Back on the opponent that was being prepared for - unless the save has
  // since beaten them, in which case the next boss is the better guess again.
  if (first && !calcTrainer) {
    let kept = null;
    try { kept = localStorage.getItem(CALC_TRAINER_KEY); } catch { /* ignore */ }
    if (kept) kept = fightLead(kept);     // one half of a pair was remembered by an older build
    const stillOpen = kept && [...sel.options].some((o) => o.value === kept)
      && !(typeof isDefeated === 'function' && isDefeated(kept));
    if (stillOpen) { sel.value = kept; calcTrainer = kept; }
    renderCalcFieldNote();
  }

  on($('#calc-send-team'), 'click', sendTeamToCalc);

  const zoom = $('#calc-zoom');
  const savedZoom = (() => { try { return localStorage.getItem('kudzu.calc.zoom'); } catch { return null; } })();
  // An unrecognised stored value (an old build's "1.2") must not leave the
  // select blank - fall back to fitting.
  if (savedZoom && [...zoom.options].some((o) => o.value === savedZoom)) zoom.value = savedZoom;
  on(zoom, 'change', () => applyCalcZoom(zoom.value));

  let refitTimer = null;
  on(window, 'resize', () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(refitCalcIfAuto, 120);
  });

  // Every load and reload - first open, a trainer handoff, a team import - puts
  // the frame back at zoom 1, so the fit has to be re-taken. Twice: once as
  // soon as it lays out, and again once webfonts and the select2 pickers have
  // settled, which changes the height under it.
  const frame = $('#calc-frame');
  if (frame) {
    on(frame, 'load', () => {
      requestAnimationFrame(refitCalcIfAuto);
      setTimeout(refitCalcIfAuto, 350);
    });
  }

  const wide = $('#calc-wide');
  const savedWide = (() => { try { return localStorage.getItem('kudzu.calc.wide'); } catch { return null; } })();
  if (savedWide) { wide.checked = true; setCalcWide(true); }
  on(wide, 'change', () => setCalcWide(wide.checked));
  on($('#calc-unhide'), 'click', () => { wide.checked = false; setCalcWide(false); });

  // Load the frame the first time the tab is opened, not at boot: it is a
  // whole second site and there is no reason to fetch it for a Pokédex visit.
  const btn = document.querySelector('#tabs button[data-tab="calc"]');
  on(btn, 'click', async () => {
    // First open with nothing chosen: the next boss in run order is the fight
    // to prepare for, so it is loaded rather than an empty calculator.
    if (!calcTrainer && typeof nextBossFight === 'function') {
      // "Next" is read from the beaten-trainer flags, and at launch the save may
      // not have been read yet: a boss beaten while the tracker was closed would
      // be offered again, and nothing re-picks once an opponent is set.
      if (typeof firstSaveRead === 'function') await firstSaveRead(4000);
      const nb = calcTrainer ? null : nextBossFight();
      const nbKey = nb ? fightLead(nb.trainer.constant) : null;
      if (nbKey && [...sel.options].some((o) => o.value === nbKey)) {
        sel.value = nbKey;
        calcTrainer = nbKey;
        rememberCalcTrainer(calcTrainer);
        renderCalcFieldNote();
        try { await handoffTrainer(calcTrainer); } catch { /* the calc opens without it */ }
      }
    }
    showCalcFrame();
  });
  if (document.querySelector('#tab-calc.on')) showCalcFrame();
}
window.initCalc = initCalc;
