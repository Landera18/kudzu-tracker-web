/* Split Viewer — the run's timeline, with the boss fights in each split.
 *
 * A split is a milestone segment: the badge splits from splits.json, in run
 * order, each with the level cap in force, the boss fights inside it and the
 * deaths that happened there. Which split the run is in comes from the save
 * (progress.js); Start / Complete still work by hand, and a hand-picked split
 * pins the rules until "Follow the save again".
 *
 * Deaths and encounters are NOT stored per split. They are attributed by the
 * splitId already on each encounter record, so editing a record after the fact
 * moves it to the right split instead of leaving a stale copy behind.
 *
 * Loads after tracker.js and progress.js and shares their globals.
 */
'use strict';

let compareRun = null;   // an imported run to measure this one against

function splitState() {
  RUN.splits ||= {};
  return RUN.splits;
}

const splitList = () => (D.progression?.splits || []);

/* ── boss fights ──────────────────────────────────────────────────── */

/**
 * A boss is anyone the party file gives a mugshot: gym leaders, the rival,
 * Rocket admins, the Elite Four and Champion, and the handful of "special"
 * trainers (the Three Island biker boss, admins fought under another class).
 * bossKind covers most of them; the mugshot catches the rest.
 */
const isBossFight = (t) => !!(t && (t.isBoss || t.mugshot));

/* The rival and the Champion come in one variant per starter. They are one
   fight; the save's defeated flag says which variant it was. */
const STARTER_SUFFIX = /_(SQUIRTLE|BULBASAUR|CHARMANDER)$/;
const bossGroupKey = (t) => {
  // Trainers a script fights together (Koga & Lt. Surge, Petrel & Archer) are one fight.
  const co = typeof coOpponents === 'function' ? coOpponents(t) : [];
  if (co.length) return `fight:${[t.constant, ...co].sort().join('+')}`;
  return (t.bossKind === 'rival' || t.bossKind === 'champion') && STARTER_SUFFIX.test(t.constant)
    ? t.constant.replace(STARTER_SUFFIX, '') : t.constant;
};
const starterVariantOf = (t) => {
  const m = STARTER_SUFFIX.exec(t.constant || '');
  return m ? m[1] : null;
};

/** Which rival variant this run fights, from a beaten one, else the starter. */
function rivalVariant() {
  const P = RUN.progress || {};
  if (P.rivalVariant) return P.rivalVariant;
  // The rival's starter beats the player's: Charmander -> Squirtle, and so on.
  const counter = { SPECIES_CHARMANDER: 'SQUIRTLE', SPECIES_SQUIRTLE: 'BULBASAUR', SPECIES_BULBASAUR: 'CHARMANDER' };
  for (const rec of Object.values(RUN.encounters)) {
    const line = rec.species ? lineOf(rec.species) : null;
    if (line && counter[line] && /gift:/.test(rec.areaId || '')) return counter[line];
  }
  return null;
}

const BOSS_KIND_LABEL = {
  gymLeader: 'Gym', eliteFour: 'Elite Four', champion: 'Champion',
  rival: 'Rival', bossRocket: 'Rocket', normal: 'Boss',
};

/**
 * Every boss fight in run order, grouped per encounter (one row per rival
 * fight, not three), each with where it is, whether it is beaten, and which
 * variant applies.
 */
