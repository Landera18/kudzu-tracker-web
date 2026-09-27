/* Phone layout.
 *
 * Below 940px (the three columns need about 936) the three-column pages (filters, list, detail) cannot stand side
 * by side, so style.css's phone block turns every page into one scrolling
 * column. This file only adds what CSS cannot do by itself:
 *
 *   - a "Filters ▾" button at the top of each sidebar, which folds it away
 *     (some sidebars are the page's main controls - the save picker, the run
 *     list - and start open);
 *   - list -> detail: opening a trainer, a Pokemon or a box slot shows its
 *     detail full-screen with a Back button, and the phone's own back gesture
 *     does the same (one history entry per opened detail).
 *
 * Everything here only sets classes the phone CSS reads, so a desktop-width
 * window ignores it.
 */
'use strict';

(function () {
  const phone = window.matchMedia('(max-width: 940px)');

  // [button label, starts open]
  const PANES = {
    home: ['Run options', false],
    dex: ['Filters', false],
    enc: ['Filters', false],
    box: ['Boxes', false],
    items: ['Filters', false],
    splits: ['Compare with a run', false],
    calc: ['Opponent, team & zoom', false],
    sav: ['Save file', true],
    runs: ['Runs', true],
    frags: ['About', false],
    caps: ['Options', false],
    trainers: ['Filters', false],
    glossary: ['Search & sections', false],
    sandbox: ['Filters', false],
  };

  const sectionOf = (id) => document.getElementById(`tab-${id}`);

  function openDetail(sec) {
    if (!sec || !phone.matches || sec.classList.contains('show-detail')) return;
    sec.dataset.listY = String(sec.scrollTop);
    sec.classList.add('show-detail');
    sec.scrollTop = 0;
    try { history.pushState({ kzDetail: sec.id }, ''); } catch { /* sandboxed */ }
  }

  function closeDetail(sec) {
    if (!sec || !sec.classList.contains('show-detail')) return;
    sec.classList.remove('show-detail');
    // Setting scrollTop lays the list out first, so it can be done at once.
    sec.scrollTop = Number(sec.dataset.listY) || 0;
  }

  // The back gesture: close whatever detail is open rather than leave the page.
  window.addEventListener('popstate', () => {
    document.querySelectorAll('main > section.show-detail').forEach(closeDetail);
  });

  function calcSummary() {
    const sel = document.getElementById('calc-trainer');
    const o = sel && sel.selectedOptions && sel.selectedOptions[0];
    if (!o || !o.value) return '';
    const who = o.textContent.replace(/\s*\(.*\)\s*$/, '');
    // D is app.js's top-level const: shared by the page's scripts, not on window.
    const t = typeof D !== 'undefined' && D.trainerBy && D.trainerBy[o.value];
    const fx = t && typeof fieldEffectsOf === 'function' ? fieldEffectsOf(fightGroup(t)).map(fieldName) : [];
    return fx.length ? `${who} · ${fx.join(', ')}` : who;
  }

  function refreshToggle(sec) {
    const t = sec && sec.querySelector(':scope > aside.filters > .pane-toggle .pane-sub');
    if (t && sec.id === 'tab-calc') t.textContent = calcSummary();
  }

  function setup() {
    for (const sec of document.querySelectorAll('main > section.tab')) {
      const id = sec.id.replace(/^tab-/, '');
      const aside = sec.querySelector(':scope > aside.filters');
      if (aside && !aside.querySelector(':scope > .pane-toggle')) {
        const [label, open] = PANES[id] || ['Filters', false];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pane-toggle';
        const main = document.createElement('span');
        main.className = 'pane-label';
        main.textContent = label;
        const sub = document.createElement('span');
        sub.className = 'pane-sub';
        const chev = document.createElement('span');
        chev.className = 'pane-chev';
        chev.textContent = '▾';
        b.append(main, sub, chev);
        b.addEventListener('click', () => {
          aside.classList.toggle('collapsed');
          refreshToggle(sec);
        });
        aside.prepend(b);
        if (!open) aside.classList.add('collapsed');
      }

      const detail = sec.querySelector(':scope > .detail');
      if (detail && !sec.querySelector(':scope > .pane-back')) {
        // Outside the detail pane: every render empties it.
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'pane-back';
        back.textContent = '‹ Back';
        back.addEventListener('click', () => {
          if (history.state && history.state.kzDetail === sec.id) history.back();
          else closeDetail(sec);
        });
        sec.insertBefore(back, detail);
        // Picking from the list (Sandbox rows, PC box slots) opens the detail.
        sec.addEventListener('click', (e) => {
          if (e.target.closest('.list .row-item, .pcgrid .pccell:not(.empty)')) openDetail(sec);
        });
      }
    }

    // Trainers and Pokemon are opened from every page (a boss row, a party
    // link, a dex jump), always through these two - so the detail follows them.
    for (const [name, tab] of [['selectTrainer', 'trainers'], ['selectSpecies', 'dex']]) {
      const orig = window[name];
      if (typeof orig !== 'function') continue;
      window[name] = function (...args) {
        const r = orig.apply(this, args);
        openDetail(sectionOf(tab));
        return r;
      };
    }

    const calcSel = document.getElementById('calc-trainer');
    if (calcSel) calcSel.addEventListener('change', () => refreshToggle(sectionOf('calc')));
    // The Calc tab picks the next boss for itself on first open, without a
    // change event; catch up once it has had a moment.
    document.addEventListener('click', (e) => {
      if (e.target.closest('#groups button, #tabs button')) setTimeout(() => refreshToggle(sectionOf('calc')), 300);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
