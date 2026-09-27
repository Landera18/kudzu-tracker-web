/* Sandbox — edit a Pokémon in the save file.
 *
 * Two uses. Trying something out: a nature, a spread, a move the Pokémon could
 * not normally have. And repair: the ROM changed - a learnset, an ability slot,
 * a species' stats - and a Pokémon caught before the change cannot be brought
 * into line from inside the game.
 *
 * The rest of the tracker READS the save; this is the one place that writes
 * it, so it is deliberately slow to do so. An edit is prepared here and shown
 * as a list of changes, the file is re-read at the moment of writing, the new
 * bytes are verified twice (savwrite.js, then again by the server in Python),
 * the server refuses while the emulator has the file open, and the save as it
 * was is copied to sav_backups/ before every write - the list on the left puts
 * any of them back.
 *
 * It edits the Pokémon that are there. It does not add, delete or move them,
 * and it never changes the personality, so the run's record of a Pokémon
 * (keyed personality:otId) follows it through any edit made here.
 */
'use strict';

const SBX = {
  bytes: null, mtimeMs: null, parsed: null, error: null,
  sel: null,            // {where, box, slot, key}
  form: null, orig: null,
  armed: false, busy: false,
  message: null,        // {kind: 'good'|'bad'|'warn', text}
  backups: [], backupsDir: null, inUse: false,
  stale: { critical: [], learnsets: [] },
  loading: null,
};

const SBX_STATS = [['hp', 'HP'], ['attack', 'Atk'], ['defense', 'Def'],
  ['spAttack', 'SpA'], ['spDefense', 'SpD'], ['speed', 'Spe']];

/* ── lookups ──────────────────────────────────────────────────────── */

/** Datasets in the shape savwrite.js takes them. */
function sbxData() {
  const M = idMaps();
  return {
    speciesById: M.species, moveById: M.move, itemById: M.item, natureById: M.nature,
    experience: D.experience,
  };
}

/**
 * Names for the three typed pickers, unique in both directions.
 *
 * 82 names are shared by several species - "Garchomp" is also Garchomp's
 * Mega Z form, "Gastrodon" is both seas, "Rotom" is six appliances - and a
 * picker that cannot tell them apart writes the wrong id. The lowest id keeps
 * the plain name, which is the base form in every one of those groups, so
 * typing "Garchomp" means Garchomp; the others carry their constant.
 */
function sbxNames() {
  if (sbxNames._c) return sbxNames._c;
  const build = (rows, labelOf, skip) => {
    const kept = rows.filter((r) => r && r.id > 0 && !(skip && skip(r))).sort((a, b) => a.id - b.id);
    const taken = new Set();
    const byId = new Map(); const byLabel = new Map();
    for (const r of kept) {
      const base = labelOf(r);
      const label = taken.has(base.toLowerCase())
        ? `${base} · ${String(r.constant).replace(/^[A-Z]+_/, '')}` : base;
      taken.add(base.toLowerCase());
      byId.set(r.id, label);
      byLabel.set(label.toLowerCase(), r.id);
      byLabel.set(String(r.constant).toLowerCase(), r.id);
    }
    return { byId, byLabel, labels: [...byId.values()].sort((a, b) => a.localeCompare(b)) };
  };
  const placeholder = (r) => /^\?+$/.test(r.displayName || '') || !r.displayName;
  sbxNames._c = {
    species: build(D.species, (s) => s.fullName || s.displayName, (s) => s.constant === 'SPECIES_EGG'),
    item: build(D.items || [], (i) => i.displayName, placeholder),
    move: build(D.moves, (m) => m.displayName, placeholder),
  };
  return sbxNames._c;
}

/** Text typed into a picker -> id. '' and "(none)" are 0; unknown is null. */
function sbxResolve(kind, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t === '(none)' || t === 'none') return 0;
  const hit = sbxNames()[kind].byLabel.get(t);
  return hit == null ? null : hit;
}
const sbxLabel = (kind, id) => (id ? (sbxNames()[kind].byId.get(id) || `#${id}`) : '');

/** Why this species can have this move, or null when nothing says it can. */
function sbxMoveSource(sp, moveId) {
  const mv = idMaps().move.get(moveId);
  const ls = sp && D.learnsets && D.learnsets.species && D.learnsets.species[sp.constant];
  if (!mv || !ls) return null;
  const c = mv.constant;
  const lv = (ls.levelUp || []).filter((x) => x.move === c).map((x) => x.level);
  if (lv.length) return lv[0] === 0 ? 'on evolving' : `level ${Math.min(...lv)}`;
  if ((ls.tm || []).includes(c)) return 'TM';
  if ((ls.hm || []).includes(c)) return 'HM';
  if ((ls.tutor || []).includes(c)) return 'tutor';
  if ((ls.egg || []).includes(c)) return 'egg move';
  if ((D.learnsets.universalMoves || []).includes(c)) return 'universal';
  return null;
}

