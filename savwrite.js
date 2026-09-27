/* Writing a Pokémon back into a .sav — sav.js run in reverse.
 *
 * The Sandbox tab edits a Pokémon the game already has: its species, level,
 * nature, ability slot, held item, IVs and moves. Nothing is created and
 * nothing moves - the 80 (box) or 100 (party) bytes that are already there are
 * decrypted, changed, re-encrypted and put back, and the checksums the game
 * verifies on load are brought up to date.
 *
 * What the game checks, and therefore what this has to get right:
 *
 *   the Pokémon    BoxPokemon.checksum is the sum of the 24 decrypted halfwords
 *                  of the secure block. A mismatch makes it a Bad Egg.
 *   the sector     every 4 KB sector carries a checksum of its data region
 *                  (CalculateChecksum in src/save.c). A mismatch makes the game
 *                  refuse the whole slot and fall back to the older one.
 *
 * The sector checksum covers only `sizeof(struct)` bytes of the last sector of
 * a block, and the struct sizes are exactly what this fork's headers cannot be
 * trusted on (see findLevelCap in sav.js). They are not needed: the game zeroes
 * the sector buffer before filling it, so the bytes past the struct are zero and
 * summing the WHOLE data region gives the same number. That is not assumed - it
 * is checked against every sector of the live slot before a byte is changed,
 * and a save where it does not hold is refused.
 *
 * A party Pokémon also stores its level and battle stats, which the game only
 * recomputes on a level-up or a trip through the PC. They are recomputed here
 * with CalculateMonStats' own integer arithmetic - verified against a real
 * save, where it reproduces every stored stat of all six party Pokémon.
 *
 * Nature is written the way the game's own mints and the bottle-cap NPC write
 * it: BoxPokemon.hiddenNatureModifier, leaving the personality alone. Changing
 * the personality instead would also change the substruct order, the gender,
 * shininess and the key the tracker follows a Pokémon by.
 *
 * No DOM and no globals beyond sav.js: every dataset arrives as an argument, so
 * the self-test can run this against a real save.
 */
'use strict';

const SAVW_STATS = ['hp', 'attack', 'defense', 'speed', 'spAttack', 'spDefense'];
const SAVW_IV_FIELD = {
  hp: 'hpIV', attack: 'attackIV', defense: 'defenseIV',
  speed: 'speedIV', spAttack: 'spAttackIV', spDefense: 'spDefenseIV',
};

/** CalculateChecksum in src/save.c: u32 words summed, then folded to 16 bits. */
function sectorChecksum(u8, base, size) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let total = 0;
  for (let i = 0; i + 4 <= size; i += 4) total = (total + v.getUint32(base + i, true)) >>> 0;
  return ((total >>> 16) + total) & 0xFFFF;
}

