/* Save ingestion — the interface.
 *
 * The run follows the emulator's save. progress.js watches the file the
 * server exposes and hands its bytes here whenever the timestamp moves; this
 * file parses them (sav.js), reconciles the roster against the run, applies
 * what the save says, and shows a receipt. A .sav can still be imported by
 * hand once, for a save that lives somewhere the app is not pointed at.
 *
 * Box roles come straight from the run's own convention: boxes 1-3 are the
 * living PC, 13-14 are the graveyard, and everything between is ignored.
 */
'use strict';

let savResult = null;
let savDiff = [];        // held back for a decision - hand-marked deaths only
let savApplied = [];     // what the last read wrote in, for the receipt
let savMeta = null;      // {path, mtimeMs, reason, manual, at} of the last read

const boxRoleOf = (n, cfg) => {
  const living = cfg.livingPc || [1, 2, 3];
  const grave = cfg.graveyard || [13, 14];
  if (grave.includes(n)) return 'graveyard';
  if (living.includes(n)) return 'pc';
  return 'other';
};

/** id -> record lookups, built once. The datasets are keyed by constant. */
function idMaps() {
  if (idMaps._c) return idMaps._c;
  const m = {
    species: new Map(D.species.map((s) => [s.id, s])),
    move: new Map(D.moves.map((x) => [x.id, x])),
    item: new Map((D.items || []).map((x) => [x.id, x])),
    nature: new Map((D.natures || []).map((n, i) => [n.id ?? i, n])),
  };
  idMaps._c = m;
  return m;
}

/**
 * The level of a Pokémon that does not record one.
 *
 * Only the 100-byte party struct stores a level. A BoxPokemon stores
 * experience, and the game derives the level from it - so without this every
 * boxed Pokémon comes out level-less: invisible to the level cap, blank in the
 * PC, and arriving in the calculator at its default of 100.
 *
 * The level is the highest rung of the species' growth-rate curve whose
 * requirement its experience has met.
 */
function levelFromExperience(exp, sp) {
  if (exp == null || !sp) return null;
  const ex = D.experience;
  const rate = sp.growthRate;
  if (!ex || !ex.tables || !rate) return null;
  const row = ex.growthRates.find((g) => g.id === rate.id || g.constant === rate.constant);
  const table = row && ex.tables[row.row];
  if (!table || !table.length) return null;
  let lv = 1;
  for (let i = 1; i < table.length; i += 1) {
    if (table[i] == null || table[i] > exp) break;
    lv = i;
  }
  return lv;
}

/** Turn a parsed mon into the shape the rest of the app speaks. */
function normaliseMon(mon, where, boxNumber) {
  const M = idMaps();
  const sp = M.species.get(mon.speciesId);
  const nat = M.nature.get(mon.natureId);
  const level = mon.level ?? levelFromExperience(mon.experience, sp);
  const ab = abilityForSlot(sp, mon.abilityNum) || {};
  // Item slot 0 is ITEM_NONE, whose name in this ROM is a row of question
  // marks; that is "nothing held", not an item called ????????.
  const item = M.item.get(mon.heldItemId);
  const heldItem = item && item.constant !== 'ITEM_NONE' && !/^\?+$/.test(item.displayName || '')
    ? item.displayName : null;
  return {
    speciesConstant: sp ? sp.constant : null,
    speciesId: mon.speciesId,
    displayName: sp ? sp.displayName : `#${mon.speciesId}`,
    fullName: sp ? (sp.fullName || sp.displayName) : `#${mon.speciesId}`,
    nickname: mon.nickname || null,
    level,
    levelFrom: mon.level != null ? 'stored' : (level != null ? 'experience' : null),
    experience: mon.experience ?? null,
    hp: mon.hp ?? null,
    maxHP: mon.maxHP ?? null,
    nature: nat ? nat.displayName : null,
    // The save stores which ability SLOT, not the ability; resolving it needs
    // the species, which is why it happens here and not in the parser.
    ability: ab.displayName || null,
    abilityIsHidden: !!ab.isHidden,
    abilityNum: mon.abilityNum ?? null,
    heldItem,
    moves: mon.moveIds.map((id) => M.move.get(id)?.displayName).filter(Boolean),
    ivs: mon.ivs,
    hyperTrained: mon.hyperTrained || null,
    evs: mon.evs,
    frags: mon.killCount,
    shiny: !!mon.shinyModifier,
    isEgg: mon.isEgg,
    otName: mon.otName,
    otId: mon.otId,
    where,
    boxNumber: boxNumber ?? null,
    slot: mon.slot ?? null,          // position within the party or box
    metLocation: mon.metLocation ?? null,
    metLevel: mon.metLevel ?? null,
    key: `${mon.personality}:${mon.otId}`,     // stable identity across syncs
  };
}