/* ── loading ──────────────────────────────────────────────────────── */

async function sbxFetchSave() {
  const r = await fetch('api/sav');
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `could not read the save (${r.status})`);
  }
  return { bytes: await r.arrayBuffer(), mtimeMs: Number(r.headers.get('X-Sav-Mtime-Ms')) || null };
}

async function sbxFetchBackups() {
  try {
    const j = await (await fetch('api/sav/backups')).json();
    SBX.backups = j.backups || [];
    SBX.backupsDir = j.dir || null;
    SBX.inUse = !!j.inUse;
  } catch { /* the list is a convenience; the write path asks again */ }
  await sbxFetchStale();
}

/**
 * Has the ROM source moved on since the datasets were extracted?
 *
 * Everywhere else in the tracker stale data is a wrong label. Here it is a
 * wrong byte: add one move to the ROM and every move id after it shifts, and
 * the id this tab would write is the old one. So a change to the files the
 * write depends on - struct layouts, the species/move/item enums, base stats,
 * growth curves, PP - blocks writing until Refresh data has been pressed.
 * Learnset changes only date the "level 24 / TM" hints, and only say so.
 */
async function sbxFetchStale() {
  try {
    const src = (await (await fetch('api/status')).json()).source || {};
    SBX.stale = { critical: src.changedCritical || [], learnsets: src.changedLearnsets || [] };
  } catch { /* keep what was known */ }
  return SBX.stale;
}

/** Every Pokémon in the parsed save, with where it sits. */
function sbxRoster() {
  const p = SBX.parsed;
  if (!p || p.error) return [];
  const out = p.party.map((m) => ({ where: 'party', box: null, slot: m.slot, mon: m }));
  for (const b of p.boxes) {
    for (const m of b.mons) out.push({ where: 'box', box: b.number, boxName: b.name, slot: m.slot, mon: m });
  }
  return out;
}
const sbxKey = (m) => `${m.personality}:${m.otId}`;
const sbxSame = (e, t) => !!t && e.where === t.where && e.slot === t.slot && (e.where === 'party' || e.box === t.box);

async function sbxLoad(opts) {
  if (SBX.loading) return SBX.loading;
  SBX.loading = (async () => {
    try {
      const got = await sbxFetchSave();
      SBX.bytes = got.bytes; SBX.mtimeMs = got.mtimeMs;
      SBX.parsed = parseSav(got.bytes, D.savelayout, D.monlayout);
      SBX.error = SBX.parsed.error || null;
    } catch (e) {
      SBX.bytes = null; SBX.parsed = null;
      SBX.error = String((e && e.message) || e);
    }
    await sbxFetchBackups();
    // Keep the selection if that Pokémon is still in that slot.
    const still = SBX.sel && sbxRoster().find((e) => sbxSame(e, SBX.sel) && sbxKey(e.mon) === SBX.sel.key);
    if (still) { if (!(opts && opts.keepForm)) sbxSelect(still, true); } else { SBX.sel = null; SBX.form = null; SBX.orig = null; }
    SBX.armed = false;
    renderSandbox();
  })();
  try { await SBX.loading; } finally { SBX.loading = null; }
  return null;
}

/* ── the form ─────────────────────────────────────────────────────── */

function sbxFormOf(entry) {
  const m = entry.mon;
  const sp = idMaps().species.get(m.speciesId);
  return {
    speciesId: m.speciesId,
    level: m.level ?? levelForExp(sp, m.experience, D.experience),
    natureId: m.natureId,
    abilityNum: m.abilityNum ?? 0,
    heldItemId: m.heldItemId || 0,
    ivs: Object.assign({}, m.ivs),
    moveIds: [0, 1, 2, 3].map((i) => m.moveIds[i] || 0),
  };
}

function sbxSelect(entry, quiet) {
  SBX.sel = { where: entry.where, box: entry.box, slot: entry.slot, key: sbxKey(entry.mon) };
  SBX.orig = sbxFormOf(entry);
  SBX.form = JSON.parse(JSON.stringify(SBX.orig));
  SBX.armed = false;
  if (!quiet) { SBX.message = null; renderSandbox(); }
}

