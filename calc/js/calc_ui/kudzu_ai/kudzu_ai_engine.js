/* Kudzu AI move-choice engine.
 *
 * A JavaScript port of the move-scoring half of this ROM's battle AI
 * (pkmn-np: src/battle_ai_main.c, src/battle_ai_util.c,
 * src/battle_ai_field_statuses.c) as it is configured for every trainer in
 * the hack: AI_FLAG_SMART_TRAINER =
 *   CHECK_BAD_MOVE | TRY_TO_FAINT | CHECK_VIABILITY | OMNISCIENT |
 *   SMART_MON_CHOICES | PP_STALL_PREVENTION | SMART_TERA | SMART_SWITCHING
 * (TRY_TO_2HKO and HP_AWARE were removed from trainers on 2026-09-13 to match
 * Run & Bun and Null; their useful HP rules now live inside individual moves.)
 * The score functions run in flag-bit order (bad move, faint, viability),
 * then AI_CompareDamagingMoves adds the highest-damage bonus (and the Run &
 * Bun bonus for a weaker attack with a guaranteed stat drop), then the best
 * score wins with uniform tie-breaks.
 *
 * Every Random() call in the C is a branch here. The scorer is deterministic
 * given the sequence of roll outcomes, so `enumeratePaths` walks the full
 * binary tree of outcomes and weights each leaf by its probability. That
 * gives exact percentages; a Monte Carlo fallback covers pathological cases.
 * The AI's damage roll (one of 16 per attack, per turn, since 2026-09-13) is
 * enumerated outside that tree: rolls that change nothing the scorer reads
 * are grouped first (see damageRollOutcomes in the scorer).
 *
 * Hack-specific quirks reproduced deliberately (they differ from upstream
 * pokeemerald-expansion):
 *   - score constants: WORST -10, DOMINATED -20, AWFUL -5, BAD -2,
 *     SLOW_KILL 3, best-damage +6 (75%) / +8 (25%); status moves on the Run &
 *     Bun scale (+6 default, hazards +8/+9 first turn, recovery +7/+5, ...)
 *   - Null-style setup scoring (ShouldBlockSetup / Calc*SetupScore)
 *   - highest damage is the highest random roll, every KO counts as highest,
 *     charge moves and unwanted self-sacrifice moves are left out; no
 *     accuracy or effect tie-breaks (Run & Bun / Null)
 *   - TryToFaint: slower priority move gets +5 if it is the highest-damage
 *     move, +11 otherwise; Eject Button slower gets +11
 *   - Eelevate counts as a Moxie-type ability (+1 on KO)
 *   - SUCKER_PUNCH_CHANCE 50, ENABLE_RECOVERY_THRESHOLD 50, no switch
 *     prediction, no move prediction (predicted move = player's last move)
 *
 * Doubles are not modelled; the caller shows a warning and this scores the
 * matchup as singles.
 */
