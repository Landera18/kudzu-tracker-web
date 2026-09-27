/* The box — who is left, and who is not.
 *
 * Three sections: Party, Alive, Dead. It used to mirror the game's 14 boxes,
 * which read well and answered the wrong question: a Pokémon marked dead in the
 * app stayed sitting in Box 1, because the save had recorded a boxNumber and
 * that outranked its having died. Placement decides availability everywhere
 * else in the app, so it decides the layout here, and a death moves a Pokémon
 * to Dead the moment it is recorded.
 *
 * The real box number is still shown on a Pokémon's card - it is how you find
 * it in game - it just no longer shapes the screen.
 */
'use strict';

let boxSelected = null;

const BOX_COLS = 6;

/**
 * Every tracked Pokémon, grouped by whether it is alive.
 *
 * Deliberately NOT by which of the 14 boxes it sits in. Mirroring the real PC
 * meant a Pokémon you marked dead stayed in Box 1 - the save had recorded a
 * boxNumber, and grouping by that outranked the fact that it had died - so the
 * one thing the view exists to show, who is left, was the thing it got wrong.
 * Placement is what decides everything else in the app, so it decides here too,
 * and a death moves a Pokémon across on the spot.
 *
 * Which box a Pokémon is really in is still worth knowing, for finding it in
 * game; it is a fact on its card rather than the shape of the screen.
 */
function boxLayout() {
  const groups = { party: [], alive: [], dead: [] };
  for (const m of roster()) {
    const entry = { id: m.id, rec: m.rec, placement: m.placement };
    if (m.placement === 'graveyard') groups.dead.push(entry);
    else if (m.placement === 'party') groups.party.push(entry);
    else groups.alive.push(entry);
  }
  return groups;
}

/** Enough cells to hold them, rounded up to whole rows, never fewer than one. */
const gridRows = (n) => Math.max(1, Math.ceil(n / BOX_COLS)) * BOX_COLS;

/**
 * Hidden Power's type for a set of IVs.
 *
 * The ROM's own calculation, from GetBattlerType/EFFECT_HIDDEN_POWER in
 * src/battle_main.c: the low bit of each IV builds a 0-63 index, which is
 * scaled across the types flagged `isHiddenPowerType` in gTypesInfo. The list
 * is taken from typechart rather than written out here - it is 16 types in this
 * ROM, and both the count and the order come out of the data, so flagging
 * another type would move every result and this follows it.
 *
 * Integer division, as in the C. Returns null unless all six IVs are known:
 * a guessed IV flips a bit and names the wrong type with total confidence.
 */
function hiddenPowerType(ivs) {
  const list = (D.typechart && D.typechart.hiddenPowerTypes) || [];
  if (list.length < 2) return null;
  const v = ivValues(ivs, true);
  if (!v) return null;
  const bits = ((v[0] & 1) << 0) | ((v[1] & 1) << 1) | ((v[2] & 1) << 2)
    | ((v[5] & 1) << 3) | ((v[3] & 1) << 4) | ((v[4] & 1) << 5);
  return list[Math.floor(((list.length - 1) * bits) / 63)] || null;
}

function boxIcon(rec) {
  // spr() serves the extractor's own 32x32 icons from data/sprites/, which are
  // already cropped and palette-correct - and unlike reading the decomp, they
  // still exist in a frozen build.
  const wrap = el('div', 'pcicon');
  if (rec.species) wrap.append(spr(rec.species, 'icon'));
  else wrap.classList.add('noicon');
  return wrap;
}

function boxCell(entry) {
  const rec = entry.rec;
  const sp = D.byConst[rec.species];
  const name = (sp && sp.displayName) || rec.speciesRaw || '?';
  const cell = el('div', `pccell ${entry.placement}`);
  if (boxSelected === entry.id) cell.classList.add('on');

  cell.append(boxIcon(rec));
  const label = el('div', 'pcname', rec.nickname || name);
  cell.append(label);
  cell.append(el('div', 'pclv', rec.currentLevel ? `L${rec.currentLevel}` : ''));
  if (rec.frags) {
    const f = el('div', 'pcfrag', `${rec.frags} KO`);
    cell.append(f);
  }
  cell.title = `${rec.nickname ? `${rec.nickname} (${name})` : name}`
    + `${rec.currentLevel ? ` · L${rec.currentLevel}` : ''}`
    + `${rec.area ? ` · ${rec.area}` : ''}`;
  cell.addEventListener('click', () => {
    boxSelected = entry.id;
    renderBox();
  });
  return cell;
}

/**
 * A grid of cells, padded out to `capacity` with empty slots.
 *
 * Ordered by the slot the save recorded, so the party keeps the order you set
 * in game, but never POSITIONED by it: these sections are sized to fit their
 * occupants, and honouring a raw slot index would drop a Pokémon whose slot
 * sits past the end of a shorter grid.
 */
