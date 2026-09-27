/* Bottle caps — a finite-supply ledger.
 *
 * Caps are Kudzu's currency, not just Hyper Training fodder: the Celadon prize
 * room sells consumables, TMs and Mega Stones for them, and nothing restocks
 * them. So the question this tab answers is "how many do I have left, and what
 * did I burn them on" — not "have I ticked this box".
 *
 * Three numbers matter and they are different:
 *   in world   caps that exist but you have not collected
 *   in hand    collected minus spent
 *   spent      the ledger
 *
 * Loads after app.js and tracker.js and shares their globals.
 */
'use strict';

let capsMode = 'ledger';

function capsState() {
  RUN.caps ||= { found: {}, spends: [] };
  RUN.caps.found ||= {};
  RUN.caps.spends ||= [];
  return RUN.caps;
}

function capTotals() {
  const B = D.bottlecaps;
  const st = capsState();
  const total = B.totalAvailable || 0;
  let found = 0;
  for (const s of B.sources) if (st.found[s.id]) found += s.quantity || 1;
  const spent = st.spends.reduce((a, s) => a + (Number(s.cost) || 0), 0);
  return { total, found, spent, inHand: found - spent, inWorld: total - found };
}

function renderCapsHeader(main) {
  const t = capTotals();
  const wrap = el('div', 'capsum');
  const cell = (n, label, cls) => {
    const c = el('div', `cs ${cls || ''}`);
    c.append(el('b', null, String(n)));
    c.append(el('span', null, label));
    return c;
  };
  wrap.append(cell(t.inHand, 'in hand', t.inHand < 0 ? 'bad' : 'good'));
  wrap.append(cell(t.spent, 'spent'));
  wrap.append(cell(t.found, 'collected'));
  wrap.append(cell(t.inWorld, 'still in world'));
  wrap.append(cell(t.total, 'in the game'));
  main.append(wrap);

  if (t.inHand < 0) {
    main.append(el('div', 'note',
      'You have spent more caps than you have marked collected. '
      + 'Tick the pickups you have taken on the Sources tab.'));
  }
}

function renderCaps() {
  const main = $('#caps-main');
  if (!main || !D.bottlecaps) return;
  main.textContent = '';
  fillSpendMons();
  renderCapsHeader(main);

  if (capsMode === 'ledger') return renderCapLedger(main);
  if (capsMode === 'shop') return renderCapShop(main);
  return renderCapSources(main);
}

function renderCapLedger(main) {
  const st = capsState();
  main.append(el('h3', null, `Ledger — ${st.spends.length} spend(s)`));
  if (!st.spends.length) {
    main.append(el('div', 'empty', 'Nothing spent yet. Record a spend from the panel on the left.'));
    return;
  }
  const t = el('table', 'grid');
  t.innerHTML = '<tr><th>On</th><th>Cost</th><th>Pokémon</th><th>Note</th><th>When</th><th></th></tr>';
  for (const [i, s] of [...st.spends].reverse().entries()) {
    const idx = st.spends.length - 1 - i;
    const tr = el('tr');
    tr.append(el('td', null, s.label));
    tr.append(el('td', 'mono', String(s.cost)));
    tr.append(el('td', null, s.mon || '—'));
    tr.append(el('td', null, s.note || '—'));
    tr.append(el('td', 'const', (s.at || '').slice(0, 16).replace('T', ' ')));
    const del = el('td');
    const b = el('button', 'btn ghost', 'remove');
    b.addEventListener('click', () => {
      st.spends.splice(idx, 1); saveRun(); renderCaps();
    });
    del.append(b); tr.append(del);
    t.append(tr);
  }
  main.append(t);
}

function renderCapSources(main) {
  const B = D.bottlecaps;
  const st = capsState();
  const q = $('#caps-q').value.trim().toLowerCase();
  const todo = $('#caps-todo').checked;

  // Group by split so the list reads in run order rather than alphabetically.
  const rows = B.sources.filter((s) => {
    if (todo && st.found[s.id]) return false;
    if (q && !`${s.map} ${s.id}`.toLowerCase().includes(q)) return false;
    return true;
  });
  $('#caps-count').textContent = `${rows.length} of ${B.sources.length} pickups`;

  const groups = new Map();
  for (const s of rows) {
    const sp = D.splitOfMap[s.map];
    const key = sp ? sp.splitKey : null;
    if (!groups.has(key)) {
      groups.set(key, { label: sp ? sp.splitLabel : 'Unordered / optional', order: sp ? sp.splitIndex : 999, rows: [] });
    }
    groups.get(key).rows.push(s);
  }

  for (const g of [...groups.values()].sort((a, b) => a.order - b.order)) {
    const head = el('div', 'split-head');
    head.append(el('b', null, g.label));
    const n = g.rows.reduce((a, s) => a + (s.quantity || 1), 0);
    head.append(el('span', 'sub', `${n} cap${n === 1 ? '' : 's'}`));
    main.append(head);

    const t = el('table', 'grid');
    t.innerHTML = '<tr><th></th><th>Where</th><th>How</th><th>Caps</th></tr>';
    for (const s of g.rows) {
      const tr = el('tr');
      const c0 = el('td');
      const box = el('input'); box.type = 'checkbox'; box.checked = !!st.found[s.id];
      box.addEventListener('change', () => {
        if (box.checked) st.found[s.id] = true; else delete st.found[s.id];
        saveRun(); renderCaps();
      });
      c0.append(box); tr.append(c0);
      tr.append(el('td', null, mapLabel(s.map)));
      tr.append(el('td', null, s.kind));
      tr.append(el('td', 'mono', String(s.quantity || 1)));
      if (st.found[s.id]) tr.style.opacity = '.55';
      t.append(tr);
    }
    main.append(t);
  }
}

