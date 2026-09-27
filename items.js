/* Items — what the player can hold, and whether they have it.
 *
 * A nuzlocke is decided by held items as much as by levels, and "do I own a
 * Rocky Helmet yet, and if not where is one" used to mean opening the bag in
 * game and a spreadsheet beside it. This tab answers both from two datasets
 * and the save:
 *
 *   have      the BAG, read out of the save (sav.js readBag), plus whatever the
 *             living roster is holding, plus the PC's item storage. Nothing is
 *             ticked by hand unless no save is being followed.
 *   missing   every holdable item with a known source - a ground or hidden
 *             pickup, a gift, mart stock, a bottle-cap prize - placed in the
 *             split its map belongs to, so "what could I have by now" is a
 *             filter rather than a judgement.
 *
 * A pickup whose flag the save has set is marked taken, so an item that was
 * collected and then used up (a berry) reads as "taken - not in the bag"
 * instead of as something still lying on Route 9.
 *
 * The owned list is also what the damage calculator offers for the player's
 * side (calcBagPayload, below): its item picker only lists what is really in
 * the bag.
 */
'use strict';

const HOLD_KIND = { POCKET_HELD_ITEMS: 'held', POCKET_BERRIES: 'berry', POCKET_MEGA_STONES: 'mega' };
const HOLD_KIND_LABEL = { held: 'Held items', berry: 'Berries', mega: 'Mega Stones' };
const SOURCE_KIND_LABEL = {
  ground: 'on the ground', hidden: 'hidden', gift: 'gift', unflagged_gift: 'gift',
  dynamic_gift: 'gift (one of several)', underfoot: 'underfoot', berry_tree: 'berry tree',
  mart: 'mart', prize: 'bottle-cap prize',
};

let itemsMode = 'all';
let ITEMX = null;                 // the index, rebuilt whenever the datasets are

const itemNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Everything about the item table the tab needs, joined once. */
function itemIndex() {
  if (ITEMX && ITEMX.items === D.items && ITEMX.locs === D.itemlocations) return ITEMX;
  const byConst = {}; const byId = {}; const byName = {};
  for (const it of D.items || []) {
    byConst[it.constant] = it;
    if (it.id != null) byId[it.id] = it;
    if (it.displayName) byName[itemNorm(it.displayName)] = it;
  }
  const sources = {};
  const add = (constant, src) => {
    if (!constant || constant === 'ITEM_NONE' || !byConst[constant]) return;
    (sources[constant] ||= []).push(src);
  };
  const placeOf = (folder) => {
    const sp = D.splitOfMap[folder] || null;
    const m = D.mapByFolder ? D.mapByFolder[folder] : null;
    return {
      folder,
      label: (m && (m.displayLabel || m.folderDerivedName)) || folder || '',
      splitIndex: sp ? (sp.splitIndex ?? 998) : 998,
      splitId: sp ? sp.splitKey : null,
      splitLabel: sp ? sp.splitLabel : null,
      locationIndex: sp ? (sp.locationIndex ?? 0) : 0,
    };
  };
  for (const r of D.itemlocations || []) {
    const base = Object.assign({
      id: r.id, kind: r.kind, flagId: r.autoCheckable ? r.flagId : null, flag: r.flag,
      renewable: !!r.renewable, quantity: r.quantity, note: r.note || null,
      gate: r.gate || [], choice: false, price: null,
    }, placeOf(r.map));
    if (r.item) add(r.item, base);
    for (const c of r.possibleItems || []) add(c, Object.assign({}, base, { choice: true }));
    for (const s of r.stock || []) add(s.item, Object.assign({}, base, { price: s.price, flagId: null }));
  }
  // Bottle-cap prizes are bought in the Celadon prize room.
  const prizeRoom = 'CeladonCity_GameCorner_PrizeRoom_Frlg';
  for (const p of (D.bottlecaps && D.bottlecaps.prizes) || []) {
    add(p.item, Object.assign({
      id: `prize:${p.item}`, kind: 'prize', flagId: null, flag: null, renewable: true,
      quantity: 1, note: p.note || null, gate: [], choice: false, caps: p.price,
      capsDiscounted: p.discountedPrice ?? null,
    }, placeOf(prizeRoom)));
  }
  for (const list of Object.values(sources)) {
    list.sort((a, b) => a.splitIndex - b.splitIndex || a.locationIndex - b.locationIndex
      || a.label.localeCompare(b.label));
  }
  ITEMX = { items: D.items, locs: D.itemlocations, byConst, byId, byName, sources };
  return ITEMX;
}