/** {edit, lines, invalid}: what would be written, in words, and what blocks it. */
function sbxDiff() {
  const o = SBX.orig; const f = SBX.form;
  const edit = {}; const lines = []; const invalid = [];
  if (!o || !f) return { edit, lines, invalid };
  const M = idMaps();
  const spName = (id) => (M.species.get(id) ? (M.species.get(id).fullName || M.species.get(id).displayName) : `#${id}`);

  if (f.speciesId == null) invalid.push('species is not one the ROM has');
  else if (f.speciesId !== o.speciesId) { edit.speciesId = f.speciesId; lines.push(`Species: ${spName(o.speciesId)} → ${spName(f.speciesId)}`); }

  const max = (D.experience && D.experience.maxLevel) || 100;
  if (!(Number.isInteger(f.level) && f.level >= 1 && f.level <= max)) invalid.push(`level must be 1–${max}`);
  else if (f.level !== o.level) { edit.level = f.level; lines.push(`Level: ${o.level} → ${f.level}`); }

  if (f.natureId !== o.natureId) {
    edit.natureId = f.natureId;
    lines.push(`Nature: ${M.nature.get(o.natureId)?.displayName || '?'} → ${M.nature.get(f.natureId)?.displayName || '?'}`);
  }

  // The slot is what is stored, so the ability is compared as the game would
  // resolve it for the species on each side.
  const abOld = abilityForSlot(M.species.get(o.speciesId), o.abilityNum);
  const abNew = f.speciesId ? abilityForSlot(M.species.get(f.speciesId), f.abilityNum) : null;
  if (f.abilityNum !== o.abilityNum) edit.abilityNum = f.abilityNum;
  if ((abOld && abOld.constant) !== (abNew && abNew.constant) && abNew) {
    lines.push(`Ability: ${abOld ? abOld.displayName : '?'} → ${abNew.displayName}`);
  } else if (f.abilityNum !== o.abilityNum) {
    lines.push(`Ability slot: ${o.abilityNum + 1} → ${f.abilityNum + 1} (same ability)`);
  }

  if (f.heldItemId == null) invalid.push('held item is not one the ROM has');
  else if (f.heldItemId !== o.heldItemId) {
    edit.heldItemId = f.heldItemId;
    lines.push(`Held item: ${sbxLabel('item', o.heldItemId) || 'none'} → ${sbxLabel('item', f.heldItemId) || 'none'}`);
  }

  const ivBad = SBX_STATS.some(([k]) => !(Number.isInteger(f.ivs[k]) && f.ivs[k] >= 0 && f.ivs[k] <= 31));
  if (ivBad) invalid.push('IVs must be 0–31');
  else if (SBX_STATS.some(([k]) => f.ivs[k] !== o.ivs[k])) {
    edit.ivs = Object.assign({}, f.ivs);
    const show = (v) => SBX_STATS.map(([k]) => v[k]).join('/');
    lines.push(`IVs: ${show(o.ivs)} → ${show(f.ivs)}`);
  }

  if (f.moveIds.some((id) => id == null)) invalid.push('a move is not one the ROM has');
  else {
    const want = f.moveIds.filter((id) => id > 0);
    if (!want.length) invalid.push('at least one move is needed');
    if (new Set(want).size !== want.length) invalid.push('the same move is listed twice');
    const packed = [0, 1, 2, 3].map((i) => want[i] || 0);
    if (packed.some((id, i) => id !== o.moveIds[i])) {
      edit.moveIds = packed;
      const show = (ids) => ids.filter(Boolean).map((id) => sbxLabel('move', id)).join(', ') || 'none';
      lines.push(`Moves: ${show(o.moveIds)} → ${show(packed)}`);
    }
  }
  return { edit, lines, invalid };
}

/* ── writing ──────────────────────────────────────────────────────── */

function sbxLogEdit(report, lines, name) {
  if (typeof RUN === 'undefined' || !RUN) return;
  // Kept in the run file: a run that was edited should say so, and say how.
  (RUN.sandboxEdits ||= []).push({
    at: new Date().toISOString(), key: SBX.sel.key, name,
    where: SBX.sel.where === 'party' ? `party ${SBX.sel.slot + 1}` : `box ${SBX.sel.box} slot ${SBX.sel.slot + 1}`,
    changes: lines,
  });
  if (typeof saveRun === 'function') saveRun();
}