function boxGrid(entries, capacity) {
  const grid = el('div', 'pcgrid');
  const order = entries.slice().sort((a, b) => {
    const x = a.rec.boxSlot ?? Infinity;
    const y = b.rec.boxSlot ?? Infinity;
    return x - y;
  });
  const cells = Math.max(capacity, order.length);
  for (let i = 0; i < cells; i += 1) {
    grid.append(order[i] ? boxCell(order[i]) : el('div', 'pccell empty'));
  }
  return grid;
}

function renderBox() {
  const main = $('#box-main');
  if (!main || !D.species) return;
  main.textContent = '';

  const { party, alive, dead } = boxLayout();

  if (!roster().length) {
    main.append(el('div', 'empty',
      'Nothing caught yet. Catch something on the Encounters tab, or load a save.'));
    renderBoxDetail();
    return;
  }

  // (append() returns undefined, so each header is built before it is added
  // rather than chained onto the call.)
  const section = (id, title, role, entries, capacity) => {
    const head = el('div', `pchead ${role}`);
    head.id = `pchead-${id}`;
    head.append(el('b', null, title));
    head.append(el('div', 'grow'));
    head.append(el('span', 'sub', capacity ? `${entries.length}/${capacity}`
      : String(entries.length)));
    main.append(head);
    main.append(boxGrid(entries, capacity || gridRows(entries.length)));
  };

  section('party', 'Party', 'pc', party, 6);
  section('alive', 'Alive — in the PC', 'pc', alive, 0);
  if (dead.length) section('dead', 'Dead', 'graveyard', dead, 0);

  renderBoxRail(party, alive, dead);
  renderBoxDetail();
}