/* The three met-location values that are not map sections. Read from the
   layout the extractor computed; the Gen 3 values are the fallback only for a
   dataset built before the field existed. */
function metSpecials() {
  const m = (D.savelayout && D.savelayout.metLocation) || {};
  return {
    egg: m.specialEgg ?? 0xFD,
    trade: m.inGameTrade ?? 0xFE,
    fateful: m.fatefulEncounter ?? 0xFF,
  };
}

/**
 * What the cartridge says about where a Pokémon was met.
 *
 * The save stores a MAPSEC byte, which is the region-map section rather than
 * the map - MAPSEC_MT_MOON covers all three floors, MAPSEC_ROUTE_3 the whole
 * route. So this returns the section's in-game name plus every encounter area
 * inside it, narrowed to the areas that can actually yield this Pokémon's
 * evolution line when that leaves any, and the caller only files the Pokémon
 * automatically when that comes to exactly one. More than one is still worth
 * having: it turns "pick from 174" into "pick from 2".
 *
 * Three values are not sections at all: hatched from an egg, received in an
 * in-game trade, and a fateful encounter (a gift or a static). Those are
 * matched against the areas of that kind instead.
 */
function metInfo(value, speciesConstant, metLevel) {
  if (value == null) return null;
  const all = (typeof AREAS !== 'undefined' && AREAS) ? AREAS : [];
  const S = metSpecials();
  const line = speciesConstant && typeof lineOf === 'function' ? lineOf(speciesConstant) : null;
  const sameLine = (a) => !!line && (a.species || []).some((x) => lineOf(x) === line);

  let areas;
  let name;
  let kind = 'section';
  let known = true;
  let id = null;
  // Gen 3 records a hatched Pokemon with met level 0 and the place it hatched
  // as its met location. The encounter that matters for the run is the egg it
  // came from, so when an egg gift of its line exists that is the area.
  const eggAreas = metLevel === 0 && line
    ? all.filter((a) => a.entry.kind === 'egg' && sameLine(a)) : [];
  if (eggAreas.length) {
    kind = 'egg'; name = 'Hatched from an egg';
    areas = eggAreas;
  } else if (value === S.trade) {
    kind = 'trade'; name = 'In-game trade';
    areas = all.filter((a) => a.entry.kind === 'trade');
  } else if (value === S.egg) {
    kind = 'egg'; name = 'Hatched from an egg';
    areas = all.filter((a) => a.entry.kind === 'egg');
  } else if (value === S.fateful) {
    kind = 'fateful'; name = 'Fateful encounter';
    areas = all.filter((a) => a.entry.kind === 'gift' || a.entry.kind === 'static' || a.entry.kind === 'pool');
  } else {
    const sec = D.mapsecByValue[value] || null;
    const folders = new Set(D.foldersOfMapsec[value] || []);
    areas = all.filter((a) => (a.folders || [a.folder]).some((f) => folders.has(f)));
    name = sec ? sec.name : `map section ${value}`;
    known = !!sec;
    id = sec ? sec.id : null;
  }
  // A section with several areas usually has only one that can produce this
  // line; narrowing by it is what files most Pokémon without a question.
  if (areas.length > 1) {
    const byLine = areas.filter(sameLine);
    if (byLine.length) areas = byLine;
  } else if (kind !== 'section' && areas.length && line) {
    const byLine = areas.filter(sameLine);
    if (byLine.length) areas = byLine;
  }
  return { value, id, name, known, kind, areas };
}

/** Every Pokémon in the save, tagged with the role of where it sits. */
function savRoster(result) {
  const res = result || savResult;
  if (!res || res.error) return [];
  const cfg = (D.manifest?.config?.boxes) || {};
  const out = res.party.map((m) => normaliseMon(m, 'party', null));
  for (const b of res.boxes) {
    const role = boxRoleOf(b.number, cfg);
    for (const m of b.mons) out.push(normaliseMon(m, role, b.number));
  }
  return out;
}