(function (root) {
    "use strict";

    var SC = {
        DEFAULT: 100, DOMINATED: -20, WORST: -10, AWFUL: -5, BAD: -2, SLIGHT_BAD: -1,
        WEAK: 1, DECENT: 2, GOOD: 3, BEST: 4,
        DEFAULT_STATUS: 5, BASE_STATUS: 6, GOOD_STATUS: 7, GREAT_STATUS: 8,
        HIGH_PRIORITY: 9, PERFECT: 10, FIRST_TURN_HAZARD_HIGH: 12,
        SLOW_KILL: 3, FAST_KILL: 6, LAST_CHANCE: 2,
        BEST_DAMAGE_BONUS: 6, BEST_DAMAGE_BONUS_HIGH: 8,
        NO_DAMAGE_OR_FAILS: -20
    };
    var CFG = {
        SUCKER_PUNCH_CHANCE: 50, SHOULD_RECOVER_CHANCE: 50, ENABLE_RECOVERY_THRESHOLD: 50,
        FINAL_GAMBIT_CHANCE: 50, LOW_ACCURACY_THRESHOLD: 75, SHOULD_PIVOT_BREAK_SASH_CHANCE: 50,
        EXPLOSION_LOWER: 10, EXPLOSION_HIGHER: 90, EXPLOSION_MIN: 0, EXPLOSION_MAX: 90,
        STATUS_MOVE_FOCUS_PUNCH_CHANCE: 0, BOOST_INTO_HAZE_CHANCE: 0
    };
    var STAT_STAGE_RATIO = [[2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2]];
    var ACC_STAGE_RATIO = [[3, 9], [3, 8], [3, 7], [3, 6], [3, 5], [3, 4], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3]];
    var MOXIE_ABILITIES = ["Moxie", "Beast Boost", "Eelevate", "Chilling Neigh", "Grim Neigh", "As One (Glastrier)", "As One (Spectrier)", "As One"];
    var MOLD_BREAKERS = ["Mold Breaker", "Teravolt", "Turboblaze"];
    var DAZZLING = ["Dazzling", "Queenly Majesty", "Armor Tail"];
    var STAT_RAISING = ["ATTACK_UP", "ATTACK_UP_2", "DEFENSE_UP", "DEFENSE_UP_2", "DEFENSE_UP_3", "AUTOTOMIZE", "SPEED_UP", "SPEED_UP_2",
        "SPECIAL_ATTACK_UP", "SPECIAL_ATTACK_UP_2", "SPECIAL_ATTACK_UP_3", "SPECIAL_DEFENSE_UP", "SPECIAL_DEFENSE_UP_2", "ACCURACY_UP",
        "ACCURACY_UP_2", "EVASION_UP", "EVASION_UP_2", "MINIMIZE", "DEFENSE_CURL", "CALM_MIND", "COSMIC_POWER", "DRAGON_DANCE", "ACUPRESSURE",
        "SHELL_SMASH", "SHIFT_GEAR", "ATTACK_ACCURACY_UP", "ATTACK_SPATK_UP", "GROWTH", "COIL", "QUIVER_DANCE", "BULK_UP", "GEOMANCY",
        "STOCKPILE", "VICTORY_DANCE", "CHARGE"];
    var STAT_LOWERING = ["ATTACK_DOWN", "DEFENSE_DOWN", "SPEED_DOWN", "SPECIAL_ATTACK_DOWN", "SPECIAL_DEFENSE_DOWN", "ACCURACY_DOWN",
        "EVASION_DOWN", "ATTACK_DOWN_2", "DEFENSE_DOWN_2", "SPEED_DOWN_2", "SPECIAL_ATTACK_DOWN_2", "SPECIAL_DEFENSE_DOWN_2",
        "ACCURACY_DOWN_2", "EVASION_DOWN_2", "TICKLE", "CAPTIVATE", "NOBLE_ROAR", "MEMENTO"];
    var HAZARD_EFFECTS = ["CEASELESS_EDGE", "SPIKES", "STEALTH_ROCK", "STICKY_WEB", "STONE_AXE", "TOXIC_SPIKES"];
    var AROMA_VEIL_EFFECTS = ["DISABLE", "ATTRACT", "ENCORE", "TORMENT", "TAUNT", "HEAL_BLOCK"];
    var PINCH_BERRIES = ["ATTACK_UP", "DEFENSE_UP", "SPEED_UP", "SP_ATTACK_UP", "SP_DEFENSE_UP", "CRITICAL_UP", "RANDOM_STAT_UP", "CUSTAP_BERRY", "MICLE_BERRY"];
    var STAT_NAMES = ["atk", "def", "spe", "spa", "spd", "acc", "eva"]; // ROM order minus HP: ATK DEF SPEED SPATK SPDEF ACC EVASION
    var NORMAL_TYPE_STATUS = { par: "PARALYSIS", psn: "POISON", tox: "TOXIC", brn: "BURN", slp: "SLEEP", frz: "FREEZE" };

    function has(list, v) { return list.indexOf(v) !== -1; }
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    // ---------------------------------------------------------------------
    // Move accessors. `m` is a move slot: {name, d (ai data or null), sim, eff, acc, present, calc (calc.Move)}
    function eff(m) { return m.d ? m.d.e : "HIT"; }
    function power(m) { return m.d ? m.d.pow : 0; }
    function isStatus(m) { return !m.present || (m.d ? m.d.cat === "Status" : true); }
    function isPhysical(m) { return m.present && m.d && m.d.cat === "Physical"; }
    function isSpecial(m) { return m.present && m.d && m.d.cat === "Special"; }
    function moveType(m) { return m.calc && m.calc.type ? m.calc.type : (m.d ? m.d.type : "Normal"); }
    function flag(m, f) { return !!(m.d && m.d.f && has(m.d.f, f)); }
    function target(m) { return m.d ? m.d.t : "SELECTED"; }
    function fx(m) { return (m.d && m.d.fx) || []; }
    function nonVolatile(m) { return m.d && m.d.nv ? m.d.nv : null; }
    function hasFx(m, name, self) {
        return fx(m).some(function (f) { return f[0] === name && (self === undefined || !!f[2] === self); });
    }
    function isExplosion(m) { return flag(m, "explosion"); }
    function isSound(m) { return flag(m, "soundMove"); }
    function isPowder(m) { return flag(m, "powderMove"); }
    function isHealing(m) { return flag(m, "healingMove"); }
    function isMultiHit(m) { return !!(m.d && m.d.mh); }
    function strikeCount(m) { return m.d ? m.d.sc : 1; }
    function basePriority(m) { return m.d ? m.d.pri : 0; }
    function isSelfSacrifice(m) { return isExplosion(m) || has(["FINAL_GAMBIT", "MEMENTO", "HEALING_WISH", "REVIVAL_BLESSING"], eff(m)); }
    // Recoil effects that always hurt the user (Double-Edge, Head Smash, Steel Beam, Chloroblast, ...)
    function isRecoilDamageEffect(m) { return has(["RECOIL", "MAX_HP_50_RECOIL", "CHLOROBLAST"], eff(m)); }
    function isDamagedByRecoil(b) { return !has(["Magic Guard", "Rock Head"], b.ability); }
    // DoesBattlerKOItselfWithRecoil (upstream #10258) for a given damage roll: the recoil would KO the AI while the
    // player still has something to switch to. RECOIL moves take a % of the damage dealt (capped by the foe's HP),
    // Chloroblast / Mind Blown / Steel Beam half the user's max HP rounded up.
    function recoilKOsSelfAt(ctx, m, dmg) {
        var ai = ctx.ai, recoil;
        if (!isRecoilDamageEffect(m) || !isDamagedByRecoil(ai) || ctx.opts.playerLastMon) return false;
        if (eff(m) === "RECOIL") recoil = Math.max(1, Math.floor(Math.min(dmg, ctx.pl.hp) * ((m.d && m.d.recoil) || 0) / 100));
        else recoil = Math.floor((ai.maxHp + 1) / 2);
        return recoil >= ai.hp;
    }
    function doesBattlerKOItselfWithRecoil(ctx, m) { return recoilKOsSelfAt(ctx, m, dmgOf(m)); }
    function isTrappingMove(m) { return has(["MEAN_LOOK", "FAIRY_LOCK"], eff(m)) || hasFx(m, "PREVENT_ESCAPE", false) || hasFx(m, "WRAP", false); }
    function isHazardMove(m) { return has(HAZARD_EFFECTS, eff(m)) || hasFx(m, "STEALTH_ROCK") || hasFx(m, "STEELSURGE"); }
    function isHazardClearing(m) { return has(["RAPID_SPIN", "TIDY_UP", "DEFOG"], eff(m)) || hasFx(m, "DEFOG"); }
    function aiEffectGroup(m) {
        var g = {};
        var e = eff(m);
        if (e === "WEATHER" || e === "WEATHER_AND_SWITCH") g.weather = true;
        if (has(["ELECTRIC_TERRAIN", "GRASSY_TERRAIN", "MISTY_TERRAIN", "PSYCHIC_TERRAIN", "STEEL_ROLLER", "ICE_SPINNER"], e)) g.terrain = true;
        if (e === "COURT_CHANGE") { g.clearHazards = true; g.auroraVeil = true; g.breakScreens = true; }
        if (e === "DEFOG") { g.clearHazards = true; g.breakScreens = true; }
        if (e === "RAPID_SPIN" || e === "TIDY_UP") g.clearHazards = true;
        if (e === "HAZE") g.resetStats = true;
        fx(m).forEach(function (f) {
            var n = f[0];
            if (has(["SUN", "RAIN", "SANDSTORM", "HAIL"], n)) g.weather = true;
            if (has(["ELECTRIC_TERRAIN", "GRASSY_TERRAIN", "MISTY_TERRAIN", "PSYCHIC_TERRAIN"], n)) g.terrain = true;
            if (n === "DEFOG") { g.clearHazards = true; g.breakScreens = true; }
            if (n === "CLEAR_SMOG" || n === "HAZE") g.resetStats = true;
            if (n === "BREAK_SCREEN") g.breakScreens = true;
            if (n === "AURORA_VEIL") g.auroraVeil = true;
        });
        return g;
    }

    // ---------------------------------------------------------------------
    // Battler accessors. `b` is the battler model built by the UI.
    function hasType(b, t) { return b.types.indexOf(t) !== -1; }
    function hold(b) { return b.itemEnabled ? b.hold : "NONE"; }
    function holdParam(b) { return b.itemEnabled ? b.holdParam : 0; }
    function isBerry(b) { return !!(b.itemEnabled && b.holdIsBerry); }
    function movesOf(b) { return b.moves.filter(function (m) { return m.present; }); }
    function hasMoveEffect(b, e) { return movesOf(b).some(function (m) { return eff(m) === e; }); }
    function hasMoveNamed(b, n) { return movesOf(b).some(function (m) { return m.name === n; }); }
    function hasMoveWithCategory(b, cat) { return movesOf(b).some(function (m) { return m.d && m.d.cat === cat; }); }
    function hasMoveWithType(b, t) { return movesOf(b).some(function (m) { return moveType(m) === t; }); }
    function hasDamagingMove(b) { return movesOf(b).some(function (m) { return power(m) !== 0; }); }
    function hasDamagingMoveOfType(b, t) { return movesOf(b).some(function (m) { return power(m) !== 0 && moveType(m) === t; }); }
    function hasMoveWithFx(b, name) { return movesOf(b).some(function (m) { return hasFx(m, name, false); }); }
    function hasMoveWithFxExcept(b, name, exceptEffect) { return movesOf(b).some(function (m) { return hasFx(m, name, false) && eff(m) !== exceptEffect; }); }
    function hasNonVolatileMoveEffect(b, nv) { return movesOf(b).some(function (m) { return nonVolatile(m) === nv; }); }
    function hasMoveWithFlag(b, f) { return movesOf(b).some(function (m) { return flag(m, f); }); }
    function hasMoveWithAiEffect(b, key) { return movesOf(b).some(function (m) { return !!aiEffectGroup(m)[key]; }); }
    function hasOnlyMovesWithCategory(b, cat) {
        var ms = movesOf(b).filter(function (m) { return power(m) !== 0; });
        return ms.length > 0 && ms.every(function (m) { return m.d && m.d.cat === cat; });
    }
    function hasThawingMove(b) { return hasMoveWithFlag(b, "thawsUser"); }
    function hasUsableWhileAsleepMove(b) { return hasMoveEffect(b, "SNORE") || hasMoveEffect(b, "SLEEP_TALK"); }
    function hasHealingEffect(b) { return movesOf(b).some(function (m) { return isHealing(m); }); }
    function stage(b, s) { return (b.boosts[s] || 0) + 6; }
    function anyStatRaised(b) { return STAT_NAMES.some(function (s) { return (b.boosts[s] || 0) > 0; }); }
    function countPositive(b) { return STAT_NAMES.filter(function (s) { return (b.boosts[s] || 0) > 0; }).length; }
    function countNegative(b) { return STAT_NAMES.filter(function (s) { return (b.boosts[s] || 0) < 0; }).length; }
    function statsMaxed(b) { return STAT_NAMES.every(function (s) { return (b.boosts[s] || 0) >= 6; }); }
    function isMoldBreaker(b) { return has(MOLD_BREAKERS, b.ability); }
    function ignoresAbility(atk, m) { return isMoldBreaker(atk) || flag(m, "ignoresTargetAbility"); }
    function atMaxHp(b) { return b.hpPct === 100; }
    function isGrounded(b, field) {
        if (field.gravity || hold(b) === "IRON_BALL" || b.vol.root || b.vol.smackDown) return true;
        if (hasType(b, "Flying") || b.ability === "Levitate" || hold(b) === "AIR_BALLOON" || b.vol.magnetRise || b.vol.telekinesis) return false;
        return true;
    }
    function terrainAffected(b, field, terrain) { return field.terrain === terrain && isGrounded(b, field); }
    function weatherActive(field) { return field.weatherEffect !== false && !!field.weather; }
    function weatherIs(field, names) { return weatherActive(field) && has(names, field.weather); }
    var SUN = ["Sun", "Harsh Sunshine"], RAIN = ["Rain", "Heavy Rain"], SAND = ["Sand"], ICY = ["Hail", "Snow"], PRIMAL = ["Harsh Sunshine", "Heavy Rain", "Strong Winds"];
    function statusIs(b, list) { return has(list, b.status); }
    function incapacitated(b) {
        if (b.status === "frz" && !hasThawingMove(b)) return true;
        if (b.status === "slp" && !hasMoveEffect(b, "SLEEP_TALK")) return true;
        if (b.vol.recharge || (b.ability === "Truant" && b.vol.truant)) return true;
        return false;
    }
    function isAsleepOrComatose(b) { return b.status === "slp" || b.ability === "Comatose"; }
    function isWakeupTurn(b) { return b.status === "slp" && !!b.vol.wakeupTurn; }

    // ---------------------------------------------------------------------
    // Type chart (direct table lookup; damage rolls already carry the real
    // effectiveness for attacking moves, this is for status moves).
    function chartMult(atkType, defType, field) {
        // Same table the damage engine reads (calc/mechanics/util.js getMoveEffectiveness).
        var chart = typeof typeChart !== "undefined" ? typeChart : null;
        var v = chart && chart[atkType] ? chart[atkType][defType] : undefined;
        if (v === undefined) v = 1;
        if (field.inverse) v = v === 0 || v === 0.5 ? 2 : v === 2 ? 0.5 : v;
        return v;
    }
    function typeEffectiveness(m, atk, def, field) {
        var mult = 1;
        def.types.forEach(function (dt) {
            var v = chartMult(moveType(m), dt, field);
            if (v === 0 && dt === "Ghost" && (def.side.isForesight || atk.ability === "Scrappy" || atk.ability === "Mind's Eye")) v = 1;
            if (v === 0 && dt === "Flying" && moveType(m) === "Ground" && (field.gravity || def.vol.smackDown)) v = 1;
            mult *= v;
        });
        if (hold(def) === "RING_TARGET" && mult === 0) mult = 1;
        return mult;
    }

    // ---------------------------------------------------------------------
    // Speed and priority
    function movePriority(b, m, field) {
        var pri = basePriority(m);
        if (!m.present) return 0;
        if (b.ability === "Gale Wings" && atMaxHp(b) && moveType(m) === "Flying") pri++;
        else if (isStatus(m) && b.ability === "Prankster") pri++;
        else if (eff(m) === "GRASSY_GLIDE" && terrainAffected(b, field, "Grassy")) pri++;
        else if (b.ability === "Triage" && isHealing(m)) pri += 3;
        return pri;
    }
    // AI_WhoStrikesFirst: 1 = AI first, -1 = AI second. Speed ties count as AI faster.
    function whoStrikesFirst(ai, pl, aiMove, plMove, considerPriority, field) {
        if (considerPriority) {
            var a = aiMove ? movePriority(ai, aiMove, field) : 0;
            var p = plMove ? movePriority(pl, plMove, field) : 0;
            if (a > p) return 1;
            if (a < p) return -1;
        }
        var ha = hold(ai), hp = hold(pl);
        if (ha === "LAGGING_TAIL" && hp !== "LAGGING_TAIL") return -1;
        if (ha !== "LAGGING_TAIL" && hp === "LAGGING_TAIL") return 1;
        if (ai.ability === "Stall" && pl.ability !== "Stall") return -1;
        if (ai.ability !== "Stall" && pl.ability === "Stall") return 1;
        if (ai.speed > pl.speed) return field.trickRoom ? -1 : 1;
        if (ai.speed === pl.speed) return 1;
        return field.trickRoom ? 1 : -1;
    }
    function aiIsFaster(ctx, aiMove, plMove, considerPriority) { return whoStrikesFirst(ctx.ai, ctx.pl, aiMove, plMove, considerPriority, ctx.field) === 1; }
    function aiIsSlower(ctx, aiMove, plMove, considerPriority) { return whoStrikesFirst(ctx.ai, ctx.pl, aiMove, plMove, considerPriority, ctx.field) === -1; }

    // ---------------------------------------------------------------------
    // Accuracy as the AI records it (101 = bypasses accuracy)
    function moveAccuracy(atk, def, m, field) {
        if (!m.present || !m.d) return 101;
        var acc = m.d.acc;
        if (acc === 0 || atk.ability === "No Guard" || def.ability === "No Guard" || def.vol.lockOn || def.vol.telekinesis) return 101;
        if (flag(m, "alwaysHitsInRain") && weatherIs(field, RAIN)) return 101;
        if (flag(m, "alwaysHitsInHailSnow") && weatherIs(field, ICY)) return 101;
        var accStage = stage(atk, "acc"), evaStage = stage(def, "eva");
        if (has(["Unaware", "Keen Eye", "Mind's Eye", "Illuminate"], atk.ability) || flag(m, "ignoresTargetDefenseEvasionStages")) evaStage = 6;
        if (def.ability === "Unaware") accStage = 6;
        var buff = (def.side.isForesight || def.vol.miracleEye) ? accStage : accStage + 6 - evaStage;
        buff = clamp(buff, 0, 12);
        if (weatherIs(field, SUN) && flag(m, "accuracy50InSun")) acc = 50;
        if (def.ability === "Wonder Skin" && isStatus(m) && acc > 50) acc = 50;
        var calc = Math.floor(ACC_STAGE_RATIO[buff][0] * acc / ACC_STAGE_RATIO[buff][1]);
        if (atk.ability === "Compound Eyes") calc = Math.floor(calc * 130 / 100);
        else if (atk.ability === "Victory Star") calc = Math.floor(calc * 110 / 100);
        else if (atk.ability === "Hustle" && isPhysical(m)) calc = Math.floor(calc * 80 / 100);
        if (def.ability === "Sand Veil" && weatherIs(field, SAND)) calc = Math.floor(calc * 80 / 100);
        else if (def.ability === "Snow Cloak" && weatherIs(field, ICY)) calc = Math.floor(calc * 80 / 100);
        else if (def.ability === "Tangled Feet" && def.vol.confused) calc = Math.floor(calc * 50 / 100);
        if (flag(m, "accIncreaseByTenOnSameType") && !hasType(atk, moveType(m))) calc = Math.floor(calc * 110 / 100);
        if (hold(atk) === "WIDE_LENS") calc = Math.floor(calc * (100 + holdParam(atk)) / 100);
        if (hold(def) === "EVASION_UP") calc = Math.floor(calc * (100 - holdParam(def)) / 100);
        return calc > 100 ? 100 : calc;
    }

    // ---------------------------------------------------------------------
    // Damage and KO helpers. sim = {min, med, max, rolls} for the AI's view of a move. The AI's own
    // attacks use sim.roll, the random roll KudzuAI.evaluate picked for this outcome (AI_GetDamage);
    // the player's attacks stay at the 9th roll.
    function dmgOf(m) { return m.sim ? (m.sim.roll != null ? m.sim.roll : m.sim.med) : 0; }
    function hitsToKO(dmg, hp) { return dmg === 0 ? 0 : Math.ceil(hp / dmg); }
    function canEndureHit(atk, def, m) {
        if (!atMaxHp(def) || isMultiHit(m) || atk.ability === "Parental Bond") return false;
        if (strikeCount(m) > 1 && target(m) !== "SMART") return false;
        if (hold(def) === "FOCUS_SASH") return true;
        if (!ignoresAbility(atk, m)) {
            if (def.ability === "Sturdy") return true;
            if (def.ability === "Disguise" && def.vol.disguised) return true;
            if (def.ability === "Ice Face" && def.vol.iceFace && isPhysical(m)) return true;
        }
        return false;
    }
    function hitsToKOBattler(atk, def, m, considerEndure) {
        var h = hitsToKO(dmgOf(m), def.hp);
        if (considerEndure && h === 1 && canEndureHit(atk, def, m)) h += 1;
        return h;
    }
    function canTargetFaintAi(ctx) {
        return movesOf(ctx.pl).some(function (m) { return dmgOf(m) >= ctx.ai.hp && !canEndureHit(ctx.pl, ctx.ai, m); });
    }
    function noOfHitsForTargetToFaint(ctx, considerEndure) {
        var least = Infinity;
        movesOf(ctx.pl).forEach(function (m) {
            var h = hitsToKOBattler(ctx.pl, ctx.ai, m, considerEndure);
            if (h !== 0 && h < least) least = h;
        });
        return least;
    }
    function noOfHitsForTargetToFaintWithMod(ctx, hpMod) {
        var least = Infinity, hpCheck = Math.min(ctx.ai.hp + hpMod, ctx.ai.maxHp);
        movesOf(ctx.pl).forEach(function (m) {
            var d = dmgOf(m);
            if (d === 0) return;
            var h = Math.floor(hpCheck / (d + 1)) + 1;
            if (h < least) least = h;
        });
        return least;
    }
    function canTargetFaintAiWithMod(ctx, hpMod, dmgMod) {
        var hpCheck = Math.min(ctx.ai.hp + hpMod, ctx.ai.maxHp);
        return movesOf(ctx.pl).some(function (m) {
            var d = dmgOf(m);
            if (dmgMod) d *= dmgMod;
            return d >= hpCheck && !(canEndureHit(ctx.pl, ctx.ai, m) && dmgMod <= 1);
        });
    }
    function canIndexMoveFaintTarget(ctx, m) { return dmgOf(m) >= ctx.pl.hp && !canEndureHit(ctx.ai, ctx.pl, m); }
    function canAIFaintTarget(ctx, numHits) {
        return movesOf(ctx.ai).some(function (m) {
            var d = dmgOf(m) * (numHits || 1);
            if (ctx.pl.hp <= d) {
                if (numHits > 1) return true;
                if (!canEndureHit(ctx.ai, ctx.pl, m)) return true;
            }
            return false;
        });
    }
    function canBattlerKOTargetIgnoringSturdy(ctx) {
        return movesOf(ctx.ai).some(function (m) { return ctx.pl.hp <= dmgOf(m) && canEndureHit(ctx.ai, ctx.pl, m); });
    }
    function canTargetMoveFaintAi(ctx, m, nHits) {
        var h = hitsToKO(dmgOf(m), ctx.ai.hp);
        return h <= nHits && h !== 0 && !(canEndureHit(ctx.pl, ctx.ai, m) && h === 1);
    }
    function bestDmgMoves(atk, def) {
        var out = [];
        var ctxLike = { ai: atk, pl: def };
        var canFaint = movesOf(atk).some(function (m) { return def.hp <= dmgOf(m) && !canEndureHit(atk, def, m); });
        if (canFaint) {
            movesOf(atk).forEach(function (m) { if (dmgOf(m) >= def.hp && !canEndureHit(atk, def, m)) out.push(m); });
        } else {
            var best = 0;
            movesOf(atk).forEach(function (m) {
                if (power(m) === 0 || dmgOf(m) === 0) return;
                if (best < dmgOf(m)) { best = dmgOf(m); out = [m]; }
                else if (best === dmgOf(m)) out.push(m);
            });
        }
        void ctxLike;
        return out;
    }
    function isBestDmgMove(atk, def, m) {
        if (dmgOf(m) >= def.hp && !canEndureHit(atk, def, m)) return true;
        return bestDmgMoves(atk, def).indexOf(m) !== -1;
    }
    function bestDmgMoveHasEffect(atk, def, e) { return bestDmgMoves(atk, def).some(function (m) { return eff(m) === e; }); }
    function hasPhysicalBestMove(atk, def) { return bestDmgMoves(atk, def).some(function (m) { return isPhysical(m); }); }
    function bestDmgFrom(atk) { var b = 0; movesOf(atk).forEach(function (m) { if (dmgOf(m) > b) b = dmgOf(m); }); return b; }

    // ---------------------------------------------------------------------
    // Secondary (residual) damage
    function secondaryDamage(b, field) {
        if (b.ability === "Magic Guard") return 0;
        var d = 0, mh = b.maxHp;
        if (b.side.isSeeded) d += Math.max(1, Math.floor(mh / 8));
        if (b.vol.nightmare && isAsleepOrComatose(b)) d += Math.max(1, Math.floor(mh / 4));
        if (b.vol.cursed) d += Math.max(1, Math.floor(mh / 4));
        if (b.vol.wrapped) d += Math.max(1, Math.floor(mh / 8));
        if (b.ability !== "Poison Heal") {
            if (b.status === "psn") d += Math.max(1, Math.floor(mh / 8));
            else if (b.status === "tox") d += Math.max(1, Math.floor(mh / 16)) * Math.min(15, (b.toxicCounter || 0) + 1);
        }
        d += weatherDamage(b, field);
        return d;
    }
    function takesSandDamage(b, field) {
        return weatherIs(field, SAND) && !hasType(b, "Rock") && !hasType(b, "Ground") && !hasType(b, "Steel")
            && !has(["Sand Veil", "Sand Force", "Sand Rush", "Magic Guard", "Overcoat"], b.ability);
    }
    function takesHailDamage(b, field) {
        return weatherIs(field, ["Hail"]) && !hasType(b, "Ice") && !has(["Snow Cloak", "Ice Body", "Magic Guard", "Overcoat"], b.ability);
    }
    function weatherDamage(b, field) {
        if (hold(b) === "SAFETY_GOGGLES") return 0;
        if (takesSandDamage(b, field) || takesHailDamage(b, field)) return Math.max(1, Math.floor(b.maxHp / 16));
        return 0;
    }
    function willFaintFromWeather(b, field) {
        if (hold(b) === "SAFETY_GOGGLES") return false;
        return (takesSandDamage(b, field) || takesHailDamage(b, field)) && b.hp <= Math.max(1, Math.floor(b.maxHp / 16));
    }
    // BattlerWillFaintFromSecondaryDamage: compares HP against the actual residual damage (upstream #10427)
    function willFaintFromSecondary(b, field) { var d = secondaryDamage(b, field); return d !== 0 && b.hp <= d; }
    function isDamagedByStatus(b) {
        return statusIs(b, ["psn", "tox", "brn"]) || b.vol.wrapped || b.vol.nightmare || b.vol.cursed || b.vol.saltCure || b.side.isSeeded || b.vol.perishSong;
    }

    // ---------------------------------------------------------------------
    // Status infliction possibility (CanSetNonVolatileStatus + AI wrappers)
    function substituteBlocks(atk, def, m) {
        if (!def.vol.substitute) return false;
        if (flag(m, "ignoresSubstitute")) return false;
        if (eff(m) === "TRANSFORM" || eff(m) === "SKY_DROP") return true;
        if (atk.ability === "Infiltrator") return false;
        return true;
    }
    function statusBlockedGeneral(def, field) {
        if (def.ability === "Comatose" || def.ability === "Purifying Salt") return true;
        if (terrainAffected(def, field, "Misty")) return true;
        if (def.ability === "Leaf Guard" && weatherIs(field, SUN) && hold(def) !== "UTILITY_UMBRELLA") return true;
        if (def.ability === "Shields Down" && def.vol.shieldsDown) return true;
        if (def.ability === "Flower Veil" && hasType(def, "Grass")) return true;
        if (def.side.isSafeguard) return true;
        if (def.status) return true;
        return false;
    }
    function canBePoisoned(atk, def, field) {
        if (statusIs(def, ["psn", "tox"])) return false;
        if (atk.ability !== "Corrosion" && (hasType(def, "Poison") || hasType(def, "Steel"))) return false;
        if (def.ability === "Pastel Veil" || def.ability === "Immunity") return false;
        return !statusBlockedGeneral(def, field);
    }
    function canBeParalyzed(def, field) {
        if (def.status === "par" || hasType(def, "Electric") || def.ability === "Limber") return false;
        return !statusBlockedGeneral(def, field);
    }
    function canBeBurned(def, field) {
        if (def.status === "brn" || hasType(def, "Fire") || has(["Water Veil", "Water Bubble", "Thermal Exchange"], def.ability)) return false;
        return !statusBlockedGeneral(def, field);
    }
    function canBeSlept(def, field) {
        if (def.status === "slp") return false;
        if (terrainAffected(def, field, "Electric")) return false;
        if (has(["Sweet Veil", "Vital Spirit", "Insomnia"], def.ability)) return false;
        return !statusBlockedGeneral(def, field);
    }
    function canBeFrozen(def, field) {
        if (statusIs(def, ["frz"]) || hasType(def, "Ice") || weatherIs(field, SUN) || def.ability === "Magma Armor") return false;
        return !statusBlockedGeneral(def, field);
    }
    function aiCanPoison(ctx, m) { return canBePoisoned(ctx.ai, ctx.pl, ctx.field) && m.effv !== 0 && !substituteBlocks(ctx.ai, ctx.pl, m); }
    function aiCanParalyze(ctx, m) { return canBeParalyzed(ctx.pl, ctx.field) && m.effv !== 0 && !substituteBlocks(ctx.ai, ctx.pl, m); }
    function aiCanBurn(ctx, m) { return canBeBurned(ctx.pl, ctx.field) && m.effv !== 0 && !substituteBlocks(ctx.ai, ctx.pl, m); }
    function aiCanFrostbite(ctx, m) { return canBeFrozen(ctx.pl, ctx.field) && m.effv !== 0 && !substituteBlocks(ctx.ai, ctx.pl, m); }
    function aiCanPutToSleep(ctx, m) { return canBeSlept(ctx.pl, ctx.field) && !substituteBlocks(ctx.ai, ctx.pl, m); }
    function aiCanBeConfused(ctx, m) {
        var pl = ctx.pl;
        if (pl.vol.confused || (pl.ability === "Own Tempo" && !ignoresAbility(ctx.ai, m)) || terrainAffected(pl, ctx.field, "Misty") || pl.side.isSafeguard || substituteBlocks(ctx.ai, pl, m)) return false;
        return true;
    }
    function aiCanBeInfatuated(ctx, m) {
        var pl = ctx.pl;
        if (pl.vol.infatuated || m.effv === 0 || pl.ability === "Oblivious" || pl.ability === "Aroma Veil") return false;
        if (!ctx.ai.gender || !pl.gender || ctx.ai.gender === "N" || pl.gender === "N" || ctx.ai.gender === pl.gender) return false;
        return true;
    }
    function benefitsFromStatus(b) {
        return has(["Marvel Scale", "Quick Feet", "Magic Guard"], b.ability)
            || (b.ability === "Guts" && hasMoveWithCategory(b, "Physical"))
            || hasMoveEffect(b, "FACADE") || hasMoveEffect(b, "PSYCHO_SHIFT");
    }
    // ShouldPoison/Burn/Paralyze with battlerAtk != battlerDef (the AI targeting the player)
    function shouldPoisonTarget(ctx) {
        var pl = ctx.pl;
        if (canBePoisoned(ctx.ai, pl, ctx.field) && (benefitsFromStatus(pl) || pl.ability === "Poison Heal" || (pl.ability === "Toxic Boost" && hasMoveWithCategory(pl, "Physical")))) return false;
        return true;
    }
    function shouldBurnTarget(ctx) {
        var pl = ctx.pl;
        if (canBeBurned(pl, ctx.field) && (benefitsFromStatus(pl) || pl.ability === "Heatproof" || (pl.ability === "Flare Boost" && hasMoveWithCategory(pl, "Special")))) return false;
        return true;
    }
    function shouldParalyzeTarget(ctx) {
        var pl = ctx.pl;
        if (canBeParalyzed(pl, ctx.field) && benefitsFromStatus(pl)) return false;
        return true;
    }
    // ShouldPoison/Burn targeting self (Trick with orbs)
    function shouldPoisonSelf(ctx) {
        var ai = ctx.ai;
        return canBePoisoned(ai, ai, ctx.field) && (benefitsFromStatus(ai) || ai.ability === "Poison Heal" || (ai.ability === "Toxic Boost" && hasMoveWithCategory(ai, "Physical")));
    }
    function shouldBurnSelf(ctx) {
        var ai = ctx.ai;
        return canBeBurned(ai, ctx.field) && (benefitsFromStatus(ai) || ai.ability === "Heatproof" || (ai.ability === "Flare Boost" && hasMoveWithCategory(ai, "Special")));
    }
    // ShouldCureStatusInternal for self-targeting only (Refresh, Rest-like, Purify self)
    function shouldCureOwnStatus(b) {
        var st = b.status;
        if (!st) return false;
        if (st === "slp") return !hasUsableWhileAsleepMove(b) ? false : false; // usingItem false, targetingSelf: returns FALSE
        if (st === "frz") return false;
        var harmless = benefitsFromStatus(b);
        if (st === "psn" || st === "tox") {
            if (hold(b) === "TOXIC_ORB") return false;
            if (b.ability === "Poison Heal") harmless = true;
            if (b.ability === "Toxic Boost" && !harmless && hasMoveWithCategory(b, "Physical")) harmless = true;
        }
        if (st === "brn") {
            if (hold(b) === "FLAME_ORB") return false;
            if (b.ability === "Flare Boost" && !harmless && hasMoveWithCategory(b, "Special")) harmless = true;
        }
        return !harmless;
    }
    // ShouldCureStatus for the player's status (AI removing it, e.g. Sparkling Aria / Purify on foe)
    function shouldCureTargetStatus(ctx) {
        var pl = ctx.pl, st = pl.status;
        if (!st || st === "slp" || st === "frz") return false;
        var harmless = benefitsFromStatus(pl);
        if (st === "psn" || st === "tox") {
            if (hold(pl) === "TOXIC_ORB") return false;
            if (pl.ability === "Poison Heal") harmless = true;
            if (pl.ability === "Toxic Boost" && !harmless && (hasMoveWithCategory(pl, "Physical") || !hasMoveWithCategory(pl, "Special"))) harmless = true;
        }
        if (st === "brn") {
            if (hold(pl) === "FLAME_ORB") return false;
            if (pl.ability === "Flare Boost" && !harmless && (hasMoveWithCategory(pl, "Special") || !hasMoveWithCategory(pl, "Physical"))) harmless = true;
        }
        return harmless;
    }

    // ---------------------------------------------------------------------
    // Trapping
    function canBattlerEscape(b) { return hasType(b, "Ghost") || hold(b) === "SHED_SHELL" || b.ability === "Run Away"; }
    function isTrapped(ctx) {
        var pl = ctx.pl, ai = ctx.ai;
        if (canBattlerEscape(pl)) return false;
        if (pl.vol.trapped || pl.vol.wrapped) return true;
        if (ai.ability === "Shadow Tag" && pl.ability !== "Shadow Tag") return true;
        if (ai.ability === "Arena Trap" && isGrounded(pl, ctx.field)) return true;
        if (ai.ability === "Magnet Pull" && hasType(pl, "Steel")) return true;
        return false;
    }
    // ShouldTrap; considerWrapDamage counts the residual damage a fresh Wrap/Bind/etc. would add (upstream #10427)
    function shouldTrap(ctx, considerWrapDamage) {
        var pl = ctx.pl;
        if (canBattlerEscape(pl)) return false;
        if (isTrapped(ctx)) return false;
        var wrapState = pl.vol.wrapped;
        if (considerWrapDamage) pl.vol.wrapped = true;
        var faints = willFaintFromSecondary(pl, ctx.field);
        pl.vol.wrapped = wrapState;
        return faints;
    }

    // ---------------------------------------------------------------------
    // Flinch
    function guaranteedEffects(atk, m) {
        return fx(m).filter(function (f) {
            var chance = f[1];
            if (chance === 0) return true;
            if (atk.ability === "Serene Grace") chance *= 2;
            if (atk.side.isRainbow) chance *= 2;
            return chance >= 100;
        });
    }
    function sheerForceAffected(atk, m) {
        return atk.ability === "Sheer Force" && fx(m).some(function (f) { return f[1] > 0; });
    }
    function isFlinchGuaranteed(ctx, m) {
        if (!hasFx(m, "FLINCH", false)) return false;
        if (aiIsSlower(ctx, m, null, true)) return false;
        var g = guaranteedEffects(ctx.ai, m).some(function (f) { return f[0] === "FLINCH"; });
        if (!g) return false;
        var pl = ctx.pl;
        if (hold(pl) === "COVERT_CLOAK" || substituteBlocks(ctx.ai, pl, m)) return false;
        if (!isMoldBreaker(ctx.ai) && (pl.ability === "Shield Dust" || pl.ability === "Inner Focus")) return false;
        return true;
    }
    function shouldTryToFlinch(ctx, m) {
        var pl = ctx.pl, ai = ctx.ai;
        if ((!isMoldBreaker(ai) && (pl.ability === "Shield Dust" || pl.ability === "Inner Focus")) || hold(pl) === "COVERT_CLOAK" || substituteBlocks(ai, pl, m) || aiIsSlower(ctx, m, null, true)) return false;
        if (ai.ability === "Serene Grace" || pl.status === "par" || pl.vol.infatuated || pl.vol.confused || (aiIsFaster(ctx, m, null, true) && canTargetFaintAi(ctx))) return true;
        return false;
    }

    // ---------------------------------------------------------------------
    // Stat changes
    function canLowerStat(ctx, m, s) {
        var pl = ctx.pl, ai = ctx.ai;
        if (stage(pl, s) === 0) return false;
        if (hold(pl) === "CLEAR_AMULET") return false;
        if (pl.side.isMist && ai.ability !== "Infiltrator") return false;
        if (!ignoresAbility(ai, m)) {
            if (hasType(pl, "Grass") && pl.ability === "Flower Veil") return false;
            var ab = pl.ability;
            if (ab === "Speed Boost" && s === "spe") return false;
            if (ab === "Hyper Cutter" && s === "atk") return false;
            if (ab === "Big Pecks" && s === "def") return false;
            if ((ab === "Keen Eye" || ab === "Mind's Eye" || ab === "Illuminate") && s === "acc") return false;
            if (has(["Contrary", "Clear Body", "White Smoke", "Full Metal Body"], ab)) return false;
            if (ab === "Shield Dust" && !isStatus(m)) return false;
        }
        if (s === "spe") {
            return !(aiIsFaster(ctx, m, null, false) && ctx.opts.aiLastMon && !hasMoveEffect(ai, "ELECTRO_BALL"));
        }
        return true;
    }
    function statDownScore(ctx, s) {
        var pl = ctx.pl, ai = ctx.ai, t = 0;
        if (s !== "spe" && stage(pl, s) <= 3) return 0;
        if (secondaryDamage(pl, ctx.field) >= pl.hp) return 0;
        if (has(["Defiant", "Competitive", "Contrary"], pl.ability)) return 0;
        switch (s) {
            case "atk": if (hasMoveWithCategory(pl, "Physical")) t += SC.DECENT; break;
            case "def": if (hasMoveWithCategory(ai, "Physical")) t += SC.DECENT; break;
            case "spe": if (aiIsSlower(ctx, null, null, false)) t += SC.DECENT; break;
            case "spa": if (hasMoveWithCategory(pl, "Special")) t += SC.DECENT; break;
            case "spd": if (hasMoveWithCategory(ai, "Special")) t += SC.DECENT; break;
            case "acc":
                t += SC.WEAK;
                if (isTrapped(ctx)) t += SC.DECENT;
                if (pl.side.isSeeded) t += SC.WEAK;
                if (pl.vol.cursed) t += SC.WEAK;
                break;
            case "eva":
                if (statusIs(pl, ["psn", "tox"])) t += SC.WEAK;
                if (pl.side.isSeeded) t += SC.WEAK;
                if (pl.vol.root) t += SC.WEAK;
                if (pl.vol.cursed) t += SC.WEAK;
                break;
        }
        return t > SC.BEST ? SC.BEST : t;
    }
    function statCanRise(b, s) {
        if (b.ability === "Contrary") return stage(b, s) > 0;
        return stage(b, s) < 12;
    }
    function shouldRaiseAnyStat(ctx, rng) {
        var ai = ctx.ai, pl = ctx.pl;
        if (statsMaxed(ai)) return false;
        if (pl.ability === "Unaware") return false;
        if (ai.vol.yawn && canBeSlept(ai, ctx.field)) return false;
        if (secondaryDamage(ai, ctx.field) >= ai.hp) return false;
        if (pl.ability === "Opportunist") return false;
        if (!rng.pct(CFG.BOOST_INTO_HAZE_CHANCE, "boost into Haze") && pl.vol.usedHaze) return false;
        if (countPositive(ai) > 0 && hasMoveWithAiEffect(pl, "resetStats")) return false;
        if (canBattlerKOTargetIgnoringSturdy(ctx)) return false;
        return true;
    }
    function hasMoveThatChangesKOThreshold(ctx, noOfHits, faster) {
        return movesOf(ctx.pl).some(function (m) {
            if (noOfHits > 2) return false;
            if (basePriority(m) > 0) return true;
            return fx(m).some(function (f) { return (f[0] === "SPD_MINUS_1" || f[0] === "SPD_MINUS_2") && faster && !f[2]; });
        });
    }
    // statChange: {stat, stages}
    function statUpScore(ctx, rng, stat, stages, considerContrary) {
        var ai = ctx.ai, pl = ctx.pl, t = 0;
        var noOfHits = noOfHitsForTargetToFaint(ctx, false);
        var faster = aiIsFaster(ctx, null, null, false);
        var shouldSetUp = (noOfHits >= 2 && faster) || (noOfHits >= 3 && !faster) || noOfHits === Infinity;
        if (considerContrary !== false && ai.ability === "Contrary") return 0;
        if (!shouldRaiseAnyStat(ctx, rng)) return 0;
        if (stage(ai, stat) >= 10) return 0;
        if (ai.hpPct < 70 && noOfHits === Infinity) return 0;
        if (hasMoveThatChangesKOThreshold(ctx, noOfHits, faster)) return 0;
        if (ai.ability === "Simple") stages *= 2;
        switch (stat) {
            case "atk":
                if (hasMoveWithCategory(ai, "Physical") && shouldSetUp) t += stages === 1 ? SC.DECENT : stages === 6 ? SC.BEST : SC.GOOD;
                break;
            case "def":
                if (hasMoveWithCategory(pl, "Physical") || !hasMoveWithCategory(pl, "Special")) t += stages === 1 ? SC.WEAK : SC.DECENT;
                break;
            case "spe":
                if ((noOfHits >= 3 && !faster) || noOfHits === Infinity) t += stages === 1 ? SC.DECENT : SC.GOOD;
                break;
            case "spa":
                if (hasMoveWithCategory(ai, "Special") && shouldSetUp) t += stages === 1 ? SC.DECENT : SC.GOOD;
                break;
            case "spd":
                if (hasMoveWithCategory(pl, "Special") || !hasMoveWithCategory(pl, "Physical")) t += stages === 1 ? SC.WEAK : SC.DECENT;
                break;
            case "acc":
                if (stage(ai, "acc") <= 3) t += SC.DECENT;
                break;
            case "eva":
                t += (noOfHits > 3 || noOfHits === Infinity) ? SC.GOOD : SC.DECENT;
                break;
        }
        if (t > 0 && hasMoveEffect(ai, "STORED_POWER")) t += SC.WEAK;
        return t;
    }
    function statUp(ctx, rng, stat, stages) { return statUpScore(ctx, rng, stat, stages, true); }
    function statUpContrary(ctx, rng, stat, stages) { return statUpScore(ctx, rng, stat, stages, false); }
    var FX_STAT = { ATK: "atk", DEF: "def", SPD: "spe", SP_ATK: "spa", SP_DEF: "spd", ACC: "acc", EVS: "eva" };
    function parseStatFx(name) {
        var mm = /^(ATK|DEF|SPD|SP_ATK|SP_DEF|ACC|EVS)_(PLUS|MINUS)_(1|2)$/.exec(name);
        if (!mm) return null;
        return { stat: FX_STAT[mm[1]], dir: mm[2] === "PLUS" ? 1 : -1, stages: +mm[3] };
    }

    // Null-style setup scoring
    function shouldBlockSetup(ctx, m) {
        var ai = ctx.ai, pl = ctx.pl;
        if (canTargetFaintAi(ctx)) {
            if (ai.ability === "Sturdy" && ai.hp === ai.maxHp) return false;
            if (hold(ai) === "FOCUS_SASH" && ai.hp === ai.maxHp) return false;
            return true;
        }
        if (pl.ability === "Unaware" && !has(["Power-Up Punch", "Swords Dance", "Howl"], m.name)) return true;
        if (hasMoveEffect(pl, "HAZE") || hasMoveNamed(pl, "Clear Smog") || hasMoveEffect(pl, "TOPSY_TURVY") || hasMoveNamed(pl, "Freezy Frost")) return true;
        return false;
    }
    function offensiveSetupScore(ctx, rng, boostsAtk, boostsSpAtk) {
        var ai = ctx.ai, pl = ctx.pl, score = 6;
        var faster = aiIsFaster(ctx, null, null, false);
        var noOfHits = noOfHitsForTargetToFaint(ctx, true);
        if (incapacitated(pl)) { if (rng.pct(90, "setup: foe incapacitated")) score += 3; }
        else if (noOfHits >= 4) score += faster ? 2 : 1;
        if (!faster && noOfHits === 2) score -= 5;
        if ((hasMoveEffect(pl, "ROAR") || hasMoveEffect(pl, "HIT_SWITCH_TARGET")) && !ctx.opts.aiLastMon) score -= 5;
        if ((hasMoveEffect(pl, "FOUL_PLAY") || hasMoveEffect(pl, "CONFUSE")) && boostsAtk) score -= 5;
        if ((hasMoveNamed(pl, "Burning Jealousy") || hasMoveNamed(pl, "Alluring Voice")) && faster && boostsAtk) score -= 5;
        if (boostsAtk && stage(ai, "atk") >= 8 && rng.pct(80, "setup: already +2 Atk")) score -= 1;
        if (boostsSpAtk && stage(ai, "spa") >= 8 && rng.pct(80, "setup: already +2 SpA")) score -= 1;
        return score;
    }
    function defensiveSetupScore(ctx, rng, boostsDef, boostsSpDef) {
        var ai = ctx.ai, pl = ctx.pl, score = 6;
        var faster = aiIsFaster(ctx, null, null, false);
        var noOfHits = noOfHitsForTargetToFaint(ctx, true);
        if (rng.pct(80, "defensive setup bonuses")) {
            if (incapacitated(pl) && rng.pct(90, "setup: foe incapacitated")) score += 2;
            if ((hasMoveEffect(ai, "STORED_POWER") || hasMoveEffect(ai, "BODY_PRESS")) && rng.pct(50, "setup: Stored Power/Body Press")) score += 1;
            if (boostsDef && hasMoveWithCategory(pl, "Physical") && !hasMoveWithCategory(pl, "Special")) score += 1;
            if (boostsSpDef && hasMoveWithCategory(pl, "Special") && !hasMoveWithCategory(pl, "Physical")) score += 1;
            if (boostsDef && stage(ai, "def") >= 8) score -= 1;
            if (boostsSpDef && stage(ai, "spd") >= 8) score -= 1;
            if (boostsDef && boostsSpDef && (stage(ai, "def") < 8 || stage(ai, "spd") < 8)) score += 2;
        }
        if (!faster && noOfHits === 2) score -= 5;
        if ((hasMoveEffect(pl, "ROAR") || hasMoveEffect(pl, "HIT_SWITCH_TARGET")) && !ctx.opts.aiLastMon) score -= 5;
        return score;
    }
    function speedSetupScore(ctx, rng) {
        var pl = ctx.pl, score = 6;
        if (aiIsFaster(ctx, null, null, false)) score -= 20;
        else if (rng.pct(80, "speed setup")) score += 1;
        if (hasMoveEffect(pl, "HAZE") || hasMoveNamed(pl, "Clear Smog") || hasMoveEffect(pl, "TOPSY_TURVY") || hasMoveEffect(pl, "ROAR") || hasMoveEffect(pl, "HIT_SWITCH_TARGET")) score -= 20;
        return score;
    }

    // ---------------------------------------------------------------------
    // Recovery
    function recoveryEnablesWinning(ctx, rng, faster, healAmount) {
        var ai = ctx.ai;
        if (faster) {
            if (canTargetFaintAi(ctx) && !canTargetFaintAiWithMod(ctx, healAmount, 0)) return true;
            if (!canTargetFaintAi(ctx) && ai.hpPct < CFG.ENABLE_RECOVERY_THRESHOLD && rng.pct(CFG.SHOULD_RECOVER_CHANCE, "recover roll")) return true;
        } else {
            if (!canTargetFaintAi(ctx) && bestDmgFrom(ctx.pl) < healAmount && noOfHitsForTargetToFaint(ctx, true) < noOfHitsForTargetToFaintWithMod(ctx, healAmount)) return true;
            if (!canTargetFaintAi(ctx) && ai.hpPct < CFG.ENABLE_RECOVERY_THRESHOLD && rng.pct(CFG.SHOULD_RECOVER_CHANCE, "recover roll")) return true;
        }
        return false;
    }
    function shouldRecover(ctx, rng, m, healPercent) {
        var ai = ctx.ai;
        var heal = Math.floor(healPercent * ai.maxHp / 100);
        var faster = aiIsFaster(ctx, m, null, true);
        if (heal + ai.hp > ai.maxHp) heal = ai.maxHp - ai.hp;
        if (ai.vol.healBlock) heal = 0;
        if (ai.hp === ai.maxHp) return false;
        return recoveryEnablesWinning(ctx, rng, faster, heal);
    }
    function shouldAbsorb(ctx, rng, m) {
        var ai = ctx.ai, pl = ctx.pl;
        var heal = Math.floor(dmgOf(m) * ((m.d && m.d.absorb) || 50) / 100);
        if (hold(ai) === "BIG_ROOT") heal = Math.floor(heal * 5324 / 4096);
        var faster = aiIsFaster(ctx, m, null, true);
        if (heal === 0) heal = 1;
        if (heal + ai.hp > ai.maxHp) heal = ai.maxHp - ai.hp;
        if (ai.vol.healBlock) heal = 0;
        if (pl.ability === "Liquid Ooze") return false;
        var incoming = ctx.playerLastMove;
        if (ai.hp === ai.maxHp && (faster || !incoming || isStatus(incoming))) return false;
        if (recoveryEnablesWinning(ctx, rng, faster, heal)) return true;
        var best = bestDmgFrom(pl);
        if (best >= ai.maxHp + heal) return false;
        if (best >= ai.hp && ai.hp + heal > best) return true;
        return false;
    }
    function shouldSetScreen(ctx, e) {
        if (hasMoveWithAiEffect(ctx.pl, "breakScreens")) return false;
        return isScreenUseful(ctx, e);
    }
    // Same as shouldSetScreen minus the screen-breaker check, so the caller can weigh that risk itself
    function isScreenUseful(ctx, e) {
        var ai = ctx.ai, pl = ctx.pl;
        switch (e) {
            case "AURORA_VEIL": return weatherIs(ctx.field, ICY) && !(ai.side.isReflect || ai.side.isLightScreen || ai.side.isAuroraVeil);
            case "REFLECT": return hasMoveWithCategory(pl, "Physical") && !(ai.side.isReflect || ai.side.isAuroraVeil);
            case "LIGHT_SCREEN": return hasMoveWithCategory(pl, "Special") && !(ai.side.isLightScreen || ai.side.isAuroraVeil);
        }
        return false;
    }
    function shouldUseWishAromatherapy(ctx, m) {
        var ai = ctx.ai;
        if (ctx.opts.aiLastMon && (canTargetFaintAi(ctx) || willFaintFromSecondary(ai, ctx.field))) return false;
        if (eff(m) === "WISH") return ai.hpPct < 65; // own HP is the only party HP known here
        if (eff(m) === "HEAL_BELL") return !!ai.status;
        return false;
    }
    function shouldPivot(ctx, rng, m) {
        var ai = ctx.ai, pl = ctx.pl;
        var faster = aiIsFaster(ctx, m, null, true);
        var hasGoodSwitchin = !!ctx.opts.aiGoodSwitchin && !ctx.opts.aiLastMon;
        var maxHpProtection = atMaxHp(pl) && (hold(pl) === "FOCUS_SASH" || has(["Sturdy", "Multiscale", "Shadow Shield"], pl.ability));
        if (!isStatus(m) && maxHpProtection && hasGoodSwitchin && rng.pct(CFG.SHOULD_PIVOT_BREAK_SASH_CHANCE, "pivot: break sash")) return "SHOULD";
        if (ai.ability === "Regenerator" && shouldRecover(ctx, rng, m, 33) && hasGoodSwitchin) return "SHOULD";
        if (hitsToKOBattler(ai, pl, m, true) && !hasGoodSwitchin) return "DONT";
        return "CAN";
    }
    function shouldSetUpHazards(ctx, m) {
        var ai = ctx.ai, pl = ctx.pl;
        if (ctx.opts.playerLastMon || hasMoveWithAiEffect(pl, "clearHazards")) return false;
        if (isStatus(m)) {
            if (hasMoveEffect(pl, "MAGIC_COAT")) return false;
            if (ignoresAbility(ai, m)) return true;
            if (pl.ability === "Magic Bounce") return false;
        } else {
            if (ignoresAbility(ai, m)) return true;
            if (pl.ability === "Shield Dust") return false;
        }
        return true;
    }
    function substituteMoveScore(ctx, m) {
        var ai = ctx.ai, pl = ctx.pl, s = 0;
        if (eff(m) === "SUBSTITUTE") {
            if (bestDmgFrom(pl) < Math.floor(ai.maxHp / 4)) s += SC.GOOD;
        } else if (eff(m) === "SHED_TAIL") {
            if (bestDmgFrom(pl) < Math.floor(ai.maxHp / 2)) s += SC.BEST; // ShouldPivot is always truthy
        }
        if (pl.vol.perishSong) s += SC.GOOD;
        if (pl.status === "slp") s += SC.GOOD;
        else if (statusIs(pl, ["psn", "tox", "brn"])) s += SC.DECENT;
        if (hasNonVolatileMoveEffect(pl, "SLEEP") || hasNonVolatileMoveEffect(pl, "TOXIC") || hasNonVolatileMoveEffect(pl, "PARALYSIS") || hasNonVolatileMoveEffect(pl, "BURN") || hasMoveEffect(pl, "CONFUSE") || hasMoveEffect(pl, "LEECH_SEED")) s += SC.GOOD;
        if (ai.hpPct > 70) s += SC.WEAK;
        return s;
    }
    function tryToClearStats(ctx) { return Math.min(countPositive(ctx.pl), 4); }
    function shouldCopyStatChanges(ctx) {
        var ai = ctx.ai, pl = ctx.pl;
        for (var i = 0; i < STAT_NAMES.length; i++) {
            var s = STAT_NAMES[i];
            if ((pl.boosts[s] || 0) > (ai.boosts[s] || 0)) {
                switch (s) {
                    case "atk": return hasMoveWithCategory(ai, "Physical");
                    case "spa": return hasMoveWithCategory(ai, "Special");
                    case "acc": return hasMoveWithLowAccuracy(ctx, CFG.LOW_ACCURACY_THRESHOLD, false);
                    case "eva": case "spe": return true;
                    case "def": case "spd": return false;
                }
            }
        }
        return false;
    }
    function hasMoveWithLowAccuracy(ctx, accCheck, ignoreStatus) {
        return movesOf(ctx.ai).some(function (m) {
            if (ignoreStatus && isStatus(m)) return false;
            if (!isStatus(m) && m.d && m.d.acc === 0) return false;
            if (target(m) === "USER" || target(m) === "OPPONENTS_FIELD") return false;
            return m.accv <= accCheck;
        });
    }
    function hasSleepMoveWithLowAccuracy(ctx) {
        return movesOf(ctx.ai).some(function (m) { return nonVolatile(m) === "SLEEP" && m.accv < 85; });
    }
    function shouldTryOHKO(ctx, rng, m) {
        var ai = ctx.ai, pl = ctx.pl;
        if (hold(pl) === "FOCUS_BAND" && rng.pct(holdParam(pl), "Focus Band")) return false;
        if (hold(pl) === "FOCUS_SASH" && atMaxHp(pl)) return false;
        if (!ignoresAbility(ai, m) && pl.ability === "Sturdy") return false;
        if ((pl.vol.lockOn || ai.ability === "No Guard" || pl.ability === "No Guard") && ai.level >= pl.level) return true;
        var odds = m.accv + (ai.level - pl.level);
        if (flag(m, "accIncreaseByTenOnSameType") && !hasType(ai, moveType(m))) odds -= 10;
        if (ai.level >= pl.level && rng.pct(odds - 1, "OHKO odds")) return true;
        return false;
    }
    function explosionMementoHPScore(ctx, rng) {
        var p = Math.floor(ctx.ai.hp * 100 / ctx.ai.maxHp);
        if (p < 10) return 10;
        if (p < 33) return rng.pct(70, "explosion HP roll") ? 8 : 0;
        if (p < 66) return rng.pct(50, "explosion HP roll") ? 7 : 0;
        return rng.pct(5, "explosion HP roll") ? 7 : 0;
    }
    function explosionChanceFromHP(hpPct) {
        if (hpPct >= CFG.EXPLOSION_HIGHER) return CFG.EXPLOSION_MIN;
        if (hpPct <= CFG.EXPLOSION_LOWER) return CFG.EXPLOSION_MAX;
        return CFG.EXPLOSION_HIGHER - hpPct;
    }
    function shouldFinalGambit(ctx, faster) {
        if (!ctx.roll.finalGambit) return false;
        return ctx.ai.hp >= ctx.pl.hp && faster;
    }
    function shouldConsiderSelfSacrifice(ctx, m, faster) {
        if (isExplosion(m) && ctx.roll.explosion) return true;
        if (eff(m) === "FINAL_GAMBIT") return shouldFinalGambit(ctx, faster);
        return false;
    }

    // ---------------------------------------------------------------------
    // Weather / terrain benefit (battle_ai_field_statuses.c), singles
    function abilityBenefitsFromWeather(ab, w) {
        switch (ab) {
            case "Forecast": return has(SUN, w) || has(RAIN, w) || has(ICY, w);
            case "Magic Guard": case "Overcoat": return w === "Sand" || w === "Hail";
            case "Sand Force": case "Sand Rush": case "Sand Veil": return w === "Sand";
            case "Ice Body": case "Ice Face": case "Snow Cloak": return has(ICY, w);
            case "Slush Rush": return w === "Snow";
            case "Dry Skin": case "Hydration": case "Rain Dish": case "Swift Swim": return has(RAIN, w);
            case "Chlorophyll": case "Flower Gift": case "Harvest": case "Leaf Guard": case "Orichalcum Pulse": case "Protosynthesis": case "Solar Power": case "Mega Sol": return has(SUN, w);
        }
        return false;
    }
    function abilityBenefitsFromField(ab, t) {
        switch (ab) {
            case "Mimicry": return !!t;
            case "Hadron Engine": case "Quark Drive": case "Surge Surfer": return t === "Electric";
            case "Grass Pelt": return t === "Grassy";
        }
        return false;
    }
    function isLightSensitive(m) { return has(["SOLAR_BEAM", "MORNING_SUN", "SYNTHESIS", "MOONLIGHT", "GROWTH"], eff(m)); }
    function hasLightSensitiveMove(b) { return movesOf(b).some(isLightSensitive); }
    function hasTerrainBoostMove(b, t) { return movesOf(b).some(function (m) { return eff(m) === "TERRAIN_BOOST" && m.d && m.d.terrainBoost === t.toUpperCase(); }); }
    var POS = 1, NEU = 0, NEG = -1;
    function benefitsFromSun(b, foe, field) {
        if (hold(b) === "UTILITY_UMBRELLA") return has(["Orichalcum Pulse", "Protosynthesis"], b.ability) ? POS : NEU;
        if (abilityBenefitsFromWeather(b.ability, "Sun") || hasLightSensitiveMove(b) || hasDamagingMoveOfType(b, "Fire") || hasMoveEffect(b, "HYDRO_STEAM")) return POS;
        if (hasMoveWithFlag(b, "accuracy50InSun") || hasDamagingMoveOfType(b, "Water") || b.ability === "Dry Skin") return NEG;
        return NEU;
    }
    function benefitsFromSand(b, foe, field) {
        if (abilityBenefitsFromWeather(b.ability, "Sand") || hasType(b, "Rock")) return POS;
        if (hold(b) === "SAFETY_GOGGLES" || hasType(b, "Rock") || hasType(b, "Ground") || hasType(b, "Steel")) {
            if (!(hasType(foe, "Rock") || hasType(foe, "Ground") || hasType(foe, "Steel")) || hold(foe) === "SAFETY_GOGGLES" || abilityBenefitsFromWeather(foe.ability, "Sand")) return POS;
            return NEU;
        }
        return NEG;
    }
    function benefitsFromHailOrSnow(b, foe, field, w) {
        if (abilityBenefitsFromWeather(b.ability, w) || hasType(b, "Ice") || hasMoveWithFlag(b, "alwaysHitsInHailSnow") || hasMoveEffect(b, "AURORA_VEIL")) return POS;
        if (w === "Hail" && hold(b) !== "SAFETY_GOGGLES") return NEG;
        if (hasLightSensitiveMove(b)) return NEG;
        if (hasMoveWithFlag(foe, "alwaysHitsInHailSnow")) return NEG;
        return NEU;
    }
    function benefitsFromRain(b, foe, field) {
        if (hold(b) === "UTILITY_UMBRELLA") return NEU;
        if (abilityBenefitsFromWeather(b.ability, "Rain") || hasMoveWithFlag(b, "alwaysHitsInRain") || hasDamagingMoveOfType(b, "Water")) return POS;
        if (hasLightSensitiveMove(b) || hasDamagingMoveOfType(b, "Fire")) return NEG;
        if (hasMoveWithFlag(foe, "alwaysHitsInRain")) return NEG;
        return NEU;
    }
    function weatherOutcome(ctx, w) {
        var b = ctx.ai, foe = ctx.pl, f = ctx.field;
        if (w === "Rain") return benefitsFromRain(b, foe, f);
        if (w === "Sun") return benefitsFromSun(b, foe, f);
        if (w === "Sand") return benefitsFromSand(b, foe, f);
        if (w === "Hail" || w === "Snow") return benefitsFromHailOrSnow(b, foe, f, w);
        return NEU;
    }
    function weatherChecker(ctx, w, desired) {
        if (weatherIs(ctx.field, PRIMAL)) return desired === "BLOCKED";
        return weatherOutcome(ctx, w) === desired;
    }
    function weatherMatches(field, w) {
        if (!weatherActive(field)) return false;
        if (w === "Sun") return has(SUN, field.weather);
        if (w === "Rain") return has(RAIN, field.weather);
        if (w === "Sand") return field.weather === "Sand";
        if (w === "Hail") return field.weather === "Hail";
        if (w === "Snow") return field.weather === "Snow";
        return false;
    }
    function shouldSetWeather(ctx, w) { if (weatherMatches(ctx.field, w)) return false; return weatherChecker(ctx, w, POS); }
    function shouldClearWeather(ctx, w) { return weatherChecker(ctx, w, NEG); }
    function terrainOutcome(ctx, t) {
        var b = ctx.ai, foe = ctx.pl, f = ctx.field;
        var grounded = isGrounded(b, f);
        if (abilityBenefitsFromField(b.ability, t)) return POS;
        switch (t) {
            case "Electric":
                if (hasTerrainBoostMove(b, "Electric")) return POS;
                if (hasMoveEffect(foe, "REST") && isGrounded(foe, f)) return POS;
                if (grounded && hasMoveWithFx(foe, "SLEEP")) return POS;
                if (grounded && (b.status === "slp" || b.vol.yawn || hasDamagingMoveOfType(b, "Electric"))) return POS;
                if (hasTerrainBoostMove(foe, "Electric")) return NEG;
                return NEU;
            case "Grassy":
                if (hasMoveEffect(b, "GRASSY_GLIDE") || hasMoveWithFx(b, "FLORAL_HEALING")) return POS;
                if (grounded && (hasMoveEffect(foe, "EARTHQUAKE") || hasMoveEffect(foe, "MAGNITUDE"))) return POS;
                if (grounded && hasDamagingMoveOfType(b, "Grass")) return POS;
                if (hasMoveEffect(foe, "GRASSY_GLIDE")) return NEG;
                return NEU;
            case "Misty":
                if (hasTerrainBoostMove(b, "Misty")) return POS;
                if (hasMoveEffect(foe, "REST") && isGrounded(foe, f)) return POS;
                if (grounded && hasDamagingMoveOfType(foe, "Dragon")) return POS;
                if (grounded && hasNonVolatileMoveEffect(foe, "SLEEP")) return POS;
                if (grounded && (b.status === "slp" || b.vol.yawn)) return POS;
                return NEU;
            case "Psychic":
                if (hasTerrainBoostMove(b, "Psychic")) return POS;
                if (grounded && has(["Gale Wings", "Triage", "Prankster"], foe.ability)) return POS;
                if (grounded && hasDamagingMoveOfType(b, "Psychic")) return POS;
                if (hasTerrainBoostMove(foe, "Psychic")) return NEG;
                if (has(["Gale Wings", "Triage", "Prankster"], b.ability)) return NEG;
                return NEU;
            case "Gravity":
                if (!grounded) return NEG;
                if (b.ability === "Hustle") return POS;
                if (hasMoveWithFlag(b, "gravityBanned")) return NEG;
                if (hasMoveWithLowAccuracy(ctx, CFG.LOW_ACCURACY_THRESHOLD, false) || (!isGrounded(foe, f) && hasDamagingMoveOfType(b, "Ground"))) return POS;
                return NEU;
            case "TrickRoom":
                if (b.speed < foe.speed) return POS;
                if (b.speed === foe.speed) return NEU;
                return NEG;
        }
        return NEU;
    }
    function shouldSetFieldStatus(ctx, t) {
        var f = ctx.field;
        if (t === "TrickRoom") { if (f.trickRoom) return false; }
        else if (t === "Gravity") { if (f.gravity) return false; }
        else if (f.terrain === t) return false;
        return terrainOutcome(ctx, t) === POS;
    }
    function shouldClearFieldStatus(ctx, t) { return terrainOutcome(ctx, t) === NEG; }
    function weatherScore(ctx, m) {
        var ai = ctx.ai, pl = ctx.pl, w = m.d && m.d.weather, s = 0;
        var hasWeatherBall = hasMoveEffect(ai, "WEATHER_BALL");
        var foeSunHeal = hasMoveEffect(pl, "MORNING_SUN") || hasMoveEffect(pl, "SYNTHESIS") || hasMoveEffect(pl, "MOONLIGHT");
        if (w === "RAIN" && shouldSetWeather(ctx, "Rain")) {
            s += SC.DECENT;
            if (hasWeatherBall) s += SC.WEAK;
            if (hold(ai) === "DAMP_ROCK") s += SC.WEAK;
            if (foeSunHeal || hasMoveEffect(pl, "SOLAR_BEAM")) s += SC.WEAK;
            if (hasDamagingMoveOfType(pl, "Fire")) s += SC.WEAK;
        } else if (w === "SUN" && shouldSetWeather(ctx, "Sun")) {
            s += SC.DECENT;
            if (hasWeatherBall) s += SC.WEAK;
            if (hold(ai) === "HEAT_ROCK") s += SC.WEAK;
            if (hasDamagingMoveOfType(pl, "Water")) s += SC.WEAK;
            if (hasMoveWithFlag(pl, "accuracy50InSun")) s += SC.WEAK;
        } else if (w === "SANDSTORM" && shouldSetWeather(ctx, "Sand")) {
            s += SC.DECENT;
            if (hasWeatherBall) s += SC.WEAK;
            if (hold(ai) === "SMOOTH_ROCK") s += SC.WEAK;
            if (foeSunHeal) s += SC.WEAK;
        } else if ((w === "HAIL" || w === "SNOW") && shouldSetWeather(ctx, w === "HAIL" ? "Hail" : "Snow")) {
            s += SC.DECENT;
            if (hasMoveEffect(ai, "AURORA_VEIL") && shouldSetScreen(ctx, "AURORA_VEIL")) s += SC.GOOD;
            if (hasWeatherBall) s += SC.WEAK;
            if (hold(ai) === "ICY_ROCK") s += SC.WEAK;
            if (foeSunHeal) s += SC.WEAK;
        }
        return s;
    }

    // ---------------------------------------------------------------------
    // Status-inflicting score helpers (with rolls)
    function berryCureRoll(rng, label) {
        var r = rng.uniform100(label);
        if (r < 40) return 6;
        if (r < 60) return 7;
        return 0;
    }
    function increasePoisonScore(ctx, rng, m, adj) {
        if (!aiCanPoison(ctx, m)) return;
        var pl = ctx.pl, ai = ctx.ai;
        if (hold(pl) === "CURE_PSN" || hold(pl) === "CURE_STATUS") { adj(berryCureRoll(rng, "poison vs cure berry"), "poison (berry cure)"); return; }
        adj(6, "poison");
        if (!canAIFaintTarget(ctx, 0) && pl.hp > Math.floor(pl.maxHp / 5) && rng.pct(20, "poison extras")) {
            if (!hasDamagingMove(pl)) adj(1, "poison: foe has no attacks");
            if (hasMoveEffect(ai, "PROTECT")) adj(1, "poison: has Protect");
            if (hasMoveEffect(ai, "DOUBLE_POWER_ON_ARG_STATUS") || hasMoveEffect(ai, "VENOM_DRENCH") || ai.ability === "Merciless") adj(1, "poison: Hex/Venoshock/Merciless");
        }
    }
    function increaseBurnScore(ctx, rng, m, adj) {
        if (!aiCanBurn(ctx, m)) return;
        var pl = ctx.pl, ai = ctx.ai;
        if (hold(pl) === "CURE_BRN" || hold(pl) === "CURE_STATUS") { adj(berryCureRoll(rng, "burn vs cure berry"), "burn (berry cure)"); return; }
        adj(6, "burn");
        if (!canAIFaintTarget(ctx, 0) && rng.pct(33, "burn extras")) {
            adj(1, "burn: extra");
            if (hasMoveWithCategory(pl, "Physical")) adj(1, "burn: foe is physical");
            else if (hasMoveEffect(ai, "DOUBLE_POWER_ON_ARG_STATUS")) adj(1, "burn: has Hex");
        }
    }
    function increaseParalyzeScore(ctx, rng, m, adj) {
        if (!aiCanParalyze(ctx, m)) return;
        var pl = ctx.pl, ai = ctx.ai;
        if (hold(pl) === "CURE_PAR" || hold(pl) === "CURE_STATUS") { adj(berryCureRoll(rng, "para vs cure berry"), "paralysis (berry cure)"); return; }
        if (canAIFaintTarget(ctx, 0)) return;
        var flip = pl.speed > ai.speed && Math.floor(pl.speed / 4) < ai.speed;
        var hexOrFlinch = hasMoveEffect(ai, "DOUBLE_POWER_ON_ARG_STATUS") || hasMoveWithFxExcept(ai, "FLINCH", "FIRST_TURN_ONLY");
        var conf = pl.vol.infatuated || pl.vol.confused;
        if (flip || hexOrFlinch || conf) adj(rng.pct(50, "paralysis roll") ? 8 : 7, "paralysis (speed flip/Hex/flinch)");
        else adj(rng.pct(50, "paralysis roll") ? 7 : 6, "paralysis");
    }
    function increaseSleepScore(ctx, rng, m, adj) {
        if (!aiCanPutToSleep(ctx, m)) return;
        var pl = ctx.pl, ai = ctx.ai;
        if (hold(pl) === "CURE_SLP" || hold(pl) === "CURE_STATUS") { adj(berryCureRoll(rng, "sleep vs cure berry"), "sleep (berry cure)"); return; }
        adj(6, "sleep");
        if (!canAIFaintTarget(ctx, 0) && rng.pct(25, "sleep extras")) {
            if ((hasMoveEffect(ai, "DREAM_EATER") || hasMoveEffect(ai, "NIGHTMARE")) && !hasMoveEffect(pl, "SNORE") && !hasMoveEffect(pl, "SLEEP_TALK")) adj(1, "sleep: Dream Eater/Nightmare");
            if (hasMoveEffect(ai, "DOUBLE_POWER_ON_ARG_STATUS")) adj(1, "sleep: has Hex");
        }
    }
    function increaseConfusionScore(ctx, rng, m, adj) {
        if (canAIFaintTarget(ctx, 0)) return;
        if (!aiCanBeConfused(ctx, m)) return;
        var pl = ctx.pl, ai = ctx.ai;
        if (hold(pl) === "CURE_CONFUSION" || hold(pl) === "CURE_STATUS") { adj(berryCureRoll(rng, "confuse vs cure berry"), "confusion (berry cure)"); return; }
        adj(6, "confusion");
        if (!canAIFaintTarget(ctx, 0) && rng.pct(25, "confusion extras")) {
            adj(1, "confusion extra");
            if (pl.status === "par" || pl.vol.infatuated || (ai.ability === "Serene Grace" && hasMoveWithFxExcept(ai, "FLINCH", "FIRST_TURN_ONLY"))) adj(1, "confusion: para/infatuated/Serene Grace");
        }
    }
    function increaseFrostbiteScore(ctx, rng, m, adj) {
        if (canAIFaintTarget(ctx, 0)) return;
        if (!aiCanFrostbite(ctx, m)) return;
        var pl = ctx.pl, ai = ctx.ai;
        if (hasMoveWithCategory(pl, "Special")) {
            var hasSpecial = bestDmgMoves(pl, ai).some(isSpecial);
            adj(hasSpecial ? SC.DECENT : SC.WEAK, "frostbite");
        }
        if (movesOf(ai).some(function (mm) { return eff(mm) === "DOUBLE_POWER_ON_ARG_STATUS" && mm.d && (mm.d.argStatus === "FROSTBITE" || mm.d.argStatus === "ANY"); })) adj(SC.WEAK, "frostbite: has Hex");
    }

    // ---------------------------------------------------------------------
    // Protect
    function protectChecks(ctx, rng, m, predicted) {
        var ai = ctx.ai, pl = ctx.pl, score = 6;
        if (predicted && flag(predicted, "ignoresProtect")) return SC.WORST;
        if ((m.d && m.d.protect !== "MAX_GUARD") && predicted && flag(predicted, "makesContact") && pl.ability === "Unseen Fist") return SC.WORST;
        if (statusIs(pl, ["psn", "tox", "brn"]) || pl.vol.cursed || pl.vol.infatuated || pl.vol.perishSong || pl.side.isSeeded || pl.vol.yawn) score += 1;
        if (statusIs(ai, ["psn", "tox", "brn"]) || ai.vol.cursed || ai.vol.infatuated || ai.vol.perishSong || ai.side.isSeeded || ai.vol.yawn) score -= 2;
        if (ctx.opts.firstTurn) score -= 1;
        if (ctx.opts.protectStreak === 1) { if (rng.pct(50, "protected last turn")) return -20; }
        else if (ctx.opts.protectStreak >= 2) return -20;
        if (willFaintFromSecondary(ai, ctx.field)) return -20;
        return score;
    }

    root.KudzuAIEngineCore = {
        SC: SC, CFG: CFG, STAT_STAGE_RATIO: STAT_STAGE_RATIO, STAT_NAMES: STAT_NAMES, MOXIE_ABILITIES: MOXIE_ABILITIES, DAZZLING: DAZZLING,
        STAT_RAISING: STAT_RAISING, STAT_LOWERING: STAT_LOWERING, HAZARD_EFFECTS: HAZARD_EFFECTS, AROMA_VEIL_EFFECTS: AROMA_VEIL_EFFECTS,
        PINCH_BERRIES: PINCH_BERRIES, NORMAL_TYPE_STATUS: NORMAL_TYPE_STATUS, SUN: SUN, RAIN: RAIN, SAND: SAND, ICY: ICY, PRIMAL: PRIMAL,
        has: has, eff: eff, power: power, isStatus: isStatus, isPhysical: isPhysical, isSpecial: isSpecial, moveType: moveType, flag: flag,
        target: target, fx: fx, nonVolatile: nonVolatile, hasFx: hasFx, isExplosion: isExplosion, isSound: isSound, isPowder: isPowder,
        isHealing: isHealing, isMultiHit: isMultiHit, strikeCount: strikeCount, basePriority: basePriority, isSelfSacrifice: isSelfSacrifice,
        isRecoilDamageEffect: isRecoilDamageEffect, isDamagedByRecoil: isDamagedByRecoil, recoilKOsSelfAt: recoilKOsSelfAt, doesBattlerKOItselfWithRecoil: doesBattlerKOItselfWithRecoil,
        isTrappingMove: isTrappingMove, isHazardMove: isHazardMove, isHazardClearing: isHazardClearing, aiEffectGroup: aiEffectGroup,
        hasType: hasType, hold: hold, holdParam: holdParam, isBerry: isBerry, movesOf: movesOf, hasMoveEffect: hasMoveEffect, hasMoveNamed: hasMoveNamed,
        hasMoveWithCategory: hasMoveWithCategory, hasMoveWithType: hasMoveWithType, hasDamagingMove: hasDamagingMove, hasDamagingMoveOfType: hasDamagingMoveOfType,
        hasMoveWithFx: hasMoveWithFx, hasMoveWithFxExcept: hasMoveWithFxExcept, hasNonVolatileMoveEffect: hasNonVolatileMoveEffect, hasMoveWithFlag: hasMoveWithFlag,
        hasMoveWithAiEffect: hasMoveWithAiEffect, hasOnlyMovesWithCategory: hasOnlyMovesWithCategory, hasThawingMove: hasThawingMove,
        hasUsableWhileAsleepMove: hasUsableWhileAsleepMove, hasHealingEffect: hasHealingEffect, stage: stage, anyStatRaised: anyStatRaised,
        countPositive: countPositive, countNegative: countNegative, statsMaxed: statsMaxed, isMoldBreaker: isMoldBreaker, ignoresAbility: ignoresAbility,
        atMaxHp: atMaxHp, isGrounded: isGrounded, terrainAffected: terrainAffected, weatherActive: weatherActive, weatherIs: weatherIs, statusIs: statusIs,
        incapacitated: incapacitated, isAsleepOrComatose: isAsleepOrComatose, isWakeupTurn: isWakeupTurn, typeEffectiveness: typeEffectiveness,
        chartMult: chartMult,
        movePriority: movePriority, whoStrikesFirst: whoStrikesFirst, aiIsFaster: aiIsFaster, aiIsSlower: aiIsSlower, moveAccuracy: moveAccuracy,
        dmgOf: dmgOf, hitsToKO: hitsToKO, canEndureHit: canEndureHit, hitsToKOBattler: hitsToKOBattler, canTargetFaintAi: canTargetFaintAi,
        noOfHitsForTargetToFaint: noOfHitsForTargetToFaint, noOfHitsForTargetToFaintWithMod: noOfHitsForTargetToFaintWithMod,
        canTargetFaintAiWithMod: canTargetFaintAiWithMod, canIndexMoveFaintTarget: canIndexMoveFaintTarget, canAIFaintTarget: canAIFaintTarget,
        canBattlerKOTargetIgnoringSturdy: canBattlerKOTargetIgnoringSturdy, canTargetMoveFaintAi: canTargetMoveFaintAi, bestDmgMoves: bestDmgMoves,
        isBestDmgMove: isBestDmgMove, bestDmgMoveHasEffect: bestDmgMoveHasEffect, hasPhysicalBestMove: hasPhysicalBestMove, bestDmgFrom: bestDmgFrom,
        secondaryDamage: secondaryDamage, willFaintFromWeather: willFaintFromWeather, willFaintFromSecondary: willFaintFromSecondary, isDamagedByStatus: isDamagedByStatus,
        substituteBlocks: substituteBlocks, canBePoisoned: canBePoisoned, canBeParalyzed: canBeParalyzed, canBeBurned: canBeBurned, canBeSlept: canBeSlept,
        canBeFrozen: canBeFrozen, aiCanPoison: aiCanPoison, aiCanParalyze: aiCanParalyze, aiCanBurn: aiCanBurn, aiCanFrostbite: aiCanFrostbite,
        aiCanPutToSleep: aiCanPutToSleep, aiCanBeConfused: aiCanBeConfused, aiCanBeInfatuated: aiCanBeInfatuated, benefitsFromStatus: benefitsFromStatus,
        shouldPoisonTarget: shouldPoisonTarget, shouldBurnTarget: shouldBurnTarget, shouldParalyzeTarget: shouldParalyzeTarget, shouldPoisonSelf: shouldPoisonSelf,
        shouldBurnSelf: shouldBurnSelf, shouldCureOwnStatus: shouldCureOwnStatus, shouldCureTargetStatus: shouldCureTargetStatus,
        canBattlerEscape: canBattlerEscape, isTrapped: isTrapped, shouldTrap: shouldTrap, guaranteedEffects: guaranteedEffects, sheerForceAffected: sheerForceAffected,
        isFlinchGuaranteed: isFlinchGuaranteed, shouldTryToFlinch: shouldTryToFlinch, canLowerStat: canLowerStat, statDownScore: statDownScore, statCanRise: statCanRise,
        shouldRaiseAnyStat: shouldRaiseAnyStat, statUp: statUp, statUpContrary: statUpContrary, parseStatFx: parseStatFx, shouldBlockSetup: shouldBlockSetup,
        offensiveSetupScore: offensiveSetupScore, defensiveSetupScore: defensiveSetupScore, speedSetupScore: speedSetupScore,
        shouldRecover: shouldRecover, shouldAbsorb: shouldAbsorb, shouldSetScreen: shouldSetScreen, isScreenUseful: isScreenUseful, shouldUseWishAromatherapy: shouldUseWishAromatherapy,
        shouldPivot: shouldPivot, shouldSetUpHazards: shouldSetUpHazards, substituteMoveScore: substituteMoveScore, tryToClearStats: tryToClearStats,
        shouldCopyStatChanges: shouldCopyStatChanges, hasMoveWithLowAccuracy: hasMoveWithLowAccuracy, hasSleepMoveWithLowAccuracy: hasSleepMoveWithLowAccuracy,
        shouldTryOHKO: shouldTryOHKO, explosionMementoHPScore: explosionMementoHPScore, explosionChanceFromHP: explosionChanceFromHP,
        shouldFinalGambit: shouldFinalGambit, shouldConsiderSelfSacrifice: shouldConsiderSelfSacrifice, shouldSetWeather: shouldSetWeather,
        shouldClearWeather: shouldClearWeather, shouldSetFieldStatus: shouldSetFieldStatus, shouldClearFieldStatus: shouldClearFieldStatus, weatherScore: weatherScore,
        increasePoisonScore: increasePoisonScore, increaseBurnScore: increaseBurnScore, increaseParalyzeScore: increaseParalyzeScore,
        increaseSleepScore: increaseSleepScore, increaseConfusionScore: increaseConfusionScore, increaseFrostbiteScore: increaseFrostbiteScore,
        protectChecks: protectChecks, weatherMatches: weatherMatches
    };
})(typeof window !== "undefined" ? window : this);
