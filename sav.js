/* Gen 3 .sav parser — driven entirely by the extracted layout.
 *
 * Every offset, width and constant comes from data/savelayout.json and
 * data/monlayout.json, both computed from the headers on each extraction. That
 * is not ceremony: this fork has moved enough that a stock Gen 3 parser reads
 * several fields wrong.
 *
 *   species is 11 bits, sharing a halfword with teraType (vanilla: a full u16)
 *   heldItem is 10 bits              move slots are 11 bits each
 *   experience is 21 bits            killCount is an added 8-bit field
 *   nickname is 12 characters: 10 in BoxPokemon plus nickname11 and
 *     nickname12 packed into substruct 0 — truncating at 10 loses the tail
 *   every sector carries a 116-byte SaveBlock3 chunk before its footer
 *
 * No DOM here. savui.js is the interface; keeping them apart lets the self-test
 * run this against a real save file.
 */
'use strict';

/* The 24 substruct orders are the permutations of (Growth, Attacks, EVs, Misc)
   in lexicographic order, indexed by personality % 24. Generated rather than
   transcribed — a 24-row table copied by hand is a needless place for a typo. */
const SUBSTRUCT_ORDERS = (() => {
  const out = [];
  const permute = (arr, cur) => {
    if (!arr.length) { out.push(cur); return; }
    for (let i = 0; i < arr.length; i += 1) {
      permute(arr.slice(0, i).concat(arr.slice(i + 1)), cur.concat(arr[i]));
    }
  };
  permute([0, 1, 2, 3], []);
  return out;
})();

const rd8 = (v, o) => v.getUint8(o);
const rd16 = (v, o) => v.getUint16(o, true);
const rd32 = (v, o) => v.getUint32(o, true);

/** Pull a bitfield described by monlayout: {byteOffset, bitOffset, bitWidth}. */
function bits(view, base, f) {
  if (f.bitOffset == null) {
    const n = f.bytes;
    return n === 1 ? rd8(view, base + f.byteOffset)
      : n === 2 ? rd16(view, base + f.byteOffset)
        : rd32(view, base + f.byteOffset);
  }
  // Read the whole storage unit, then shift. Reading a u32 at a 2-byte offset
  // is fine here because every unit is naturally aligned by construction.
  const unit = f.bytes === 1 ? rd8(view, base + f.byteOffset)
    : f.bytes === 2 ? rd16(view, base + f.byteOffset)
      : rd32(view, base + f.byteOffset);
  return (unit >>> f.bitOffset) & ((f.bitWidth >= 32 ? 0xFFFFFFFF : (1 << f.bitWidth) - 1));
}

function decodeName(bytes, charmap, terminator) {
  let s = '';
  for (const b of bytes) {
    if (b === terminator) break;
    s += charmap[String(b)] ?? '';
  }
  return s;
}