const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

/**
 * Compare the save against the run and propose changes.
 * Deliberately conservative: it proposes, it never writes.
 */
function buildSavDiff() {
  const save = savRoster();
  const byKey = new Map();
  for (const [id, rec] of Object.entries(RUN.encounters)) {
    if (rec.saveKey) byKey.set(rec.saveKey, { id, rec });
  }

  const out = [];
  for (const m of save) {
    if (m.where === 'other') continue;             // boxes 4-12 are not tracked
    const known = byKey.get(m.key);

    if (!known) {
      const where = m.where === 'party' ? 'party'
        : m.where === 'pc' ? `PC box ${m.boxNumber}` : 'graveyard';
      out.push({
        kind: 'new', mon: m,
        label: `${m.nickname || m.displayName} (L${m.level ?? '?'}) added from the save · ${where}`,
        detail: m.where === 'graveyard'
          ? 'It is in the graveyard boxes, so it is recorded as dead.'
          : `It is in ${m.where === 'party' ? 'your party' : 'the living PC'}.`,
      });
      continue;
    }

    const rec = known.rec;
    const who = m.nickname || m.displayName;
    // A move into the graveyard boxes is a death.
    if (m.where === 'graveyard' && placementOf(rec) !== 'graveyard') {
      out.push({
        kind: 'death', mon: m, areaId: known.id,
        label: `${who} has moved into the graveyard boxes`,
        detail: 'Recorded as dead.',
      });
    } else if (m.where !== 'graveyard' && placementOf(rec) === 'graveyard') {
      out.push({
        kind: 'revive', mon: m, areaId: known.id,
        label: `${who} is marked dead here but is alive in the save`,
        detail: rec.deathSource === 'manual'
          ? 'You marked this one dead by hand, so the save is NOT applied automatically.'
          : 'Accepting puts it back in the roster.',
        manual: rec.deathSource === 'manual',
      });
    } else if (m.where !== placementOf(rec) || (m.boxNumber != null && m.boxNumber !== rec.boxNumber)) {
      out.push({
        kind: 'placement', mon: m, areaId: known.id,
        label: `${who} moved to ${m.where === 'party' ? 'the party' : m.where === 'pc' ? `box ${m.boxNumber}` : m.where}`,
        detail: `The run had it in ${placementOf(rec)}.`,
      });
    }

    // Evolution keeps the personality, so the same key now names a new species.
    if (m.speciesConstant && rec.species !== m.speciesConstant) {
      out.push({
        kind: 'species', mon: m, areaId: known.id,
        label: `${who} evolved: ${D.byConst[rec.species]?.displayName || rec.speciesRaw || '?'} → ${m.displayName}`,
        detail: 'Same Pokémon, new species.',
      });
    }
    if ((m.nickname || null) !== (rec.nickname || null)) {
      out.push({
        kind: 'nickname', mon: m, areaId: known.id,
        label: `${rec.nickname || rec.speciesRaw || '?'} renamed to ${m.nickname || m.displayName}`,
        detail: '',
      });
    }

    if (m.level != null && Number(rec.currentLevel) !== m.level) {
      out.push({
        kind: 'level', mon: m, areaId: known.id,
        label: `${who}: L${rec.currentLevel ?? '?'} → L${m.level}`,
        detail: 'Level and KOs refreshed from the save.',
      });
    } else if (m.frags != null && Number(rec.frags || 0) !== m.frags) {
      out.push({
        kind: 'frags', mon: m, areaId: known.id,
        label: `${who}: ${rec.frags || 0} → ${m.frags} KOs`,
        detail: 'The game counts this itself.',
      });
    }

    // Moves, item, ability, nature and IVs all change during a run - relearned
    // moves, a swapped item, a cap spent on a Nature Change or on an IV - and
    // the calc exports whatever the snapshot says, so it must follow the save.
    //
    // The IVs were missing from this list, and a bottle cap spent on an IV
    // changes NOTHING ELSE about a Pokemon, so nothing here ever fired: the run
    // kept the IVs it was caught with for ever and handed those to the
    // calculator. A Bibarel with two IVs raised to 31 in game was still 8 and 0
    // in the run weeks later.
    const snap = rec.snapshot || {};
    const changed = [];
    if (!sameList(snap.moves, m.moves)) changed.push('moves');
    if ((snap.heldItem || null) !== (m.heldItem || null)) changed.push('item');
    if ((snap.ability || null) !== (m.ability || null)) changed.push('ability');
    if ((snap.nature || null) !== (m.nature || null)) changed.push('nature');
    if ((snap.ivs || null) !== ivsOf(m)) changed.push('IVs');
    if (JSON.stringify(snap.hyperTrained || null) !== JSON.stringify(hyperOf(m))) {
      changed.push('hyper training');
    }
    if (changed.length) {
      out.push({
        kind: 'snapshot', mon: m, areaId: known.id,
        label: `${who}: ${changed.join(', ')} updated`,
        detail: '',
      });
    }
  }
  return out;
}

