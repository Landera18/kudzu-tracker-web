/* How a run ended.
 *
 * Starting a new run is the moment the last one is over, and the one moment
 * its ending is still fresh: who did it, where, with what. Nothing in a save
 * says so - a wipe heals the party at the Pokemon Center and the game carries
 * on - so it is asked once, as the new run is started, and stored on the run
 * that ended (`RUN.ending`). The new run keeps a copy under `RUN.previous`, so
 * its Run tab opens on what went wrong last time, and the Runs tab can list
 * what keeps ending runs.
 *
 * Everything in the dialog is prefilled from what the tracker already knows:
 * the split the save put the run in, the first boss it had not beaten, and the
 * cause typed on the most recent deaths. Recording an ending is never required;
 * "Skip" starts the new run without one.
 */
'use strict';

const ENDING_OUTCOMES = [
  ['wiped', 'Wiped - the whole team went down'],
  ['abandoned', 'Abandoned - not worth continuing'],
  ['won', 'Won - Hall of Fame'],
  ['parked', 'Not over - parking it for now'],
];
const ENDING_LABEL = { wiped: 'wiped', abandoned: 'abandoned', won: 'won', parked: 'parked' };

/** A run with nothing in it has no ending worth asking about. */
function runHasProgress(run) {
  return !!run && (Object.keys(run.encounters || {}).length > 0 || (run.deaths || []).length > 0);
}

/** One line for an ending: "wiped to Misty (Gym 3) · Misty Split, cap 39 - crit Surf". */
function endingSummary(e) {
  if (!e) return '';
  const bits = [ENDING_LABEL[e.outcome] || e.outcome || 'ended'];
  if (e.trainerName && e.outcome !== 'won') bits[0] += ` to ${e.trainerName}`;
  const where = [e.splitLabel, e.cap ? `cap ${e.cap}` : null].filter(Boolean).join(', ');
  let s = bits[0] + (where ? ` · ${where}` : '');
  if (e.cause) s += ` - ${e.cause}`;
  return s;
}

/** The trainers a run could have ended on: every reachable one, in run order,
 *  bosses flagged. Beaten ones stay in - the save may not have seen the loss. */
function endingTrainerOptions() {
  const rows = [];
  for (const t of D.trainers?.trainers || []) {
    if (t.reachable === false) continue;
    const p = typeof trainerPlace === 'function' ? trainerPlace(t) : null;
    if (!p) continue;
    rows.push({ t, p });
  }
  rows.sort((a, b) => (a.p.splitIndex ?? 998) - (b.p.splitIndex ?? 998)
    || (a.p.locationIndex ?? 998) - (b.p.locationIndex ?? 998)
    || (a.p.hops ?? 0) - (b.p.hops ?? 0)
    || (a.t.sourceLine || 0) - (b.t.sourceLine || 0));
  return rows;
}

function trainerDisplay(t) {
  if (!t) return '';
  const cls = typeof trainerClassName === 'function' ? trainerClassName(t) : (t.class || '');
  return `${t.name || pretty(t.constant)}${cls ? ` (${cls})` : ''}`;
}

/**
 * Ask how `run` ended. Resolves to an ending object, to null for "Skip", or to
 * the string 'cancel' when the dialog is dismissed and nothing should happen.
 */