function renderCapShop(main) {
  const B = D.bottlecaps;

  main.append(el('h3', null, 'NPC services'));
  const t1 = el('table', 'grid');
  t1.innerHTML = '<tr><th>Service</th><th>Caps</th><th>What it does</th></tr>';
  for (const s of B.services) {
    const tr = el('tr');
    tr.append(el('td', null, pretty(s.service)));
    tr.append(el('td', 'mono', s.cost === 0 ? 'free' : String(s.cost)));
    tr.append(el('td', null, s.note || '—'));
    t1.append(tr);
  }
  main.append(t1);

  main.append(el('h3', null, `Game Corner prize room — ${B.prizeCount} items`));
  const t2 = el('table', 'grid');
  t2.innerHTML = '<tr><th>Item</th><th>Price</th><th>After you find one</th></tr>';
  for (const p of B.prizes) {
    const item = (D.items || []).find((i) => i.constant === p.item);
    const tr = el('tr');
    tr.append(el('td', null, item?.displayName || pretty(p.item)));
    tr.append(el('td', 'mono', String(p.price)));
    tr.append(el('td', 'mono', p.discountedPrice != null && p.discountedPrice !== p.price
      ? `${p.discountedPrice}` : '—'));
    t2.append(tr);
  }
  main.append(t2);
  main.append(el('div', 'const',
    'Prices drop once you have collected the matching pickup out in the world, '
    + 'so finding an item first makes buying a second one cheaper.'));
}

function fillSpendOptions() {
  const B = D.bottlecaps;
  const sel = $('#spend-what');
  sel.textContent = '';
  for (const s of B.services) {
    if (!s.cost) continue;
    const o = el('option', null, `${pretty(s.service)} — ${s.cost}`);
    o.value = `svc:${s.id}:${s.cost}`;
    sel.append(o);
  }
  for (const p of B.prizes) {
    const item = (D.items || []).find((i) => i.constant === p.item);
    const name = item?.displayName || pretty(p.item);
    const cheap = p.discountedPrice != null ? p.discountedPrice : p.price;
    const o = el('option', null, `${name} — ${p.price}${cheap !== p.price ? `/${cheap}` : ''}`);
    o.value = `prize:${p.item}:${p.price}`;
    sel.append(o);
  }
  const other = el('option', null, 'Other — 1');
  other.value = 'other::1';
  sel.append(other);
}

function fillSpendMons() {
  const sel = $('#spend-mon');
  const cur = sel.value;
  sel.textContent = '';
  const none = el('option', null, '— not tied to a Pokémon —');
  none.value = ''; sel.append(none);
  for (const m of roster()) {
    const o = el('option', null, `${rosterLabel(m)}${m.placement === 'graveyard' ? ' †' : ''}`);
    o.value = m.id; sel.append(o);
  }
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function recordSpend() {
  const v = $('#spend-what').value;
  if (!v) return;
  const [kind, id, cost] = v.split(':');
  const label = $('#spend-what').selectedOptions[0].textContent.replace(/ — .*$/, '');
  const monId = $('#spend-mon').value || null;
  const mon = monId
    ? ($('#spend-mon').selectedOptions[0].textContent.replace(' †', ''))
    : null;
  capsState().spends.push({
    kind, id, label, cost: Number(cost) || 0,
    monId, mon, note: $('#spend-note').value.trim() || null,
    splitId: RUN.rules?.splitId || null,
    at: new Date().toISOString(),
  });
  $('#spend-note').value = '';
  saveRun();
  capsMode = 'ledger';
  $$('#caps-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'ledger'));
  renderCaps();
}

function initCaps() {
  if (!D.bottlecaps) return;
  fillSpendOptions();
  fillSpendMons();
  $$('#caps-mode button').forEach((b) => b.addEventListener('click', () => {
    capsMode = b.dataset.mode;
    $$('#caps-mode button').forEach((x) => x.classList.toggle('on', x === b));
    renderCaps();
  }));
  $('#spend-add').addEventListener('click', recordSpend);
  for (const id of ['#caps-q', '#caps-todo']) $(id).addEventListener('input', renderCaps);
  renderCaps();
}
window.initCaps = initCaps;