/**
 * Write everything the save says into the run, without being asked.
 *
 * Reading the save IS the instruction to record it - having to click Accept
 * on each of twenty cards afterwards is the app making you do its job. The
 * one exception stays: a death you marked by hand is not undone because the
 * save has not caught up with the box move yet. Those are held back as cards.
 */
function autoApplySave() {
  const auto = savDiff.filter((c) => !c.manual);
  for (const c of auto) applyChange(c);
  savDiff = savDiff.filter((c) => c.manual);
  return auto;
}

/* The order the snapshot's "0/8/31/23/5/7" is written in. One spelling, used
   by both the snapshot and the comparison that decides whether it is stale -
   two copies of this list is how the IVs stopped being compared at all. */
const SNAP_IV_ORDER = ['hp', 'attack', 'defense', 'spAttack', 'spDefense', 'speed'];
const ivsOf = (mon) => SNAP_IV_ORDER.map((k) => mon.ivs[k]).join('/');

/**
 * Which stats are Hyper Trained, or null when none are.
 *
 * Hyper Training (the `hypertrain` script command) leaves the stored IV alone
 * and has the game compute the stat as though it were 31. The bottle-cap NPC's
 * Hyper Trainer does NOT use it - it writes a real 31 - so this is null for
 * every Pokemon in the save today. It is carried because the ROM has the other
 * mechanism, and a stat that is silently 31 in game and 3 in the calculator is
 * the worst thing this file could produce.
 *
 * Null rather than six falses, so a run written before this existed does not
 * read as a change on the next save read.
 */
function hyperOf(mon) {
  const h = mon.hyperTrained;
  return h && SNAP_IV_ORDER.some((k) => h[k]) ? h : null;
}

function snapshotFromMon(mon) {
  return {
    nature: mon.nature, ability: mon.ability,
    abilityIsHidden: mon.abilityIsHidden,
    heldItem: mon.heldItem, ot: mon.otName,
    ivs: ivsOf(mon),
    // Kept structured as well: anything computed from the IVs - Hidden
    // Power's type - should not have to re-parse the display string and
    // guess at its order.
    ivsByStat: mon.ivs,
    hyperTrained: hyperOf(mon),
    moves: mon.moves,
  };
}