/** Parse one 80-byte BoxPokemon (or the box half of a 100-byte Pokemon). */
function parseBoxMon(buf, base, L, ML) {
  const v = new DataView(buf);
  const F = L.boxPokemon.fields;
  const personality = rd32(v, base + F.personality.offset);
  const otId = rd32(v, base + F.otId.offset);
  if (personality === 0 && otId === 0) return null;      // empty slot

  // Decrypt the 48-byte secure block: XOR each u32 with personality ^ otId.
  const key = (personality ^ otId) >>> 0;
  const secBase = base + F.secure.offset;
  const dec = new ArrayBuffer(F.secure.bytes);
  const dv = new DataView(dec);
  for (let i = 0; i < F.secure.bytes; i += 4) {
    dv.setUint32(i, (rd32(v, secBase + i) ^ key) >>> 0, true);
  }

  // Checksum: the sum of the decrypted halfwords, truncated to 16 bits.
  let sum = 0;
  for (let i = 0; i < F.secure.bytes; i += 2) sum = (sum + dv.getUint16(i, true)) & 0xFFFF;
  const stored = rd16(v, base + F.checksum.offset);

  const order = SUBSTRUCT_ORDERS[personality % 24];
  const sub = {};
  const size = ML.substructSizeBytes;
  ['g', 'a', 'e', 'm'].forEach((k, want) => { sub[k] = order.indexOf(want) * size; });

  const S0 = ML.structs.PokemonSubstruct0.byName;
  const S1 = ML.structs.PokemonSubstruct1.byName;
  const S2 = ML.structs.PokemonSubstruct2.byName;
  const S3 = ML.structs.PokemonSubstruct3.byName;
  const g = (f) => bits(dv, sub.g, f);
  const a = (f) => bits(dv, sub.a, f);
  const e = (f) => bits(dv, sub.e, f);
  const m = (f) => bits(dv, sub.m, f);

  // The nickname is 12 characters: 10 in the box struct, plus two more packed
  // into substruct 0. Stopping at 10 silently truncates long names.
  const nameBytes = [];
  for (let i = 0; i < F.nickname.bytes; i += 1) {
    nameBytes.push(rd8(v, base + F.nickname.offset + i));
  }
  if (S0.nickname11) nameBytes.push(g(S0.nickname11));
  if (S0.nickname12) nameBytes.push(g(S0.nickname12));

  const otBytes = [];
  for (let i = 0; i < F.otName.bytes; i += 1) {
    otBytes.push(rd8(v, base + F.otName.offset + i));
  }

  const langByte = rd8(v, base + F.language.offset);
  const flagByte = rd8(v, base + F.isBadEgg.offset);
  const pick = (f, byte) => (byte >>> f.bits[0]) & ((1 << f.bits[1]) - 1);

  const ivRaw = {
    hp: m(S3.hpIV), attack: m(S3.attackIV), defense: m(S3.defenseIV),
    speed: m(S3.speedIV), spAttack: m(S3.spAttackIV), spDefense: m(S3.spDefenseIV),
  };

  return {
    personality,
    otId,
    checksumOk: sum === stored,
    speciesId: g(S0.species),
    heldItemId: g(S0.heldItem),
    experience: g(S0.experience),
    friendship: g(S0.friendship),
    pokeball: S0.pokeball ? g(S0.pokeball) : null,
    teraTypeId: S0.teraType ? g(S0.teraType) : null,
    nicknameBytes: nameBytes,
    otNameBytes: otBytes,
    language: pick(F.language, langByte),
    hiddenNatureModifier: pick(F.hiddenNatureModifier, langByte),
    isEgg: !!pick(F.isEgg, flagByte),
    isBadEgg: !!pick(F.isBadEgg, flagByte),
    hasSpecies: !!pick(F.hasSpecies, flagByte),
    shinyModifier: (rd16(v, base + F.hpLost.offset) >>> F.shinyModifier.bits[0]) & 1,
    hpLost: rd16(v, base + F.hpLost.offset) & 0x3FFF,
    moveIds: [S1.move1, S1.move2, S1.move3, S1.move4].map((f) => a(f)),
    pp: [S1.pp1, S1.pp2, S1.pp3, S1.pp4].map((f) => a(f)),
    ppBonuses: S0.ppBonuses ? g(S0.ppBonuses) : 0,
    // Hyper Training does not touch the IV; CalculateMonStats reads the stat
    // as 31 while the flag is set. Same order as `ivs`.
    hyperTrained: {
      hp: S1.hyperTrainedHP ? !!a(S1.hyperTrainedHP) : false,
      attack: S1.hyperTrainedAttack ? !!a(S1.hyperTrainedAttack) : false,
      defense: S1.hyperTrainedDefense ? !!a(S1.hyperTrainedDefense) : false,
      speed: S1.hyperTrainedSpeed ? !!a(S1.hyperTrainedSpeed) : false,
      spAttack: S1.hyperTrainedSpAttack ? !!a(S1.hyperTrainedSpAttack) : false,
      spDefense: S1.hyperTrainedSpDefense ? !!a(S1.hyperTrainedSpDefense) : false,
    },
    evs: {
      hp: e(S2.hpEV), attack: e(S2.attackEV), defense: e(S2.defenseEV),
      speed: e(S2.speedEV), spAttack: e(S2.spAttackEV), spDefense: e(S2.spDefenseEV),
    },
    ivs: ivRaw,
    // The nature the game PLAYS with: MON_DATA_HIDDEN_NATURE in src/pokemon.c,
    // which is what CalculateMonStats uses. A mint, the bottle-cap NPC's Nature
    // Change and the Sandbox all leave the personality alone and write the
    // modifier, so reading personality % 25 on its own shows the nature the
    // Pokémon was born with rather than the one its stats follow.
    natureId: (personality % 25) ^ pick(F.hiddenNatureModifier, langByte),
    birthNatureId: personality % 25,
    killCount: S3.killCount ? m(S3.killCount) : null,
    abilityNum: S3.abilityNum ? m(S3.abilityNum) : null,
    metLevel: m(S3.metLevel),
    metLocation: m(S3.metLocation),
  };
}