/** Store a bitfield described by monlayout - the inverse of bits() in sav.js. */
function wrBits(view, base, f, value) {
  const at = base + f.byteOffset;
  const n = f.bytes;
  const width = f.bitOffset == null ? n * 8 : f.bitWidth;
  const max = width >= 32 ? 0xFFFFFFFF : ((1 << width) >>> 0) - 1;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${f.name}: ${value} does not fit in ${width} bits`);
  }
  const read = () => (n === 1 ? view.getUint8(at) : n === 2 ? view.getUint16(at, true) : view.getUint32(at, true));
  const write = (x) => {
    if (n === 1) view.setUint8(at, x); else if (n === 2) view.setUint16(at, x, true);
    else view.setUint32(at, x >>> 0, true);
  };
  if (f.bitOffset == null) { write(value); return; }
  const mask = (max << f.bitOffset) >>> 0;
  write((((read() & ~mask) >>> 0) | ((value << f.bitOffset) >>> 0)) >>> 0);
}

/* ── experience, level, stats ─────────────────────────────────────── */

function growthRow(sp, experience) {
  const rate = sp && sp.growthRate;
  if (!experience || !experience.tables || !rate) return null;
  const g = (experience.growthRates || []).find((x) => x.id === rate.id || x.constant === rate.constant);
  return g ? experience.tables[g.row] : null;
}

/** GetLevelFromBoxMonExp: the highest level whose requirement the exp has met. */
function levelForExp(sp, exp, experience) {
  const row = growthRow(sp, experience);
  if (!row) return null;
  let lv = 1;
  for (let i = 1; i < row.length; i += 1) {
    if (row[i] == null || row[i] > exp) break;
    lv = i;
  }
  return Math.min(lv, experience.maxLevel || 100);
}

function expForLevel(sp, level, experience) {
  const row = growthRow(sp, experience);
  return row && row[level] != null ? row[level] : null;
}

/**
 * CalculateMonStats in src/pokemon.c, integer for integer.
 *
 * `hyper` marks Hyper Trained stats, which the game computes as IV 31 without
 * touching the IV. Friendship does nothing here: B_FRIENDSHIP_BOOST is FALSE.
 */
function calcMonStats(sp, level, ivs, evs, hyper, nature) {
  const out = {};
  const mods = (nature && nature.modifiers) || {};
  for (const k of SAVW_STATS) {
    const base = sp.baseStats[k];
    const iv = hyper && hyper[k] ? 31 : ivs[k];
    const ev = (evs && evs[k]) || 0;
    if (k === 'hp') {
      out.hp = sp.constant === 'SPECIES_SHEDINJA' ? 1
        : Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
      continue;
    }
    let n = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5;
    // ModifyStatByNature: stat * 110 / 100 or stat * 90 / 100, truncated.
    if (mods[k] > 1) n = Math.floor((n * 110) / 100);
    else if (mods[k] < 1) n = Math.floor((n * 90) / 100);
    out[k] = n;
  }
  return out;
}

/* ── names ────────────────────────────────────────────────────────── */

/** char -> byte, from the extracted charmap. The first byte to claim a
    character wins, which is the rule the decoder uses in the other direction. */
function reverseCharmap(charmap) {
  const rev = new Map();
  for (const [code, ch] of Object.entries(charmap || {})) {
    if (!rev.has(ch)) rev.set(ch, Number(code));
  }
  // charmap.txt maps both the typographic and the plain apostrophe to one
  // byte; only the first survives extraction, and species names use the other.
  if (!rev.has("'") && rev.has('’')) rev.set("'", rev.get('’'));
  return rev;
}

/** A name as `length` game bytes, terminator-padded; null if it cannot be spelt. */
function encodeName(text, charmap, terminator, length) {
  const rev = reverseCharmap(charmap);
  const chars = [...String(text || '')];
  if (!chars.length || chars.length > length) return null;
  const out = new Array(length).fill(terminator);
  for (let i = 0; i < chars.length; i += 1) {
    const b = rev.get(chars[i]);
    if (b == null || b === terminator) return null;
    out[i] = b;
  }
  return out;
}

/* ── where a Pokémon is ───────────────────────────────────────────── */

/** target: {where:'party', slot} or {where:'box', box (1-based), slot}. */
function monAddress(L, target) {
  if (target.where === 'party') {
    const B1 = L.saveBlock1;
    if (!(target.slot >= 0 && target.slot < B1.partySize)) return null;
    return {
      party: true, first: L.sectorIds.saveBlock1Start, last: L.sectorIds.saveBlock1End,
      offset: B1.playerParty + target.slot * B1.monBytes, bytes: B1.monBytes,
    };
  }
  const St = L.storage.boxes;
  const b = target.box - 1;
  if (!(b >= 0 && b < St.boxes && target.slot >= 0 && target.slot < St.perBox)) return null;
  return {
    party: false, first: L.sectorIds.storageStart, last: L.sectorIds.storageEnd,
    offset: St.offset + (b * St.perBox + target.slot) * St.entryBytes, bytes: St.entryBytes,
  };
}

const targetLabel = (t) => (t.where === 'party'
  ? `party slot ${t.slot + 1}` : `box ${t.box}, slot ${t.slot + 1}`);

/* ── the edit ─────────────────────────────────────────────────────── */

/**
 * Apply `edit` to the Pokémon at `target` and return a NEW buffer.
 *
 *   data       {speciesById, moveById, itemById, natureById: Map, experience}
 *   expectKey  `${personality}:${otId}` of the Pokémon the edit was made for.
 *              The file is re-read right before writing, and a Pokémon that has
 *              since been moved or released must not have its slot's new
 *              occupant edited in its place.
 *   edit       any of {speciesId, level, natureId, abilityNum, heldItemId,
 *              ivs: {hp..}, moveIds: [4]}. A key that is absent is left alone.
 *
 * Returns {bytes, report} or {error}. The input is never modified, and the
 * result has already been read back and checked - see verifyEdit.
 */
function applyMonEdit(bytes, L, ML, data, target, expectKey, edit) {
  try {
    return applyMonEditUnsafe(bytes, L, ML, data, target, expectKey, edit);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function applyMonEditUnsafe(bytes, L, ML, data, target, expectKey, edit) {
  const S = L.sector;
  const out = bytes.slice(0);
  const u8 = new Uint8Array(out);
  const slot = savSlot(out, S);
  if (slot.error) return { error: slot.error };
  if (slot.live.length !== S.perSlot) {
    return { error: `save slot ${slot.useSlot + 1} has ${slot.live.length} of ${S.perSlot} sectors - `
      + 'it is mid-write or damaged, and is not edited in that state' };
  }
  for (const s of slot.live) {
    if (sectorChecksum(u8, s.base, S.dataSize) !== s.checksum) {
      return { error: `sector ${s.index} (id ${s.id}) does not match its own checksum before any `
        + 'change. The writer relies on reproducing the game\'s checksums, so it will not '
        + 'touch a save where it cannot.' };
    }
  }

  const addr = monAddress(L, target);
  if (!addr) return { error: `there is no ${targetLabel(target)}` };

  // The block as the game sees it: the data regions of its sectors, in id order.
  const block = new Uint8Array((addr.last - addr.first + 1) * S.dataSize);
  for (const s of slot.live) {
    if (s.id < addr.first || s.id > addr.last) continue;
    block.set(u8.subarray(s.base, s.base + S.dataSize), (s.id - addr.first) * S.dataSize);
  }
  const base = addr.offset;
  const before = addr.party ? parsePartyMon(block.buffer, base, L, ML) : parseBoxMon(block.buffer, base, L, ML);
  if (!before) return { error: `${targetLabel(target)} is empty` };
  if (`${before.personality}:${before.otId}` !== expectKey) {
    return { error: `a different Pokémon is in ${targetLabel(target)} now - the save changed `
      + 'since it was loaded. Reload and make the edit again.' };
  }
  if (!before.checksumOk || before.isBadEgg) {
    return { error: 'that Pokémon already fails its own checksum (a Bad Egg); it is left alone' };
  }
  if (before.isEgg) return { error: 'eggs are not edited' };

  const F = L.boxPokemon.fields;
  const bv = new DataView(block.buffer);
  const key = (before.personality ^ before.otId) >>> 0;
  const secBase = base + F.secure.offset;
  const dec = new ArrayBuffer(F.secure.bytes);
  const dv = new DataView(dec);
  for (let i = 0; i < F.secure.bytes; i += 4) {
    dv.setUint32(i, (bv.getUint32(secBase + i, true) ^ key) >>> 0, true);
  }
  const order = SUBSTRUCT_ORDERS[before.personality % 24];
  const size = ML.substructSizeBytes;
  const at = {};
  ['g', 'a', 'e', 'm'].forEach((k, want) => { at[k] = order.indexOf(want) * size; });
  const S0 = ML.structs.PokemonSubstruct0.byName;
  const S1 = ML.structs.PokemonSubstruct1.byName;
  const S3 = ML.structs.PokemonSubstruct3.byName;

  const oldSp = data.speciesById.get(before.speciesId);
  if (!oldSp) return { error: `species #${before.speciesId} is not in the species dataset` };
  const notes = [];

  /* species */
  let sp = oldSp;
  if (edit.speciesId != null && edit.speciesId !== before.speciesId) {
    sp = data.speciesById.get(edit.speciesId);
    if (!sp) return { error: `species #${edit.speciesId} is not in the species dataset` };
    wrBits(dv, at.g, S0.species, sp.id);
    // A Pokémon with no nickname stores its species name, and the game tells
    // the two apart by comparing them - so an un-nicknamed one has to follow
    // the species or it becomes a Charizard nicknamed "Bewear".
    const term = L.terminator;
    const current = decodeName(before.nicknameBytes, L.charmap, term);
    if (current === oldSp.displayName) {
      const enc = encodeName(sp.displayName, L.charmap, term, F.nickname.bytes + 2);
      if (enc) {
        for (let i = 0; i < F.nickname.bytes; i += 1) bv.setUint8(base + F.nickname.offset + i, enc[i]);
        if (S0.nickname11) wrBits(dv, at.g, S0.nickname11, enc[F.nickname.bytes]);
        if (S0.nickname12) wrBits(dv, at.g, S0.nickname12, enc[F.nickname.bytes + 1]);
      } else {
        notes.push(`"${sp.displayName}" cannot be spelt in the game's character set, so the name `
          + `stays "${current}"`);
      }
    }
  }

  /* level -> experience. A box Pokémon has no level of its own. */
  const oldLevel = before.level ?? levelForExp(oldSp, before.experience, data.experience);
  let level = oldLevel;
  if (edit.level != null) {
    level = Math.max(1, Math.min(data.experience.maxLevel || 100, Math.trunc(edit.level)));
  }
  let experience = before.experience;
  const curveChanged = sp !== oldSp
    && growthRow(sp, data.experience) !== growthRow(oldSp, data.experience);
  if (level !== oldLevel || curveChanged
      || levelForExp(sp, experience, data.experience) !== level) {
    // Exactly the level's threshold: the species' own curve decides the level,
    // so the same experience is a different level on another curve.
    const need = expForLevel(sp, level, data.experience);
    if (need == null) return { error: `no experience table for ${sp.constant}` };
    experience = need;
    wrBits(dv, at.g, S0.experience, experience);
  }

  /* nature, ability slot, held item */
  let natureId = before.natureId;
  if (edit.natureId != null && edit.natureId !== before.natureId) {
    if (!data.natureById.has(edit.natureId)) return { error: `nature #${edit.natureId} does not exist` };
    natureId = edit.natureId;
    const lf = F.hiddenNatureModifier;
    const byteAt = base + lf.offset;
    const mask = ((1 << lf.bits[1]) - 1) << lf.bits[0];
    const modifier = (before.personality % 25) ^ natureId;
    bv.setUint8(byteAt, (bv.getUint8(byteAt) & ~mask & 0xFF) | ((modifier << lf.bits[0]) & mask));
  }
  if (edit.abilityNum != null && edit.abilityNum !== before.abilityNum) {
    if (!S3.abilityNum) return { error: 'this build has no abilityNum field' };
    if (!(edit.abilityNum >= 0 && edit.abilityNum <= 2)) return { error: 'ability slot must be 0, 1 or 2' };
    wrBits(dv, at.m, S3.abilityNum, edit.abilityNum);
  }
  if (edit.heldItemId != null && edit.heldItemId !== before.heldItemId) {
    if (edit.heldItemId !== 0 && !data.itemById.has(edit.heldItemId)) {
      return { error: `item #${edit.heldItemId} is not in the items dataset` };
    }
    wrBits(dv, at.g, S0.heldItem, edit.heldItemId);
  }

  /* IVs */
  const ivs = Object.assign({}, before.ivs);
  if (edit.ivs) {
    for (const k of SAVW_STATS) {
      if (edit.ivs[k] == null) continue;
      const n = Math.trunc(edit.ivs[k]);
      if (!(n >= 0 && n <= 31)) return { error: `${k} IV must be 0-31` };
      ivs[k] = n;
      wrBits(dv, at.m, S3[SAVW_IV_FIELD[k]], n);
    }
  }

  /* moves. A move that stays keeps its PP and its PP Ups wherever it ends up;
     a new one arrives full with none, which is what the game does when a move
     is replaced (RemoveMonPPBonus). Gaps are closed: the game's menus expect
     the moves packed from the first slot. */
  let finalMoves = before.moveIds;
  if (edit.moveIds) {
    const want = edit.moveIds.map((n) => Math.trunc(n || 0)).filter((n) => n > 0);
    finalMoves = [0, 1, 2, 3].map((i) => want[i] || 0);
    if (!want.length) return { error: 'a Pokémon needs at least one move' };
    if (want.length > 4) return { error: 'four moves at most' };
    if (new Set(want).size !== want.length) return { error: 'the same move is listed twice' };
    const had = before.moveIds.map((id, i) => ({
      id, pp: before.pp[i], bonus: (before.ppBonuses >>> (2 * i)) & 3,
    }));
    const moveF = [S1.move1, S1.move2, S1.move3, S1.move4];
    const ppF = [S1.pp1, S1.pp2, S1.pp3, S1.pp4];
    let bonuses = 0;
    for (let i = 0; i < 4; i += 1) {
      const id = want[i] || 0;
      let pp = 0; let bonus = 0;
      if (id) {
        const rec = data.moveById.get(id);
        if (!rec) return { error: `move #${id} is not in the moves dataset` };
        const kept = had.find((h) => h.id === id);
        if (kept) { pp = kept.pp; bonus = kept.bonus; } else { pp = rec.pp || 0; }
      }
      wrBits(dv, at.a, moveF[i], id);
      wrBits(dv, at.a, ppF[i], Math.min(pp, 127));
      bonuses |= bonus << (2 * i);
    }
    if (S0.ppBonuses) wrBits(dv, at.g, S0.ppBonuses, bonuses);
  }

  /* stats and HP */
  const nature = data.natureById.get(natureId);
  const oldNature = data.natureById.get(before.natureId);
  const oldStats = calcMonStats(oldSp, oldLevel, before.ivs, before.evs, before.hyperTrained, oldNature);
  const stats = calcMonStats(sp, level, ivs, before.evs, before.hyperTrained, nature);
  const hl = F.hpLost;
  const hlAt = base + hl.offset;
  const hlMask = (1 << hl.bits[1]) - 1;
  const setHpLost = (n) => bv.setUint16(hlAt, (bv.getUint16(hlAt, true) & ~hlMask & 0xFFFF)
    | (Math.max(0, n) & hlMask), true);
  let hp = null;
  if (addr.party) {
    const P = L.pokemon.fields;
    // CalculateMonStats: a fainted Pokémon stays fainted, a gain in max HP is
    // added to current HP, and current HP never exceeds the maximum.
    const oldMax = before.maxHP;
    hp = before.hp;
    if (!(hp === 0 && oldMax !== 0)) {
      if (stats.hp > oldMax) hp += stats.hp - oldMax;
      if (hp > stats.hp) hp = stats.hp;
    }
    bv.setUint8(base + P.level.offset, level);
    bv.setUint16(base + P.hp.offset, hp, true);
    bv.setUint16(base + P.maxHP.offset, stats.hp, true);
    for (const k of SAVW_STATS.slice(1)) bv.setUint16(base + P[k].offset, stats[k], true);
    setHpLost(stats.hp - hp);
  } else if (stats.hp !== oldStats.hp) {
    // A box Pokémon stores the HP it has LOST, and BoxMonToMon subtracts that
    // from a freshly computed maximum - unsigned, so a loss larger than the new
    // maximum would wrap. Fainted stays fainted; anything else keeps its damage
    // but is left at least 1 HP.
    const lost = before.hpLost;
    setHpLost(lost >= oldStats.hp ? stats.hp : Math.min(lost, stats.hp - 1));
  }

  /* re-encrypt, re-checksum the Pokémon */
  let sum = 0;
  for (let i = 0; i < F.secure.bytes; i += 2) sum = (sum + dv.getUint16(i, true)) & 0xFFFF;
  bv.setUint16(base + F.checksum.offset, sum, true);
  for (let i = 0; i < F.secure.bytes; i += 4) {
    bv.setUint32(secBase + i, (dv.getUint32(i, true) ^ key) >>> 0, true);
  }

  /* put the Pokémon's bytes back into whichever sectors hold them - eight box
     slots straddle two - and bring those sectors' checksums up to date. */
  const allowed = [];                                // file ranges that may differ
  const touched = [];
  for (const s of slot.live) {
    if (s.id < addr.first || s.id > addr.last) continue;
    const lo = (s.id - addr.first) * S.dataSize;
    const from = Math.max(base, lo);
    const to = Math.min(base + addr.bytes, lo + S.dataSize);
    if (from >= to) continue;
    u8.set(block.subarray(from, to), s.base + (from - lo));
    allowed.push([s.base + (from - lo), s.base + (to - lo)]);
    new DataView(out).setUint16(s.base + S.checksumOffset, sectorChecksum(u8, s.base, S.dataSize), true);
    allowed.push([s.base + S.checksumOffset, s.base + S.checksumOffset + 2]);
    touched.push(s.index);
  }
  if (!touched.length) return { error: 'the Pokémon\'s sector was not found in the live slot' };

  const expected = {
    speciesId: sp.id, level, natureId, experience,
    abilityNum: edit.abilityNum != null ? edit.abilityNum : before.abilityNum,
    heldItemId: edit.heldItemId != null ? edit.heldItemId : before.heldItemId,
    ivs,
    moveIds: finalMoves,
    stats: addr.party ? stats : null,
    hp,
  };
  const problem = verifyEdit(bytes, out, L, ML, target, expectKey, expected, allowed, data);
  if (problem) return { error: `the edited save failed its own check and was discarded: ${problem}` };

  const changedBytes = countDiff(bytes, out);
  return {
    bytes: out,
    report: {
      target, slot: slot.useSlot + 1, sectorsTouched: touched, changedBytes, notes,
      before: {
        speciesId: before.speciesId, level: oldLevel, natureId: before.natureId,
        abilityNum: before.abilityNum, heldItemId: before.heldItemId, ivs: before.ivs,
        moveIds: before.moveIds, stats: oldStats,
      },
      after: Object.assign({}, expected, { stats }),
    },
  };
}