function applyChange(c) {
  if (c.kind === 'new') {
    // The save does say where a Pokémon was met - a MAPSEC byte - so it is
    // filed automatically when that section holds exactly one encounter area
    // for its line and nothing has claimed it yet. Anything less certain stays
    // unfiled with the section named and the candidates kept: a guessed area
    // silently corrupts the dupes clause, so an ambiguous met location narrows
    // the choice rather than making it.
    const met = metInfo(c.mon.metLocation, c.mon.speciesConstant, c.mon.metLevel);
    const free = (met ? met.areas : []).filter((a) => !areaRecordId(a));
    const only = met && free.length === 1 ? free[0] : null;
    const id = only ? only.id : `save:${c.mon.key}`;
    const hatched = (met && met.kind === 'egg') || c.mon.metLevel === 0;
    RUN.encounters[id] = {
      areaId: id,
      area: only ? only.label
        : met ? `met at ${met.name} — pick an area`
          : 'from save — unassigned',
      metLocation: c.mon.metLocation,
      metLocationName: met ? met.name : null,
      metKind: met ? met.kind : null,
      metLevel: c.mon.metLevel,
      metAreaSource: only ? 'save' : null,
      metCandidates: only ? null : (met ? met.areas.map((a) => a.id) : []),
      status: c.mon.where === 'graveyard' ? 'fainted' : 'caught',
      placement: c.mon.where === 'graveyard' ? 'graveyard' : c.mon.where,
      species: c.mon.speciesConstant,
      speciesRaw: c.mon.displayName,
      nickname: c.mon.nickname,
      currentLevel: c.mon.level,
      // metLevel is the level it was caught at, straight from the cartridge;
      // a hatched Pokémon records 0 there, which is not a level.
      levelCaught: hatched ? null : c.mon.metLevel,
      hatched: !!hatched,
      boxNumber: c.mon.boxNumber,
      boxSlot: c.mon.slot,
      frags: c.mon.frags,
      fragsSource: 'save',
      saveKey: c.mon.key,
      snapshot: snapshotFromMon(c.mon),
      splitId: RUN.rules.splitId || null,
    };
    if (c.mon.where === 'graveyard') {
      RUN.encounters[id].deathSource = 'save';
      RUN.encounters[id].diedInSplit = RUN.rules.splitId || null;
    }
  } else {
    const rec = RUN.encounters[c.areaId];
    if (!rec) return;
    if (c.kind === 'death') {
      rec.status = 'fainted';
      rec.placement = 'graveyard';
      rec.deathSource = 'save';
      rec.boxNumber = c.mon.boxNumber;
      rec.boxSlot = c.mon.slot;
      rec.diedInSplit = rec.diedInSplit || RUN.rules.splitId || rec.splitId || null;
    } else if (c.kind === 'revive') {
      rec.placement = c.mon.where;
      rec.status = 'caught';
      rec.cause = null;
      rec.deathSource = null;
      rec.diedInSplit = null;
      rec.boxNumber = c.mon.boxNumber;
      rec.boxSlot = c.mon.slot;
    } else if (c.kind === 'placement') {
      rec.placement = c.mon.where;
      rec.boxNumber = c.mon.boxNumber;
      rec.boxSlot = c.mon.slot;
    } else if (c.kind === 'species') {
      rec.species = c.mon.speciesConstant;
      rec.speciesRaw = c.mon.displayName;
    } else if (c.kind === 'nickname') {
      rec.nickname = c.mon.nickname;
    } else if (c.kind === 'level') {
      rec.currentLevel = c.mon.level;
      if (c.mon.frags != null) { rec.frags = c.mon.frags; rec.fragsSource = 'save'; }
    } else if (c.kind === 'frags') {
      rec.frags = c.mon.frags;
      rec.fragsSource = 'save';
    } else if (c.kind === 'snapshot') {
      rec.snapshot = Object.assign({}, rec.snapshot, snapshotFromMon(c.mon));
    }
  }
}

/**
 * File the still-unfiled once more with what is known now.
 *
 * A record left waiting because its met section held several areas may be
 * decidable later: another catch has since taken the other area, or a newer
 * build narrows candidates by evolution line where the old one did not.
 */
function autoFileUnfiled() {
  const out = [];
  for (const [id, rec] of Object.entries(RUN.encounters)) {
    if (!Array.isArray(rec.metCandidates) || !rec.species) continue;
    const met = metInfo(rec.metLocation, rec.species, rec.metLevel);
    if (!met) continue;
    const free = met.areas.filter((a) => !areaRecordId(a));
    if (free.length !== 1) {
      rec.metCandidates = met.areas.map((a) => a.id);   // keep the narrowing
      continue;
    }
    const a = free[0];
    if (rec.metLevel === 0) { rec.hatched = true; rec.levelCaught = null; }
    if (refileRecord(id, a.id, { quiet: true, source: 'save' })) {
      out.push({ kind: 'filed', label: `${rec.nickname || rec.speciesRaw || '?'} filed under ${a.label}` });
    }
  }
  return out;
}

/**
 * The whole import, from bytes to receipt. progress.js calls this for the
 * watched file; the one-off picker calls it for a chosen file.
 */