function askRunEnding(run, opts) {
  const forNewRun = !(opts && opts.standalone);
  return new Promise((resolve) => {
    const old = document.getElementById('dialog');
    if (old) old.remove();
    const wrap = el('div');
    wrap.id = 'dialog';
    const card = el('div', 'modal-card dialog-card');
    const head = el('header');
    head.append(el('strong', null, `How did "${run.name || 'run'}" end?`));
    card.append(head);
    const body = el('div', 'dialog-body');

    const P = run.progress || {};
    const splits = D.progression?.splits || [];
    const curSplit = splits.find((s) => s.id === (run.rules && run.rules.splitId)) || splits[0] || null;
    const alive = Object.values(run.encounters || {}).filter((r) => isAliveRec(r)).length;
    const dead = (run.deaths || []).length;
    body.append(el('div', 'hint',
      `${curSplit ? curSplit.label : 'No split'} · ${P.badgeCount ?? 0} badges · ${alive} alive · ${dead} dead.`
      + (forNewRun ? ' Saved on that run before the new one starts.' : '')));

    const field = (label, node) => {
      const f = el('label', 'f');
      f.append(el('span', null, label));
      f.append(node);
      body.append(f);
      return node;
    };

    const prev = run.ending || {};
    const outcome = el('select');
    for (const [v, text] of ENDING_OUTCOMES) {
      const o = el('option', null, text); o.value = v; outcome.append(o);
    }
    // No one left alive reads as a wipe; a run with the Champion beaten as won.
    const champBeaten = (D.trainers?.trainers || []).some((t) => t.bossKind === 'champion'
      && run.defeated && run.defeated[t.constant]);
    outcome.value = prev.outcome || (champBeaten ? 'won' : 'wiped');
    field('What happened', outcome);

    const splitSel = el('select');
    for (const s of splits) { const o = el('option', null, s.label); o.value = s.id; splitSel.append(o); }
    if (prev.splitId || curSplit) splitSel.value = prev.splitId || curSplit.id;
    field('In which split', splitSel);

    const trainerSel = el('select');
    const fillTrainers = () => {
      const keep = trainerSel.value;
      trainerSel.textContent = '';
      const none = el('option', null, '- not a trainer (wild Pokémon, other) -'); none.value = '';
      trainerSel.append(none);
      const inSplit = endingTrainerOptions().filter((x) => x.p.split === splitSel.value);
      let lastLoc = null; let group = null;
      for (const { t, p } of inSplit) {
        const loc = p.locationLabel || p.label || '';
        if (loc !== lastLoc) { lastLoc = loc; group = document.createElement('optgroup'); group.label = loc; trainerSel.append(group); }
        const boss = typeof isBossFight === 'function' && isBossFight(t);
        const o = el('option', null, `${boss ? '★ ' : ''}${trainerDisplay(t)}`);
        o.value = t.constant;
        group.append(o);
      }
      if (keep && [...trainerSel.options].some((o) => o.value === keep)) trainerSel.value = keep;
    };
    fillTrainers();
    splitSel.addEventListener('change', fillTrainers);
    // Default: the fight the run was up to. Only when it is in the chosen split,
    // so a wipe on a route trainer is not silently blamed on the gym leader.
    const nb = typeof nextBossFight === 'function' ? nextBossFight() : null;
    const guess = prev.trainer || (nb && nb.split === splitSel.value ? nb.trainer.constant : '');
    if (guess && [...trainerSel.options].some((o) => o.value === guess)) trainerSel.value = guess;
    field('Who ended it', trainerSel);

    const cause = el('input');
    cause.type = 'text';
    cause.placeholder = 'e.g. crit Rock Slide into the lead, then swept by Onix';
    cause.autocomplete = 'off';
    // The cause typed on the most recent death is usually the cause of the run.
    const lastCause = [...(run.deaths || [])].reverse().map((d) => (d.cause || '').trim()).find(Boolean);
    cause.value = prev.cause || lastCause || '';
    field('What went wrong', cause);

    const lesson = el('input');
    lesson.type = 'text';
    lesson.placeholder = 'optional - what to do differently next time';
    lesson.autocomplete = 'off';
    lesson.value = prev.lesson || '';
    field('Note for next time', lesson);

    card.append(body);

    const foot = el('div', 'dialog-foot');
    const cancel = el('button', 'btn ghost', 'Cancel');
    const skip = el('button', 'btn ghost', forNewRun ? 'Skip' : 'Clear');
    const ok = el('button', 'btn', forNewRun ? 'Save and start the new run' : 'Save');
    foot.append(cancel, el('div', 'grow'), skip, ok);
    card.append(foot);
    wrap.append(card);
    document.body.append(wrap);
    cause.focus();

    const close = (value) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (ev) => {
      if (ev.key === 'Escape') close('cancel');
      if (ev.key === 'Enter' && ev.target.tagName !== 'SELECT') ok.click();
    };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', (ev) => { if (ev.target === wrap) close('cancel'); });
    cancel.addEventListener('click', () => close('cancel'));
    skip.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => {
      const t = trainerSel.value ? D.trainerBy[trainerSel.value] : null;
      const sp = splits.find((s) => s.id === splitSel.value) || null;
      const { cap } = typeof capInfo === 'function' ? capInfo() : { cap: null };
      close({
        outcome: outcome.value,
        splitId: sp ? sp.id : null,
        splitLabel: sp ? sp.label : null,
        splitIndex: sp ? sp.index : null,
        trainer: t ? t.constant : null,
        trainerName: t ? trainerDisplay(t) : null,
        cause: cause.value.trim(),
        lesson: lesson.value.trim(),
        cap: cap || null,
        badges: P.badgeCount ?? null,
        alive,
        dead,
        at: new Date().toISOString(),
      });
    });
  });
}

/** Write a run document straight to its file, and wait for it. Used for the
 *  run being left, which the debounced autosave would otherwise write late -
 *  or never, once RUN points at the new run. */
async function writeRunNow(doc) {
  doc.savedAt = new Date().toISOString();
  try {
    const r = await fetch(`api/run/${encodeURIComponent(doc.name || 'run1')}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
    });
    return r.ok;
  } catch { return false; }
}

/** The "last time" card for the Run tab, or null when there is nothing to say. */
function previousRunCard() {
  const p = RUN.previous;
  if (!p || !p.ending) return null;
  const e = p.ending;
  const box = el('div', `lastrun ${e.outcome === 'won' ? 'good' : ''}`);
  const head = el('div', 'lastrun-head');
  head.append(el('b', null, `Last run · ${p.name}`));
  head.append(el('span', `pill ${e.outcome === 'won' ? 'good' : e.outcome === 'wiped' ? 'bad' : 'warn'}`,
    ENDING_LABEL[e.outcome] || e.outcome));
  box.append(head);
  const where = [e.trainerName ? `to ${e.trainerName}` : null, e.splitLabel,
    e.cap ? `cap ${e.cap}` : null, e.badges != null ? `${e.badges} badges` : null,
    e.dead != null ? `${e.dead} dead` : null].filter(Boolean).join(' · ');
  if (where) box.append(el('div', 'const', where));
  if (e.cause) box.append(el('div', 'lastrun-cause', e.cause));
  if (e.lesson) box.append(el('div', 'lastrun-lesson', `Next time: ${e.lesson}`));
  if (e.trainer && D.trainerBy[e.trainer] && e.outcome !== 'won' && typeof openCalcFor === 'function') {
    const row = el('div', 'row');
    const b = el('button', 'btn ghost', `Open ${D.trainerBy[e.trainer].name || 'them'} in the calc`);
    b.addEventListener('click', () => openCalcFor(e.trainer));
    row.append(b);
    box.append(row);
  }
  return box;
}