const holdKindOf = (it) => (it ? HOLD_KIND[it.pocket] || null : null);
const hasBattleEffect = (it) => !!(it && it.holdEffect && it.holdEffect !== 'HOLD_EFFECT_NONE');

/* ── what the save says ───────────────────────────────────────────── */

/**
 * Fold one save read's bag into the run. Called from applyProgressFromSave.
 * The bag is only believed when it looks like a bag: the empty slots agree on
 * one key, and the items sit in the pockets the item table says they belong
 * to. A layout that drifted would otherwise fill this tab with confident junk.
 */
function applyBagFromSave(sav) {
  const bag = sav && sav.bag;
  if (!bag) return null;
  const X = itemIndex();
  const known = bag.slots.filter((s) => X.byId[s.itemId]);
  const inPlace = known.filter((s) => X.byId[s.itemId].pocket === s.pocket);
  const sane = bag.keyAgreed && known.length === bag.slots.length
    && (known.length === 0 || inPlace.length / known.length >= 0.9);
  if (!sane) {
    RUN.bag = Object.assign(RUN.bag || {}, {
      error: 'the bag in the save did not look like a bag (unknown items, or items in the '
        + 'wrong pockets), so it was not used - press Refresh data after a ROM rebuild',
      errorAt: new Date().toISOString(),
    });
    return null;
  }
  const items = {};
  for (const s of known) {
    const c = X.byId[s.itemId].constant;
    items[c] = (items[c] || 0) + (s.quantity == null ? 1 : s.quantity);
  }
  const pc = {};
  for (const s of bag.pcItems || []) {
    const it = X.byId[s.itemId];
    if (it) pc[it.constant] = (pc[it.constant] || 0) + (s.quantity || 1);
  }
  // Which pickups are already taken: the flag of every flagged item location.
  const taken = [];
  const isSet = sav.flags && sav.flags.isSet;
  if (isSet) {
    for (const r of D.itemlocations || []) {
      if (r.autoCheckable && r.flagId != null && isSet(r.flagId)) taken.push(r.id);
    }
  }
  const before = RUN.bag && RUN.bag.items ? Object.keys(RUN.bag.items) : null;
  const holdable = (list) => list.filter((c) => holdKindOf(X.byConst[c]));
  const gained = before ? holdable(Object.keys(items)).filter((c) => !before.includes(c)) : [];
  RUN.bag = { items, pc, taken, hasFlags: !!isSet, readAt: new Date().toISOString() };
  if (!gained.length) return null;
  const names = gained.map((c) => X.byConst[c].displayName);
  return {
    kind: 'items',
    label: `${gained.length} new held item${gained.length === 1 ? '' : 's'} in the bag`,
    detail: names.join(', '),
  };
}

/**
 * What the player owns right now: constant -> { qty, bag, pc, heldBy[], manual }.
 * Held items on the dead are not counted - they are in boxes 13-14 and, by the
 * rules of the run, out of play.
 */
