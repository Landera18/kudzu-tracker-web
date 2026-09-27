/* Run management, and what you can learn from all your runs at once.
 *
 * One run is one file: runs/<name>.json. The run you are playing is written
 * there continuously (tracker.js autosaves on every change), so there is no
 * separate "Save" step and nothing to forget. Every write keeps a rolling
 * backup in runs/backups/, and a run can be restored from any of them here.
 * New starts a fresh file; Load switches to another; Export / Import move a
 * run as a file.
 *
 * The aggregate view is the part worth having: across every run you have
 * saved, what keeps killing you, which species you keep reaching for, and how
 * far you usually get.
 */
'use strict';

let runList = [];
let runDocs = {};        // name -> full document, loaded on demand
let runsMode = 'manage';
let runBackupsOpen = null;   // name whose backups are listed
let runBackups = [];

async function fetchRunList() {
  try {
    const r = await (await fetch('api/runs')).json();
    runList = r.runs || [];
  } catch { runList = []; }
}

async function fetchAllRuns() {
  runDocs = {};
  await Promise.all(runList.map(async (r) => {
    try {
      const doc = await (await fetch(`api/run/${encodeURIComponent(r.name)}`)).json();
      if (!doc.error) runDocs[r.name] = doc;
    } catch { /* skip an unreadable run rather than failing the whole view */ }
  }));
}

const currentRunName = () => RUN.name || 'run1';

/* A name that will be the file name, minus anything that cannot be. */
const cleanRunName = (s) => String(s || '').replace(/[^\w \-]+/g, '').trim().slice(0, 64);

async function startNewRun(name, ending) {
  // The run being left goes to disk first, and is waited for: the debounced
  // autosave would otherwise fire after RUN points at the new run, and the
  // last edits of the old one - its ending included - would never be written.
  const left = RUN;
  let previous = null;
  if (typeof runHasProgress === 'function' && runHasProgress(left)) {
    if (ending) left.ending = ending;
    clearTimeout(autosaveTimer);
    autosavePending = false;
    await writeRunNow(left);
    previous = { name: left.name, ending: left.ending || null };
  }
  RUN = newRun();                       // tracker.js's factory
  RUN.name = name;
  RUN.previous = previous;
  RUN.fingerprint = D.manifestFingerprint || null;
  RUN.hackVersion = D.hackVersion ? D.hackVersion.string : null;
  if ((D.progression.splits || []).length) RUN.rules.splitId = D.progression.splits[0].id;
  syncRulesToUI();
  // Deliberately blank, so this is the one write allowed to create an empty
  // run file. Everything else goes through the guarded path.
  await markRunReplaced();
  saveRun();
  renderAll();
  await refreshRuns();
  // A new run's progress comes from the save straight away.
  if (typeof progressState === 'function') progressState().saveMtimeMs = null;
  if (typeof syncTick === 'function') syncTick().catch(() => {});
}

async function loadRunNamed(name) {
  const doc = await (await fetch(`api/run/${encodeURIComponent(name)}`)).json();
  if (doc.error) { $('#runs-status').textContent = `could not load ${name}`; return; }
  // Flush the run being left first, so switching never loses its last edits.
  if (typeof flushAutosave === 'function') flushAutosave();
  adoptRun(doc);
  syncRulesToUI();
  saveRun();
  renderAll();
  await refreshRuns();
  $('#runs-status').textContent = `switched to ${name}`;
  if (typeof progressState === 'function') progressState().saveMtimeMs = null;
  if (typeof syncTick === 'function') syncTick().catch(() => {});
}

async function renameRun(to) {
  const from = currentRunName();
  const name = cleanRunName(to);
  if (!name || name === from) return;
  const r = await fetch(`api/run/${encodeURIComponent(from)}/rename`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: name }),
  });
  const j = await r.json();
  if (!j.ok) { $('#runs-status').textContent = `rename failed: ${j.error || r.status}`; return; }
  RUN.name = j.name;
  saveRun();
  renderAll();
  await refreshRuns();
  $('#runs-status').textContent = `renamed to ${j.name}`;
}