function ingestSave(bytes, meta) {
  let result;
  try {
    result = parseSav(bytes, D.savelayout, D.monlayout);
  } catch (e) {
    result = { error: `could not read that save: ${e.message}` };
  }
  savResult = result;
  savMeta = Object.assign({ at: new Date().toISOString() }, meta || {});
  if (result.error) {
    savDiff = [];
    savApplied = [];
    renderSav();
    return { error: result.error, applied: 0, held: 0, changes: [] };
  }
  savDiff = buildSavDiff();
  const roster = autoApplySave();
  const filed = autoFileUnfiled();
  const progress = typeof applyProgressFromSave === 'function'
    ? applyProgressFromSave(result, savMeta) : [];
  savApplied = [...progress, ...roster, ...filed];
  syncDeaths();
  saveRun();
  // Everything downstream of the roster and the rules may have changed.
  renderAll();
  // And the team the calculator holds is now the wrong one.
  if (typeof sendTeamToCalc === 'function') {
    try { sendTeamToCalc({ quiet: true }); } catch { /* calc not open yet */ }
  }
  return { error: null, applied: savApplied.length, held: savDiff.length, changes: savApplied };
}

/* ── the settings side of the tab ─────────────────────────────────── */

function renderSavSettings() {
  const st = (typeof SYNC !== 'undefined' && SYNC.status) || null;
  const pathEl = $('#sav-path');
  const input = $('#sav-path-input');
  const browse = $('#sav-browse');
  const auto = $('#sav-auto');
  if (!pathEl) return;
  if (!st) {
    pathEl.textContent = 'Checking the save file…';
  } else if (!st.path) {
    pathEl.innerHTML = '<b>No save file set.</b> Point the tracker at the emulator\'s '
      + '<code>.sav</code> and the run will follow the game on its own.';
  } else {
    const when = st.mtime ? st.mtime.slice(0, 19).replace('T', ' ') + ' UTC' : '';
    pathEl.innerHTML = `<code>${esc(st.path)}</code><br>`
      + (st.exists
        ? `${(st.size / 1024).toFixed(0)} KB · written ${esc(when)}`
        : '<b>not found</b> — the file has moved, or the path is wrong')
      + (st.source === 'default' ? '<br>(the .sav beside the built ROM; set a path to change it)' : '');
  }
  if (input && document.activeElement !== input) input.value = (st && st.configured) || '';
  if (browse) {
    browse.disabled = !(st && st.browseAvailable);
    browse.title = st && st.browseAvailable ? '' : 'Available in the app window; type the path here instead';
  }
  if (auto && typeof SYNC !== 'undefined') auto.checked = !!SYNC.enabled;
  const status = $('#sav-status');
  if (status && typeof SYNC !== 'undefined') {
    const P = RUN.progress || {};
    status.textContent = SYNC.lastError
      ? `Problem: ${SYNC.lastError}`
      : P.syncedAt ? `Last read ${P.syncedAt.slice(0, 19).replace('T', ' ')}`
        + (P.saveManual ? ' (a file imported by hand)' : '')
        : 'Not read yet.';
  }
}

async function applySavPath(value) {
  const r = await fetch('api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sav_path: value }),
  });
  const j = await r.json();
  if (typeof SYNC !== 'undefined' && j.sav) SYNC.status = j.sav;
  if (typeof progressState === 'function') progressState().saveMtimeMs = null;   // force a read
  renderSavSettings();
  if (typeof syncTick === 'function') syncTick().catch(() => {});
  return j;
}

async function browseSavPath() {
  const r = await fetch('api/sav/browse', { method: 'POST' });
  const j = await r.json();
  if (j.error) { if (typeof SYNC !== 'undefined') SYNC.lastError = j.error; renderSavSettings(); return; }
  if (!j.available) {
    const note = $('#sav-status');
    if (note) note.textContent = 'The file picker needs the app window; type the path instead.';
    return;
  }
  if (j.picked) {
    if (typeof SYNC !== 'undefined' && j.sav) SYNC.status = j.sav;
    if (typeof progressState === 'function') progressState().saveMtimeMs = null;
    renderSavSettings();
    if (typeof syncTick === 'function') syncTick().catch(() => {});
  }
}

/* ── the receipt ──────────────────────────────────────────────────── */