function bossFights() {
  const groups = new Map();
  for (const t of D.trainers.trainers) {
    if (!isBossFight(t) || t.reachable === false) continue;
    const place = trainerPlace(t);
    if (!place) continue;                 // no script starts it: never fought
    const key = bossGroupKey(t);
    if (!groups.has(key)) groups.set(key, { key, variants: [], place });
    const g = groups.get(key);
    g.variants.push(t);
    // The earliest placement wins for the group, as for a single trainer.
    const better = (a, b) => (a.splitIndex ?? 998) - (b.splitIndex ?? 998)
      || (a.locationIndex ?? 998) - (b.locationIndex ?? 998) || (a.hops ?? 0) - (b.hops ?? 0);
    if (better(place, g.place) < 0) g.place = place;
  }
  const variant = rivalVariant();
  const out = [];
  for (const g of groups.values()) {
    const together = g.key.startsWith('fight:');
    const beaten = g.variants.filter((t) => isDefeated(t.constant));
    const chosen = (together ? g.variants[0] : beaten[0])
      || g.variants.find((t) => variant && starterVariantOf(t) === variant)
      || g.variants[0];
    const kind = chosen.bossKind && chosen.bossKind !== 'normal' ? chosen.bossKind : 'normal';
    out.push({
      key: g.key,
      trainer: chosen,
      // The opponents of one scripted double (both beaten in the same battle).
      together: together ? g.variants.slice() : null,
      ally: together || (chosen.battleFormat === 'tag') ? tagPartner(chosen) : null,
      variants: together ? [chosen] : g.variants,
      variantKnown: together || g.variants.length === 1 || !!beaten.length || !!variant,
      place: g.place,
      split: g.place.split,
      splitIndex: g.place.splitIndex ?? 998,
      defeated: !!beaten.length,
      defeatedSource: beaten.length ? defeatedSource(beaten[0].constant) : null,
      kindLabel: kind === 'gymLeader' && chosen.gymNumber ? `Gym ${chosen.gymNumber}` : BOSS_KIND_LABEL[kind],
      kind,
    });
    if (together) {
      const last = out[out.length - 1];
      // Order the pair as the party file does, so it reads the same everywhere.
      last.together.sort((a, b) => (a.sourceLine || 0) - (b.sourceLine || 0));
      last.trainer = last.together[0];
    }
  }
  out.sort((a, b) => a.splitIndex - b.splitIndex
    || (a.place.locationIndex ?? 998) - (b.place.locationIndex ?? 998)
    || (a.place.hops ?? 0) - (b.place.hops ?? 0)
    || (a.trainer.sourceLine || 0) - (b.trainer.sourceLine || 0));
  return out;
}

const bossesForSplit = (splitId) => bossFights().filter((b) => b.split === splitId);

/** The first boss fight in run order the save has not beaten. */
function nextBossFight() {
  return bossFights().find((b) => !b.defeated) || null;
}