async function sbxWrite() {
  if (SBX.busy || !SBX.sel) return;
  const { edit, lines, invalid } = sbxDiff();
  if (invalid.length || !lines.length) return;
  SBX.busy = true; SBX.message = null; renderSandbox();
  const target = { where: SBX.sel.where, box: SBX.sel.box, slot: SBX.sel.slot };
  const entry = sbxRoster().find((e) => sbxSame(e, SBX.sel));
  const M = idMaps();
  const name = entry ? (entry.mon.nickname || M.species.get(entry.mon.speciesId)?.displayName || '?') : '?';
  try {
    const stale = await sbxFetchStale();
    if (stale.critical.length) {
      throw new Error('The ROM source changed since the datasets were extracted '
        + `(${stale.critical.slice(0, 3).join(', ')}). Press Refresh data, then write.`);
    }
    // The file as it is NOW, not as it was when the tab was opened: the edit is
    // re-applied to fresh bytes, and savwrite checks the same Pokémon is still
    // in that slot.
    const fresh = await sbxFetchSave();
    const res = applyMonEdit(fresh.bytes, D.savelayout, D.monlayout, sbxData(), target, SBX.sel.key, edit);
    if (res.error) throw new Error(res.error);
    const r = await fetch('api/sav/write', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Sav-Base-Mtime-Ms': String(fresh.mtimeMs || ''),
        'X-Sav-Note': encodeURIComponent(`${name}: ${lines.join('; ')}`.slice(0, 380)),
      },
      body: res.bytes,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      if (j.error === 'in-use') SBX.inUse = true;
      throw new Error(j.message || j.error || `the server refused the write (${r.status})`);
    }
    sbxLogEdit(res.report, lines, name);
    SBX.message = {
      kind: 'good',
      text: `Written: ${lines.length} change${lines.length === 1 ? '' : 's'} to ${name}, `
        + `${j.changedBytes} bytes of the save. The file as it was is kept as ${j.backup}.`
        + (res.report.notes.length ? ` Note: ${res.report.notes.join(' ')}` : ''),
    };
    // The run follows the save, so let it read the new one straight away.
    if (typeof syncNow === 'function') await syncNow('sandbox').catch(() => {});
    SBX.busy = false;
    await sbxLoad();
  } catch (e) {
    SBX.message = { kind: 'bad', text: String((e && e.message) || e) };
    await sbxFetchBackups();
  } finally {
    SBX.busy = false; SBX.armed = false;
    renderSandbox();
  }
}

