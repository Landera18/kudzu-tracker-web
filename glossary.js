/* Glossary (Pokédex > Glossary).
 *
 * What the words and rules mean: how Kudzu differs from FireRed, every field
 * effect a trainer can start a battle with, how the AI decides, and the
 * tracker's own terms. The text is src/data/glossary.json in the ROM repo
 * (written by hand, like splits.json); the field effects come with their side,
 * duration and users from the X-macro via extract/glossary.py, and the AI flags
 * from trainers.json's glossary of the source's own comments.
 */
'use strict';

const glState = { q: '' };

/** The field effects trainers actually use, one per effect: Spikes L1-L3 and
 *  both sides of Sticky Web fold together, with every place it turns up. */
function glossaryFieldEntries() {
  const groups = new Map();
  for (const e of D.glossary?.fieldEffects || []) {
    if (!e.trainers.length) continue;
    const g = groups.get(e.key) || { key: e.key, name: e.name, text: e.text, sides: new Set(), permanent: false,
      layers: 0, trainers: [] };
    if (e.side) g.sides.add(e.side);
    g.permanent = g.permanent || e.permanent;
    g.layers = Math.max(g.layers, e.layers || 0);
    for (const c of e.trainers) if (!g.trainers.includes(c)) g.trainers.push(c);
    groups.set(e.key, g);
  }
  return [...groups.values()].map((g) => {
    const places = [];
    for (const c of g.trainers) {
      const t = D.trainerBy[c];
      const p = t && trainerPlace(t);
      const label = p && (p.locationLabel || p.label);
      if (label && !places.includes(label)) places.push(label);
    }
    const bits = [];
    if (g.sides.size === 1) bits.push(`on ${FIELD_SIDE[[...g.sides][0]]}`);
    if (g.permanent) bits.push('the whole battle');
    if (g.layers > 1) bits.push(`up to ${g.layers} layers`);
    return {
      term: g.name,
      sub: bits.join(', '),
      text: g.text || 'The battle starts with this in effect.',
      foot: `${g.trainers.length} trainer${g.trainers.length === 1 ? '' : 's'}`
        + (places.length ? `: ${places.slice(0, 8).join(', ')}${places.length > 8 ? `, and ${places.length - 8} more places` : ''}` : ''),
      trainers: g.trainers,
    };
  }).sort((a, b) => b.trainers.length - a.trainers.length || a.term.localeCompare(b.term));
}

/** The AI flags every trainer carries, expanded, with the source's own words. */
function glossaryAiFlags() {
  const used = new Set();
  for (const t of D.trainers.trainers) {
    if (t.reachable === false) continue;
    for (const f of (t.aiFlagsExpanded?.length ? t.aiFlagsExpanded : t.aiFlags) || []) used.add(f);
  }
  const gl = D.trainers.aiFlagGlossary || {};
  return [...used].filter((f) => !(gl[f] && gl[f].composite)).sort().map((f) => {
    const g = gl[f];
    return { term: f.replace('AI_FLAG_', ''), text: (typeof g === 'string' ? g : g?.gloss) || '' };
  });
}

function glossarySections() {
  const hand = (D.glossary?.sections || []).map((s) => ({ ...s, entries: s.entries.slice() }));
  const out = [];
  const take = (id) => {
    const i = hand.findIndex((s) => s.id === id);
    return i < 0 ? null : hand.splice(i, 1)[0];
  };
  const rules = take('rules');
  if (rules) out.push(rules);
  out.push({
    id: 'field', title: 'Field effects',
    intro: 'What some trainers start the battle with. "Your side" is yours; the rest affect everyone. '
      + 'The trainer\'s page, the Trainers list and the Calc tab say which fight starts with what.',
    entries: glossaryFieldEntries(),
  });
  const ai = take('ai');
  if (ai) {
    const flags = glossaryAiFlags();
    if (flags.length) ai.flags = flags;
    out.push(ai);
  }
  return out.concat(hand);
}

function glossaryMatches(e, q) {
  return !q || `${e.term} ${e.sub || ''} ${e.text} ${e.foot || ''}`.toLowerCase().includes(q);
}

function renderGlossary() {
  const main = $('#gl-main');
  const nav = $('#gl-nav');
  if (!main) return;
  main.textContent = '';
  if (nav) nav.textContent = '';
  if (!D.glossary) {
    main.append(el('div', 'empty', 'No glossary data yet - it comes with the next Refresh data.'));
    return;
  }
  const q = glState.q.trim().toLowerCase();
  let shown = 0;
  for (const s of glossarySections()) {
    const entries = s.entries.filter((e) => glossaryMatches(e, q));
    const flags = (s.flags || []).filter((e) => glossaryMatches(e, q));
    if (q && !entries.length && !flags.length) continue;
    const sec = el('section', 'gl-sec');
    sec.id = `gl-${s.id}`;
    sec.append(el('h3', null, s.title));
    if (s.intro && !q) sec.append(el('p', 'gl-intro', s.intro));
    const dl = el('dl', 'gl-list');
    for (const e of entries) {
      const dt = el('dt');
      dt.append(el('span', 'gl-term', e.term));
      if (e.sub) dt.append(el('span', 'gl-sub', e.sub));
      dl.append(dt);
      const dd = el('dd', null, e.text);
      if (e.foot) {
        const foot = el('div', 'gl-foot', e.foot);
        if (e.trainers && e.trainers.length) {
          const a = el('a', 'jump', ' Show them');
          a.addEventListener('click', () => {
            showTab('trainers');
            const box = $('#tr-q');
            if (box) { box.value = ''; }
            glossaryShowTrainers(e.term);
          });
          foot.append(a);
        }
        dd.append(foot);
      }
      dl.append(dd);
      shown += 1;
    }
    sec.append(dl);
    if (flags.length) {
      sec.append(el('h4', 'gl-subhead', 'The AI flags every trainer has'));
      const fl = el('dl', 'gl-list gl-flags');
      for (const f of flags) {
        fl.append(el('dt', null, f.term));
        fl.append(el('dd', null, f.text));
        shown += 1;
      }
      sec.append(fl);
    }
    main.append(sec);
    if (nav) {
      const b = el('button', 'btn ghost', s.title);
      b.addEventListener('click', () => sec.scrollIntoView({ block: 'start' }));
      nav.append(b);
    }
  }
  if (!shown) main.append(el('div', 'empty', 'Nothing in the glossary matches that.'));
}

/** From a field effect's entry to the Trainers list, filtered to its users. */
function glossaryShowTrainers(name) {
  const box = $('#tr-q');
  if (!box) return;
  box.value = name;
  box.dispatchEvent(new Event('input'));
}

function initGlossary() {
  const q = $('#gl-q');
  if (q && !initGlossary.wired) {
    initGlossary.wired = true;
    q.addEventListener('input', () => { glState.q = q.value; renderGlossary(); });
  }
  renderGlossary();
}