function ownedItems() {
  const X = itemIndex();
  const out = new Map();
  const at = (c) => {
    if (!out.has(c)) out.set(c, { constant: c, bag: 0, pc: 0, heldBy: [], manual: false });
    return out.get(c);
  };
  for (const [c, n] of Object.entries((RUN.bag && RUN.bag.items) || {})) at(c).bag += n;
  for (const [c, n] of Object.entries((RUN.bag && RUN.bag.pc) || {})) at(c).pc += n;
  for (const m of roster()) {
    if (m.placement === 'graveyard') continue;
    const name = m.rec.snapshot && m.rec.snapshot.heldItem;
    const it = name ? X.byName[itemNorm(name)] : null;
    if (it) at(it.constant).heldBy.push(m.rec.nickname || D.byConst[m.rec.species]?.displayName || 'a Pokémon');
  }
  for (const [c, on] of Object.entries(RUN.itemsManual || {})) {
    if (on) at(c).manual = true;
    else if (out.has(c) && !out.get(c).bag && !out.get(c).pc && !out.get(c).heldBy.length) out.delete(c);
  }
  for (const o of out.values()) o.qty = o.bag + o.pc + o.heldBy.length;
  return out;
}

/** The owned, holdable items as the calculator wants them. */
function calcBagPayload() {
  const X = itemIndex();
  const items = [];
  for (const o of ownedItems().values()) {
    const it = X.byConst[o.constant];
    const kind = holdKindOf(it);
    if (!kind) continue;
    if (kind === 'berry' && !hasBattleEffect(it)) continue;
    items.push({
      name: it.displayName, constant: it.constant, kind,
      qty: o.qty || (o.manual ? 1 : 0), inBag: o.bag + o.pc, heldBy: o.heldBy,
      effect: (it.description || '').replace(/\s+/g, ' ').trim(),
    });
  }
  items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return {
    version: 1,
    at: new Date().toISOString(),
    run: RUN.name || null,
    fromSave: !!(RUN.bag && RUN.bag.readAt),
    items,
  };
}

const CALC_BAG_KEY = 'kudzu.calc.bag';
/** Hand the bag to the calculator. It listens for the storage event, so an
 *  open calculator updates without a reload. */
let lastCalcBag = null;
function stageCalcBag() {
  const payload = calcBagPayload();
  // Compared without the timestamp, so re-rendering the tab does not make the
  // calculator rebuild its picker for an unchanged bag.
  const sig = JSON.stringify(Object.assign({}, payload, { at: null }));
  if (sig === lastCalcBag) return;
  lastCalcBag = sig;
  try { localStorage.setItem(CALC_BAG_KEY, JSON.stringify(payload)); } catch { /* private mode */ }
}

/* ── the tab ──────────────────────────────────────────────────────── */

function currentSplitIndex() {
  const s = (D.progression?.splits || []).find((x) => x.id === RUN.rules.splitId);
  return s ? s.index : 0;
}

function sourceText(s) {
  const bits = [s.label];
  let how = SOURCE_KIND_LABEL[s.kind] || s.kind;
  if (s.kind === 'mart' && s.price != null) how += ` · ₽${s.price}`;
  if (s.kind === 'prize') how += ` · ${s.caps} cap${s.caps === 1 ? '' : 's'}`;
  if (s.choice) how += ' · a choice';
  bits.push(how);
  return bits.join(' — ');
}

