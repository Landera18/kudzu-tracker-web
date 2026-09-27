/* Kudzu AI switch-in predictor.
 *
 * Which Pokémon the trainer sends out next, as the ROM decides it. Every Kudzu
 * trainer carries AI_FLAG_SMART_TRAINER, which includes AI_FLAG_SMART_MON_CHOICES,
 * so in singles the choice is GetBestMonIntegrated (src/battle_ai_switch.c). This
 * is a port of that function, not a heuristic of its own:
 *
 *   for every healthy bench Pokémon the AI works out
 *     - how many hits the player's best move needs to KO it (median roll, after
 *       entry hazards, with Leftovers / Black Sludge / status / weather ticking
 *       and Focus Sash / Sturdy / a healing berry counted),
 *     - the same for the player's best PRIORITY move,
 *     - for each of its own moves: the damage, the hits to KO the player, who
 *       moves first, and so whether it "wins the 1v1" - which it must do against
 *       both the best move and the best priority move,
 *   sorts candidates into categories, and takes the first category that has
 *   anyone in it:
 *
 *     after a KO    trapper > fast OHKO > slow OHKO > fast 2HKO > slow 2HKO >
 *                   resists + super-effective move > resists > Baton Pass >
 *                   wins the 1v1 > deals any damage
 *     mid-battle    trapper > resists + SE move > resists > takes 4+ hits >
 *                   Baton Pass > wins the 1v1
 *
 *   Within a category the LAST one in party order is sent, except the type
 *   matchup, defensive and damage categories, which send the best one. With
 *   nobody in any category the last healthy Pokémon goes out.
 *
 * It is a percentage rather than a name because Kudzu's AI rolls a random damage
 * roll for each of its own attacks (AI_GetDamage, the Run & Bun behaviour), so
 * "can it OHKO" is a coin-flip whenever the range straddles the player's HP. The
 * rolls are sampled with a fixed seed: the same board always shows the same
 * numbers.
 *
 * A Mega Stone holder is weighed as its BASE form, because that is what the ROM
 * does (see benchFrom): the Mega copy the data export adds for the calculator is
 * never a candidate.
 *
 * Not modelled: Wish / Healing Wish / Lunar Dance arriving with the switch-in
 * (healInfo), Truant, doubles (the ROM falls back to a simpler routine there),
 * AI_FLAG_ACE_POKEMON / RANDOMIZE_SWITCHIN, which no Kudzu trainer sets, and a
 * Pokémon that has ALREADY Mega Evolved this battle and then switched out - its
 * party slot holds the Mega species until the battle ends, so the ROM would weigh
 * it as the Mega, and this still weighs the base form.
 */
