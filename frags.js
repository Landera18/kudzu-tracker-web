/* Frag board — KOs per Pokémon.
 *
 * The hack keeps a real counter: `killCount`, an 8-bit field in Pokémon
 * substruct 3 (byte 8, bits 20–27), incremented whenever that Pokémon faints an
 * opposing trainer's Pokémon and capped at 255. It is shown on the summary
 * screen, and `data/monlayout.json` carries the offsets computed from
 * `include/pokemon.h`, so save ingestion can read it without hardcoding
 * anything.
 *
 * Until that lands the number is typed in, which is why every figure here is
 * marked with where it came from. A frag count read from a save is truth; one
 * typed in is a memory.
 *
 * Loads after tracker.js and shares its globals.
 */
'use strict';

const fragOf = (rec) => Number(rec?.frags) || 0;

function fragRows() {
  return roster()
    .map((m) => ({
      ...m,
      frags: fragOf(m.rec),
      source: m.rec.fragsSource || (m.rec.frags != null ? 'manual' : null),
    }))
    .sort((a, b) => b.frags - a.frags
      || rosterLabel(a).localeCompare(rosterLabel(b)));
}

function fragTotals(rows) {
  const total = rows.reduce((a, m) => a + m.frags, 0);
  const alive = rows.filter((m) => m.placement !== 'graveyard');
  const dead = rows.filter((m) => m.placement === 'graveyard');
  return {
    total,
    alive: alive.reduce((a, m) => a + m.frags, 0),
    dead: dead.reduce((a, m) => a + m.frags, 0),
    top: rows[0] && rows[0].frags ? rows[0] : null,
    contributors: rows.filter((m) => m.frags > 0).length,
    trainerMons: (D.trainers?.partyMonCount) || null,
  };
}

function renderFrags() {
  const main = $('#frags-main');
  if (!main || !D.encounters) return;
  main.textContent = '';

  const rows = fragRows();
  const t = fragTotals(rows);

  const sum = el('div', 'capsum');
  const cell = (n, label, cls) => {
    const c = el('div', `cs ${cls || ''}`);
    c.append(el('b', null, String(n)));
    c.append(el('span', null, label));
    return c;
  };
  sum.append(cell(t.total, 'total KOs', t.total ? 'good' : ''));
  sum.append(cell(t.alive, 'by the living'));
  sum.append(cell(t.dead, 'by the fallen', t.dead ? 'bad' : ''));
  sum.append(cell(t.contributors, 'contributed'));
  if (t.top) sum.append(cell(t.top.frags, `top — ${rosterLabel(t.top)}`));
  main.append(sum);

  if (!rows.length) {
    main.append(el('div', 'empty', 'No Pokémon caught yet.'));
    return;
  }

  const table = el('table', 'grid');
  table.innerHTML = '<tr><th>#</th><th>Pokémon</th><th>KOs</th><th>Share</th>'
    + '<th>Where</th><th>Lv</th><th>Source</th></tr>';
  const max = Math.max(1, ...rows.map((m) => m.frags));

  for (const [i, m] of rows.entries()) {
    const tr = el('tr');
    tr.append(el('td', 'mono', String(i + 1)));

    const name = el('td');
    if (m.rec.species) name.append(spr(m.rec.species));
    name.append(document.createTextNode(rosterLabel(m)));
    if (m.placement === 'graveyard') {
      const p = el('span', 'pill bad', '†');
      p.style.marginLeft = '6px';
      name.append(p);
    }
    tr.append(name);

    // Editable until save ingestion can fill it in.
    const cell2 = el('td');
    const inp = el('input');
    inp.type = 'number'; inp.min = '0'; inp.max = '255';
    inp.style.width = '64px';
    inp.value = m.rec.frags ?? '';
    inp.addEventListener('change', () => {
      const v = inp.value === '' ? null : Math.max(0, Math.min(255, Number(inp.value)));
      m.rec.frags = v;
      m.rec.fragsSource = v == null ? null : 'manual';
      saveRun(); renderFrags();
    });
    cell2.append(inp);
    tr.append(cell2);

    const bar = el('td');
    const w = el('div', 'barwrap');
    w.style.minWidth = '110px';
    const b = el('div', 'bar');
    b.style.width = `${(m.frags / max) * 100}%`;
    b.style.background = m.placement === 'graveyard' ? '#e35d6a' : '#7bd88f';
    w.append(b); bar.append(w);
    tr.append(bar);

    tr.append(el('td', null, PLACEMENT_LABEL[m.placement] || '—'));
    tr.append(el('td', 'mono', dash(m.rec.currentLevel)));
    tr.append(el('td', 'const', m.frags ? (m.source === 'save' ? 'from save' : 'typed') : '—'));
    table.append(tr);
  }
  main.append(table);

  const kc = D.monlayout?.killCount;
  const n = el('div', 'note');
  n.style.marginTop = '14px';
  n.innerHTML = kc
    ? `The game already counts this. <b>killCount</b> is an ${kc.bitWidth}-bit field at `
      + `byte ${kc.byteOffset}, bits ${kc.bitOffset}–${kc.bitOffset + kc.bitWidth - 1} of `
      + `Pokémon substruct 3 (max ${kc.max}), incremented on every KO of an opposing `
      + "trainer's Pokémon and shown on the summary screen. Those offsets are computed "
      + 'from <code>include/pokemon.h</code> on every extraction, so save ingestion will '
      + 'read the real numbers rather than these typed ones.'
    : 'No killCount field found in this build — frags can only be typed in.';
  main.append(n);
}

function initFrags() {
  renderFrags();
}
window.initFrags = initFrags;