/** Parse a full 100-byte party Pokemon: box half plus the battle stats. */
function parsePartyMon(buf, base, L, ML) {
  const box = parseBoxMon(buf, base, L, ML);
  if (!box) return null;
  const v = new DataView(buf);
  const P = L.pokemon.fields;
  box.level = rd8(v, base + P.level.offset);
  box.hp = rd16(v, base + P.hp.offset);
  box.maxHP = rd16(v, base + P.maxHP.offset);
  box.stats = {
    attack: rd16(v, base + P.attack.offset),
    defense: rd16(v, base + P.defense.offset),
    speed: rd16(v, base + P.speed.offset),
    spAttack: rd16(v, base + P.spAttack.offset),
    spDefense: rd16(v, base + P.spDefense.offset),
  };
  box.status = rd32(v, base + P.status.offset);
  return box;
}

/**
 * Read a .sav. Returns the newer save slot's party, boxes and trainer info.
 * `bytes` is an ArrayBuffer; a trailing RTC footer (mGBA writes 16 extra bytes)
 * is ignored.
 */
/**
 * The live level cap, read out of SaveBlock1.vars.
 *
 * The offset of `vars` cannot be taken from include/global.h. Its /*0x…*\/
 * comments are Emerald's: they put `flags` at 0x1270 and `vars` at 0x139C,
 * which needs FLAGS_COUNT 2400, but this build compiles the FireRed arm of
 * flags.h where it is 2304. Even correcting for that lands at 0x1390, and the
 * array is really at 0x1B8C - some struct before it grew by 0x7FC bytes. The
 * same comments were already found wrong for PokemonStorage.
 *
 * So the array is located by what it looks like instead of where it is claimed
 * to be, and the result has to pass two tests at once: 256 u16 that are nearly
 * all zero or small - which no packed struct or flag bitfield is - AND a value
 * at VAR_LEVEL_CAP's index that is one the ROM's scripts actually set. On a
 * real save exactly one window in 16 KB passes both. Anything else returns
 * null and the caller keeps whatever cap it had, because a wrong cap is worse
 * than no cap: it marks a legal team as cheating.
 */