/** One boss row: mugshot colour, kind, name, party, where, status, actions. */
function bossRow(b, opts) {
  const t = b.trainer;
  const next = opts && opts.next;
  const row = el('div', `bossrow${b.defeated ? ' beaten' : ''}${next ? ' next' : ''}`);
  const shot = el('span', `mug mug-${String(t.mugshot || '').toLowerCase() || 'none'}`);
  shot.title = t.mugshot ? `${t.mugshot} mugshot` : 'no mugshot';
  row.append(shot);
  row.append(el('span', 'pill', b.kindLabel));

  const who = el('span', 'who');
  const opponents = b.together || [t];
  opponents.forEach((o, i) => {
    if (i) who.append(document.createTextNode(' & '));
    const name = el('a', 'jump', o.name || pretty(o.constant));
    name.addEventListener('click', () => { showTab('trainers'); selectTrainer(o.constant); });
    who.append(name);
  });
  who.append(el('span', 'cls', b.together ? 'together' : trainerClassName(t)));
  const fp = typeof formatPill === 'function' ? formatPill(t) : null;
  if (fp) who.append(fp);
  if (typeof megaPills === 'function') {
    const seen = new Set();
    for (const o of opponents) {
      for (const mp of megaPills(o)) {
        if (seen.has(mp.textContent)) continue;
        seen.add(mp.textContent);
        who.append(mp);
      }
    }
  }
  if (b.ally) {
    const a = el('span', 'pill good', `with ${b.ally.name}`);
    a.title = `Your ally: ${(b.ally.party || []).map((m) => `${m.species} L${m.level ?? '?'}`).join(', ')}`;
    who.append(a);
  }
  if (!b.variantKnown && b.variants.length > 1) {
    const v = el('span', 'pill warn', `${b.variants.length} variants`);
    v.title = 'The rival\'s team depends on your starter; the save will say which once you have fought one.';
    who.append(v);
  } else if (b.variants.length > 1) {
    const v = starterVariantOf(t);
    if (v) who.append(el('span', 'pill', `${v[0]}${v.slice(1).toLowerCase()} variant`));
  }
  row.append(who);

  // A fight against two trainers shows both teams, one after the other.
  const party = opponents.flatMap((o) => o.party || []);
  const lv = party.map((m) => m.level).filter((x) => x != null);
  const strip = el('span', 'party-strip');
  opponents.forEach((o, i) => {
    if (i) strip.append(el('span', 'strip-sep', '|'));
    for (const m of (o.party || []).slice(0, 6)) strip.append(spr(m.speciesConstant));
  });
  strip.title = opponents.map((o) => `${o.name}: ${(o.party || []).map((m) => `${m.species} L${m.level ?? '?'}`).join(', ')}`).join('\n');
  row.append(strip);
  row.append(el('span', 'lv', lv.length ? `L${Math.min(...lv)}–${Math.max(...lv)}` : ''));
  row.append(el('span', 'where', b.place.label || b.place.locationLabel || ''));

  const st = el('span', `pill ${b.defeated ? 'good' : next ? 'next' : ''}`,
    b.defeated ? (b.defeatedSource === 'save' ? 'beaten' : 'beaten (by hand)') : next ? 'next' : 'ahead');
  if (b.defeated && b.defeatedSource === 'save') st.title = 'The save\'s trainer flag says this battle is won';
  row.append(st);

  const calc = el('button', 'btn ghost', 'Calc');
  calc.title = 'Load this team into the damage calculator';
  calc.addEventListener('click', () => {
    if (typeof openCalcFor === 'function') openCalcFor(t.constant);
  });
  row.append(calc);
  return row;
}

/** All the boss fights of one split, as rows, with the next one marked. */
function renderBossRows(splitId, container) {
  const rows = bossesForSplit(splitId);
  if (!rows.length) return 0;
  const next = nextBossFight();
  const wrap = el('div', 'bosses');
  for (const b of rows) wrap.append(bossRow(b, { next: next && next.key === b.key }));
  container.append(wrap);
  return rows.length;
}

/* ── locations ────────────────────────────────────────────────────── */

/* Which split cards have their location list open. View state, not run data. */
const openLocations = new Set();

/**
 * The split's places in run order, straight from splits.json, each with what
 * the tracker knows is there: its encounter areas (maps splits.json leaves out
 * are counted at the location they were placed beside), the trainers fought
 * there, and its shops. A trainerOverrides entry has a split but no place of
 * its own, so those come last under "Also in this split".
 */
function splitLocations(s) {
  const out = (s.locations || []).map((l) => ({
    index: l.index, label: l.label, note: l.note, parts: l.parts || [],
    areas: [], trainers: [], marts: martsAt(s.id, l.index),
  }));
  const at = new Map(out.map((l) => [l.index, l]));
  for (const a of AREAS) {
    if (a.split === s.id && at.has(a.locOrder)) at.get(a.locOrder).areas.push(a);
  }
  const elsewhere = [];
  for (const t of D.trainers.trainers) {
    if (t.reachable === false) continue;
    const p = trainerPlace(t);
    if (!p || p.split !== s.id) continue;
    if (at.has(p.locationIndex)) at.get(p.locationIndex).trainers.push(t);
    else elsewhere.push(t);
  }
  if (elsewhere.length) {
    out.push({ index: 999, label: 'Also in this split', note: 'filed here by trainerOverrides',
      parts: [], areas: [], trainers: elsewhere, marts: [] });
  }
  return out;
}

