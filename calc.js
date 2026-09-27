/* Damage calculator — Gen 9 mechanics, Kudzu's data.
 *
 * WHY NOT @smogon/calc. kudzucalc vendors it, and it works, but it carries its
 * own species/move/type tables underneath. Anything the override layer misses
 * falls back to Smogon's vanilla value — which is exactly how Flash ended up
 * calculating as a Normal status move when Kudzu made it a 40 BP Electric
 * special attack. It also knows nothing about this fork's rules:
 * B_EXPLOSION_DEFENSE = GEN_4, B_ABILITY_WEATHER = GEN_3, EV_CAP_NO_GAIN, or
 * the 11 custom abilities. So the formula is computed here, from data/*.json,
 * with the config values the extractor resolved.
 *
 * WHAT IS MODELLED: the Gen 9 damage formula, stat stages, STAB, Kudzu's type
 * chart, criticals, weather, burn, screens, multi-hit, Explosion's Gen-4
 * Defense halving, and the common damage-affecting items and abilities.
 *
 * WHAT IS NOT: per-ability special cases beyond the listed set, entry hazards,
 * residual damage, and anything decided by a battle script rather than by the
 * move table. Unmodelled things are listed in the UI rather than silently
 * assumed away — a calc that quietly ignores an ability is worse than one that
 * says it ignored it.
 */
'use strict';

const STAT_KEYS = ['hp', 'attack', 'defense', 'spAttack', 'spDefense', 'speed'];

/* Stat stage multipliers, Gen 3+. */
const STAGE = [2 / 8, 2 / 7, 2 / 6, 2 / 5, 2 / 4, 2 / 3, 1, 3 / 2, 4 / 2, 5 / 2, 6 / 2, 7 / 2, 8 / 2];
const stageMul = (s) => STAGE[Math.max(-6, Math.min(6, s)) + 6];

/** Gen 3+ stat formula. EVs are always 0 in Kudzu (B_EV_CAP_TYPE = EV_CAP_NO_GAIN). */
function statValue(base, level, iv, ev, natureMod, isHp) {
  if (base == null) return null;
  const core = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
  if (isHp) return core + level + 10;
  return Math.floor((core + 5) * natureMod);
}

const natureByName = (name) => (D.natures || []).find(
  (n) => n.displayName.toLowerCase() === String(name || '').toLowerCase()
      || n.constant === name);

/** Turn a roster record or a trainer party mon into something the engine can use. */
function toCombatant(src, opts = {}) {
  const sp = D.byConst[src.speciesConstant || src.species];
  if (!sp) return null;
  const level = Number(src.level ?? src.currentLevel ?? opts.level ?? 50) || 50;

  // Trainer mons carry explicit IVs. Player mons may carry a typed snapshot;
  // when they do not, assume 31s and SAY SO in the UI rather than guessing low.
  let ivs = { hp: 31, attack: 31, defense: 31, spAttack: 31, spDefense: 31, speed: 31 };
  let ivSource = 'assumed 31s';
  if (src.ivs && typeof src.ivs === 'object') {
    ivs = {
      hp: src.ivs.hp ?? 31, attack: src.ivs.atk ?? src.ivs.attack ?? 31,
      defense: src.ivs.def ?? src.ivs.defense ?? 31,
      spAttack: src.ivs.spa ?? src.ivs.spAttack ?? 31,
      spDefense: src.ivs.spd ?? src.ivs.spDefense ?? 31,
      speed: src.ivs.spe ?? src.ivs.speed ?? 31,
    };
    ivSource = 'from the party file';
  } else if (src.snapshot?.ivs) {
    const parts = String(src.snapshot.ivs).split(/[^0-9x]+/i).filter(Boolean);
    if (parts.length === 6) {
      const n = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : 31));
      ivs = { hp: n[0], attack: n[1], defense: n[2], spAttack: n[3], spDefense: n[4], speed: n[5] };
      ivSource = 'from your snapshot';
    }
  }

  const natName = src.nature || src.snapshot?.nature;
  const nat = natureByName(natName);
  const mods = nat ? nat.modifiers : null;

  const stats = {};
  for (const k of STAT_KEYS) {
    stats[k] = statValue(sp.baseStats[k], level, ivs[k], 0,
      mods ? mods[k] : 1, k === 'hp');
  }

  return {
    species: sp,
    name: src.nickname || sp.displayName,
    level,
    stats,
    ivs,
    ivSource,
    nature: nat ? nat.displayName : (natName || null),
    ability: src.ability || src.snapshot?.ability || null,
    item: src.heldItem || src.snapshot?.heldItem || null,
    types: sp.types.map((t) => t.constant),
    moves: (src.moveConstants || (src.snapshot?.moves || [])
      .map((m) => (D.moves.find((x) => x.displayName === m) || {}).constant))
      .filter(Boolean),
    boosts: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
    source: src,
  };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* Items and abilities the engine understands. Everything else is reported as
   unmodelled rather than silently ignored. */