async function deleteRunNamed(name) {
  await fetch(`api/run/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (name === currentRunName()) {
    // The file under the open run is gone; the next autosave recreates it,
    // which is the right thing - deleting the run you are on is not a reset.
    $('#runs-status').textContent = `deleted ${name}; it will be written again on the next change`;
  }
  await refreshRuns();
}

async function fetchBackups(name) {
  try {
    const r = await (await fetch(`api/run/${encodeURIComponent(name)}/backups`)).json();
    runBackups = r.backups || [];
  } catch { runBackups = []; }
}

async function restoreBackup(name, file) {
  const r = await fetch(`api/run/${encodeURIComponent(name)}/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  const j = await r.json();
  if (!j.ok) { $('#runs-status').textContent = `restore failed: ${j.error || r.status}`; return; }
  if (name === currentRunName() && j.run) {
    adoptRun(j.run);
    syncRulesToUI();
    saveRun();
    renderAll();
  }
  runBackupsOpen = null;
  await refreshRuns();
  $('#runs-status').textContent = `restored ${name} from ${file}`;
}

/* ── export / import: a run as a file you can hand to someone ─────── */

function exportRun() {
  const blob = new Blob([JSON.stringify(RUN, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${RUN.name || 'run'}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importRun(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const doc = JSON.parse(fr.result);
      if (!doc || typeof doc !== 'object' || !doc.encounters) throw new Error('not a run file');
      if (typeof flushAutosave === 'function') flushAutosave();
      adoptRun(doc);
      // An imported run keeps its own name unless that would overwrite the
      // run being played.
      if (RUN.name === currentRunName()) RUN.name = cleanRunName(file.name.replace(/\.json$/i, '')) || RUN.name;
      syncRulesToUI(); saveRun(); renderAll();
      refreshRuns();
      $('#runs-status').textContent = `imported ${file.name} as ${RUN.name}`;
    } catch (e) {
      $('#runs-status').textContent = `import failed: ${e.message}`;
    }
  };
  fr.readAsText(file);
}

/* ── aggregate stats ──────────────────────────────────────────────── */

function aggregate() {
  const docs = Object.values(runDocs);
  const byLine = new Map();
  const endings = new Map();
  const causes = new Map();
  const killers = new Map();
  const perRun = [];

  for (const doc of docs) {
    const encs = Object.values(doc.encounters || {});
    const deaths = doc.deaths || [];
    const caught = encs.filter((r) => r.species
      && ['caught', 'gift', 'fainted', 'dead'].includes(r.status));

    for (const r of caught) {
      const line = D.byConst[r.species]?.lineId || r.species;
      const e = byLine.get(line) || { line, used: 0, died: 0 };
      e.used += 1;
      if (deaths.some((d) => d.areaId === r.areaId)) e.died += 1;
      byLine.set(line, e);
    }
    for (const d of deaths) {
      const c = (d.cause || 'unrecorded').trim().toLowerCase();
      causes.set(c, (causes.get(c) || 0) + 1);
      const sp = d.species ? (D.byConst[d.species]?.displayName || d.species)
        : (d.speciesRaw || 'unknown');
      killers.set(sp, (killers.get(sp) || 0) + 1);
    }

    const splitsDone = Object.values(doc.splits || {}).filter((s) => s.exitedAt).length;
    if (doc.ending) {
      const e = doc.ending;
      const key = e.outcome === 'won' ? 'Won' : (e.trainerName || (e.splitLabel ? `somewhere in the ${e.splitLabel}` : 'unrecorded'));
      const cur = endings.get(key) || { key, n: 0, outcome: e.outcome, splitLabel: e.splitLabel, causes: [] };
      cur.n += 1;
      if (e.cause) cur.causes.push(e.cause);
      endings.set(key, cur);
    }
    perRun.push({
      name: doc.name,
      ending: doc.ending || null,
      caught: caught.length,
      deaths: deaths.length,
      splitsDone,
      furthest: splitsDone,
      caps: (doc.caps?.spends || []).reduce((a, s) => a + (Number(s.cost) || 0), 0),
      fingerprint: doc.fingerprint,
    });
  }

  return {
    runs: docs.length,
    perRun: perRun.sort((a, b) => b.splitsDone - a.splitsDone || a.deaths - b.deaths),
    lines: [...byLine.values()].sort((a, b) => b.used - a.used),
    endings: [...endings.values()].sort((a, b) => b.n - a.n),
    causes: [...causes.entries()].sort((a, b) => b[1] - a[1]),
    lost: [...killers.entries()].sort((a, b) => b[1] - a[1]),
    totalDeaths: perRun.reduce((a, r) => a + r.deaths, 0),
    totalCaught: perRun.reduce((a, r) => a + r.caught, 0),
  };
}

function renderRuns() {
  const main = $('#runs-main');
  if (!main) return;
  main.textContent = '';

  if (runsMode === 'stats') return renderRunStats(main);

  main.append(el('h3', null, `Runs — ${runList.length}`));
  if (!runList.length) {
    main.append(el('div', 'empty', 'No run files yet. The run you are playing is written on its first change.'));
  } else {
    const t = el('table', 'grid');
    t.innerHTML = '<tr><th>Run</th><th>Caught</th><th>Deaths</th><th>How it ended</th><th>Saved</th>'
      + '<th>Dataset</th><th></th></tr>';
    for (const r of runList) {
      const tr = el('tr');
      const nameCell = el('td');
      nameCell.append(document.createTextNode(r.name));
      if (r.name === currentRunName()) {
        const p = el('span', 'pill good', 'playing');
        p.style.marginLeft = '6px';
        nameCell.append(p);
      }
      tr.append(nameCell);
      tr.append(el('td', 'mono', String(r.encounters)));
      tr.append(el('td', 'mono', String(r.deaths)));
      const endCell = el('td', 'ending-cell');
      const ending = r.name === currentRunName() ? (RUN.ending || null) : (r.ending || null);
      if (ending) {
        endCell.append(el('span', `pill ${ending.outcome === 'won' ? 'good' : ending.outcome === 'wiped' ? 'bad' : 'warn'}`,
          ENDING_LABEL[ending.outcome] || ending.outcome));
        const txt = endingSummary(ending).slice((ENDING_LABEL[ending.outcome] || ending.outcome || 'ended').length).trim();
        endCell.append(el('span', 'const', txt));
        endCell.title = endingSummary(ending) + (ending.lesson ? `\nNext time: ${ending.lesson}` : '');
      } else if (r.name === currentRunName()) {
        endCell.append(el('span', 'const', 'in progress'));
      } else {
        endCell.append(el('span', 'const', '—'));
      }
      let endingBtn = null;
      if (r.name === currentRunName() && runHasProgress(RUN)) {
        const eb = el('button', 'btn ghost', ending ? 'Edit ending' : 'Record ending');
        endingBtn = eb;
        eb.title = 'Record how this run ended without starting a new one';
        eb.addEventListener('click', async () => {
          const res = await askRunEnding(RUN, { standalone: true });
          if (res === 'cancel') return;
          if (res) RUN.ending = res; else delete RUN.ending;
          saveRun();
          renderRuns();
          if (typeof renderHome === 'function') renderHome();
        });
      }
      tr.append(endCell);
      tr.append(el('td', 'const', (r.savedAt || '').slice(0, 16).replace('T', ' ')));

      // A run created against different data may not line up with what is
      // loaded now, so say when they differ rather than quietly mixing them.
      const fp = el('td', 'const');
      if (r.fingerprint && D.manifestFingerprint && r.fingerprint !== D.manifestFingerprint) {
        const p = el('span', 'pill warn', 'older dataset');
        p.title = `Created against ${r.fingerprint}; current data is ${D.manifestFingerprint}`;
        fp.append(p);
      } else {
        fp.append(document.createTextNode('current'));
      }
      tr.append(fp);

      const act = el('td', 'actions');
      if (endingBtn) act.append(endingBtn);
      if (r.name !== currentRunName()) {
        const load = el('button', 'btn ghost', 'Switch to');
        load.addEventListener('click', () => loadRunNamed(r.name));
        act.append(load);
      }
      const bk = el('button', 'btn ghost', r.backups ? `Backups (${r.backups})` : 'Backups');
      bk.style.marginLeft = '5px';
      bk.disabled = !r.backups;
      bk.addEventListener('click', async () => {
        runBackupsOpen = runBackupsOpen === r.name ? null : r.name;
        if (runBackupsOpen) await fetchBackups(r.name);
        renderRuns();
      });
      act.append(bk);
      const del = el('button', 'btn ghost', 'Delete');
      del.style.marginLeft = '5px';
      del.addEventListener('click', () => {
        if (del.textContent === 'Delete') { del.textContent = 'Sure?'; return; }
        deleteRunNamed(r.name);
      });
      act.append(del);
      tr.append(act);
      t.append(tr);

      if (runBackupsOpen === r.name) {
        const brow = el('tr');
        const cell = el('td');
        cell.colSpan = 7;
        if (!runBackups.length) cell.append(el('div', 'const', 'no backups yet'));
        else {
          const list = el('div', 'backups');
          for (const b of runBackups) {
            const line = el('div', 'ar');
            line.append(el('span', 'const', (b.savedAt || '').slice(0, 19).replace('T', ' ')));
            line.append(el('span', null, `${b.encounters} caught · ${b.deaths} dead`));
            const rb = el('button', 'btn ghost', 'Restore');
            rb.addEventListener('click', () => {
              if (rb.textContent === 'Restore') { rb.textContent = 'Replace the run?'; return; }
              restoreBackup(r.name, b.file);
            });
            line.append(rb);
            list.append(line);
          }
          cell.append(list);
        }
        brow.append(cell);
        t.append(brow);
      }
    }
    main.append(t);
  }

  main.append(el('div', 'const',
    'Runs are kept in this browser, saved on every change. A backup is kept every '
    + 'ten minutes of play, and whenever a write would shrink the run. Export makes '
    + 'a file you can keep or send on; Import brings one back.'));
}

function renderRunStats(main) {
  const a = aggregate();
  if (!a.runs) {
    main.append(el('div', 'empty', 'No runs to compare yet.'));
    return;
  }

  const sum = el('div', 'capsum');
  const cell = (n, label, cls) => {
    const c = el('div', `cs ${cls || ''}`);
    c.append(el('b', null, String(n)));
    c.append(el('span', null, label));
    return c;
  };
  sum.append(cell(a.runs, 'runs'));
  sum.append(cell(a.totalCaught, 'caught'));
  sum.append(cell(a.totalDeaths, 'deaths', a.totalDeaths ? 'bad' : ''));
  sum.append(cell(a.runs ? (a.totalDeaths / a.runs).toFixed(1) : 0, 'deaths / run'));
  sum.append(cell(a.perRun[0] ? a.perRun[0].splitsDone : 0, 'furthest split'));
  main.append(sum);

  main.append(el('h3', null, 'Runs'));
  const t = el('table', 'grid');
  t.innerHTML = '<tr><th>Run</th><th>Splits done</th><th>Caught</th><th>Deaths</th>'
    + '<th>Caps spent</th><th>How it ended</th></tr>';
  for (const r of a.perRun) {
    const tr = el('tr');
    tr.append(el('td', null, r.name));
    tr.append(el('td', 'mono', String(r.splitsDone)));
    tr.append(el('td', 'mono', String(r.caught)));
    tr.append(el('td', 'mono', String(r.deaths)));
    tr.append(el('td', 'mono', String(r.caps)));
    tr.append(el('td', 'const', r.ending ? endingSummary(r.ending) : '—'));
    t.append(tr);
  }
  main.append(t);

  if (a.endings.length) {
    main.append(el('h3', null, 'What keeps ending runs'));
    const et = el('table', 'grid');
    et.innerHTML = '<tr><th>Ended by</th><th>Split</th><th>Runs</th><th>What went wrong</th></tr>';
    for (const e of a.endings) {
      const tr = el('tr');
      tr.append(el('td', null, e.key));
      tr.append(el('td', 'const', e.splitLabel || ''));
      tr.append(el('td', 'mono', String(e.n)));
      tr.append(el('td', 'const', e.causes.join(' · ')));
      et.append(tr);
    }
    main.append(et);
  }

  main.append(el('h3', null, 'Species you keep reaching for'));
  const lt = el('table', 'grid');
  lt.innerHTML = '<tr><th>Evolution line</th><th>Runs used</th><th>Died</th><th>Survival</th></tr>';
  for (const l of a.lines.slice(0, 15)) {
    const tr = el('tr');
    tr.append(el('td', null, D.byConst[l.line]?.displayName || pretty(l.line)));
    tr.append(el('td', 'mono', String(l.used)));
    tr.append(el('td', 'mono', String(l.died)));
    const rate = l.used ? Math.round(((l.used - l.died) / l.used) * 100) : 0;
    const c = el('td');
    c.append(el('span', `pill ${rate >= 70 ? 'good' : rate >= 40 ? 'warn' : 'bad'}`, `${rate}%`));
    tr.append(c);
    lt.append(tr);
  }
  main.append(lt);

  main.append(el('h3', null, 'What keeps killing you'));
  const ct = el('table', 'grid');
  ct.innerHTML = '<tr><th>Cause</th><th>Deaths</th></tr>';
  for (const [cause, n] of a.causes.slice(0, 12)) {
    const tr = el('tr');
    tr.append(el('td', null, cause));
    tr.append(el('td', 'mono', String(n)));
    ct.append(tr);
  }
  main.append(ct);

  main.append(el('h3', null, 'Most-lost Pokémon'));
  const kt = el('table', 'grid');
  kt.innerHTML = '<tr><th>Pokémon</th><th>Times lost</th></tr>';
  for (const [sp, n] of a.lost.slice(0, 12)) {
    const tr = el('tr');
    tr.append(el('td', null, sp));
    tr.append(el('td', 'mono', String(n)));
    kt.append(tr);
  }
  main.append(kt);
}

async function refreshRuns() {
  await fetchRunList();
  if (runsMode === 'stats') await fetchAllRuns();
  renderRuns();
  const nm = $('#runs-name');
  if (nm && document.activeElement !== nm) nm.value = currentRunName();
}

async function initRuns() {
  $$('#runs-mode button').forEach((b) => b.addEventListener('click', async () => {
    runsMode = b.dataset.mode;
    $$('#runs-mode button').forEach((x) => x.classList.toggle('on', x === b));
    if (runsMode === 'stats') { await fetchAllRuns(); }
    renderRuns();
  }));

  $('#runs-new').addEventListener('click', () => {
    const name = cleanRunName($('#runs-name').value);
    if (!name) { $('#runs-status').textContent = 'give the new run a name first'; return; }
    if (name === currentRunName()) { $('#runs-status').textContent = 'that is the run you are playing; pick another name'; return; }
    if (runList.some((r) => r.name === name)) { $('#runs-status').textContent = `a run called ${name} exists - switch to it instead`; return; }
    if ($('#runs-new').textContent === 'New run') {
      $('#runs-new').textContent = `Start "${name}"?`;
      return;
    }
    $('#runs-new').textContent = 'New run';
    // The run being left is over (or parked): ask how it ended while it is
    // still fresh. Nothing to ask of a run with nothing in it.
    (async () => {
      let ending = null;
      if (typeof askRunEnding === 'function' && runHasProgress(RUN)) {
        ending = await askRunEnding(RUN);
        if (ending === 'cancel') { $('#runs-status').textContent = 'new run cancelled'; return; }
      }
      await startNewRun(name, ending);
      $('#runs-status').textContent = ending
        ? `started ${name}; ${RUN.previous ? RUN.previous.name : 'the last run'} recorded as ${endingSummary(ending)}`
        : `started ${name}`;
    })();
  });
  $('#runs-name').addEventListener('input', () => { $('#runs-new').textContent = 'New run'; });
  $('#runs-rename').addEventListener('click', () => {
    const name = cleanRunName($('#runs-name').value);
    if (!name || name === currentRunName()) { $('#runs-status').textContent = 'type a new name for the run you are playing'; return; }
    renameRun(name);
  });
  $('#runs-export').addEventListener('click', exportRun);
  $('#runs-import').addEventListener('click', () => $('#runs-file').click());
  $('#runs-file').addEventListener('change', (ev) => {
    if (ev.target.files[0]) importRun(ev.target.files[0]);
    ev.target.value = '';
  });

  $('#runs-name').value = currentRunName();
  await refreshRuns();
}
window.initRuns = initRuns;