function renderLocations(s, body) {
  const locs = splitLocations(s);
  const box = el('details', 'locations');
  box.open = openLocations.has(s.id) || (!openLocations.size && s.id === RUN.rules.splitId);
  box.addEventListener('toggle', () => {
    box.open ? openLocations.add(s.id) : openLocations.delete(s.id);
  });
  const nMarts = locs.filter((l) => l.marts.length).length;
  box.append(el('summary', null,
    `Locations (${locs.filter((l) => l.index !== 999).length})${nMarts ? ` · ${nMarts} with a mart` : ''}`));
  const list = el('ol', 'loclist');
  for (const l of locs) {
    const li = el('li', l.index === 999 ? 'extra' : '');
    const head = el('div', 'loc-head');
    head.append(el('span', 'loc-name', l.label));
    if (l.areas.length) {
      const done = l.areas.filter((a) => {
        const r = areaRecord(a);
        return r && r.status && r.status !== 'unencountered';
      }).length;
      const p = el('a', `pill${done === l.areas.length ? ' good' : ''}`,
        `${done}/${l.areas.length} encounter${l.areas.length === 1 ? '' : 's'}`);
      p.title = l.areas.map((a) => a.label + (a.methodsHere ? ` (${a.methodsHere.map(methodName).join(', ')})`
        : a.entry.kind !== 'wild' ? ` (${a.entry.kind})` : '')).join('\n');
      p.addEventListener('click', () => {
        showTab('enc');
        const f = $('#enc-split');
        if (f) { f.value = s.id; }
        renderEnc();
      });
      head.append(p);
    }
    if (l.trainers.length) {
      // Two trainers fought in one battle count, and are named, as one fight.
      const fights = groupFights(l.trainers);
      const won = (g) => g.every((t) => isDefeated(t.constant));
      const beaten = fights.filter(won).length;
      const p = el('span', `pill${beaten === fights.length ? ' good' : ''}`,
        `${beaten}/${fights.length} trainer${fights.length === 1 ? '' : 's'}`);
      p.title = fights.map((g) => `${won(g) ? '✓ ' : ''}${fightNames(g)} (${fightClasses(g)})`).join('\n');
      head.append(p);
      // Fights that stand between you and a mega stone.
      const guarded = {};
      for (const t of l.trainers) {
        for (const g of t.guardsMega || []) (guarded[g.itemName] ||= []).push(t.name);
      }
      for (const [item, who] of Object.entries(guarded)) {
        const mp = el('span', 'pill mega', `guards ${item}`);
        mp.title = `${[...new Set(who)].join(' & ')} guard the ${item}`;
        head.append(mp);
      }
    }
    li.append(head);
    if (l.note) li.append(el('div', 'const', l.note));
    if (l.marts.length) li.append(martBlock(s.id, l.index));
    list.append(li);
  }
  box.append(list);
  body.append(box);
}

/* ── the timeline ─────────────────────────────────────────────────── */