function countDiff(a, b) {
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  let n = 0;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) n += 1;
  return n;
}

/**
 * Read the edited save back as a stranger would and refuse it unless:
 *
 *   - it is the same length, and every byte that differs lies inside the
 *     Pokémon that was edited or a checksum field of a sector holding it;
 *   - every sector of the live slot matches its checksum, and the live slot is
 *     the same one;
 *   - the save parses with no Pokémon failing its checksum;
 *   - the Pokémon at the target reads back with exactly the intended values,
 *     and every other Pokémon reads back exactly as it did before.
 *
 * Returns null when all of that holds, otherwise what did not.
 */
function verifyEdit(original, edited, L, ML, target, expectKey, expected, allowed, data) {
  if (original.byteLength !== edited.byteLength) return 'the length changed';
  const a = new Uint8Array(original); const b = new Uint8Array(edited);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (!allowed.some(([lo, hi]) => i >= lo && i < hi)) return `byte ${i} changed outside the Pokémon`;
  }
  const S = L.sector;
  const was = savSlot(original, S); const now = savSlot(edited, S);
  if (now.error) return now.error;
  if (now.useSlot !== was.useSlot || now.live.length !== was.live.length) return 'the live slot changed';
  for (const s of now.live) {
    if (sectorChecksum(b, s.base, S.dataSize) !== s.checksum) return `sector ${s.index} fails its checksum`;
  }
  const p0 = parseSav(original, L, ML); const p1 = parseSav(edited, L, ML);
  if (p1.error) return p1.error;
  const flat = (p) => [
    ...p.party.map((m) => ({ where: 'party', slot: m.slot, m })),
    ...p.boxes.flatMap((bx) => bx.mons.map((m) => ({ where: 'box', box: bx.number, slot: m.slot, m }))),
  ];
  const l0 = flat(p0); const l1 = flat(p1);
  if (l0.length !== l1.length) return 'the number of Pokémon changed';
  const isTarget = (e) => e.where === target.where && e.slot === target.slot
    && (target.where === 'party' || e.box === target.box);
  let seen = false;
  for (let i = 0; i < l1.length; i += 1) {
    const e = l1[i];
    if (!e.m.checksumOk) return `${targetLabel(e)} fails its checksum`;
    if (!isTarget(e)) {
      if (JSON.stringify(e.m) !== JSON.stringify(l0[i].m)) return `${targetLabel(e)} changed as well`;
      continue;
    }
    seen = true;
    const m = e.m;
    if (`${m.personality}:${m.otId}` !== expectKey) return 'the Pokémon\'s identity changed';
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    if (m.speciesId !== expected.speciesId) return 'species did not read back';
    if (m.natureId !== expected.natureId) return 'nature did not read back';
    if (m.abilityNum !== expected.abilityNum) return 'ability slot did not read back';
    if (m.heldItemId !== expected.heldItemId) return 'held item did not read back';
    if (m.experience !== expected.experience) return 'experience did not read back';
    if (!same(m.ivs, expected.ivs)) return 'IVs did not read back';
    if (!same(m.moveIds, expected.moveIds)) return 'moves did not read back';
    const sp = data.speciesById.get(m.speciesId);
    if (levelForExp(sp, m.experience, data.experience) !== expected.level) return 'level does not follow from the experience';
    if (expected.stats) {
      if (m.level !== expected.level) return 'party level did not read back';
      if (m.maxHP !== expected.stats.hp || m.hp !== expected.hp) return 'HP did not read back';
      for (const k of SAVW_STATS.slice(1)) {
        if (m.stats[k] !== expected.stats[k]) return `${k} did not read back`;
      }
      if (m.hp > m.maxHP) return 'current HP exceeds the maximum';
    }
  }
  if (!seen) return 'the edited Pokémon was not found afterwards';
  // Everything outside the roster - trainer, bag, flags, the level cap.
  const rest = (p) => JSON.stringify([p.trainer, p.partyCount, p.currentBox, p.levelCap,
    p.bag, p.flags && p.flags.trainersDefeated, p.flags && p.flags.badges, p.slot, p.counter]);
  if (rest(p0) !== rest(p1)) return 'something other than the Pokémon changed';
  return null;
}