function renderItems() {
  const main = $('#items-main');
  if (!main || !D.items || !D.itemlocations) return;
  main.textContent = '';
  const X = itemIndex();
  const owned = ownedItems();
  const taken = new Set((RUN.bag && RUN.bag.taken) || []);
  const hasFlags = !!(RUN.bag && RUN.bag.hasFlags);
  const q = $('#items-q').value.trim().toLowerCase();
  const kindF = $('#items-kind').value;
  const groupBy = $('#items-group').value;
  const reach = $('#items-reach').checked;
  const battleOnly = $('#items-battle').checked;
  const noSource = $('#items-nosource').checked;
  const curIdx = currentSplitIndex();

  const srcNote = $('#items-source');
  if (RUN.bag && RUN.bag.readAt) {
    srcNote.textContent = `Bag read from the save ${typeof ago === 'function' ? ago(RUN.bag.readAt) : ''}. `
      + 'Held items on the living team count as owned; the dead do not.';
  } else if (RUN.bag && RUN.bag.error) {
    srcNote.textContent = `Bag not used: ${RUN.bag.error}.`;
  } else {
    srcNote.textContent = 'No save has been read yet, so nothing is known about the bag. '
      + 'Tick items by hand, or point Run › Save file at the emulator\'s .sav.';
  }

  const rows = [];
  for (const it of D.items) {
    const kind = holdKindOf(it);
    if (!kind) continue;
    if (kindF && kind !== kindF) continue;
    const own = owned.get(it.constant) || null;
    const sources = X.sources[it.constant] || [];
    if (battleOnly && !hasBattleEffect(it) && !own) continue;
    if (!sources.length && !own && !noSource) continue;
    const first = sources[0] || null;
    const firstIdx = first ? first.splitIndex : 998;
    if (reach && !own && firstIdx > curIdx) continue;
    if (itemsMode === 'have' && !own) continue;
    if (itemsMode === 'missing' && own) continue;
    if (q) {
      const hay = `${it.displayName} ${it.description || ''} ${it.holdEffect || ''} `
        + sources.map((s) => `${s.label} ${s.splitLabel || ''}`).join(' ');
      if (!hay.toLowerCase().includes(q)) continue;
    }
    rows.push({ it, kind, own, sources, first, firstIdx });
  }

  const total = rows.length;
  const have = rows.filter((r) => r.own).length;
  $('#items-count').textContent = `${total} items · ${have} owned · ${total - have} missing`;

  // Summary tiles, always over the whole holdable set up to the current split.
  const sum = el('div', 'capsum');
  const tile = (n, label, cls, mode) => {
    const c = el('div', `cs link ${cls || ''}`);
    c.append(el('b', null, String(n)));
    c.append(el('span', null, label));
    c.addEventListener('click', () => setItemsMode(mode));
    return c;
  };
  let reachHave = 0; let reachMissing = 0; let later = 0;
  for (const it of D.items) {
    if (!holdKindOf(it) || !hasBattleEffect(it)) continue;
    const src = X.sources[it.constant] || [];
    const o = owned.get(it.constant);
    if (o) reachHave += 1;
    else if (src.length && src[0].splitIndex <= curIdx) reachMissing += 1;
    else if (src.length) later += 1;
  }
  sum.append(tile(reachHave, 'owned', 'good', 'have'));
  sum.append(tile(reachMissing, 'missing, reachable now', reachMissing ? 'warn' : '', 'missing'));
  sum.append(tile(later, 'in later splits', '', 'all'));
  main.append(sum);

  if (!rows.length) {
    main.append(el('div', 'empty', itemsMode === 'have'
      ? 'Nothing owned matches. The bag is read from the save - see the note on the left.'
      : 'Nothing matches these filters.'));
    return;
  }

  const keyOf = (r) => (groupBy === 'split'
    ? (r.first ? `${String(r.first.splitIndex).padStart(3, '0')}|${r.first.splitLabel || 'Unplaced'}` : '999|No known source')
    : `${['held', 'berry', 'mega'].indexOf(r.kind)}|${HOLD_KIND_LABEL[r.kind]}`);
  rows.sort((a, b) => keyOf(a).localeCompare(keyOf(b))
    || (groupBy === 'split' ? (a.first ? a.first.locationIndex : 0) - (b.first ? b.first.locationIndex : 0) : 0)
    || a.it.displayName.localeCompare(b.it.displayName));

  let last = null; let table = null;
  for (const r of rows) {
    const k = keyOf(r);
    if (k !== last) {
      last = k;
      const h = el('div', 'split-head');
      h.append(el('b', null, k.split('|')[1]));
      const inGroup = rows.filter((x) => keyOf(x) === k);
      h.append(el('span', 'sub', `${inGroup.filter((x) => x.own).length} of ${inGroup.length} owned`));
      main.append(h);
      table = el('table', 'grid items-grid');
      table.innerHTML = '<tr><th></th><th>Item</th><th>What it does</th><th>You have</th><th>Where to get it</th></tr>';
      main.append(table);
    }
    table.append(itemRow(r, taken, hasFlags, curIdx));
  }
  // Every path that changes what is owned - a save read, a run switch, a tick -
  // re-renders this tab, so this is the one place the calculator is told.
  stageCalcBag();
}