(function (root) {
    "use strict";
    var SAMPLES = 1500;
    var STORAGE_KEY = "kudzuAiSwitch";
    var H = null;
    var state = { mode: "ko", open: true, last: null };

    var CATEGORY_LABEL = {
        trapper: "traps you and wins", revengeFast: "outspeeds and OHKOs", revengeSlow: "OHKOs (moves second)",
        threatenFast: "outspeeds and 2HKOs", threatenSlow: "2HKOs (moves second)",
        typeEffective: "resists you, has a super-effective move", typeMatchup: "resists you",
        defensive: "takes 4+ hits", batonPass: "Baton Pass", generic: "wins the 1v1",
        damage: "best damage left", fallback: "last one left in party order", none: "would not switch"
    };
    var ORDER_KO = ["trapper", "revengeFast", "revengeSlow", "threatenFast", "threatenSlow", "typeEffective", "typeMatchup", "batonPass", "generic", "damage"];
    var ORDER_MID = ["trapper", "typeEffective", "typeMatchup", "defensive", "batonPass", "generic"];
    // Categories where the ROM tracks a best candidate instead of taking the last in party order.
    var BEST_OF = { typeEffective: 1, typeMatchup: 1, defensive: 1, damage: 1 };

    function isKudzu() { return typeof TITLE !== "undefined" && TITLE === "Kudzu" && typeof backup_data !== "undefined" && backup_data && backup_data.ai; }
    function load() {
        try { var s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); if (s.mode) state.mode = s.mode; if (s.open === false) state.open = false; } catch (e) { /* ignore */ }
    }
    function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: state.mode, open: state.open })); } catch (e) { /* ignore */ } }

    // mulberry32: small, fast, and good enough to pick 1-of-16 a few thousand times
    function rng(seed) {
        var a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ------------------------------------------------------------------
    // GetBattlerTypeMatchup: the player's own TYPES against the candidate, summed over the two
    // attacking types (one type counts twice). 2.0 is neutral; an immunity counts as 0.1.
    function typeMatchup(pl, cand, field) {
        function one(atkType) {
            var v = 1, seen = {};
            cand.types.forEach(function (dt) { if (seen[dt]) return; seen[dt] = 1; v *= H.chartMult(atkType, dt, field); });
            return v === 0 ? 0.1 : v;
        }
        var t1 = pl.types[0], t2 = pl.types[1] || pl.types[0];
        var e1 = one(t1);
        var e2 = t2 !== t1 ? one(t2) : e1;
        return e1 + e2;
    }

    // GetSwitchinHazardsDamage
    function hazardDamage(b, field) {
        var hold = H.hold(b), max = b.maxHp, dmg = 0, s = b.side;
        if (b.ability === "Magic Guard") return 0;
        var boots = hold === "HEAVY_DUTY_BOOTS";
        function stealth(type) {
            var mult = 1;
            b.types.forEach(function (dt) { mult *= H.chartMult(type, dt, field); });
            return Math.max(1, Math.floor(max * mult / 8));
        }
        if (s.isSR && !boots) dmg += stealth("Rock");
        if (s.steelsurge && !boots) dmg += stealth("Steel");
        if (s.spikes && !boots && H.isGrounded(b, field)) dmg += Math.max(1, Math.floor(max / ((5 - s.spikes) * 2)));
        if (s.tspikes && !boots && H.isGrounded(b, field) && !b.status && !H.hasType(b, "Poison") && !H.hasType(b, "Steel")
            && ["Immunity", "Poison Heal", "Comatose"].indexOf(b.ability) === -1) {
            dmg += Math.max(1, Math.floor(max / (s.tspikes === 1 ? 8 : 16)));
        }
        return dmg;
    }
    // GetSwitchinWeatherImpact (positive = damage, negative = healing)
    function weatherImpact(b, field) {
        if (!H.weatherActive(field)) return 0;
        var hold = H.hold(b), max = b.maxHp, a = b.ability, v = 0;
        if (hold !== "SAFETY_GOGGLES" && a !== "Magic Guard" && a !== "Overcoat") {
            // Hail chips everything but Ice types, sandstorm everything but Rock/Ground/Steel. (Until 2026-09-19 the
            // ROM had both type tests the wrong way round and this mirrored it; the two were fixed together.)
            if (H.weatherIs(field, ["Hail"]) && !H.hasType(b, "Ice") && a !== "Snow Cloak" && a !== "Ice Body") v = Math.max(1, Math.floor(max / 16));
            else if (H.weatherIs(field, H.SAND) && !(H.hasType(b, "Rock") || H.hasType(b, "Ground") || H.hasType(b, "Steel"))
                && ["Sand Veil", "Sand Rush", "Sand Force"].indexOf(a) === -1) v = Math.max(1, Math.floor(max / 16));
        }
        if (H.weatherIs(field, H.SUN) && hold !== "UTILITY_UMBRELLA" && (a === "Solar Power" || a === "Dry Skin")) v = Math.max(1, Math.floor(max / 8));
        if (H.weatherIs(field, H.RAIN) && hold !== "UTILITY_UMBRELLA") {
            if (a === "Dry Skin") v = -Math.max(1, Math.floor(max / 8));
            else if (a === "Rain Dish") v = -Math.max(1, Math.floor(max / 16));
        }
        if (H.weatherIs(field, H.ICY) && a === "Ice Body") v = -Math.max(1, Math.floor(max / 16));
        return v;
    }
    function recurringHealing(b) {
        var hold = H.hold(b), max = b.maxHp, heal = 0;
        if (b.ability !== "Klutz") {
            if (hold === "BLACK_SLUDGE" && H.hasType(b, "Poison")) heal = Math.max(1, Math.floor(max / 16));
            else if (hold === "LEFTOVERS") heal = Math.max(1, Math.floor(max / 16));
        }
        if (b.ability === "Poison Heal" && (b.status === "psn" || b.status === "tox")) heal += Math.max(1, Math.floor(max / 8));
        return heal;
    }
    function recurringDamage(b) {
        var hold = H.hold(b), max = b.maxHp;
        if (b.ability === "Magic Guard" || b.ability === "Klutz") return 0;
        if (hold === "BLACK_SLUDGE" && !H.hasType(b, "Poison")) return Math.max(1, Math.floor(max / 8));
        if (hold === "LIFE_ORB" && b.ability !== "Sheer Force") return Math.max(1, Math.floor(max / 10));
        if (hold === "STICKY_BARB") return Math.max(1, Math.floor(max / 8));
        return 0;
    }
    function statusDamage(b, toxicTurn) {
        var max = b.maxHp;
        if (!b.status || b.ability === "Magic Guard") return 0;
        if (b.status === "brn") return Math.max(1, Math.floor(max / 16) >> (b.ability === "Heatproof" ? 1 : 0));
        if (b.status === "psn" && b.ability !== "Poison Heal") return Math.max(1, Math.floor(max / 8));
        if (b.status === "tox" && b.ability !== "Poison Heal") return Math.max(1, Math.floor(max / 16)) * Math.min(15, toxicTurn);
        return 0;
    }
    // GetSwitchinHitsToKO. 0 means the player cannot hurt it at all.
    function switchinHitsToKO(damageTaken, b, pl, field) {
        var max = b.maxHp, hazards = hazardDamage(b, field);
        if (hazards >= b.hp) return 1;
        var startHp = b.hp - hazards, hp = startHp;
        var weather = weatherImpact(b, field), recDmg = recurringDamage(b), recHeal = recurringHealing(b);
        var toxicTurn = (b.toxicCounter || 0) + 1, sDmg = statusDamage(b, toxicTurn);
        if (damageTaken + sDmg + recDmg <= recHeal || damageTaken + sDmg + recDmg === 0) return 0;
        var hold = H.hold(b), param = H.holdParam(b), usedBerry = false, hits = 0;
        var moldBreaker = H.isMoldBreaker(pl);
        var unnerved = pl.ability === "Unnerve" || pl.ability === "As One";
        while (hp > 0 && hits < 100) {
            hp -= damageTaken;
            if (damageTaken >= max && startHp === max && hits < 1 && (hold === "FOCUS_SASH" || (!moldBreaker && b.ability === "Sturdy"))) hp = 1;
            if (hp > 0) hp -= weather;
            if (hp > 0 && b.ability !== "Klutz" && !usedBerry && !(unnerved && b.holdIsBerry)) {
                var heal = 0;
                if (hold === "RESTORE_HP" && hp < max / 2) heal = param;
                else if (hold === "RESTORE_PCT_HP" && hp < max / 2) heal = Math.max(1, Math.floor(max / (param || 4)));
                else if (/^CONFUSE_/.test(hold) && hp < max / 4) heal = Math.max(1, Math.floor(max / (param || 3)));
                if (heal > 0) { hp = Math.min(max, hp + heal); usedBerry = true; }
            }
            if (hp > 0) hp = hp + recHeal - recDmg - sDmg;
            if (b.status === "tox") { toxicTurn++; sDmg = statusDamage(b, toxicTurn); }
            hits++;
        }
        if (!moldBreaker && b.ability === "Disguise" && /^Mimikyu/.test(b.name || "") && !/Busted/.test(b.name || "")) hits++;
        return hits;
    }
    // CanSwitchinWin1v1
    function canWin1v1(hitsToKOAI, hitsToKOPlayer, first, free) {
        if (hitsToKOAI === 0 && hitsToKOPlayer > 0) return true;
        if (hitsToKOPlayer === 0 && hitsToKOAI > 0) return false;
        if (hitsToKOPlayer === 0 && hitsToKOAI === 0) return false;
        if (free && (hitsToKOAI > hitsToKOPlayer || (hitsToKOAI === hitsToKOPlayer && first))) return true;
        return hitsToKOAI > hitsToKOPlayer + 1 || (hitsToKOAI === hitsToKOPlayer + 1 && first);
    }
    // AI_CanSwitchinAbilityTrapOpponent
    function abilityTraps(ability, pl, field, playerLastMon) {
        if (H.canBattlerEscape(pl)) return false;
        if (playerLastMon) return false;
        if (ability === "Shadow Tag") return pl.ability !== "Shadow Tag";
        if (ability === "Arena Trap") return H.isGrounded(pl, field);
        if (ability === "Magnet Pull") return H.hasType(pl, "Steel");
        return false;
    }

    // ------------------------------------------------------------------
    // One candidate: everything that does not depend on the AI's damage rolls, plus the rolls.
    function analyse(ctx, free, playerLastMon) {
        var cand = ctx.ai, pl = ctx.pl, field = ctx.field;
        // GetMaxDamagePlayerCouldDealToSwitchin / ...Priority... (AI_DEFENDING: the median roll)
        var best = null, bestDmg = 0, bestPri = null, bestPriDmg = 0;
        pl.moves.forEach(function (m) {
            if (!m.present || H.isStatus(m) || H.eff(m) === "FOCUS_PUNCH") return;
            var d = m.sim.med || 0;
            if (d > bestDmg) { bestDmg = d; best = m; }
            if (H.movePriority(pl, m, field) > 0 && d > bestPriDmg) { bestPriDmg = d; bestPri = m; }
        });
        var hitsAI = switchinHitsToKO(bestDmg, cand, pl, field);
        var hitsAIPri = switchinHitsToKO(bestPriDmg, cand, pl, field);
        var matchup = typeMatchup(pl, cand, field);
        var traps = abilityTraps(cand.ability, pl, field, playerLastMon) || (cand.ability === "Trace" && abilityTraps(pl.ability, pl, field, playerLastMon));
        var moves = cand.moves.filter(function (m) { return m.present; }).map(function (m) {
            var status = H.isStatus(m);
            var rolls = (m.sim.rolls && m.sim.rolls.length) ? m.sim.rolls : [m.sim.med || 0];
            if (m.effv === 0 || m.blocked) rolls = [0];
            return {
                m: m, name: m.name, status: status, rolls: rolls,
                first: H.whoStrikesFirst(cand, pl, m, best, true, field) === 1,
                firstPri: H.whoStrikesFirst(cand, pl, m, bestPri, true, field) === 1,
                batonPass: H.eff(m) === "BATON_PASS", explosion: H.isExplosion(m),
                superEffective: !status && m.effv >= 2,
                endure: H.canEndureHit(cand, pl, m)
            };
        });
        return { ctx: ctx, hitsAI: hitsAI, hitsAIPri: hitsAIPri, matchup: matchup, traps: traps, moves: moves,
                 bestPlayerMove: best ? best.name : null, bestPlayerDmg: bestDmg, free: free };
    }

    // One pass of the ROM's loop over a candidate, for one set of rolls. Returns the categories it
    // lands in and the numbers the "best of" categories compare.
    function categorise(a, plHp, rand) {
        var out = { cats: {}, maxDamage: 0 };
        var free = a.free, hitsAI = a.hitsAI;
        for (var i = 0; i < a.moves.length; i++) {
            var mv = a.moves[i];
            var dmg = mv.rolls.length === 1 ? mv.rolls[0] : mv.rolls[Math.floor(rand() * mv.rolls.length)];
            var hitsPl = dmg === 0 ? 0 : Math.ceil(plHp / dmg);
            if (hitsPl === 1 && mv.endure) hitsPl = 2;
            var win = canWin1v1(hitsAI, hitsPl, mv.first, free) && canWin1v1(a.hitsAIPri, hitsPl, mv.firstPri, free);
            if (mv.batonPass && ((mv.first && hitsAI > 1) || hitsAI > 2)) out.cats.batonPass = 1;
            if (a.matchup < 2 && win) out.cats.typeMatchup = 1;
            if (hitsAI > 3 && win) out.cats.defensive = 1;
            if (win) out.cats.generic = 1;
            if (mv.status) continue;
            if (a.matchup < 2 && mv.superEffective && win) out.cats.typeEffective = 1;
            if (mv.explosion && dmg < plHp) continue;
            if (dmg > 0 && ((free && hitsAI > 1) || hitsAI > 2)) { out.cats.damage = 1; if (dmg > out.maxDamage) out.maxDamage = dmg; }
            if (dmg >= plHp && win) out.cats[mv.first ? "revengeFast" : "revengeSlow"] = 1;
            if (dmg >= Math.floor(plHp / 2) + (plHp % 2) && win) out.cats[mv.first ? "threatenFast" : "threatenSlow"] = 1;
            if (a.traps && win) out.cats.trapper = 1;
        }
        return out;
    }

    function pick(results, cands, free) {
        var order = free ? ORDER_KO : ORDER_MID;
        for (var c = 0; c < order.length; c++) {
            var cat = order[c], inCat = [];
            for (var i = 0; i < cands.length; i++) if (results[i].cats[cat]) inCat.push(i);
            if (!inCat.length) continue;
            if (!BEST_OF[cat]) return { index: inCat[inCat.length - 1], cat: cat };   // last in party order
            var bestI = inCat[0];
            for (var k = 1; k < inCat.length; k++) {
                var j = inCat[k];
                // strict comparisons, so the earliest party slot keeps a tie - as in the ROM
                if (cat === "damage" ? results[j].maxDamage > results[bestI].maxDamage
                    : cat === "defensive" ? cands[j].hitsAI > cands[bestI].hitsAI
                    : cands[j].matchup < cands[bestI].matchup) bestI = j;
            }
            return { index: bestI, cat: cat };
        }
        if (!free) return { index: -1, cat: "none" };
        // GetValidSwitchinCandidate: the last valid Pokémon in party order
        return { index: cands.length - 1, cat: "fallback" };
    }

    // ------------------------------------------------------------------
    // The bench: the trainer's REAL party, minus whoever is out and whoever has fainted.
    //
    // A party has six slots. The data export files a Mega Stone (or Primal orb) holder a second time, under
    // its Mega species at sub_index 6, so the calculator can show the transformed stats - the seventh icon
    // in the party strip. That copy is not a seventh Pokémon, and it is not what the AI weighs either:
    // InitializeSwitchinCandidate (src/battle_ai_switch.c) is PokemonToBattleMon(&party[i]) and nothing
    // more - no form-change lookup anywhere in the file - so a stone-holder on the bench is judged as the
    // base form it still is. Left in, the copy competed against its own base form and usually won: a Mega's
    // stats OHKO where the base's do not, and "Starmie-Mega 100%" was a Pokémon the AI cannot send out.
    var PARTY_SIZE = 6;
    function isFormCopy(data) { return !!data && Number(data.sub_index) >= PARTY_SIZE; }
    // "Species (set)[n]" -> "Species (set)", as getTrainerPreviewDataId does in the calculator.
    function dataIdOf(setId) { return typeof setId === "string" ? setId.split("[")[0] : ""; }
    // The copy is the base set duplicated with only its ability and sub_index changed (extract/kudzucalc.py),
    // so everything else says which real slot it was made from. A party can hold two stone-holders.
    function sameMon(a, b) {
        function j(v) { return JSON.stringify(v == null ? null : v); }
        return Number(a.tr_id) === Number(b.tr_id) && Number(a.level) === Number(b.level)
            && (a.item || "") === (b.item || "") && (a.nature || "") === (b.nature || "")
            && (a.nickname || "") === (b.nickname || "")
            && j(a.moves) === j(b.moves) && j(a.ivs) === j(b.ivs) && j(a.evs) === j(b.evs);
    }

    // entries: CURRENT_TRAINER_POKS. lookup: set id -> set data. Returns { bench, formCopies }.
    function benchFrom(entries, currentSetId, lookup, faintedIds) {
        var currentId = dataIdOf(currentSetId);
        var current = lookup(currentId);
        var trId = current ? Number(current.tr_id) : 0;
        var rows = [];
        (entries || []).forEach(function (entry) {
            var setId = Array.isArray(entry) ? entry[0] : entry;
            if (typeof setId !== "string") return;
            var dataId = dataIdOf(setId);
            var data = lookup(dataId);
            if (!data || (trId && Number(data.tr_id) !== trId)) return;
            rows.push({ setId: dataId, rawId: setId, data: data, subIndex: Number(data.sub_index) || 0, species: dataId.split(" (")[0] });
        });
        var real = rows.filter(function (r) { return !isFormCopy(r.data); });
        function baseOf(copy) {
            for (var i = 0; i < real.length; i++) if (sameMon(real[i].data, copy)) return real[i];
            return null;
        }
        // The Pokémon that is out, and the ones that are down, under EITHER of their two entries: loading the
        // Mega as the opponent does not put its base form on the bench, and a fainted Mega is a fainted slot.
        var gone = {};
        gone[currentId] = 1;
        if (isFormCopy(current)) { var b = baseOf(current); if (b) gone[b.setId] = 1; }
        rows.forEach(function (r) {
            if (faintedIds.indexOf(r.setId) === -1 && faintedIds.indexOf(r.rawId) === -1) return;
            gone[r.setId] = 1;
            if (isFormCopy(r.data)) { var base = baseOf(r.data); if (base) gone[base.setId] = 1; }
        });
        var bench = real.filter(function (r) { return !gone[r.setId]; })
            .map(function (r) { return { setId: r.setId, subIndex: r.subIndex, species: r.species }; })
            .sort(function (x, y) { return x.subIndex - y.subIndex; });
        // For the note under the list: which copies were left out, and what they are weighed as instead.
        var formCopies = [];
        rows.forEach(function (r) {
            if (!isFormCopy(r.data)) return;
            var base = baseOf(r.data);
            if (base && !gone[base.setId]) formCopies.push({ species: r.species, base: base.species });
        });
        return { bench: bench, formCopies: formCopies };
    }

    function benchSets() {
        if (typeof CURRENT_TRAINER_POKS === "undefined" || !Array.isArray(CURRENT_TRAINER_POKS)) return { bench: [], formCopies: [] };
        var current = $("#p2 input.set-selector").val() || $(".opposing.set-selector").first().val() || "";
        var lookup = function (id) { return typeof getSetDataBySetId === "function" ? getSetDataBySetId(id) : null; };
        return benchFrom(CURRENT_TRAINER_POKS, current, lookup, typeof fainted !== "undefined" && Array.isArray(fainted) ? fainted : []);
    }

    function predict(mode) {
        if (!H) H = root.KudzuAIEngineCore;
        if (!H || !root.KudzuAIUI || !root.KudzuAIUI.buildModel) return null;
        var free = mode !== "mid";
        var roster = benchSets();
        var bench = roster.bench;
        if (!bench.length) return { mode: mode, candidates: [], reason: "no healthy Pokémon on the bench" };
        if ($("#doubles-format").is(":checked")) return { mode: mode, candidates: [], reason: "doubles use the ROM's simpler routine, which is not modelled" };

        var p1 = createPokemon($("#p1"));
        if (!p1 || !p1.name) return null;
        // The player's Intimidate went off on the Pokémon that is leaving, not on the one coming in.
        if (p1.ability === "Intimidate") p1.abilityOn = false;
        var p1field = createField(), p2field = p1field.clone().swap();
        var base = root.KudzuAIUI.options();
        var o = {};
        Object.keys(base).forEach(function (k) { o[k] = base[k]; });
        o.firstTurn = true; o.aiMagnetRise = false; o.aiFocusEnergy = false; o.protectStreak = 0;

        var cands = [];
        bench.forEach(function (b) {
            var mon;
            try { mon = createPokemon(b.setId); } catch (e) { return; }
            if (!mon || !mon.name) return;
            // A switch-in ability has not happened yet when the AI compares its bench.
            if (mon.ability === "Intimidate") mon.abilityOn = false;
            var results;
            try { results = calculateAllMoves(settings.damageGen, p1.clone(), p1field, mon, p2field, false); }
            catch (e) { console.error("[Kudzu AI switch]", b.setId, e); return; }
            var ctx = root.KudzuAIUI.buildModel(results, o);
            if (!ctx) return;
            var a = analyse(ctx, free, !!o.playerLastMon);
            a.bench = b;
            cands.push(a);
        });
        if (!cands.length) return { mode: mode, candidates: [], reason: "could not calculate the bench" };

        var plHp = cands[0].ctx.pl.hp;
        var wins = cands.map(function () { return { n: 0, cats: {} }; });
        var none = 0;
        var deterministic = cands.every(function (a) { return a.moves.every(function (m) { return m.rolls.length === 1; }); });
        var n = deterministic ? 1 : SAMPLES;
        var rand = rng(0x4B55445A);       // "KUDZ": the same board always gives the same numbers
        for (var s = 0; s < n; s++) {
            var res = cands.map(function (a) { return categorise(a, plHp, rand); });
            var p = pick(res, cands, free);
            if (p.index < 0) { none++; continue; }
            wins[p.index].n++;
            wins[p.index].cats[p.cat] = (wins[p.index].cats[p.cat] || 0) + 1;
        }
        var out = cands.map(function (a, i) {
            var catList = Object.keys(wins[i].cats).sort(function (x, y) { return wins[i].cats[y] - wins[i].cats[x]; });
            return {
                setId: a.bench.setId, species: a.bench.species, slot: a.bench.subIndex + 1,
                chance: wins[i].n / n,
                why: catList.map(function (c) { return { cat: c, label: CATEGORY_LABEL[c], share: wins[i].cats[c] / n }; }),
                hitsToKOIt: a.hitsAI, playerBestMove: a.bestPlayerMove, typeMatchup: a.matchup, traps: a.traps
            };
        });
        return { mode: mode, candidates: out, stays: none / n, samples: n, player: p1.name, playerHp: plHp, formCopies: roster.formCopies };
    }

    // ------------------------------------------------------------------
    function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function pct(v) { var p = Math.round(v * 1000) / 10; return (p === 100 || p === 0 ? p.toFixed(0) : p.toFixed(1)) + "%"; }

    function ensureDom() {
        if ($("#kz-switch-panel").length) return;
        var panel = $('<div id="kz-switch-panel" class="kz-switch-panel" role="group" aria-label="AI switch-in prediction">'
            + '<div class="kz-switch-head"><button type="button" class="kz-switch-toggle" aria-expanded="true">Next in</button>'
            // Buttons, not radios in <label>s: this panel sits inside .poke-info, where the calculator's own
            // stylesheet forces every <label> to a fixed 6em width - the two options drew on top of each other.
            + '<span class="kz-switch-modes" role="group" aria-label="When">'
            + '<button type="button" class="kz-switch-mode" data-mode="ko" title="Its Pokémon faints and the AI picks a replacement (a free switch)">after a KO</button>'
            + '<button type="button" class="kz-switch-mode" data-mode="mid" title="It switches out of the Pokémon that is in now, taking a hit on the way in">if it switches out</button>'
            + '</span><span class="kz-switch-note"></span></div><div class="kz-switch-body"></div></div>');
        var anchor = $("#p2 .trainer-preview-mobile-actions").first();
        (anchor.length ? anchor : $(".trainer-pok-list.opposing").first()).after(panel);
        panel.on("click", ".kz-switch-mode", function () { state.mode = $(this).attr("data-mode"); save(); refresh(); });
        panel.on("click", ".kz-switch-toggle", function () { state.open = !state.open; save(); refresh(); });
        panel.on("click", ".kz-switch-row", function () {
            // Load that Pokémon as the opponent, exactly as clicking its sprite does.
            var id = $(this).attr("data-id");
            $(".trainer-pok-list.opposing .trainer-pok").filter(function () { return $(this).attr("data-id") === id; }).first().trigger("click");
        });
    }

    function render(r) {
        var panel = $("#kz-switch-panel");
        panel.find(".kz-switch-mode").each(function () {
            var on = $(this).attr("data-mode") === state.mode;
            $(this).toggleClass("on", on).attr("aria-pressed", on ? "true" : "false");
        });
        panel.toggleClass("collapsed", !state.open);
        panel.find(".kz-switch-toggle").attr("aria-expanded", state.open ? "true" : "false");
        $(".trainer-pok-list.opposing .kz-switch-badge").remove();
        $(".trainer-pok-list.opposing .trainer-pok-container").removeClass("kz-switch-likely");
        var body = panel.find(".kz-switch-body"), note = panel.find(".kz-switch-note");
        var headline = $("#kz-ai-next");
        if (!headline.length && $("#kz-ai-panel .kz-ai-head").length) {
            headline = $('<div id="kz-ai-next" class="kz-ai-next" title="Which Pokémon the AI sends out next - details under the opposing party"></div>');
            $("#kz-ai-panel .kz-ai-head").after(headline);
            headline.on("click", function () {
                var p = document.getElementById("kz-switch-panel");
                if (p && p.scrollIntoView) p.scrollIntoView({ block: "center", behavior: "smooth" });
            });
        }
        if (!r) { body.empty(); note.text(""); headline.empty(); return; }
        if (!r.candidates.length) { body.html('<div class="kz-switch-empty">' + esc(r.reason || "nothing to predict") + "</div>"); note.text(""); headline.empty(); return; }
        var sorted = r.candidates.slice().sort(function (a, b) { return b.chance - a.chance || a.slot - b.slot; });
        var top = sorted[0];
        var likely = sorted.filter(function (c) { return c.chance >= 0.05; }).slice(0, 3);
        headline.html('<span class="kz-ai-next-label">' + (r.mode === "mid" ? "Switches to" : "Next in") + "</span> "
            + (likely.length ? likely.map(function (c, i) {
                return '<span class="kz-ai-next-mon' + (i === 0 ? " top" : "") + '">' + esc(c.species) + " " + pct(c.chance) + "</span>";
            }).join(" ") : '<span class="kz-ai-next-mon">stays in</span>')
            + (top.why.length ? ' <span class="kz-ai-next-why">' + esc(top.why[0].label) + "</span>" : ""));
        note.text("vs " + r.player + " at " + r.playerHp + " HP" + (r.samples > 1 ? " · AI damage rolls sampled" : ""));
        // Badges on the party strip, so the answer is where the eye already is.
        r.candidates.forEach(function (c) {
            var img = $(".trainer-pok-list.opposing .trainer-pok").filter(function () { return $(this).attr("data-id") === c.setId; }).first();
            if (!img.length) return;
            var box = img.closest(".trainer-pok-container");
            if (c.chance > 0) box.append('<span class="kz-switch-badge' + (c === top ? " top" : "") + '">' + pct(c.chance) + "</span>");
            if (c === top && c.chance > 0) box.addClass("kz-switch-likely");
        });
        if (!state.open) { body.empty(); return; }
        var html = "";
        sorted.forEach(function (c) {
            var why = c.why.length ? c.why.map(function (w) { return esc(w.label) + (c.why.length > 1 ? " " + pct(w.share) : ""); }).join(" · ") : "—";
            html += '<div class="kz-switch-row' + (c === top && c.chance > 0 ? " top" : "") + (c.chance === 0 ? " zero" : "") + '" data-id="' + esc(c.setId) + '" title="Click to load it as the opponent">'
                + '<span class="kz-switch-pct">' + pct(c.chance) + "</span>"
                + '<span class="kz-switch-name">' + esc(c.species) + ' <small>slot ' + c.slot + "</small></span>"
                + '<span class="kz-switch-why">' + why + "</span>"
                + '<span class="kz-switch-meta">' + (c.hitsToKOIt === 0 ? "you cannot hurt it" : "you KO it in " + c.hitsToKOIt + (c.playerBestMove ? " (" + esc(c.playerBestMove) + ")" : ""))
                + (c.traps ? " · traps" : "") + "</span></div>";
        });
        if (r.stays > 0) html += '<div class="kz-switch-row zero"><span class="kz-switch-pct">' + pct(r.stays) + '</span><span class="kz-switch-name">stays in</span><span class="kz-switch-why">nobody on the bench is a good enough switch</span><span class="kz-switch-meta"></span></div>';
        // The party strip shows a seventh icon that this list does not; say why, once.
        (r.formCopies || []).forEach(function (f) {
            html += '<div class="kz-switch-foot">' + esc(f.species) + " is not a candidate: on the bench the AI weighs "
                + esc(f.base) + " as it is, before it transforms.</div>";
        });
        body.html(html);
    }

    var queued = null;
    function refresh() {
        if (!isKudzu() || !root.KudzuAIUI) { $("#kz-switch-panel").hide(); $(".kz-switch-badge").remove(); $("#kz-ai-next").empty(); return; }
        var o = root.KudzuAIUI.options();
        if (!o.enabled) { $("#kz-switch-panel").hide(); $(".kz-switch-badge").remove(); $("#kz-ai-next").empty(); return; }
        ensureDom();
        $("#kz-switch-panel").show();
        var r = null;
        try { r = predict(state.mode); }
        catch (e) { console.error("[Kudzu AI switch]", e); r = { candidates: [], reason: "prediction error: " + (e && e.message ? e.message : e) }; }
        state.last = r;
        render(r);
    }
    // The party strip is redrawn after a calculation (refresh_next_in is queued), which would wipe the
    // badges; run after it has settled.
    function queueRefresh() {
        if (queued) clearTimeout(queued);
        queued = setTimeout(function () { queued = null; refresh(); }, 60);
    }

    load();
    root.KudzuAISwitch = {
        refresh: refresh, queueRefresh: queueRefresh, predict: predict, last: function () { return state.last; },
        // exposed for the test harness
        _canWin1v1: canWin1v1, _switchinHitsToKO: switchinHitsToKO, _typeMatchup: typeMatchup, _pick: pick, _categorise: categorise,
        _bench: benchFrom,
        _weatherImpact: function (b, field) { if (!H) H = root.KudzuAIEngineCore; return weatherImpact(b, field); }
    };
})(typeof window !== "undefined" ? window : this);