async function sbxRestore(file) {
  if (SBX.busy) return;
  SBX.busy = true; SBX.message = null; renderSandbox();
  try {
    const r = await fetch('api/sav/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.message || j.error || `restore failed (${r.status})`);
    SBX.message = { kind: 'good', text: `Restored ${file}. The save it replaced was backed up first.` };
    if (typeof syncNow === 'function') await syncNow('sandbox').catch(() => {});
    SBX.busy = false;
    await sbxLoad();
  } catch (e) {
    SBX.message = { kind: 'bad', text: String((e && e.message) || e) };
  } finally {
    SBX.busy = false;
    renderSandbox();
  }
}

/* ── rendering ────────────────────────────────────────────────────── */

function renderSandboxAside() {
  const file = $('#sbx-file');
  if (file) {
    const st = (typeof SYNC !== 'undefined' && SYNC.status) || null;
    if (SBX.error) file.innerHTML = `<b>Cannot edit:</b> ${esc(SBX.error)}`;
    else if (!SBX.parsed) file.textContent = 'The save has not been loaded yet.';
    else {
      file.innerHTML = `<code>${esc((st && st.path) || 'save')}</code><br>`
        + `slot ${SBX.parsed.slot} · ${sbxRoster().length} Pokémon`
        + (SBX.inUse ? '<br><b class="sbx-warn">Open in another program</b> — close the game in the '
          + 'emulator before writing.' : '');
    }
  }
  const list = $('#sbx-backups');
  if (!list) return;
  list.textContent = '';
  if (!SBX.backups.length) {
    list.append(el('div', 'count', 'None yet. One is made before every write.'));
    return;
  }
  for (const b of SBX.backups.slice(0, 12)) {
    const row = el('div', 'sbx-backup');
    const when = String(b.at || '').slice(0, 16).replace('T', ' ');
    const txt = el('div', 'sbx-backup-t');
    txt.append(el('b', null, when));
    txt.append(el('span', null, b.note || (b.reason === 'before-restore' ? 'before a restore' : b.file)));
    txt.title = `${b.file}\n${b.note || ''}`;
    row.append(txt);
    const btn = el('button', 'btn ghost', 'Restore');
    btn.disabled = SBX.busy;
    btn.addEventListener('click', () => {
      if (btn.dataset.armed) { sbxRestore(b.file); return; }
      btn.dataset.armed = '1'; btn.textContent = 'Really?'; btn.classList.add('danger');
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Restore'; btn.classList.remove('danger'); } }, 4000);
    });
    row.append(btn);
    list.append(row);
  }
  if (SBX.backups.length > 12) list.append(el('div', 'count', `and ${SBX.backups.length - 12} older, in sav_backups/`));
}

function renderSandboxList() {
  const list = $('#sbx-list');
  if (!list) return;
  list.textContent = '';
  const q = (($('#sbx-q') || {}).value || '').trim().toLowerCase();
  const M = idMaps();
  const rows = sbxRoster().filter((e) => {
    if (!q) return true;
    const sp = M.species.get(e.mon.speciesId);
    return `${e.mon.nickname || ''} ${sp ? sp.fullName || sp.displayName : ''}`.toLowerCase().includes(q);
  });
  if (!rows.length) {
    list.append(el('div', 'empty', SBX.error ? 'No save to edit.' : SBX.parsed ? 'No Pokémon match.' : 'Loading…'));
    return;
  }
  let head = null;
  for (const e of rows) {
    const h = e.where === 'party' ? 'Party' : `Box ${e.box}${e.boxName ? ` · ${e.boxName}` : ''}`;
    if (h !== head) { head = h; list.append(el('div', 'line-head', h)); }
    const sp = M.species.get(e.mon.speciesId);
    const row = el('div', `row-item${sbxSame(e, SBX.sel) ? ' on' : ''}${e.mon.isEgg ? ' dim' : ''}`);
    if (sp) row.append(spr(sp.constant));
    const lv = e.mon.level ?? (sp ? levelForExp(sp, e.mon.experience, D.experience) : null);
    row.append(el('span', 'nm', e.mon.isEgg ? 'Egg' : (e.mon.nickname || (sp ? sp.displayName : `#${e.mon.speciesId}`))));
    row.append(el('span', 'sub', `${sp && e.mon.nickname !== sp.displayName ? `${sp.displayName} · ` : ''}L${lv ?? '?'}`));
    row.addEventListener('click', () => {
      if (SBX.busy) return;
      if (sbxSame(e, SBX.sel)) return;
      sbxSelect(e);
    });
    list.append(row);
  }
}

function sbxField(label, control, extra) {
  const f = el('label', 'f');
  f.append(el('span', null, label));
  f.append(control);
  if (extra) f.append(extra);
  return f;
}

function sbxPicker(kind, id, onPick) {
  const input = el('input');
  input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('list', `sbx-dl-${kind}`);
  input.value = sbxLabel(kind, id);
  input.placeholder = kind === 'species' ? 'species' : '(none)';
  input.addEventListener('input', () => {
    const got = sbxResolve(kind, input.value);
    input.classList.toggle('sbx-bad', got == null || (kind === 'species' && got === 0));
    onPick(kind === 'species' && got === 0 ? null : got);
  });
  return input;
}

function renderSandboxDetail() {
  const d = $('#sbx-detail');
  if (!d) return;
  d.textContent = '';
  if (SBX.message) d.append(el('div', `note sbx-msg ${SBX.message.kind}`, SBX.message.text));
  const entry = SBX.sel && sbxRoster().find((e) => sbxSame(e, SBX.sel));
  if (!entry || !SBX.form) {
    const box = el('div', 'empty');
    box.innerHTML = SBX.error ? esc(SBX.error)
      : 'Select a Pokémon to edit its <b>species, level, nature, ability, held item, IVs</b> and <b>moves</b>.';
    d.append(box);
    return;
  }
  const M = idMaps();
  const f = SBX.form; const o = SBX.orig; const mon = entry.mon;
  const spOld = M.species.get(o.speciesId);

  const head = el('div', 'sbx-head');
  if (spOld) head.append(spr(spOld.constant));
  const title = el('div');
  title.append(el('h2', null, mon.nickname || (spOld ? spOld.displayName : '?')));
  title.append(el('div', 'const',
    `${spOld ? spOld.fullName || spOld.displayName : `#${o.speciesId}`} · `
    + `${entry.where === 'party' ? `party slot ${entry.slot + 1}` : `box ${entry.box}, slot ${entry.slot + 1}`}`
    + ` · OT ${mon.otName || '?'} · ${mon.killCount ?? 0} KOs`));
  head.append(title);
  d.append(head);

  if (mon.isEgg) { d.append(el('div', 'note', 'Eggs are not edited.')); return; }
  if (!mon.checksumOk) { d.append(el('div', 'note', 'This Pokémon fails its own checksum (a Bad Egg) and is left alone.')); return; }

  // Typing never rebuilds the form - only what follows from it - so a field
  // keeps its focus and its caret.
  const redrawSoft = () => { renderSandboxSummary(); };
  const grid = el('div', 'sbx-grid');

  /* ability: the save stores a SLOT, so the choices are the slots of whichever
     species is in the form, and they are refilled when that changes. */
  const ab = el('select');
  const fillAbility = () => {
    const now = f.speciesId ? M.species.get(f.speciesId) : null;
    const slots = now ? [now.abilities?.primary, now.abilities?.secondary, now.abilities?.hidden] : [];
    const has = (s) => s && s.constant && s.constant !== 'ABILITY_NONE';
    ab.textContent = '';
    slots.forEach((s, i) => {
      if (!has(s) && i !== f.abilityNum) return;
      const shown = has(s) ? abilityName(s.constant)
        : `empty — plays as ${(abilityForSlot(now, i) || {}).displayName || '?'}`;
      const op = el('option', null, `${shown} · ${i === 2 ? 'hidden' : `slot ${i + 1}`}`);
      op.value = String(i); ab.append(op);
    });
    ab.value = String(f.abilityNum);
    ab.disabled = !now;
  };
  fillAbility();
  ab.addEventListener('change', () => { f.abilityNum = Number(ab.value); redrawSoft(); });

  /* species, level */
  grid.append(sbxField('Species', sbxPicker('species', f.speciesId, (id) => {
    f.speciesId = id; fillAbility(); redrawSoft();
  })));
  const lvl = el('input'); lvl.type = 'number'; lvl.min = '1'; lvl.max = String((D.experience && D.experience.maxLevel) || 100);
  lvl.value = String(f.level ?? '');
  lvl.addEventListener('input', () => { f.level = lvl.value === '' ? null : Number(lvl.value); redrawSoft(); });
  grid.append(sbxField('Level', lvl));

  /* nature */
  const nat = el('select');
  for (const n of D.natures) {
    const tag = n.neutral ? 'neutral'
      : `+${SBX_STATS.find(([k]) => n.modifiers[k] > 1)?.[1]} −${SBX_STATS.find(([k]) => n.modifiers[k] < 1)?.[1]}`;
    const op = el('option', null, `${n.displayName} (${tag})`);
    op.value = String(n.id); nat.append(op);
  }
  nat.value = String(f.natureId);
  nat.addEventListener('change', () => { f.natureId = Number(nat.value); redrawSoft(); });
  grid.append(sbxField('Nature', nat));

  grid.append(sbxField('Ability', ab));

  /* held item */
  grid.append(sbxField('Held item', sbxPicker('item', f.heldItemId, (id) => { f.heldItemId = id; redrawSoft(); })));
  d.append(grid);

  /* IVs */
  d.append(el('h3', null, 'IVs'));
  const ivRow = el('div', 'sbx-ivs');
  const ivInputs = {};
  for (const [k, label] of SBX_STATS) {
    const cell = el('label', 'sbx-iv');
    cell.append(el('span', null, label));
    const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.max = '31';
    inp.value = String(f.ivs[k]);
    inp.addEventListener('input', () => { f.ivs[k] = inp.value === '' ? null : Number(inp.value); redrawSoft(); });
    ivInputs[k] = inp;
    cell.append(inp);
    ivRow.append(cell);
  }
  d.append(ivRow);
  const ivBtns = el('div', 'row sbx-ivbtns');
  for (const [txt, val] of [['All 31', 31], ['All 0', 0]]) {
    const b = el('button', 'btn ghost', txt);
    b.addEventListener('click', () => {
      for (const [k] of SBX_STATS) { f.ivs[k] = val; ivInputs[k].value = String(val); }
      redrawSoft();
    });
    ivBtns.append(b);
  }
  const back = el('button', 'btn ghost', 'As caught');
  back.addEventListener('click', () => {
    for (const [k] of SBX_STATS) { f.ivs[k] = o.ivs[k]; ivInputs[k].value = String(o.ivs[k]); }
    redrawSoft();
  });
  ivBtns.append(back);
  ivBtns.append(el('span', 'const sbx-hp'));
  d.append(ivBtns);

  /* moves */
  d.append(el('h3', null, 'Moves'));
  const moves = el('div', 'sbx-moves');
  for (let i = 0; i < 4; i += 1) {
    const row = el('div', 'sbx-move');
    row.append(sbxPicker('move', f.moveIds[i], (id) => { f.moveIds[i] = id; redrawSoft(); }));
    row.append(el('span', 'pill sbx-src'));
    moves.append(row);
  }
  d.append(moves);

  d.append(el('div', 'sbx-summary'));
  renderSandboxSummary();
}

/** The parts that follow the form: move sources, stats, the change list, the
    buttons. Separate so typing in a field never rebuilds the field. */
function renderSandboxSummary() {
  const d = $('#sbx-detail');
  const box = d && $('.sbx-summary', d);
  if (!box || !SBX.form) return;
  const M = idMaps();
  const f = SBX.form; const o = SBX.orig;
  const entry = sbxRoster().find((e) => sbxSame(e, SBX.sel));
  if (!entry) return;
  const sp = f.speciesId ? M.species.get(f.speciesId) : null;
  const spOld = M.species.get(o.speciesId);

  /* where each move comes from, for the species being written */
  $$('.sbx-move', d).forEach((row, i) => {
    const pill = $('.sbx-src', row);
    const id = f.moveIds[i];
    pill.className = 'pill sbx-src';
    if (!id) { pill.textContent = id === 0 ? '—' : 'unknown'; if (id == null) pill.classList.add('bad'); return; }
    const src = sp ? sbxMoveSource(sp, id) : null;
    const mv = M.move.get(id);
    pill.textContent = src || 'not in its learnset';
    pill.title = mv ? `${typeName(mv.type)} · ${mv.category} · ${mv.power || '—'} BP · ${mv.pp} PP` : '';
    pill.classList.add(src ? 'good' : 'warn');
  });

  const hpNote = $('.sbx-hp', d);
  if (hpNote) {
    const ok = SBX_STATS.every(([k]) => Number.isInteger(f.ivs[k]));
    const t = ok && typeof hiddenPowerType === 'function' ? hiddenPowerType(f.ivs) : null;
    hpNote.textContent = t ? `Hidden Power / Tera Blast: ${typeName(t)}` : '';
  }

  box.textContent = '';
  const { lines, invalid } = sbxDiff();

  /* stats, before and after */
  const natOld = M.nature.get(o.natureId); const natNew = M.nature.get(f.natureId);
  const ivsOk = SBX_STATS.every(([k]) => Number.isInteger(f.ivs[k]) && f.ivs[k] >= 0 && f.ivs[k] <= 31);
  const lvOk = Number.isInteger(f.level) && f.level >= 1 && f.level <= 100;
  if (spOld) {
    const was = calcMonStats(spOld, o.level, o.ivs, entry.mon.evs, entry.mon.hyperTrained, natOld);
    const now = sp && ivsOk && lvOk ? calcMonStats(sp, f.level, f.ivs, entry.mon.evs, entry.mon.hyperTrained, natNew) : null;
    box.append(el('h3', null, 'Stats'));
    const tb = el('table', 'grid sbx-stats');
    tb.innerHTML = '<tr><th></th><th>Base</th><th>IV</th><th>Now</th><th>After</th><th></th></tr>';
    for (const [k, label] of SBX_STATS) {
      const tr = el('tr');
      tr.append(el('td', null, label));
      tr.append(el('td', 'mono', sp ? String(sp.baseStats[k]) : '—'));
      tr.append(el('td', 'mono', entry.mon.hyperTrained[k] ? `${f.ivs[k]} (HT)` : String(f.ivs[k] ?? '—')));
      tr.append(el('td', 'mono', String(was[k])));
      tr.append(el('td', 'mono', now ? String(now[k]) : '—'));
      const delta = now ? now[k] - was[k] : 0;
      tr.append(el('td', `mono ${delta > 0 ? 'sbx-up' : delta < 0 ? 'sbx-down' : ''}`, delta ? `${delta > 0 ? '+' : ''}${delta}` : ''));
      tb.append(tr);
    }
    box.append(tb);
    if (entry.where !== 'party') {
      box.append(el('div', 'const', 'A boxed Pokémon stores no stats; the game computes these when it is withdrawn.'));
    }
  }

  /* what will be written */
  box.append(el('h3', null, lines.length ? `Changes — ${lines.length}` : 'Changes'));
  if (!lines.length && !invalid.length) box.append(el('div', 'const', 'Nothing changed yet.'));
  for (const l of lines) box.append(el('div', 'sbx-change', l));
  for (const l of invalid) box.append(el('div', 'sbx-change bad', l));
  if (lines.some((l) => l.startsWith('Species'))) {
    box.append(el('div', 'note',
      'Changing species keeps the level (the experience is set to that level on the new '
      + 'species\' growth curve), the ability SLOT, the moves and the nickname. A Pokémon '
      + 'with no nickname takes the new species\' name. The run\'s record follows it.'));
  }
  if (lines.some((l) => l.startsWith('Nature'))) {
    box.append(el('div', 'note',
      'Written the way a mint is: the stats follow the new nature; the summary screen\'s '
      + 'memo still names the one it was caught with.'));
  }

  const blocked = SBX.stale.critical.length > 0;
  if (blocked) {
    const n = el('div', 'note sbx-msg bad');
    n.innerHTML = '<b>Refresh data before writing.</b> The ROM source changed since the datasets '
      + 'were extracted, in files this tab writes from: '
      + `<code>${SBX.stale.critical.slice(0, 4).map(esc).join('</code>, <code>')}</code>`
      + (SBX.stale.critical.length > 4 ? ` and ${SBX.stale.critical.length - 4} more` : '')
      + '. If an id or a struct moved, the wrong species, move or item would be written.';
    box.append(n);
  } else if (SBX.stale.learnsets.length) {
    box.append(el('div', 'const',
      'Learnsets changed in the ROM source since the datasets were extracted, so the '
      + '"level N / TM" hints beside the moves may be out of date. Refresh data to update '
      + 'them; writing is not affected.'));
  }

  const actions = el('div', 'row sbx-actions');
  const can = lines.length && !invalid.length && !SBX.busy && !blocked;
  if (!SBX.armed) {
    const w = el('button', 'btn', SBX.busy ? 'Writing…' : 'Write to the save…');
    w.disabled = !can;
    w.addEventListener('click', () => { SBX.armed = true; renderSandboxSummary(); });
    const r = el('button', 'btn ghost', 'Reset');
    r.disabled = !lines.length && !invalid.length;
    r.addEventListener('click', () => { SBX.form = JSON.parse(JSON.stringify(SBX.orig)); SBX.armed = false; renderSandboxDetail(); });
    actions.append(w, r);
  } else {
    const yes = el('button', 'btn danger', 'Confirm — rewrite the save');
    yes.disabled = !can;
    yes.addEventListener('click', () => { sbxWrite().catch(() => {}); });
    const no = el('button', 'btn ghost', 'Cancel');
    no.addEventListener('click', () => { SBX.armed = false; renderSandboxSummary(); });
    actions.append(yes, no);
  }
  box.append(actions);
  if (SBX.armed) {
    box.append(el('div', 'note',
      'The game must not be running this save: save in game and close it in the emulator '
      + 'first, then load it again after the write. The file as it is now is copied to '
      + 'sav_backups/ before anything is changed.'));
  }
}

function renderSandbox() {
  if (!$('#tab-sandbox')) return;
  renderSandboxAside();
  renderSandboxList();
  renderSandboxDetail();
}

/** Called with every re-render of the app, which follows every save read. */
function sandboxFollowSave() {
  const tab = $('#tab-sandbox');
  if (!tab || !tab.classList.contains('on') || SBX.busy) return;
  const st = (typeof SYNC !== 'undefined' && SYNC.status) || null;
  if (!st || st.mtimeMs == null || st.mtimeMs === SBX.mtimeMs) return;
  // The save moved on underneath the form. With nothing typed the list simply
  // follows it; with an edit in progress the form is kept, and writing re-reads
  // the file anyway.
  const dirty = sbxDiff().lines.length > 0;
  sbxLoad({ keepForm: dirty }).catch(() => {});
}

function initSandbox() {
  if (!$('#tab-sandbox')) return;
  const fill = (id, labels) => {
    const dl = document.getElementById(id);
    if (!dl) return;
    dl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const l of labels) { const o = document.createElement('option'); o.value = l; frag.append(o); }
    dl.append(frag);
  };
  const N = sbxNames();
  fill('sbx-dl-species', N.species.labels);
  fill('sbx-dl-item', ['(none)', ...N.item.labels]);
  fill('sbx-dl-move', ['(none)', ...N.move.labels]);

  const btn = $('#tabs button[data-tab="sandbox"]');
  if (btn) btn.addEventListener('click', () => { sbxLoad().catch(() => {}); });
  const reload = $('#sbx-reload');
  if (reload) reload.addEventListener('click', () => { SBX.message = null; sbxLoad().catch(() => {}); });
  const q = $('#sbx-q');
  if (q) q.addEventListener('input', renderSandboxList);
  renderSandbox();
}
window.initSandbox = initSandbox;
window.renderSandbox = renderSandbox;
