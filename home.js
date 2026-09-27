/* Home — the run at a glance.
 *
 * The first thing on screen when a run is in progress: where the run is, what
 * is next, who is alive and who is over the cap, what still needs filing, and
 * whether the data and the save are current. Everything here is drawn from
 * state the other tabs own; this tab owns nothing and only points at them.
 *
 * Loads after the tabs it reads from (tracker, progress, splits, box, caps).
 */
'use strict';

function homeGo(tab, fn) {
  showTab(tab);
  if (typeof fn === 'function') fn();
}

function renderHome() {
  const main = $('#home-main');
  if (!main || !D.progression) return;
  main.textContent = '';
  const P = RUN.progress || {};
  const all = roster();
  const alive = all.filter((m) => m.placement !== 'graveyard');
  const party = alive.filter((m) => m.placement === 'party');
  const dead = all.filter((m) => m.placement === 'graveyard');
  const { cap } = capInfo();
  const split = (D.progression.splits || []).find((s) => s.id === RUN.rules.splitId) || null;
  const over = alive.filter((m) => cap && Number(m.rec.currentLevel) > cap);
  const unfiled = Object.values(RUN.encounters).filter((r) => Array.isArray(r.metCandidates));

  // ── where the run is ──
  const top = el('div', 'homehead');
  const title = el('div');
  title.append(el('h2', null, RUN.name || 'run'));
  const line = [];
  line.push(split ? split.label : 'no split');
  line.push(cap ? `cap ${cap}` : 'cap unknown');
  if (P.badgeCount != null) line.push(`${P.badgeCount} badge${P.badgeCount === 1 ? '' : 's'}`);
  if (P.playTime) line.push(`${P.playTime.hours}h played`);
  title.append(el('div', 'const', line.join(' · ')));
  top.append(title);
  top.append(el('div', 'grow'));
  const saveState = el('div', 'hint');
  if (typeof SYNC !== 'undefined' && SYNC.status && !SYNC.status.exists) {
    saveState.innerHTML = '<b>No save is being followed.</b> Set it under Run › Save file.';
  } else if (P.syncedAt) {
    saveState.textContent = `save read ${ago(P.syncedAt)}`;
  } else {
    saveState.textContent = 'save not read yet';
  }
  top.append(saveState);
  main.append(top);

  // ── numbers ──
  const sum = el('div', 'capsum');
  const cell = (n, label, cls, go) => {
    const c = el('div', `cs ${cls || ''}${go ? ' link' : ''}`);
    c.append(el('b', null, String(n)));
    c.append(el('span', null, label));
    if (go) c.addEventListener('click', go);
    return c;
  };
  sum.append(cell(party.length, 'in party', '', () => homeGo('box')));
  sum.append(cell(alive.length - party.length, 'in the PC', '', () => homeGo('box')));
  sum.append(cell(dead.length, 'dead', dead.length ? 'bad' : 'good', () => homeGo('enc', () => setEncMode('grave'))));
  if (over.length) sum.append(cell(over.length, 'over the cap', 'bad', () => homeGo('box')));
  if (typeof capTotals === 'function' && D.bottlecaps) {
    const t = capTotals();
    sum.append(cell(t.inHand, 'caps in hand', t.inHand < 0 ? 'bad' : '', () => homeGo('caps')));
  }
  if (unfiled.length) sum.append(cell(unfiled.length, 'need an area', 'warn', () => homeGo('enc')));
  // A catch with no area is work waiting on the Encounters page; say so on the
  // section that holds it, whatever page is open.
  if (typeof navFlag === 'function') navFlag('route', 'unfiled', unfiled.length > 0);
  main.append(sum);

  // ── what ended the last run, while this one is young enough to use it ──
  if (typeof previousRunCard === 'function') {
    const last = previousRunCard();
    if (last) main.append(last);
  }

  if (!all.length) {
    const box = el('div', 'empty');
    box.innerHTML = 'Nothing caught yet. Point <b>Run › Save file</b> at the emulator\'s .sav and the '
      + 'run fills itself in; or record catches on the <b>Encounters</b> tab.';
    main.append(box);
  }

  // ── next fight ──
  const next = typeof nextBossFight === 'function' ? nextBossFight() : null;
  main.append(el('h3', null, 'Next boss fight'));
  if (next) {
    const wrap = el('div', 'bosses');
    wrap.append(bossRow(next, { next: true }));
    main.append(wrap);
    const t = next.trainer;
    const lv = (t.party || []).map((m) => m.level).filter((x) => x != null);
    const ready = lv.length && party.length
      ? `Their strongest is L${Math.max(...lv)}; your party is L${Math.min(...party.map((m) => Number(m.rec.currentLevel) || 0))}–L${Math.max(...party.map((m) => Number(m.rec.currentLevel) || 0))}.`
      : '';
    if (ready) main.append(el('div', 'const', ready));
  } else {
    main.append(el('div', 'const', 'Every boss fight is beaten.'));
  }

  // ── party ──
  main.append(el('h3', null, `Party — ${party.length}/6`));
  if (party.length) {
    const grid = el('div', 'pcgrid home');
    const order = party.slice().sort((a, b) => (a.rec.boxSlot ?? 99) - (b.rec.boxSlot ?? 99));
    for (const m of order) {
      const c = boxCell({ id: m.id, rec: m.rec, placement: m.placement });
      if (cap && Number(m.rec.currentLevel) > cap) c.classList.add('overcap');
      // boxCell's own click selects it; here that should also open the Box, where
      // Mark dead is - recording a death from the Overview is then two clicks.
      c.addEventListener('click', () => showTab('box'));
      grid.append(c);
    }
    for (let i = order.length; i < 6; i += 1) grid.append(el('div', 'pccell empty'));
    main.append(grid);
    if (over.length) {
      main.append(el('div', 'note', `Over the cap: ${over.map((m) => `${rosterLabel(m)} L${m.rec.currentLevel}`).join(', ')}`));
    }
  } else if (all.length) {
    main.append(el('div', 'const', 'The save shows no party. Read it again once you have Pokémon out.'));
  }

  // ── this split ──
  if (split) {
    main.append(el('h3', null, `${split.label} — what is left`));
    const areas = AREAS.filter((a) => a.split === split.id && !areaRecord(a));
    const bosses = typeof bossesForSplit === 'function' ? bosesSafe(split.id) : [];
    const left = bosses.filter((b) => !b.defeated);
    const bits = el('div', 'homesplit');
    const enc = el('div');
    enc.append(el('b', null, `${areas.length} encounter${areas.length === 1 ? '' : 's'} not yet taken`));
    if (areas.length) {
      const name = (a) => a.label + (a.entry.kind !== 'wild' ? ` (${a.entry.kind})` : '');
      const list = el('div', 'const', areas.slice(0, 10).map(name).join(' · ')
        + (areas.length > 10 ? ` · +${areas.length - 10} more` : ''));
      enc.append(list);
    }
    const go = el('a', 'jump', 'Open the tracker for this split');
    go.addEventListener('click', () => homeGo('enc', () => {
      $('#enc-split').value = split.id;
      setEncMode('tracker');
    }));
    enc.append(go);
    bits.append(enc);
    const bs = el('div');
    bs.append(el('b', null, `${left.length} boss fight${left.length === 1 ? '' : 's'} to go`
      + (bosses.length ? ` of ${bosses.length}` : '')));
    if (left.length) bs.append(el('div', 'const', left.map((b) => b.trainer.name).join(' · ')));
    const go2 = el('a', 'jump', 'Open Splits');
    go2.addEventListener('click', () => homeGo('splits'));
    bs.append(go2);
    bits.append(bs);
    main.append(bits);
  }

  // ── recent deaths ──
  if (RUN.deaths.length) {
    main.append(el('h3', null, 'Recent deaths'));
    const t = el('table', 'grid');
    t.innerHTML = '<tr><th>Pokémon</th><th>Lv</th><th>Where</th><th>Split</th><th>Cause</th></tr>';
    const recent = RUN.deaths.slice().sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 5);
    for (const d of recent) {
      const tr = el('tr');
      const nm = d.species ? (D.byConst[d.species]?.displayName || d.species) : (d.speciesRaw || '—');
      const c = el('td');
      if (d.species) c.append(spr(d.species));
      c.append(document.createTextNode(d.nickname ? `${d.nickname} (${nm})` : nm));
      tr.append(c);
      tr.append(el('td', 'mono', dash(d.level)));
      tr.append(el('td', null, dash(d.area)));
      const sp = (D.progression.splits || []).find((s) => s.id === d.splitId);
      tr.append(el('td', null, sp ? sp.label : dash(d.splitId)));
      tr.append(el('td', null, dash(d.cause)));
      t.append(tr);
    }
    main.append(t);
  }

  // ── data + save status ──
  const foot = el('div', 'hint');
  foot.style.marginTop = '16px';
  const st = $('#status-text') ? $('#status-text').textContent : '';
  foot.textContent = `Data: ${st}. ${P.savePath ? `Save: ${P.savePath}` : 'No save set.'}`;
  main.append(foot);
}

function bosesSafe(splitId) {
  try { return bossesForSplit(splitId); } catch { return []; }
}

function initHome() {
  const sync = $('#home-readnow');
  if (sync) sync.addEventListener('click', () => { if (typeof syncNow === 'function') syncNow('manual'); });
  const runs = $('#home-runs');
  if (runs) runs.addEventListener('click', () => showTab('runs'));
  renderHome();
}
window.initHome = initHome;