/** Deaths, encounters and caps attributed to one split. */
function splitStats(id) {
  const deaths = RUN.deaths.filter((d) => d.splitId === id);
  const gained = Object.values(RUN.encounters).filter(
    (r) => r.splitId === id && r.status && r.status !== 'unencountered');
  const caught = gained.filter((r) => ALIVE.has(r.status) || DEAD.has(r.status));
  const caps = (RUN.caps?.spends || []).filter((s) => s.splitId === id);
  const bosses = bossesForSplit(id);
  return {
    deaths,
    encounters: gained.length,
    caught: caught.length,
    caps: caps.reduce((a, s) => a + (Number(s.cost) || 0), 0),
    bosses: bosses.length,
    bossesBeaten: bosses.filter((b) => b.defeated).length,
  };
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function splitDuration(st) {
  if (!st?.enteredAt) return null;
  const end = st.exitedAt ? Date.parse(st.exitedAt) : Date.now();
  return end - Date.parse(st.enteredAt);
}

/** Everything alive right now, frozen for the record. */
function captureTeam() {
  return roster()
    .filter((m) => m.placement !== 'graveyard')
    .map((m) => ({
      areaId: m.id,
      species: m.rec.species || null,
      speciesRaw: m.rec.speciesRaw || null,
      nickname: m.rec.nickname || null,
      level: m.rec.currentLevel ?? null,
      placement: m.placement,
    }));
}

function renderSplits() {
  const main = $('#splits-main');
  if (!main || !D.progression) return;
  main.textContent = '';
  const st = splitState();
  const list = splitList();
  const current = RUN.rules.splitId;

  // ── summary ──
  const totalDeaths = RUN.deaths.length;
  const done = list.filter((s) => st[s.id]?.exitedAt);
  const totalMs = list.reduce((a, s) => a + (splitDuration(st[s.id]) || 0), 0);
  const fights = bossFights();

  const sum = el('div', 'capsum');
  const cell = (n, label, cls) => {
    const c = el('div', `cs ${cls || ''}`);
    c.append(el('b', null, String(n)));
    c.append(el('span', null, label));
    return c;
  };
  sum.append(cell(`${done.length}/${list.length}`, 'splits done'));
  sum.append(cell(`${fights.filter((b) => b.defeated).length}/${fights.length}`, 'bosses beaten'));
  sum.append(cell(totalDeaths, 'deaths', totalDeaths ? 'bad' : 'good'));
  sum.append(cell(fmtDuration(totalMs), 'elapsed'));
  sum.append(cell(roster().filter((m) => m.placement !== 'graveyard').length, 'alive'));
  main.append(sum);

  if (compareRun) {
    const other = compareRun.deaths?.length ?? 0;
    const diff = totalDeaths - other;
    main.append(el('div', 'note',
      `Comparing against "${compareRun.name || 'imported run'}": `
      + `${other} death(s) there vs ${totalDeaths} here `
      + `(${diff === 0 ? 'level' : diff > 0 ? `${diff} worse` : `${-diff} better`}).`));
  }

  // ── per split ──
  for (const s of list) {
    const rec = st[s.id] || {};
    const stats = splitStats(s.id);
    const state = rec.exitedAt ? 'done' : rec.enteredAt ? 'active' : 'todo';

    const card = el('div', `area${state === 'done' ? ' done' : ''}${s.id === current ? ' current' : ''}`);
    const head = el('header');
    head.append(el('span', `st ${state === 'done' ? 'caught' : state === 'active' ? 'fled' : ''}`));
    head.append(el('span', 'nm', `${s.index + 1}. ${s.label}`));
    head.append(el('span', 'pill', `cap ${s.levelCap?.atEntry ?? '—'} → ${s.levelCap?.atExit ?? '—'}`));
    if (s.id === current) {
      const p = el('span', 'pill good', 'current');
      p.title = RUN.rules.splitSource === 'manual' ? 'Picked by hand' : 'Where the save says the run is';
      head.append(p);
    }
    head.append(el('div', 'grow'));
    if (stats.bosses) {
      head.append(el('span', `pill${stats.bossesBeaten === stats.bosses ? ' good' : ''}`,
        `${stats.bossesBeaten}/${stats.bosses} bosses`));
    }
    if (stats.deaths.length) {
      head.append(el('span', 'pill bad', `${stats.deaths.length} dead`));
    }
    head.append(el('span', 'sub', rec.inferred ? 'stamped by the save' : fmtDuration(splitDuration(rec))));
    card.append(head);

    const body = el('div', 'body');

    const row = el('div', 'entry');
    if (state === 'todo') {
      const b = el('button', 'btn', 'Start split');
      b.addEventListener('click', () => {
        st[s.id] = { enteredAt: new Date().toISOString(), teamAtEntry: captureTeam() };
        RUN.rules.splitId = s.id;
        RUN.rules.splitSource = 'manual';
        syncRulesToUI(); saveRun(); renderSplits(); renderEnc();
      });
      row.append(b);
    } else if (state === 'active') {
      const b = el('button', 'btn', 'Complete split');
      b.addEventListener('click', () => {
        st[s.id].exitedAt = new Date().toISOString();
        st[s.id].teamAtExit = captureTeam();
        const next = list[s.index + 1];
        if (next) { RUN.rules.splitId = next.id; RUN.rules.splitSource = 'manual'; }
        syncRulesToUI(); saveRun(); renderSplits(); renderEnc();
      });
      row.append(b);
    }
    if (state !== 'todo') {
      const b = el('button', 'btn ghost', 'Reset');
      b.addEventListener('click', () => { delete st[s.id]; saveRun(); renderSplits(); });
      row.append(b);
    }
    row.append(el('span', 'lbl',
      `${stats.encounters} encounter(s) · ${stats.caught} caught · ${stats.caps} cap(s) spent`));
    body.append(row);

    if (rec.enteredAt) {
      body.append(el('div', 'const',
        `entered ${rec.enteredAt.slice(0, 16).replace('T', ' ')}`
        + (rec.exitedAt ? ` · exited ${rec.exitedAt.slice(0, 16).replace('T', ' ')}` : '')));
    }

    // The fights that define the split, in the order they come.
    if (stats.bosses) {
      body.append(el('h3', null, 'Boss fights'));
      renderBossRows(s.id, body);
    }

    // Where the split goes, in order, with what each place holds and sells.
    renderLocations(s, body);

    if (stats.deaths.length) {
      const t = el('table', 'grid');
      t.innerHTML = '<tr><th>Died here</th><th>Lv</th><th>Where</th><th>Cause</th></tr>';
      for (const d of stats.deaths) {
        const tr = el('tr');
        const nm = d.species ? (D.byConst[d.species]?.displayName || d.species) : (d.speciesRaw || '—');
        tr.append(el('td', null, d.nickname ? `${d.nickname} (${nm})` : nm));
        tr.append(el('td', 'mono', dash(d.level)));
        tr.append(el('td', null, dash(d.area)));
        tr.append(el('td', null, dash(d.cause)));
        t.append(tr);
      }
      body.append(t);
    }

    const team = rec.teamAtExit || rec.teamAtEntry;
    if (team?.length) {
      const g = el('div', 'slotgrid');
      for (const m of team) {
        const row2 = el('div', 's');
        const nm = m.species ? (D.byConst[m.species]?.displayName || m.species) : (m.speciesRaw || '?');
        row2.append(el('span', 'l', m.placement === 'party' ? 'party' : 'pc'));
        row2.append(el('span', null, m.nickname ? `${m.nickname} (${nm})` : nm));
        row2.append(el('span', 'l', m.level ? `L${m.level}` : ''));
        g.append(row2);
      }
      body.append(el('div', 'const',
        rec.teamAtExit ? 'team at split exit' : 'team at split entry'));
      body.append(g);
    }

    if (compareRun) {
      const o = compareRun.splits?.[s.id];
      const od = (compareRun.deaths || []).filter((d) => d.splitId === s.id).length;
      if (o || od) {
        body.append(el('div', 'const',
          `previous run: ${od} death(s), ${fmtDuration(splitDuration(o))}`));
      }
    }
    card.append(body);
    main.append(card);
  }
}

function initSplits() {
  if (!D.progression) return;
  $('#splits-compare').addEventListener('click', () => $('#splits-file').click());
  $('#splits-file').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        compareRun = JSON.parse(fr.result);
        renderSplits();
      } catch (e) {
        $('#splits-status').textContent = `could not read that run: ${e.message}`;
      }
    };
    fr.readAsText(f);
  });
  $('#splits-clear').addEventListener('click', () => { compareRun = null; renderSplits(); });
  renderSplits();
}
window.initSplits = initSplits;