const ITEM_MODS = {
  lifeorb: { dmg: 1.3 },
  choiceband: { atk: 1.5 },
  choicespecs: { spa: 1.5 },
  expertbelt: { superEffectiveOnly: 1.2 },
  muscleband: { physical: 1.1 },
  wiseglasses: { special: 1.1 },
  assaultvest: { spd: 1.5 },
  eviolite: { def: 1.5, spd: 1.5, notFullyEvolved: true },
};
const ABILITY_MODS = {
  adaptability: { stab: 2 },
  hugepower: { atk: 2 }, purepower: { atk: 2 },
  guts: { atkWhenStatused: 1.5, ignoresBurn: true },
  sheerforce: { dmgWithSecondary: 1.3 },
  technician: { weakMoveBoost: 1.5 },
  solidrock: { resistSuperEffective: 0.75 },
  filter: { resistSuperEffective: 0.75 },
  levitate: { groundImmune: true },
  thickfat: { halveFireIce: true },
};

function pokeRound(n) {
  // The engine rounds .5 DOWN, unlike Math.round.
  return Math.floor(n) + ((n % 1) > 0.5 ? 1 : 0);
}

/**
 * Damage roll range for one attacker/defender/move.
 * Returns null when the move cannot deal damage at all.
 */
function calcDamage(atk, def, move, field = {}) {
  if (!move || move.category === 'STATUS') return null;
  const power = move.power || 0;
  if (!power) return null;

  const physical = move.category === 'PHYSICAL';
  const atkAb = norm(atk.ability);
  const defAb = norm(def.ability);
  const atkItem = norm(atk.item);
  const defItem = norm(def.item);

  // Type effectiveness, from Kudzu's own chart.
  let eff = 1;
  for (const t of new Set(def.types)) {
    const row = D.typechart.matchups[move.type];
    if (row && row[t] !== undefined) eff *= row[t];
  }
  if (ABILITY_MODS[defAb]?.groundImmune && move.type === 'TYPE_GROUND') eff = 0;
  if (eff === 0) return { immune: true, eff: 0 };

  // Attack / Defense, with stages. A critical hit ignores the defender's
  // positive defence stages and the attacker's negative offence stages.
  const aKey = physical ? 'attack' : 'spAttack';
  const dKey = physical ? 'defense' : 'spDefense';
  let A = atk.stats[aKey];
  let D_ = def.stats[dKey];

  const aStage = atk.boosts[aKey] || 0;
  const dStage = def.boosts[dKey] || 0;
  A = Math.floor(A * stageMul(field.crit && aStage < 0 ? 0 : aStage));
  D_ = Math.floor(D_ * stageMul(field.crit && dStage > 0 ? 0 : dStage));

  if (ABILITY_MODS[atkAb]?.atk) A = Math.floor(A * ABILITY_MODS[atkAb].atk);
  if (atkItem === 'choiceband' && physical) A = Math.floor(A * 1.5);
  if (atkItem === 'choicespecs' && !physical) A = Math.floor(A * 1.5);
  if (defItem === 'assaultvest' && !physical) D_ = Math.floor(D_ * 1.5);

  // Kudzu keeps the Gen 4 behaviour: Explosion and Self-Destruct halve Defense.
  if (D.manifest?.config?.battle?.B_EXPLOSION_DEFENSE === 3 && move.flags?.explosion) {
    D_ = Math.max(1, Math.floor(D_ / 2));
  }

  const lvl = Math.floor((2 * atk.level) / 5) + 2;
  const base = Math.floor(Math.floor((lvl * power * A) / D_) / 50) + 2;

  // Modifier chain.
  let mod = 1;
  if (field.weather === 'rain') {
    if (move.type === 'TYPE_WATER') mod *= 1.5;
    if (move.type === 'TYPE_FIRE') mod *= 0.5;
  } else if (field.weather === 'sun') {
    if (move.type === 'TYPE_FIRE') mod *= 1.5;
    if (move.type === 'TYPE_WATER') mod *= 0.5;
  }
  if (field.crit) mod *= 1.5;

  let stab = 1;
  if (atk.types.includes(move.type)) {
    stab = ABILITY_MODS[atkAb]?.stab || 1.5;
  }

  let other = 1;
  if (field.screens && !field.crit) other *= 0.5;
  if (ITEM_MODS[atkItem]?.dmg) other *= ITEM_MODS[atkItem].dmg;
  if (atkItem === 'expertbelt' && eff > 1) other *= 1.2;
  if (atkItem === 'muscleband' && physical) other *= 1.1;
  if (atkItem === 'wiseglasses' && !physical) other *= 1.1;
  if (eff > 1 && ABILITY_MODS[defAb]?.resistSuperEffective) other *= 0.75;
  if (ABILITY_MODS[defAb]?.halveFireIce
      && (move.type === 'TYPE_FIRE' || move.type === 'TYPE_ICE')) other *= 0.5;
  if (field.burn && physical && !ABILITY_MODS[atkAb]?.ignoresBurn) other *= 0.5;

  const hits = move.minMaxHits && move.minMaxHits.max > 1
    ? move.minMaxHits : { min: 1, max: 1 };

  const rolls = [];
  for (let r = 85; r <= 100; r += 1) {
    let d = Math.floor(base * mod);
    d = Math.floor((d * r) / 100);
    d = pokeRound(d * stab);
    d = Math.floor(d * eff);
    d = Math.max(1, Math.floor(d * other));
    rolls.push(d);
  }

  const hp = def.stats.hp;
  const min = rolls[0] * hits.min;
  const max = rolls[rolls.length - 1] * hits.max;

  return {
    immune: false,
    eff,
    rolls,
    hits,
    min,
    max,
    hp,
    minPct: (min / hp) * 100,
    maxPct: (max / hp) * 100,
    ko: koChance(rolls, hp, hits),
  };
}

/** How many hits to faint, and whether it is guaranteed. */
function koChance(rolls, hp, hits) {
  const min = rolls[0] * hits.min;
  const max = rolls[rolls.length - 1] * hits.max;
  if (max <= 0) return { n: null, label: 'no damage' };
  const best = Math.ceil(hp / max);          // fewest hits needed
  const worst = Math.ceil(hp / Math.max(1, min));
  if (best === worst) return { n: best, guaranteed: true, label: `${best}HKO` };
  // Fraction of the 16 rolls that reach the KO in `best` hits.
  const need = hp / best / hits.max;
  const good = rolls.filter((r) => r >= need).length;
  return {
    n: best,
    guaranteed: false,
    chance: (good / rolls.length) * 100,
    label: `${best}–${worst}HKO`,
  };
}

/** Best damaging move from one side against the other. */
function bestMove(atk, def, field) {
  let best = null;
  for (const mc of atk.moves) {
    const mv = D.moveBy[mc];
    if (!mv) continue;
    const res = calcDamage(atk, def, mv, field);
    if (!res || res.immune) continue;
    if (!best || res.max > best.res.max) best = { move: mv, res };
  }
  return best;
}