/** The sidebar census: three groups, and a jump to each. */
function renderBoxRail(party, alive, dead) {
  const rail = $('#box-rail');
  if (!rail) return;
  rail.textContent = '';

  const row = (label, count, role, id) => {
    const b = el('button', role + (count ? '' : ' vacant'));
    b.append(el('span', 'dot'));
    b.append(el('span', null, label));
    b.append(el('span', 'n', String(count)));
    if (count) {
      b.addEventListener('click', () => {
        const head = document.getElementById(`pchead-${id}`);
        if (head) head.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    } else {
      b.disabled = true;
    }
    rail.append(b);
  };

  row('Party', party.length, 'pc', 'party');
  row('Alive', alive.length, 'pc', 'alive');
  row('Dead', dead.length, 'graveyard', 'dead');
}

function renderBoxDetail() {
  const box = $('#box-detail');
  if (!box) return;
  box.textContent = '';
  const entry = boxSelected && RUN.encounters[boxSelected];
  if (!entry) {
    box.append(el('div', 'empty', 'Click a Pokémon.'));
    return;
  }
  const rec = entry;
  const sp = D.byConst[rec.species];
  const name = (sp && sp.displayName) || rec.speciesRaw || '?';

  const head = el('div', 'boxhead');
  if (rec.species) head.append(spr(rec.species, 'front'));
  const titles = el('div');
  titles.append(el('h2', null, rec.nickname ? `${rec.nickname}` : name));
  if (rec.nickname) titles.append(el('div', 'const', name));
  head.append(titles);
  box.append(head);
  if (sp) box.append(typeChips(sp.types));

  const place = placementOf(rec);
  const tags = el('div', 'chips');
  tags.style.marginTop = '8px';
  tags.append(el('span', `pill ${place === 'graveyard' ? 'bad' : 'good'}`,
    PLACEMENT_LABEL[place] || place || 'unplaced'));
  if (rec.boxNumber != null) tags.append(el('span', 'pill', `Box ${rec.boxNumber}`));
  if (rec.fragsSource === 'save') tags.append(el('span', 'pill', 'from save'));
  if (rec.deathSource === 'manual') {
    const p = el('span', 'pill warn', 'marked by hand');
    p.title = 'Recorded in the app, not read from a save. A later sync will not '
      + 'undo this on its own.';
    tags.append(p);
  }
  box.append(tags);

  // Kill and undo, here as well as on the Encounters tab: this is the screen
  // you are already looking at when something dies, and going to find the route
  // card it was caught on to record that is the reason it does not get recorded.
  const after = () => {
    syncDeaths();                     // rebuilds RUN.deaths and autosaves
    renderBox();
    if (typeof renderEnc === 'function') renderEnc();
    if (typeof renderCap === 'function') renderCap();
  };
  const actions = el('div', 'boxactions');
  if (isDeadRec(rec)) {
    const undo = el('button', 'btn ghost', 'Revive');
    undo.title = 'Put this Pokémon back in the party and clear its death';
    undo.addEventListener('click', () => {
      rec.status = 'caught';
      rec.placement = 'party';
      rec.cause = null;
      rec.diedInSplit = null;
      rec.deathSource = null;
      after();
    });
    actions.append(undo);
  } else {
    const why = el('input');
    why.type = 'text';
    why.placeholder = 'Cause (optional)';
    why.className = 'boxcause';
    // Enter in the box is the same as pressing the button.
    why.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') kill.click(); });
    const kill = el('button', 'btn danger', 'Mark dead');
    kill.title = 'Record this as dead now, whether or not you have moved it into '
      + 'boxes 13–14 in game';
    kill.addEventListener('click', () => {
      rec.status = 'fainted';
      rec.placement = 'graveyard';
      rec.deathSource = 'manual';
      rec.diedInSplit = RUN.rules.splitId || rec.splitId || null;
      const cause = why.value.trim();
      if (cause) rec.cause = cause;
      after();
    });
    actions.append(why);
    actions.append(kill);
  }
  box.append(actions);

  box.append(el('h3', null, 'Details'));
  const kv = el('dl', 'kv');
  const add = (k, v) => { kv.append(el('dt', null, k)); kv.append(el('dd', null, dash(v))); };
  const snap = rec.snapshot || {};
  add('Level', rec.currentLevel);
  add('Caught at', rec.levelCaught ? `L${rec.levelCaught}` : null);
  add('Where', rec.area);
  // The met location comes from the save itself, so it is shown even when it
  // was too coarse to file the Pokémon into a single encounter area.
  if (rec.metLocationName) {
    add('Met at', rec.metLocationName
      + (rec.metAreaSource === 'save' ? ' (filed from save)' : ''));
  }
  add('Nature', snap.nature);
  add('Ability', snap.ability
    ? snap.ability + (snap.abilityIsHidden ? ' (hidden)' : '')
    : null);
  add('Held item', snap.heldItem);
  add('IVs', snap.ivs);
  // Hidden Power's type is a fact about the IVs, so it belongs beside them.
  const hp = hiddenPowerType(snap.ivsByStat || snap.ivs);
  kv.append(el('dt', null, 'Hidden Power'));
  const hpCell = el('dd');
  if (hp) hpCell.append(typeChips([hp]));
  else hpCell.textContent = snap.ivs ? '—' : 'needs all six IVs';
  kv.append(hpCell);
  add('OT', snap.ot);
  add('KOs', rec.frags);
  if (isDeadRec(rec)) add('Cause of death', rec.cause);
  box.append(kv);

  if (sp) {
    box.append(el('h3', null, 'Base stats'));
    const st = el('div', 'stats');
    for (const [key, lbl] of [['hp', 'HP'], ['attack', 'Atk'], ['defense', 'Def'],
      ['spAttack', 'SpA'], ['spDefense', 'SpD'], ['speed', 'Spe']]) {
      const v = (sp.baseStats || {})[key];
      st.append(el('span', 'lbl', lbl));
      st.append(el('span', 'val', dash(v)));
      const w = el('div', 'barwrap');
      const b = el('div', 'bar');
      b.style.width = `${Math.min(100, (v / 200) * 100)}%`;
      b.style.background = v >= 130 ? '#7bd88f' : v >= 90 ? '#9fd06f'
        : v >= 60 ? '#dbc07a' : '#c47a7a';
      w.append(b);
      st.append(w);
    }
    box.append(st);
  }

  const moves = (snap.moves || []).filter(Boolean);
  if (moves.length) {
    box.append(el('h3', null, 'Moves'));
    const t = el('table', 'grid');
    t.innerHTML = '<tr><th>Move</th><th>Type</th><th>Cat</th><th>Pow</th></tr>';
    for (const mvName of moves) {
      const mv = D.moves.find((x) => x.displayName === mvName) || {};
      const tr = el('tr');
      tr.append(el('td', null, mvName));
      const tc = el('td');
      if (mv.type) tc.append(typeChips([mv.type]));
      tr.append(tc);
      tr.append(el('td', null, mv.category
        ? mv.category[0] + mv.category.slice(1).toLowerCase() : '—'));
      tr.append(el('td', 'mono', dash(mv.power || null)));
      t.append(tr);
    }
    box.append(t);
  }

  if (rec.notes) {
    box.append(el('h3', null, 'Notes'));
    const n = el('div', 'note');
    n.textContent = rec.notes;
    box.append(n);
  }

  const spends = (RUN.caps?.spends || []).filter((s) => s.monId === boxSelected);
  if (spends.length) {
    const totalCaps = spends.reduce((a, s) => a + (Number(s.cost) || 0), 0);
    const by = {};
    for (const s of spends) by[s.label] = (by[s.label] || 0) + 1;
    box.append(el('div', 'note',
      `${totalCaps} bottle cap${totalCaps === 1 ? '' : 's'} spent here — `
      + Object.entries(by).map(([k, n]) => `${n}× ${k}`).join(', ')));
  }

  if (sp) {
    const jump = el('a', 'jump', `Open ${name} in the Pokédex`);
    jump.addEventListener('click', () => { showTab('dex'); selectSpecies(sp.constant); });
    const wrap = el('div');
    wrap.style.marginTop = '14px';
    wrap.append(jump);
    box.append(wrap);
  }
}

function initBox() {
  renderBox();
}
window.initBox = initBox;