function findLevelCap(sb1) {
  const prog = (typeof D !== 'undefined' && D.progression) || null;
  const lc = prog && prog.levelCap;
  if (!lc || lc.variableId == null || lc.varsStart == null) return null;

  const index = lc.variableId - lc.varsStart;
  // 0 is a legitimate cap - nothing sets the variable before the first town -
  // but it is useless for *finding* the array, because a mostly-zero window
  // reading 0 at that index describes half the unused space in the block. So a
  // save that early simply is not discovered, and the split-derived cap stands.
  const ladder = new Set((lc.sites || []).map((s) => s.value).filter((v) => v));
  if (!ladder.size) return null;

  const v = new DataView(sb1);
  const COUNT = 256;
  const BYTES = COUNT * 2;
  if (index < 0 || index >= COUNT) return null;

  const hits = [];
  for (let base = 0; base + BYTES <= sb1.byteLength; base += 2) {
    const value = v.getUint16(base + index * 2, true);
    if (!ladder.has(value)) continue;          // cheapest test first
    let zeros = 0;
    let small = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const x = v.getUint16(base + i * 2, true);
      if (x === 0) zeros += 1;
      if (x < 256) small += 1;
    }
    if (zeros >= 150 && small >= 230) hits.push({ offset: base, value });
    if (hits.length > 16) return null;         // nothing like a single array
  }
  if (!hits.length) return null;
  if (hits.length === 1) {
    return { level: hits[0].value, varsOffset: hits[0].offset, source: 'save' };
  }

  // More than one window looks like the vars array. That is not hypothetical:
  // a real save at cap 35 had a second, nearly empty region further into the
  // block that happened to read 33 - a ladder value - at the cap's index, and
  // refusing to choose cost that run its cap, badges and beaten trainers.
  //
  // SaveBlock1.flags sits directly before SaveBlock1.vars, and a save that has
  // a level cap at all has a Pokemon, so FLAG_SYS_POKEMON_GET is set in the
  // flag bytes before the REAL array. Before an impostor there is whatever
  // happens to be there - in the save above, zeros.
  const F = (typeof D !== 'undefined' && D.savelayout && D.savelayout.flags) || null;
  const pokemonGet = F && F.system ? F.system.FLAG_SYS_POKEMON_GET : null;
  if (pokemonGet == null || F.bytes == null) return null;
  const backed = hits.filter((h) => {
    const at = h.offset - F.bytes + (pokemonGet >>> 3);
    return at >= 0 && ((v.getUint8(at) >>> (pokemonGet & 7)) & 1) === 1;
  });
  if (backed.length !== 1) return null;        // still ambiguous: refuse to pick
  return {
    level: backed[0].value, varsOffset: backed[0].offset, source: 'save',
    candidates: hits.length,
  };
}

/**
 * Progress flags: badges, beaten trainers, a few system flags.
 *
 * `SaveBlock1.flags` sits immediately before `vars` in global.h, so once the
 * vars array has been found by signature the flags are the NUM_FLAG_BYTES
 * before it. That is the only anchor there is - the header's offset comments
 * are wrong for this build (see findLevelCap) - so with no cap found there
 * are no flags either, and the caller keeps whatever it knew.
 *
 * A trainer's flag is TRAINER_FLAGS_START + its id (HasTrainerBeenFought in
 * src/battle_setup.c); the ids come from the trainers dataset. Verified on a
 * real save: 30 flags set, every one a trainer on a map of the split the cap
 * placed the save in.
 */
function readFlags(sb1, varsOffset, F) {
  if (!F || varsOffset == null || F.bytes == null) return null;
  const base = varsOffset - F.bytes;
  if (base < 0) return null;
  const v = new DataView(sb1);
  const get = (n) => (n == null ? null
    : (v.getUint8(base + (n >>> 3)) >>> (n & 7)) & 1 ? true : false);

  const badges = (F.badges || []).map(get);
  const trainers = [];
  const start = F.trainerFlagsStart;
  const count = F.maxTrainers || 0;
  if (start != null) {
    for (let id = 0; id < count; id += 1) if (get(start + id)) trainers.push(id);
  }
  const system = {};
  for (const [name, n] of Object.entries(F.system || {})) system[name] = get(n);
  return {
    // Any flag by number - item pickups are checked against this.
    isSet: (n) => (n != null && n >= 0 && n < (F.count || F.bytes * 8) ? get(n) : null),
    flagsOffset: base,
    badges,
    badgeCount: badges.filter(Boolean).length,
    trainersDefeated: trainers,            // trainer ids, ascending
    system,
  };
}

/**
 * The bag: every pocket's slots, with quantities decoded.
 *
 * `B` is savelayout.bag - the offset is walked from the party and the pockets
 * come from `struct Bag`, both by the extractor. A slot is {u16 itemId, u16
 * quantity}, the quantity XORed with the low half of SaveBlock2.encryptionKey.
 * The key's offset in SaveBlock2 is one more header comment this fork cannot
 * be trusted on, and it is not needed: an EMPTY slot holds 0 ^ key, so the key
 * is whatever the empty slots agree on. With no empty slot in any pocket there
 * is no key, and quantities come back null rather than wrong.
 *
 * Returns null when the layout is missing, so the caller keeps what it knew.
 */