function itemRow(r, taken, hasFlags, curIdx) {
  const { it, own, sources } = r;
  const tr = el('tr', own ? 'own' : 'miss');

  const chk = el('td', 'chk-cell');
  const fromSave = !!(own && (own.bag || own.pc || own.heldBy.length));
  const box = el('input');
  box.type = 'checkbox';
  box.checked = !!own;
  // What the save says is not overridable by a tick; a tick is for runs with
  // no save to read, or an item the save has not caught up with yet.
  box.disabled = fromSave;
  box.title = fromSave ? 'Read from the save' : 'Tick to mark as owned by hand';
  box.addEventListener('change', () => {
    RUN.itemsManual ||= {};
    if (box.checked) RUN.itemsManual[it.constant] = true;
    else delete RUN.itemsManual[it.constant];
    saveRun();
    renderItems();
    stageCalcBag();
  });
  chk.append(box);
  tr.append(chk);

  const name = el('td', 'nm');
  name.append(el('b', null, it.displayName));
  tr.append(name);

  tr.append(el('td', 'desc', (it.description || '').replace(/\s+/g, ' ').trim()));

  const haveCell = el('td');
  if (own) {
    if (own.bag) haveCell.append(el('span', 'pill good', `bag ×${own.bag}`));
    if (own.pc) haveCell.append(el('span', 'pill good', `PC ×${own.pc}`));
    for (const who of own.heldBy) haveCell.append(el('span', 'pill', `held by ${who}`));
    if (own.manual && !fromSave) haveCell.append(el('span', 'pill', 'ticked by hand'));
  } else {
    haveCell.append(el('span', 'const', '—'));
  }
  tr.append(haveCell);

  const where = el('td', 'where');
  if (!sources.length) where.append(el('span', 'const', 'no source found in the map scripts'));
  const shown = sources.slice(0, 4);
  for (const s of shown) {
    const line = el('div', 'src');
    const wasTaken = s.flagId != null && taken.has(s.id);
    if (wasTaken) line.classList.add('taken');
    line.append(el('span', null, sourceText(s)));
    if (s.splitLabel) {
      const p = el('span', `pill ${s.splitIndex > curIdx ? '' : 'good'}`, s.splitLabel.replace(/ Split$/, ''));
      if (s.splitIndex > curIdx) p.title = 'A later split than the one the run is in';
      line.append(p);
    }
    if (wasTaken) {
      const p = el('span', 'pill', 'taken');
      p.title = 'The save has this pickup\'s flag set';
      line.append(p);
    } else if (hasFlags && s.flagId != null && !s.renewable && s.splitIndex <= curIdx) {
      line.append(el('span', 'pill warn', 'still there'));
    }
    if (typeof gauntletPill === 'function') {
      const gp = gauntletPill(s.folder);
      if (gp) line.append(gp);
    }
    where.append(line);
  }
  if (sources.length > shown.length) {
    const more = el('div', 'const', `+ ${sources.length - shown.length} more`);
    more.title = sources.slice(shown.length).map(sourceText).join('\n');
    where.append(more);
  }
  tr.append(where);
  return tr;
}

function setItemsMode(mode) {
  itemsMode = mode;
  $$('#items-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  renderItems();
}

function initItems() {
  $$('#items-mode button').forEach((b) => b.addEventListener('click', () => setItemsMode(b.dataset.mode)));
  for (const id of ['items-q', 'items-kind', 'items-group', 'items-reach', 'items-battle', 'items-nosource']) {
    const n = document.getElementById(id);
    if (n) n.addEventListener(n.type === 'search' ? 'input' : 'change', renderItems);
  }
  renderItems();
  stageCalcBag();
}
window.initItems = initItems;