function renderSav() {
  const main = $('#sav-main');
  if (!main) return;
  main.textContent = '';
  renderSavSettings();

  if (!savResult) {
    const box = el('div', 'empty');
    const st = (typeof SYNC !== 'undefined' && SYNC.status) || null;
    box.innerHTML = st && st.exists
      ? 'The save has not been read yet. It is read on its own a moment after the file changes.'
      : 'Press <b>Browse…</b> and choose the emulator\'s <b>.sav</b>, and the run will follow the game. '
        + 'Nothing is changed until it is read.';
    main.append(box);
    return;
  }
  if (savResult.error) {
    main.append(el('div', 'note', savResult.error));
    return;
  }

  const t = savResult.trainer;
  const sum = el('div', 'capsum');
  const cell = (n, label, cls) => {
    const c = el('div', `cs ${cls || ''}`);
    c.append(el('b', null, String(n)));
    c.append(el('span', null, label));
    return c;
  };
  const all = savRoster();
  const P = RUN.progress || {};
  sum.append(cell(savResult.partyCount, 'in party'));
  sum.append(cell(all.filter((m) => m.where === 'pc').length, 'living PC'));
  sum.append(cell(all.filter((m) => m.where === 'graveyard').length, 'graveyard', 'bad'));
  sum.append(cell(all.reduce((a, m) => a + (m.frags || 0), 0), 'total KOs'));
  sum.append(cell(savResult.levelCap ? savResult.levelCap.level : '—', 'level cap'));
  sum.append(cell(savResult.flags ? savResult.flags.badgeCount : '—', 'badges'));
  sum.append(cell(savResult.flags ? savResult.flags.trainersDefeated.length : '—', 'trainers beaten'));
  sum.append(cell(`${t.playTime.hours}h`, 'played'));
  main.append(sum);

  if (!savResult.levelCap) {
    main.append(el('div', 'note',
      'The level cap could not be located in this save. VAR_LEVEL_CAP is found by '
      + 'signature rather than by a fixed offset - global.h’s offset comments '
      + 'are wrong for this build - and a save from before the first cap is set '
      + 'reads 0, which is not distinctive enough to match on. Badges and beaten '
      + 'trainers are read from the same anchor, so they are unknown too.'));
  }

  const split = P.derivedSplitId ? (D.progression.splits || []).find((s) => s.id === P.derivedSplitId) : null;
  main.append(el('div', 'const',
    `${t.name} · ID ${t.trainerId} · save slot ${savResult.slot} · `
    + `${savResult.sectorsUsed} sectors · current box ${savResult.currentBox}`
    + (split ? ` · ${split.label}` : '')
    + (savMeta ? ` · read ${savMeta.at.slice(11, 19)}${savMeta.reason === 'launch' ? ' at launch' : savMeta.manual ? ' from a chosen file' : ''}` : '')));
  if (split && P.derivedSplitReasons?.length) {
    main.append(el('div', 'const', P.derivedSplitReasons.join(' · ')));
  }

  for (const w of savResult.warnings || []) main.append(el('div', 'note', w));

  // What the read already did. Reading is the instruction; this is the
  // receipt, not a queue of work.
  main.append(el('h3', null, savApplied.length
    ? `Recorded from this save — ${savApplied.length}`
    : 'Recorded from this save'));
  if (savApplied.length) {
    const list = el('div', 'applied');
    for (const c of savApplied) {
      const rowEl = el('div', 'ar');
      rowEl.append(el('span', 'pill', c.kind));
      const txt = el('span', null, c.label);
      if (c.detail) txt.title = c.detail;
      rowEl.append(txt);
      list.append(rowEl);
    }
    main.append(list);
  } else {
    main.append(el('div', 'const', 'The run already matched the save — nothing to change.'));
  }

  if (savDiff.length) {
    main.append(el('h3', null, `Needs your call — ${savDiff.length}`));
    for (const [i, c] of savDiff.entries()) {
      const card = el('div', 'area');
      const head = el('header');
      head.append(el('span', `st ${c.kind === 'death' ? 'dead' : c.kind === 'new' ? 'caught' : ''}`));
      head.append(el('span', 'nm', c.label));
      head.append(el('div', 'grow'));
      head.append(el('span', 'pill', c.kind));
      card.append(head);
      const body = el('div', 'body');
      body.append(el('div', 'const', c.detail));
      if (c.manual) {
        body.append(el('div', 'note',
          'This death was marked by hand in the app. The save has not seen the box '
          + 'move yet, so it is left alone unless you accept explicitly.'));
      }
      const row = el('div', 'entry');
      const yes = el('button', 'btn', 'Accept');
      yes.addEventListener('click', () => {
        applyChange(c);
        savDiff.splice(i, 1);
        syncDeaths(); saveRun();
        renderAll();
      });
      const no = el('button', 'btn ghost', 'Ignore');
      no.addEventListener('click', () => { savDiff.splice(i, 1); renderSav(); });
      row.append(yes, no);
      body.append(row);
      card.append(body);
      main.append(card);
    }
    // Only hand-marked-death conflicts reach here, and each one is a separate
    // judgement about a Pokemon, so there is no blanket Accept.
    if (savDiff.length > 1) {
      const allBtn = el('button', 'btn ghost');
      allBtn.textContent = `Accept all ${savDiff.length} anyway`;
      allBtn.addEventListener('click', () => {
        for (const c of savDiff) applyChange(c);
        savDiff = [];
        syncDeaths(); saveRun();
        renderAll();
      });
      main.append(allBtn);
    }
  }

  // Unfiled catches: the save said where they were met, but that section holds
  // more than one encounter area. The picker lives on the Encounters tab.
  const unfiled = Object.values(RUN.encounters).filter((r) => Array.isArray(r.metCandidates));
  if (unfiled.length) {
    const n = el('div', 'note');
    n.innerHTML = `<b>${unfiled.length}</b> caught Pokémon still need an encounter area picked - `
      + 'the section they were met in has more than one. They are listed at the top of '
      + 'the <b>Encounters</b> tab.';
    n.style.marginTop = '12px';
    main.append(n);
  }

  // What the save actually holds.
  main.append(el('h3', null, 'In the save'));
  const groups = [['party', 'Party'], ['pc', 'Living PC — boxes 1–3'],
    ['graveyard', 'Graveyard — boxes 13–14'], ['other', 'Other boxes (not tracked)']];
  for (const [role, label] of groups) {
    const rows = all.filter((m) => m.where === role);
    if (!rows.length) continue;
    const gh = el('div', 'split-head');
    gh.append(el('b', null, `${label} — ${rows.length}`));
    main.append(gh);
    const tb = el('table', 'grid');
    tb.innerHTML = '<tr><th>Pokémon</th><th>Lv</th><th>HP</th><th>Nature</th>'
      + '<th>Item</th><th>KOs</th><th>Box</th></tr>';
    for (const m of rows) {
      const tr = el('tr');
      const nameCell = el('td');
      if (m.speciesConstant) nameCell.append(spr(m.speciesConstant));
      nameCell.append(document.createTextNode(m.nickname && m.nickname !== m.displayName
        ? `${m.nickname} (${m.fullName})` : m.fullName));
      tr.append(nameCell);
      tr.append(el('td', 'mono', dash(m.level)));
      tr.append(el('td', 'mono', m.maxHP ? `${m.hp}/${m.maxHP}` : '—'));
      tr.append(el('td', null, dash(m.nature)));
      tr.append(el('td', null, dash(m.heldItem)));
      tr.append(el('td', 'mono', dash(m.frags)));
      tr.append(el('td', 'mono', m.boxNumber ? String(m.boxNumber) : '—'));
      tb.append(tr);
    }
    main.append(tb);
  }
}

function initSav() {
  const input = $('#sav-file');
  if (!input) return;
  $('#sav-pick').addEventListener('click', () => input.click());
  input.addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      ingestSave(fr.result, { path: f.name, manual: true, reason: 'manual' });
      $('#sav-status').textContent = savResult.error
        ? 'failed' : `${f.name} — slot ${savResult.slot}`;
    };
    fr.readAsArrayBuffer(f);
    input.value = '';
  });

  const browse = $('#sav-browse');
  if (browse) browse.addEventListener('click', () => { browseSavPath().catch(() => {}); });
  const apply = $('#sav-path-apply');
  const pathInput = $('#sav-path-input');
  if (apply && pathInput) {
    apply.addEventListener('click', () => { applySavPath(pathInput.value.trim()).catch(() => {}); });
    pathInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') apply.click(); });
  }
  const readNow = $('#sav-readnow');
  if (readNow) {
    readNow.addEventListener('click', () => {
      if (typeof syncNow === 'function') syncNow('manual').catch(() => {});
    });
  }
  const auto = $('#sav-auto');
  if (auto) auto.addEventListener('change', () => {
    if (typeof setSyncEnabled === 'function') setSyncEnabled(auto.checked);
  });
  renderSav();
}
window.initSav = initSav;