function readBag(sb1, B) {
  if (!B || B.offset == null || !Array.isArray(B.pockets)) return null;
  const v = new DataView(sb1);
  const slotBytes = B.slotBytes || 4;
  const raw = [];
  const keyVotes = new Map();
  let off = B.offset;
  for (const p of B.pockets) {
    for (let k = 0; k < p.slots; k += 1) {
      const at = off + k * slotBytes;
      if (at + 4 > sb1.byteLength) return null;
      const id = v.getUint16(at, true);
      const q = v.getUint16(at + 2, true);
      if (!id) keyVotes.set(q, (keyVotes.get(q) || 0) + 1);
      else raw.push({ pocket: p.pocket, member: p.member, itemId: id, q });
    }
    off += p.slots * slotBytes;
  }
  let key = null; let votes = 0; let total = 0;
  for (const [q, n] of keyVotes) { total += n; if (n > votes) { votes = n; key = q; } }
  // The empty slots must agree. If they do not, this is not the bag.
  const keyAgreed = key != null && votes / total >= 0.95;
  const pc = [];
  if (B.pcItems && B.pcItems.offset != null) {
    for (let k = 0; k < B.pcItems.slots; k += 1) {
      const at = B.pcItems.offset + k * slotBytes;
      const id = v.getUint16(at, true);
      if (id) pc.push({ itemId: id, quantity: v.getUint16(at + 2, true) });
    }
  }
  return {
    offset: B.offset,
    keyAgreed,
    emptySlots: total,
    slots: raw.map((s) => ({
      pocket: s.pocket, member: s.member, itemId: s.itemId,
      quantity: keyAgreed ? (s.q ^ key) : null,
    })),
    pcItems: pc,
  };
}

/**
 * Which save slot is live, and where its sectors are.
 *
 * Its own function because the reader is not the only caller: savwrite.js
 * patches a Pokémon in place, and it has to land in the slot the GAME will
 * load, which must be the slot this reader shows. One rule, used by both.
 */
function savSlot(bytes, S) {
  const v = new DataView(bytes);
  const need = S.size * S.total;
  if (bytes.byteLength < need) {
    return { error: `save is ${bytes.byteLength} bytes; expected at least ${need}` };
  }

  // Read every sector footer, then choose the slot with the higher counter.
  const sectors = [];
  for (let i = 0; i < S.total; i += 1) {
    const base = i * S.size;
    sectors.push({
      index: i,
      base,
      id: rd16(v, base + S.idOffset),
      checksum: rd16(v, base + S.checksumOffset),
      signature: rd32(v, base + S.signatureOffset),
      counter: rd32(v, base + S.counterOffset),
      valid: rd32(v, base + S.signatureOffset) === S.signature,
    });
  }

  const slotOf = (n) => sectors.slice(n * S.perSlot, (n + 1) * S.perSlot).filter((s) => s.valid);
  const slots = [slotOf(0), slotOf(1)];
  const score = (list) => (list.length ? Math.max(...list.map((s) => s.counter)) : -1);
  const useSlot = score(slots[1]) > score(slots[0]) ? 1 : 0;
  const live = slots[useSlot];
  if (!live.length) return { error: 'no valid save sectors found — wrong file?' };
  return { sectors, useSlot, live, counter: score(live), trailing: bytes.byteLength - need };
}

function parseSav(bytes, L, ML) {
  const warnings = [];
  const S = L.sector;
  const slot = savSlot(bytes, S);
  if (slot.error) return { error: slot.error };
  if (slot.trailing > 0) {
    warnings.push(`ignoring ${slot.trailing} trailing byte(s) — `
      + 'emulators append an RTC footer');
  }
  const { useSlot, live } = slot;
  if (live.length < S.perSlot) {
    warnings.push(`slot ${useSlot + 1} has ${live.length} of ${S.perSlot} sectors; `
      + 'the save may be mid-write or damaged');
  }

  /* Reassemble a logical block from the sectors carrying its id range. Each
     sector contributes dataSize bytes at (id - first) * dataSize — the 116-byte
     SaveBlock3 chunk after it belongs to a different block entirely. */
  const assemble = (first, last) => {
    const out = new Uint8Array((last - first + 1) * S.dataSize);
    let found = 0;
    for (const s of live) {
      if (s.id < first || s.id > last) continue;
      out.set(new Uint8Array(bytes, s.base, S.dataSize), (s.id - first) * S.dataSize);
      found += 1;
    }
    if (found !== last - first + 1) {
      warnings.push(`block ${first}–${last}: found ${found} of ${last - first + 1} sectors`);
    }
    return out.buffer;
  };

  const ids = L.sectorIds;
  const sb2 = assemble(ids.saveBlock2, ids.saveBlock2);
  const sb1 = assemble(ids.saveBlock1Start, ids.saveBlock1End);
  const storage = assemble(ids.storageStart, ids.storageEnd);

  const cm = L.charmap;
  const term = L.terminator;
  const name = (arr) => decodeName(arr, cm, term);

  // Trainer.
  const v2 = new DataView(sb2);
  const B2 = L.saveBlock2;
  const tnameBytes = [];
  for (let i = 0; i < B2.playerNameBytes; i += 1) tnameBytes.push(v2.getUint8(B2.playerName + i));
  const trainer = {
    name: name(tnameBytes),
    gender: v2.getUint8(B2.playerGender) ? 'female' : 'male',
    trainerId: v2.getUint16(B2.playerTrainerId, true),
    secretId: v2.getUint16(B2.playerTrainerId + 2, true),
    playTime: {
      hours: v2.getUint16(B2.playTimeHours, true),
      minutes: v2.getUint8(B2.playTimeMinutes),
      seconds: v2.getUint8(B2.playTimeSeconds),
    },
  };

  // Party.
  const B1 = L.saveBlock1;
  const v1 = new DataView(sb1);
  const cap = findLevelCap(sb1);
  const flags = cap ? readFlags(sb1, cap.varsOffset, L.flags) : null;
  const partyCount = Math.min(v1.getUint8(B1.playerPartyCount), B1.partySize);
  const party = [];
  for (let i = 0; i < partyCount; i += 1) {
    const mon = parsePartyMon(sb1, B1.playerParty + i * B1.monBytes, L, ML);
    if (mon) {
      mon.nickname = name(mon.nicknameBytes);
      mon.otName = name(mon.otNameBytes);
      mon.slot = i;
      party.push(mon);
    }
  }

  // Boxes, 1-indexed to match the in-game display.
  const St = L.storage;
  const boxes = [];
  for (let b = 0; b < St.boxes.boxes; b += 1) {
    const list = [];
    for (let s = 0; s < St.boxes.perBox; s += 1) {
      const off = St.boxes.offset + (b * St.boxes.perBox + s) * St.boxes.entryBytes;
      const mon = parseBoxMon(storage, off, L, ML);
      if (mon) {
        mon.nickname = name(mon.nicknameBytes);
        mon.otName = name(mon.otNameBytes);
        mon.slot = s;
        list.push(mon);
      }
    }
    const nameBytes = [];
    for (let i = 0; i < St.boxNames.entryBytes; i += 1) {
      nameBytes.push(new DataView(storage).getUint8(St.boxNames.offset + b * St.boxNames.entryBytes + i));
    }
    boxes.push({ number: b + 1, name: name(nameBytes), mons: list });
  }

  const bad = [...party, ...boxes.flatMap((b) => b.mons)].filter((m) => !m.checksumOk);
  if (bad.length) {
    warnings.push(`${bad.length} Pokémon failed their checksum — the layout may be `
      + 'wrong for this build, or the save is damaged');
  }

  return {
    slot: useSlot + 1,
    counter: slot.counter,
    sectorsUsed: live.length,
    trainer,
    partyCount,
    party,
    boxes,
    currentBox: new DataView(storage).getUint8(St.currentBox.offset) + 1,
    levelCap: cap,
    flags,
    bag: readBag(sb1, L.bag),
    warnings,
  };
}
