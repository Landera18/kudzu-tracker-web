/* Kudzu AI move-choice scorer: the flag functions of battle_ai_main.c that
 * trainers run (AI_CheckBadMove, AI_TryToFaint, AI_CheckViability,
 * AI_CompareDamagingMoves) and the outcome enumeration.
 *
 * Entry point: KudzuAI.evaluate(model) -> {
 *   moves: [{name, present, chance, scores: [{score, prob}], trace}],
 *   paths, warnings
 * }
 * `model` is built by kudzu_ai_ui.js; see buildModel there for its shape.
 */
(function (root) {
    "use strict";
    var H = root.KudzuAIEngineCore;
    var SC = H.SC, CFG = H.CFG, has = H.has, eff = H.eff, power = H.power, isStatus = H.isStatus, flag = H.flag, fx = H.fx,
        hold = H.hold, movesOf = H.movesOf, hasType = H.hasType, stage = H.stage, dmgOf = H.dmgOf;

    // ------------------------------------------------------------------
    // AI_CheckBadMove (singles subset)
    function checkBadMove(ctx, rng, m, score, adj) {
        var ai = ctx.ai, pl = ctx.pl, field = ctx.field;
        var e = eff(m), nv = H.nonVolatile(m), tgt = H.target(m);
        var predicted = ctx.playerLastMove;
        var atkPri = H.movePriority(ai, m, field);
        var effv = m.effv;
        var abilityDef = pl.ability;

        if (H.isPowder(m) && (hasType(pl, "Grass") || pl.ability === "Overcoat" || hold(pl) === "SAFETY_GOGGLES")) { adj(-10, "powder move vs immune target"); return "RET"; }
        if (H.canTargetFaintAi(ctx)) {
            if (isTwoTurnNotSemiInvulnerable(ctx, m)) { adj(-10, "charge move while KO'd"); return "RET"; }
            if (e === "SEMI_INVULNERABLE" && hold(ai) !== "POWER_HERB" && (ai.ability === "No Guard" || pl.ability === "No Guard")) { adj(-10, "semi-invulnerable vs No Guard while KO'd"); return "RET"; }
        }
        if (isStatus(m) && nv !== "SLEEP" && (!predicted || eff(predicted) !== "FOCUS_PUNCH") && H.bestDmgMoveHasEffect(pl, ai, "FOCUS_PUNCH") && rng.pct(CFG.STATUS_MOVE_FOCUS_PUNCH_CHANCE, "status into Focus Punch")) { adj(-20, "status into Focus Punch"); return "RET"; }
        if ((thawsTarget(m)) && effv < 2 && pl.status === "frz") {
            if (movesOf(ai).some(function (mm) { return !thawsTarget(mm); })) adj(SC.SLIGHT_BAD, "thawing a frozen foe");
        }
        if (effv === 0) { adj(-20, "target is immune"); return "RET"; }
        if (H.ignoresAbility(ai, m)) abilityDef = "";

        if (tgt !== "USER") {
            if (atkPri > 0 && !H.ignoresAbility(ai, m) && has(H.DAZZLING, pl.ability)) { adj(-20, "priority blocked by ability"); return "RET"; }
            if (m.blocked) { adj(-20, "blocked by target ability"); return "RET"; }
            switch (abilityDef) {
                case "Magic Guard":
                    if (e === "LEECH_SEED") adj(SC.AWFUL, "Leech Seed vs Magic Guard");
                    if (e === "CURSE" && hasType(ai, "Ghost")) adj(SC.AWFUL, "Curse vs Magic Guard");
                    if (nv === "POISON" || nv === "TOXIC" || nv === "BURN") adj(SC.AWFUL, "residual status vs Magic Guard");
                    break;
                case "Wonder Guard": if (effv < 2) { adj(-20, "Wonder Guard"); return "RET"; } break;
                case "Justified": if (H.moveType(m) === "Dark" && !isStatus(m)) { adj(-10, "Dark move vs Justified"); return "RET"; } break;
                case "Rattled": if (!isStatus(m) && has(["Dark", "Ghost", "Bug"], H.moveType(m))) { adj(-10, "vs Rattled"); return "RET"; } break;
                case "Aroma Veil": if (has(H.AROMA_VEIL_EFFECTS, e)) { adj(-10, "vs Aroma Veil"); return "RET"; } break;
                case "Sweet Veil": if (nv === "SLEEP") { adj(-10, "sleep vs Sweet Veil"); return "RET"; } break;
                case "Flower Veil": if (hasType(pl, "Grass") && nv) { adj(-10, "status vs Flower Veil"); return "RET"; } break;
                case "Magic Bounce": if (flag(m, "magicCoatAffected")) { adj(-20, "vs Magic Bounce"); return "RET"; } break;
                case "Contrary": if (has(H.STAT_LOWERING, e)) { adj(-20, "stat drop vs Contrary"); return "RET"; } break;
                case "Comatose": if (nv) { adj(-10, "status vs Comatose"); return "RET"; } break;
                case "Shields Down": if (pl.vol.shieldsDown && nv) { adj(-10, "status vs Shields Down"); return "RET"; } break;
                case "Leaf Guard": if (H.weatherIs(field, H.SUN) && hold(pl) !== "UTILITY_UMBRELLA" && nv) { adj(-10, "status vs Leaf Guard in sun"); return "RET"; } break;
            }
            if (hasType(pl, "Dark") && ai.ability === "Prankster" && isStatus(m) && tgt !== "OPPONENTS_FIELD" && tgt !== "USER") { adj(-10, "Prankster vs Dark"); return "RET"; }
            if (H.terrainAffected(pl, field, "Electric") && nv === "SLEEP") { adj(-20, "sleep in Electric Terrain"); return "RET"; }
            if (H.terrainAffected(pl, field, "Misty") && (nv || has(["CONFUSE", "SWAGGER", "FLATTER"], e))) { adj(-20, "status in Misty Terrain"); return "RET"; }
            if (atkPri > 0 && H.terrainAffected(ai, field, "Psychic")) { adj(-20, "priority in Psychic Terrain"); return "RET"; }
        }

        if (ai.vol.throatChop && H.isSound(m)) return "ZERO";
        if (ai.vol.healBlock && H.isHealing(m)) return "ZERO";

        if (H.isExplosion(m)) {
            if (!ctx.roll.explosion) adj(SC.AWFUL, "explosion: HP roll failed");
            if (effv === 0) adj(SC.WORST, "explosion: immune");
            else if ((pl.ability === "Damp" || ai.ability === "Damp") && !H.ignoresAbility(ai, m)) adj(SC.WORST, "explosion vs Damp");
        }

        switch (e) {
            case "HIT":
                if (atkPri < 0 && H.aiIsFaster(ctx, m, null, true) && ai.hpPct < 40) adj(SC.BAD, "negative priority at low HP");
                break;
            case "FINAL_GAMBIT":
                if (!ctx.roll.finalGambit) adj(SC.AWFUL, "Final Gambit roll failed");
                break;
            case "ATTACK_UP": case "ATTACK_UP_2":
                if (!H.statCanRise(ai, "atk") || !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST, "Attack can't rise / no physical moves");
                break;
            case "STUFF_CHEEKS":
                if (!H.isBerry(ai)) return "ZERO";
                if (!H.statCanRise(ai, "def")) adj(SC.WORST, "Defense can't rise");
                break;
            case "DEFENSE_UP": case "DEFENSE_UP_2": case "DEFENSE_UP_3": case "DEFENSE_CURL":
                if (!H.statCanRise(ai, "def")) adj(SC.WORST, "Defense can't rise");
                break;
            case "SPECIAL_ATTACK_UP": case "SPECIAL_ATTACK_UP_2": case "SPECIAL_ATTACK_UP_3":
                if (!H.statCanRise(ai, "spa") || !H.hasMoveWithCategory(ai, "Special")) adj(SC.WORST, "Sp. Atk can't rise / no special moves");
                break;
            case "SPECIAL_DEFENSE_UP": case "SPECIAL_DEFENSE_UP_2":
                if (!H.statCanRise(ai, "spd")) adj(SC.WORST, "Sp. Def can't rise");
                break;
            case "ACCURACY_UP": case "ACCURACY_UP_2":
                if (!H.statCanRise(ai, "acc")) adj(SC.WORST, "accuracy can't rise");
                break;
            case "EVASION_UP": case "EVASION_UP_2": case "MINIMIZE":
                if (!H.statCanRise(ai, "eva")) adj(SC.WORST, "evasion can't rise");
                break;
            case "COSMIC_POWER":
                if (!H.statCanRise(ai, "def")) adj(SC.WORST, "Defense can't rise");
                else if (!H.statCanRise(ai, "spd")) adj(SC.WORST + 2, "Sp. Def can't rise");
                break;
            case "BULK_UP":
                if (!H.statCanRise(ai, "atk") || !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST, "Attack can't rise / no physical moves");
                else if (!H.statCanRise(ai, "def")) adj(SC.WORST + 2, "Defense can't rise");
                break;
            case "CALM_MIND":
                if (!H.statCanRise(ai, "spa")) adj(SC.WORST, "Sp. Atk can't rise");
                else if (!H.statCanRise(ai, "spd")) adj(SC.WORST + 2, "Sp. Def can't rise");
                break;
            case "DRAGON_DANCE":
                if (!H.statCanRise(ai, "atk") || !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST, "Attack can't rise / no physical moves");
                else if (!H.statCanRise(ai, "spe")) adj(SC.WORST + 2, "Speed can't rise");
                break;
            case "COIL":
                if (!H.statCanRise(ai, "acc")) adj(SC.WORST, "accuracy can't rise");
                else if (!H.statCanRise(ai, "atk") || !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST + 2, "Attack can't rise");
                else if (!H.statCanRise(ai, "def")) adj(-SC.BASE_STATUS, "Defense can't rise");
                break;
            case "ATTACK_ACCURACY_UP":
                if (ai.ability === "Contrary") adj(SC.WORST, "Hone Claws with Contrary");
                else if (stage(ai, "atk") >= 12 && (stage(ai, "acc") >= 12 || !H.hasMoveWithCategory(ai, "Physical"))) adj(SC.WORST, "Hone Claws maxed");
                break;
            case "CHARGE":
                if (ai.vol.charged) adj(SC.DOMINATED, "already charged");
                else if (!H.hasMoveWithType(ai, "Electric")) adj(SC.WORST, "no Electric move");
                else if (!H.statCanRise(ai, "spd")) adj(SC.AWFUL, "Sp. Def can't rise");
                break;
            case "QUIVER_DANCE": case "GEOMANCY":
                if (pl.ability === "Unaware") adj(SC.WORST, "vs Unaware");
                if (stage(ai, "spa") >= 12 || !H.hasMoveWithCategory(ai, "Special")) adj(SC.WORST, "Sp. Atk maxed / no special moves");
                else if (!H.statCanRise(ai, "spe")) adj(SC.WORST + 2, "Speed can't rise");
                else if (!H.statCanRise(ai, "spd")) adj(-SC.BASE_STATUS, "Sp. Def can't rise");
                break;
            case "VICTORY_DANCE":
                if (stage(ai, "atk") >= 12 || !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST, "Attack maxed / no physical moves");
                else if (!H.statCanRise(ai, "spe")) adj(SC.WORST + 2, "Speed can't rise");
                else if (!H.statCanRise(ai, "def")) adj(-SC.BASE_STATUS, "Defense can't rise");
                break;
            case "SHIFT_GEAR":
                if (!H.statCanRise(ai, "atk") || !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST, "Attack can't rise / no physical moves");
                else if (!H.statCanRise(ai, "spe")) adj(SC.WORST + 2, "Speed can't rise");
                break;
            case "SHELL_SMASH":
                if (ai.ability === "Contrary") {
                    if (!H.statCanRise(ai, "def")) adj(SC.WORST, "Defense can't rise");
                    else if (!H.statCanRise(ai, "spd")) adj(SC.WORST + 2, "Sp. Def can't rise");
                } else {
                    if (!H.statCanRise(ai, "atk") || !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST, "Attack can't rise / no physical moves");
                    else if (!H.statCanRise(ai, "spa") || !H.hasMoveWithCategory(ai, "Special")) adj(SC.WORST + 2, "Sp. Atk can't rise / no special moves");
                    else if (!H.statCanRise(ai, "spe")) adj(-SC.BASE_STATUS, "Speed can't rise");
                }
                break;
            case "GROWTH": case "ATTACK_SPATK_UP":
                if ((!H.statCanRise(ai, "atk") && !H.statCanRise(ai, "spa")) || !H.hasDamagingMove(ai)) adj(SC.WORST, "no stat can rise / no attacks");
                break;
            case "ROTOTILLER":
                if (!(hasType(ai, "Grass") && H.isGrounded(ai, field) && (H.statCanRise(ai, "atk") || H.statCanRise(ai, "spa")))) adj(SC.WORST, "Rototiller useless");
                break;
            case "GEAR_UP": case "MAGNETIC_FLUX":
                if (ai.ability === "Plus" || ai.ability === "Minus") {
                    var s1 = e === "GEAR_UP" ? "atk" : "def", s2 = e === "GEAR_UP" ? "spa" : "spd";
                    if (!H.statCanRise(ai, s1) || (e === "GEAR_UP" && !H.hasMoveWithCategory(ai, "Physical"))) adj(SC.WORST, "stat can't rise");
                    else if (!H.statCanRise(ai, s2) || (e === "GEAR_UP" && !H.hasMoveWithCategory(ai, "Special"))) adj(SC.WORST + 2, "stat can't rise");
                } else adj(SC.WORST, "no Plus/Minus");
                break;
            case "ACUPRESSURE":
                if (H.substituteBlocks(ai, pl, m) || H.statsMaxed(pl)) adj(SC.WORST, "Acupressure fails");
                break;
            case "ATTACK_DOWN": case "ATTACK_DOWN_2": if (!H.canLowerStat(ctx, m, "atk")) adj(SC.WORST, "can't lower Attack"); break;
            case "DEFENSE_DOWN": case "DEFENSE_DOWN_2": if (!H.canLowerStat(ctx, m, "def")) adj(SC.WORST, "can't lower Defense"); break;
            case "SPEED_DOWN": case "SPEED_DOWN_2": if (!H.canLowerStat(ctx, m, "spe")) adj(SC.WORST, "can't lower Speed"); break;
            case "SPECIAL_ATTACK_DOWN": case "SPECIAL_ATTACK_DOWN_2": if (!H.canLowerStat(ctx, m, "spa")) adj(SC.WORST, "can't lower Sp. Atk"); break;
            case "SPECIAL_DEFENSE_DOWN": case "SPECIAL_DEFENSE_DOWN_2": if (!H.canLowerStat(ctx, m, "spd")) adj(SC.WORST, "can't lower Sp. Def"); break;
            case "ACCURACY_DOWN": case "ACCURACY_DOWN_2": if (!H.canLowerStat(ctx, m, "acc")) adj(SC.WORST, "can't lower accuracy"); break;
            case "EVASION_DOWN": case "EVASION_DOWN_2": case "TICKLE":
                if (!H.canLowerStat(ctx, m, "atk")) adj(SC.WORST, "can't lower Attack");
                else if (!H.canLowerStat(ctx, m, "def")) adj(SC.WORST + 2, "can't lower Defense");
                break;
            case "VENOM_DRENCH":
                if (!H.statusIs(pl, ["psn", "tox"])) adj(SC.WORST, "target not poisoned");
                else if (!H.canLowerStat(ctx, m, "spe")) adj(SC.WORST, "can't lower Speed");
                else if (!H.canLowerStat(ctx, m, "spa")) adj(SC.WORST + 2, "can't lower Sp. Atk");
                else if (!H.canLowerStat(ctx, m, "atk")) adj(-SC.BASE_STATUS, "can't lower Attack");
                break;
            case "NOBLE_ROAR":
                if (!H.canLowerStat(ctx, m, "spa")) adj(SC.WORST, "can't lower Sp. Atk");
                else if (!H.canLowerStat(ctx, m, "atk")) adj(SC.WORST + 2, "can't lower Attack");
                break;
            case "CAPTIVATE":
                if (!(ai.gender && pl.gender && ai.gender !== "N" && pl.gender !== "N" && ai.gender !== pl.gender)) adj(SC.WORST, "not opposite gender");
                break;
            case "HAZE":
                H.STAT_NAMES.forEach(function (s) { if ((ai.boosts[s] || 0) > 0) adj(SC.WORST, "Haze would reset own boosts"); });
                H.STAT_NAMES.forEach(function (s) { if ((pl.boosts[s] || 0) < 0) adj(SC.WORST, "Haze would reset foe drops"); });
                break;
            case "PRESENT": case "FIXED_HP_DAMAGE": case "FOCUS_PUNCH":
                if (pl.ability === "Wonder Guard" && effv < 2) adj(SC.WORST, "vs Wonder Guard");
                if (H.hasDamagingMove(pl) && !(ai.vol.substitute || H.incapacitated(pl) || pl.vol.infatuated || pl.vol.confused)) adj(SC.WORST, "high-risk move while foe can attack");
                if (H.hasMoveEffect(ai, "SUBSTITUTE") && !ai.vol.substitute) adj(SC.WORST, "prefers Substitute first");
                if (H.hasNonVolatileMoveEffect(ai, "SLEEP") && pl.status !== "slp") adj(SC.WORST, "prefers sleep first");
                break;
            case "REFLECT_DAMAGE":
                if (H.incapacitated(pl) || pl.vol.infatuated || pl.vol.confused) adj(SC.SLIGHT_BAD, "foe may not attack");
                if (!predicted || isStatus(predicted) || (ai.vol.substitute && !flag(predicted, "ignoresSubstitute"))) adj(SC.WORST, "no damaging move predicted");
                break;
            case "ROAR":
                if (ctx.opts.playerLastMon) adj(SC.WORST, "foe has no party left");
                else if (pl.ability === "Suction Cups") adj(SC.WORST, "vs Suction Cups");
                break;
            case "TOXIC_THREAD":
                if (!H.canLowerStat(ctx, m, "spe")) adj(SC.SLIGHT_BAD, "can't lower Speed");
                if (!H.aiCanPoison(ctx, m)) adj(SC.WORST, "can't poison");
                break;
            case "LIGHT_SCREEN": if (ai.side.isLightScreen || ai.side.isAuroraVeil) adj(SC.WORST, "screen already up"); break;
            case "REFLECT": if (ai.side.isReflect || ai.side.isAuroraVeil) adj(SC.WORST, "screen already up"); break;
            case "AURORA_VEIL": if (ai.side.isAuroraVeil || !H.weatherIs(field, H.ICY)) adj(SC.WORST, "Aurora Veil unusable"); break;
            case "OHKO":
                if (!H.shouldTryOHKO(ctx, rng, m)) adj(SC.WORST, "OHKO not worth trying");
                else if (pl.vol.lockOn) adj(8, "OHKO with Lock-On");
                else {
                    var minHits = 255;
                    movesOf(ai).forEach(function (mm) { if (mm === m || isStatus(mm)) return; var h = H.hitsToKOBattler(ai, pl, mm, true); if (h > 0 && h < minHits) minHits = h; });
                    if (minHits >= 3) adj(6, "OHKO beats 3HKO+");
                }
                break;
            case "MIST": if (ai.side.isMist) adj(SC.WORST, "Mist already up"); break;
            case "FOCUS_ENERGY": if (ai.vol.focusEnergy) adj(SC.WORST, "already pumped"); break;
            case "CONFUSE": case "SWAGGER": case "FLATTER":
                if (!H.aiCanBeConfused(ctx, m)) adj(SC.WORST, "can't confuse");
                break;
            case "SUBSTITUTE":
                if (ai.vol.substitute || pl.ability === "Infiltrator") adj(SC.WORST + 2, "Substitute up / vs Infiltrator");
                else if (ai.hpPct <= 25) adj(SC.WORST, "too little HP for Substitute");
                else if (H.hasMoveWithFlag(pl, "ignoresSubstitute")) adj(SC.WORST + 2, "foe bypasses Substitute");
                break;
            case "SHED_TAIL":
                if (ctx.opts.aiLastMon) adj(SC.WORST, "last mon");
                if (ai.vol.substitute || pl.ability === "Infiltrator") adj(SC.WORST + 2, "Substitute up / vs Infiltrator");
                else if (ai.hpPct <= 50) adj(SC.WORST, "too little HP");
                else if (H.hasMoveWithFlag(pl, "ignoresSubstitute")) adj(SC.WORST + 2, "foe bypasses Substitute");
                break;
            case "LEECH_SEED":
                if (pl.side.isSeeded || hasType(pl, "Grass")) adj(SC.WORST, "Leech Seed fails");
                else if (pl.ability === "Liquid Ooze") adj(-SC.GOOD, "vs Liquid Ooze");
                break;
            case "DISABLE": case "ENCORE":
                if ((e === "DISABLE" ? pl.vol.disabled : pl.vol.encored) || hold(pl) === "MENTAL_HERB") adj(SC.WORST, e === "DISABLE" ? "Disable fails" : "Encore fails");
                else if (!predicted) adj(SC.WORST, "no move to target");
                break;
            case "SNORE": case "SLEEP_TALK":
                if (H.isWakeupTurn(ai) || !H.isAsleepOrComatose(ai)) adj(SC.WORST, "not asleep");
                break;
            case "MEAN_LOOK":
                if (H.canBattlerEscape(pl) || H.isTrapped(ctx)) adj(SC.WORST, "trap useless");
                break;
            case "NIGHTMARE":
                if (pl.vol.nightmare) adj(SC.WORST, "already nightmared");
                else if (!H.isAsleepOrComatose(pl)) adj(SC.WORST + 2, "foe not asleep");
                break;
            case "CURSE":
                if (hasType(ai, "Ghost")) {
                    if (pl.vol.cursed) adj(SC.WORST, "already cursed");
                    else if (ai.hpPct <= 50) adj(-SC.BASE_STATUS, "Ghost Curse at low HP");
                } else {
                    if (!H.statCanRise(ai, "atk") || !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST, "Attack can't rise / no physical moves");
                    else if (!H.statCanRise(ai, "def")) adj(SC.WORST + 2, "Defense can't rise");
                }
                break;
            case "SPIKES": if (pl.side.spikes >= 3) adj(SC.WORST, "Spikes maxed"); break;
            case "STEALTH_ROCK": if (pl.side.isSR) adj(SC.WORST, "Stealth Rock already up"); break;
            case "TOXIC_SPIKES": if (pl.side.tspikes >= 2) adj(SC.WORST, "Toxic Spikes maxed"); break;
            case "STICKY_WEB": if (pl.side.stickyWeb) adj(SC.WORST, "Sticky Web already up"); break;
            case "FORESIGHT":
                if (pl.side.isForesight) adj(SC.WORST, "already identified");
                else if (stage(pl, "eva") <= 4 || !hasType(pl, "Ghost")) adj(-SC.HIGH_PRIORITY, "Foresight pointless");
                break;
            case "PERISH_SONG":
                if (ctx.opts.aiLastMon && ai.ability !== "Soundproof" && !ctx.opts.playerLastMon) adj(SC.WORST, "Perish Song would lose");
                if (pl.vol.perishSong || pl.ability === "Soundproof") adj(SC.WORST, "Perish Song fails");
                break;
            case "WEATHER_AND_SWITCH":
                if (ctx.opts.aiLastMon) { adj(SC.WORST, "last mon"); break; }
                /* falls through */
            case "WEATHER":
                var w = m.d && m.d.weather;
                if ((w === "RAIN" && (H.weatherIs(field, H.RAIN) || H.weatherIs(field, H.PRIMAL)))
                    || (w === "SUN" && (H.weatherIs(field, H.SUN) || H.weatherIs(field, H.PRIMAL)))
                    || (w === "SANDSTORM" && (H.weatherIs(field, H.SAND) || H.weatherIs(field, H.PRIMAL)))
                    || ((w === "HAIL" || w === "SNOW") && (H.weatherIs(field, H.ICY) || H.weatherIs(field, H.PRIMAL)))) adj(SC.WORST + 2, "weather already up");
                break;
            case "ATTRACT": if (!H.aiCanBeInfatuated(ctx, m)) adj(SC.WORST, "can't infatuate"); break;
            case "SAFEGUARD": if (ai.side.isSafeguard) adj(SC.WORST, "Safeguard up"); break;
            case "PARTING_SHOT": if (ctx.opts.aiLastMon) adj(SC.WORST, "last mon"); break;
            case "BATON_PASS":
                if (ctx.opts.aiLastMon) adj(SC.WORST, "last mon");
                else if (ai.vol.substitute || ai.vol.powerTrick || ai.vol.magnetRise || ai.vol.aquaRing || ai.vol.root || H.anyStatRaised(ai)) { /* keep */ }
                else adj(-SC.BASE_STATUS, "nothing to pass");
                break;
            case "BELLY_DRUM": case "FILLET_AWAY":
                if (pl.ability === "Unaware") adj(SC.WORST, "vs Unaware");
                if (ai.ability === "Contrary") adj(SC.WORST, "with Contrary");
                else if (ai.hpPct <= 60) adj(SC.WORST, "too little HP");
                break;
            case "FUTURE_SIGHT":
                if (pl.vol.futureSight) adj(-SC.FIRST_TURN_HAZARD_HIGH, "Future Sight already pending");
                else adj(SC.GOOD, "Future Sight");
                break;
            case "TELEPORT": adj(SC.WORST, "Teleport"); break;
            case "FIRST_TURN_ONLY":
                if (!ctx.opts.firstTurn) adj(SC.WORST, "not first turn");
                if (hold(ai) === "CHOICE_BAND" || hold(ai) === "CHOICE_SCARF" || hold(ai) === "CHOICE_SPECS" || ai.ability === "Gorilla Tactics") adj(SC.AWFUL, "Fake Out with choice lock");
                break;
            case "STOCKPILE": if (ai.vol.stockpile >= 3) adj(SC.WORST, "Stockpile maxed"); break;
            case "SWALLOW":
                if (!ai.vol.stockpile) adj(SC.WORST, "no Stockpile");
                else if (H.atMaxHp(ai)) adj(SC.WORST, "at full HP");
                else if (ai.hpPct >= 80) adj(SC.AWFUL, "high HP");
                break;
            case "TORMENT":
                if (pl.vol.torment) { adj(SC.WORST, "already tormented"); break; }
                if (hold(pl) === "MENTAL_HERB") adj(-SC.BASE_STATUS, "vs Mental Herb");
                break;
            case "MEMENTO":
                if (ctx.opts.aiLastMon) adj(SC.WORST, "last mon");
                else if (stage(pl, "atk") === 0 && stage(pl, "spa") === 0) adj(SC.WORST, "foe attacks minimized");
                break;
            case "FOLLOW_ME": case "HELPING_HAND": adj(SC.DOMINATED, "no partner"); break;
            case "TRICK":
                if ((!ai.item && !pl.item) || pl.ability === "Sticky Hold" || H.substituteBlocks(ai, pl, m)) adj(SC.WORST, "Trick fails");
                break;
            case "KNOCK_OFF": case "CORROSIVE_GAS": if (pl.ability === "Sticky Hold") adj(SC.WORST, "vs Sticky Hold"); break;
            case "INGRAIN": if (ai.vol.root) adj(SC.WORST, "already rooted"); break;
            case "AQUA_RING": if (ai.vol.aquaRing) adj(SC.WORST, "Aqua Ring up"); break;
            case "RECYCLE": if (!ai.vol.usedItem || ai.item) adj(SC.WORST, "nothing to recycle"); break;
            case "IMPRISON": if (ai.vol.imprison) adj(SC.WORST, "Imprison already up"); break;
            case "REFRESH": if (!H.statusIs(ai, ["psn", "tox", "brn", "par"]) || !H.shouldCureOwnStatus(ai)) adj(SC.WORST, "nothing to Refresh"); break;
            case "PSYCHO_SHIFT":
                if (H.statusIs(ai, ["psn", "tox"]) && !H.aiCanPoison(ctx, m)) adj(SC.WORST, "can't pass poison");
                else if (ai.status === "brn" && !H.aiCanBurn(ctx, m)) adj(SC.WORST, "can't pass burn");
                else if (ai.status === "par" && !H.aiCanParalyze(ctx, m)) adj(SC.WORST, "can't pass paralysis");
                else if (ai.status === "slp" && !H.aiCanPutToSleep(ctx, m)) adj(SC.WORST, "can't pass sleep");
                else if (!ai.status) adj(SC.WORST, "no status to shift");
                break;
            case "MUD_SPORT": if (field.mudSport) adj(SC.WORST, "Mud Sport up"); break;
            case "WATER_SPORT": if (field.waterSport) adj(SC.WORST, "Water Sport up"); break;
            case "STRENGTH_SAP":
                if (pl.ability === "Contrary") adj(SC.WORST, "vs Contrary");
                else if (!H.canLowerStat(ctx, m, "atk")) adj(SC.WORST, "can't lower Attack");
                break;
            case "NATURE_POWER":
                // The ROM checks the move Nature Power turns into
                if (m.np) return checkBadMove(ctx, rng, m.np, score, adj);
                adj(SC.WORST, "Nature Power (called move unknown)");
                break;
            case "COPYCAT": case "MIRROR_MOVE": case "ME_FIRST":
                adj(SC.WORST, "copy move (not modelled)");
                break;
            case "FLOWER_SHIELD": if (!hasType(ai, "Grass")) adj(SC.WORST, "not Grass type"); break;
            case "AROMATIC_MIST": adj(SC.WORST, "no partner"); break;
            case "BIDE":
                if (!H.hasDamagingMove(pl) || ai.hpPct < 30 || H.statusIs(pl, ["slp", "frz"])) adj(SC.WORST, "Bide pointless");
                break;
            case "HIT_SWITCH_TARGET":
                if (pl.hpPct < 10 && H.secondaryDamage(pl, field)) adj(SC.WORST, "foe about to faint");
                else if (pl.vol.perishSong) adj(SC.WORST, "foe perish songed");
                break;
            case "CONVERSION":
                if (movesOf(ai).length && hasType(ai, H.moveType(movesOf(ai)[0]))) adj(SC.WORST, "already that type");
                break;
            case "REST":
                // CanBeSlept on itself: any existing status (not just sleep) makes the AI think Rest fails.
                if (ai.status || !restCanSleep(ctx)) adj(SC.WORST, "Rest would fail (statused / sleep blocked)");
                /* falls through */
            case "RESTORE_HP": case "SOFTBOILED": case "ROOST":
                if (H.atMaxHp(ai)) adj(SC.WORST, "at full HP");
                else if (ai.hpPct >= 90) adj(-SC.HIGH_PRIORITY, "HP >= 90%");
                break;
            case "MORNING_SUN": case "SYNTHESIS": case "MOONLIGHT":
                if (H.atMaxHp(ai)) adj(SC.WORST, "at full HP");
                else if (ai.hpPct >= 90) adj(-SC.HIGH_PRIORITY, "HP >= 90%");
                else if (H.weatherIs(field, H.RAIN) || H.weatherIs(field, H.SAND) || H.weatherIs(field, H.ICY) || H.weatherIs(field, ["Fog"])) adj(-SC.GOOD, "weak healing in this weather");
                break;
            case "LIFE_DEW": if (H.atMaxHp(ai)) adj(SC.WORST, "at full HP"); break;
            case "PURIFY":
                if (!pl.status) adj(SC.WORST, "foe has no status");
                else if (!H.shouldCureTargetStatus(ctx)) {
                    if (H.atMaxHp(ai)) adj(SC.WORST, "at full HP");
                    else if (ai.hpPct >= 90) adj(SC.WORST + 2, "HP >= 90%");
                }
                break;
            case "RECOIL_IF_MISS":
                if (ai.ability !== "Magic Guard" && m.accv < 75) adj(-SC.BASE_STATUS, "crash damage risk");
                break;
            case "TRANSFORM": if (ai.vol.transformed || pl.vol.transformed || pl.vol.substitute) adj(SC.WORST, "Transform fails"); break;
            case "SPITE": case "MIMIC": case "SKETCH": if (!predicted) adj(SC.WORST, "no move to copy"); break;
            case "METRONOME":
                if (!H.canAIFaintTarget(ctx, 0)) {
                    if (H.canTargetFaintAi(ctx)) adj(SC.GREAT_STATUS, "Metronome gamble");
                    else if (rng.pct(90, "Metronome roll")) adj(SC.BASE_STATUS, "Metronome");
                    else adj(25, "Metronome jackpot roll");
                }
                break;
            case "CONVERSION_2":
                if (predicted && !isStatus(predicted) && predicted.effOnAi < 1) adj(SC.DOMINATED, "already resists");
                else if (H.canTargetFaintAi(ctx)) adj(rng.pct(25, "Conversion 2 roll") ? 8 : 6, "Conversion 2");
                break;
            case "REFLECT_TYPE": break;
            case "LOCK_ON": if (pl.vol.lockOn || ai.ability === "No Guard" || pl.ability === "No Guard") adj(SC.WORST, "Lock-On pointless"); break;
            case "LASER_FOCUS":
                if (ai.vol.laserFocus) adj(SC.WORST, "already focused");
                else if (pl.ability === "Shell Armor" || pl.ability === "Battle Armor") adj(SC.WORST + 2, "vs crit immunity");
                break;
            case "DESTINY_BOND": if (ai.vol.destinyBond) adj(SC.WORST, "Destiny Bond active"); break;
            case "HEAL_BELL": if (!ai.status) adj(SC.WORST, "no status to heal"); break;
            case "ENDURE": if (ai.hp === 1 || H.secondaryDamage(ai, field)) adj(SC.WORST, "Endure pointless"); break;
            case "PROTECT": {
                var method = m.d && m.d.protect;
                var dec = false;
                if (method === "QUICK_GUARD" && (!predicted || H.basePriority(predicted) <= 0)) { adj(SC.WORST, "Quick Guard pointless"); dec = true; }
                else if (method === "WIDE_GUARD" && !(predicted && (H.target(predicted) === "BOTH" || H.target(predicted) === "FOES_AND_ALLY"))) { adj(SC.WORST, "Wide Guard pointless"); dec = true; }
                else if (method === "CRAFTY_SHIELD") { adj(SC.WORST, "no partner"); dec = true; }
                else if (method === "MAT_BLOCK" && !ctx.opts.firstTurn) { adj(SC.WORST, "Mat Block after first turn"); dec = true; }
                if (dec) break;
                if (predicted && flag(predicted, "ignoresProtect")) { adj(SC.WORST, "foe's move ignores Protect"); break; }
                if (method !== "MAX_GUARD" && predicted && flag(predicted, "makesContact") && pl.ability === "Unseen Fist") { adj(SC.WORST, "vs Unseen Fist"); break; }
                if (H.incapacitated(pl)) { adj(SC.WORST, "foe can't move"); break; }
                if (method !== "QUICK_GUARD" && method !== "WIDE_GUARD" && method !== "CRAFTY_SHIELD") {
                    if (H.secondaryDamage(ai, field) >= ai.hp && !has(H.MOXIE_ABILITIES, pl.ability)) adj(SC.WORST, "would faint after protecting");
                    else if (ctx.opts.protectStreak === 1 && rng.pct(50, "protected last turn")) adj(-SC.BASE_STATUS, "protected last turn");
                    else if (ctx.opts.protectStreak >= 2) adj(SC.WORST, "protected twice");
                }
                break;
            }
            case "MIRACLE_EYE":
                if (pl.vol.miracleEye) adj(SC.WORST, "already identified");
                if (stage(pl, "eva") <= 4 || !hasType(pl, "Dark")) adj(-SC.HIGH_PRIORITY, "Miracle Eye pointless");
                break;
            case "COURT_CHANGE":
                if (pl.side.isReflect || pl.side.isLightScreen || pl.side.isAuroraVeil || pl.side.isTailwind || pl.side.isSafeguard || pl.side.isMist) adj(SC.BAD, "would give foe good court");
                if (ai.side.isReflect || ai.side.isLightScreen || ai.side.isAuroraVeil || ai.side.isTailwind) adj(SC.BAD, "would lose own good court");
                if (anyHazards(pl.side) && !ctx.opts.aiLastMon) adj(SC.WORST, "would take foe's hazards");
                break;
            case "DEFOG":
                if (anyHazards(pl.side)) { adj(SC.WORST, "would clear own hazards on foe"); break; }
                if (stage(pl, "eva") === 0 || pl.ability === "Contrary") adj(SC.WORST, "Defog evasion drop useless");
                break;
            case "PSYCH_UP":
                H.STAT_NAMES.forEach(function (s) { if ((ai.boosts[s] || 0) > 0) adj(SC.WORST, "would reset own boosts"); });
                H.STAT_NAMES.forEach(function (s) { if ((pl.boosts[s] || 0) < 0) adj(SC.WORST, "would copy drops"); });
                break;
            case "SEMI_INVULNERABLE":
                if (predicted && H.aiIsSlower(ctx, m, null, true) && eff(predicted) === "SEMI_INVULNERABLE") adj(SC.WORST, "foe also goes semi-invulnerable");
                if (H.willFaintFromWeather(ai, field) && m.d && m.d.semi === "ON_AIR") adj(SC.WORST, "would faint in the air");
                break;
            case "HEALING_WISH": if (ctx.opts.aiLastMon) adj(SC.WORST, "last mon"); break;
            case "TAUNT": if (pl.vol.taunted) adj(SC.WORST, "already taunted"); break;
            case "BESTOW": if (hold(ai) === "NONE" || pl.item || H.substituteBlocks(ai, pl, m)) adj(SC.WORST, "Bestow fails"); break;
            case "WISH": if (ai.vol.wish) adj(SC.WORST, "Wish pending"); break;
            case "ASSIST": if (ctx.opts.aiLastMon) adj(SC.WORST, "no teammates"); break;
            case "MAGIC_COAT": if (!H.hasMoveWithFlag(pl, "magicCoatAffected")) adj(SC.WORST, "nothing to bounce"); break;
            case "YAWN":
                if (pl.vol.yawn) adj(SC.WORST, "already drowsy");
                else if (!H.aiCanPutToSleep(ctx, m)) adj(SC.WORST, "can't sleep");
                break;
            case "DOODLE": case "ENTRAINMENT": case "GASTRO_ACID": case "ROLE_PLAY": case "SKILL_SWAP": case "OVERWRITE_ABILITY":
                if (!ctx.abilities) { adj(SC.NO_DAMAGE_OR_FAILS, "ability change (no ability data in backups/kudzu.js; regenerate with the updated tracker extractor)"); return "RET"; }
                if (!canEffectChangeAbility(ctx, m)) { adj(SC.NO_DAMAGE_OR_FAILS, "ability change fails"); return "RET"; }
                break;
            case "SNATCH": if (!H.hasMoveWithFlag(pl, "snatchAffected")) adj(SC.WORST, "nothing to snatch"); break;
            case "POWER_TRICK": if (ai.mon.rawStats.def >= ai.mon.rawStats.atk && !H.hasMoveWithCategory(ai, "Physical")) adj(SC.WORST, "Power Trick pointless"); break;
            case "POWER_SWAP": if (stage(ai, "atk") >= stage(pl, "atk") && stage(ai, "spa") >= stage(pl, "spa")) adj(SC.WORST, "Power Swap pointless"); break;
            case "GUARD_SWAP": if (stage(ai, "def") >= stage(pl, "def") && stage(ai, "spd") >= stage(pl, "spd")) adj(SC.WORST, "Guard Swap pointless"); break;
            case "SPEED_SWAP":
                if (field.trickRoom ? ai.speed <= pl.speed : ai.speed >= pl.speed) adj(SC.WORST, "Speed Swap pointless");
                break;
            case "HEART_SWAP":
                if (H.countPositive(ai) >= H.countPositive(pl) && H.countNegative(ai) <= H.countNegative(pl)) adj(SC.WORST, "Heart Swap pointless");
                break;
            case "POWER_SPLIT": if (ai.mon.rawStats.atk + ai.mon.rawStats.spa >= pl.mon.rawStats.atk + pl.mon.rawStats.spa) adj(SC.WORST, "Power Split pointless"); break;
            case "GUARD_SPLIT": if (ai.mon.rawStats.def + ai.mon.rawStats.spd >= pl.mon.rawStats.def + pl.mon.rawStats.spd) adj(SC.WORST, "Guard Split pointless"); break;
            case "NATURAL_GIFT": if (!H.isBerry(ai)) adj(SC.WORST, "no berry"); break;
            case "GRASSY_TERRAIN": case "ELECTRIC_TERRAIN": case "PSYCHIC_TERRAIN": case "MISTY_TERRAIN":
                if (field.terrain === e.split("_")[0].charAt(0) + e.split("_")[0].slice(1).toLowerCase()) adj(SC.WORST, "terrain already up");
                break;
            case "STEEL_ROLLER": if (!field.terrain) adj(SC.WORST, "no terrain"); break;
            case "TRICK_ROOM":
                if (!field.trickRoom && !H.shouldSetFieldStatus(ctx, "TrickRoom")) adj(SC.WORST, "Trick Room doesn't help");
                else if (field.trickRoom && !H.shouldClearFieldStatus(ctx, "TrickRoom")) adj(SC.WORST, "would end a good Trick Room");
                break;
            case "MAGIC_ROOM": if (field.magicRoom) adj(SC.WORST, "Magic Room up"); break;
            case "WONDER_ROOM": if (field.wonderRoom) adj(SC.WORST, "Wonder Room up"); break;
            case "GRAVITY": if (field.gravity && !hasType(ai, "Flying") && hold(ai) !== "AIR_BALLOON") adj(SC.WORST, "Gravity up"); break;
            case "ION_DELUGE": if (field.ionDeluge) adj(SC.WORST, "Ion Deluge up"); break;
            case "FLING": if (!ai.item) adj(SC.WORST, "nothing to fling"); break;
            case "EMBARGO": if (!ai.itemEnabled || pl.vol.embargo) adj(SC.WORST, "Embargo fails"); break;
            case "POWDER": if (!H.hasMoveWithType(pl, "Fire")) adj(SC.WORST, "foe has no Fire move"); break;
            case "TELEKINESIS":
                if (pl.vol.telekinesis || pl.vol.root || pl.vol.smackDown || field.gravity || hold(pl) === "IRON_BALL") adj(SC.WORST, "Telekinesis fails");
                break;
            case "HEAL_BLOCK": if (pl.vol.healBlock) adj(SC.WORST, "already heal blocked"); break;
            case "SOAK": if (pl.types.length === 1 && pl.types[0] === (m.d && m.d.argType)) adj(SC.WORST, "already that type"); break;
            case "THIRD_TYPE": if (hasType(pl, m.d && m.d.argType)) adj(SC.WORST, "already has that type"); break;
            case "HEAL_PULSE": adj(SC.WORST, "would heal the foe"); break;
            case "ELECTRIFY": if (H.aiIsSlower(ctx, m, null, true)) adj(SC.WORST, "Electrify too slow"); break;
            case "TOPSY_TURVY":
                if (H.countPositive(pl) === 0) adj(SC.WORST, "no boosts to invert");
                else if (H.countNegative(pl) < H.countPositive(pl)) { /* fine */ }
                else adj(SC.AWFUL, "would help the foe");
                break;
            case "FAIRY_LOCK": if (field.fairyLock) adj(SC.WORST, "Fairy Lock up"); break;
            case "DO_NOTHING": case "HOLD_HANDS": case "CELEBRATE": case "HAPPY_HOUR": adj(SC.WORST, "does nothing"); break;
            case "INSTRUCT": adj(SC.WORST, "no partner"); break;
            case "QUASH": case "AFTER_YOU": adj(SC.WORST, "no partner"); break;
            case "SUCKER_PUNCH":
                if ((H.hasMoveWithCategory(pl, "Status") && rng.pct(CFG.SUCKER_PUNCH_CHANCE, "Sucker Punch vs status move")) || H.aiIsSlower(ctx, m, null, true)) adj(SC.WORST, "Sucker Punch may fail");
                break;
            case "TAILWIND": if (ai.side.isTailwind) adj(SC.WORST, "Tailwind up"); break;
            case "LUCKY_CHANT": if (ai.side.isLuckyChant) adj(SC.WORST, "Lucky Chant up"); break;
            case "MAGNET_RISE":
                if (field.gravity || ai.vol.magnetRise || hold(ai) === "IRON_BALL" || ai.vol.smackDown || ai.vol.root || !H.isGrounded(ai, field)) adj(SC.WORST, "Magnet Rise pointless");
                break;
            case "CAMOUFLAGE": break;
            case "SYNCHRONOISE":
                if (!(hold(pl) === "RING_TARGET" || ai.types.some(function (t) { return hasType(pl, t); }))) adj(SC.WORST, "no shared type");
                break;
            case "FLAIL":
                if (H.aiIsSlower(ctx, m, null, true) || ai.hpPct > 50) adj(-SC.BEST, "Flail weak");
                break;
            case "SKY_DROP":
                if (hasType(pl, "Flying")) adj(SC.WORST, "vs Flying");
                if (H.willFaintFromWeather(ai, field) || H.substituteBlocks(ai, pl, m) || (pl.mon.weightkg || 0) >= 200) adj(SC.WORST, "Sky Drop fails");
                break;
            case "NO_RETREAT": if (ai.vol.noRetreat) adj(SC.WORST, "already committed"); break;
            case "EXTREME_EVOBOOST": if (H.statsMaxed(ai)) adj(SC.WORST, "stats maxed"); break;
            case "CLANGOROUS_SOUL":
                if (ai.hp <= Math.floor(ai.maxHp / 3)) adj(SC.WORST, "too little HP");
                else if (pl.ability === "Unaware") adj(SC.WORST, "vs Unaware");
                break;
            case "REVIVAL_BLESSING":
                if (!ctx.opts.aiHasFainted) adj(SC.WORST, "nothing to revive");
                else if (H.canAIFaintTarget(ctx, 0)) adj(SC.WORST, "can KO instead");
                else if (H.canTargetFaintAi(ctx) && H.aiIsSlower(ctx, m, null, true)) adj(SC.WORST, "would be KO'd first");
                break;
            case "JUNGLE_HEALING":
                if (H.atMaxHp(ai) && !(ai.status && H.shouldCureOwnStatus(ai))) adj(SC.WORST, "nothing to heal");
                break;
            case "TAKE_HEART":
                if (!ai.status && !H.statCanRise(ai, "spa") && !H.statCanRise(ai, "spd")) adj(SC.WORST, "Take Heart pointless");
                break;
            case "SPICY_EXTRACT":
                if (H.hasMoveWithCategory(pl, "Physical") || pl.ability === "Clear Body" || pl.ability === "Good as Gold" || hold(pl) === "CLEAR_AMULET") adj(SC.WORST, "Spicy Extract pointless");
                break;
            case "UPPER_HAND":
                if (!predicted || isStatus(predicted) || H.aiIsSlower(ctx, m, null, true) || H.movePriority(pl, predicted, field) < 1 || H.movePriority(pl, predicted, field) > 3) adj(SC.WORST, "Upper Hand fails");
                break;
            case "TEATIME":
                if (hasBeneficialTeatimeBerry(pl)) adj(SC.DECENT, "denies foe's berry");
                break;
            case "DARK_VOID": if (ai.mon.name.indexOf("Darkrai") === -1) adj(SC.WORST, "not Darkrai"); break;
            case "HYPERSPACE_FURY": if (ai.mon.name !== "Hoopa-Unbound") adj(SC.WORST, "not Hoopa-Unbound"); break;
            case "PLACEHOLDER": return "ZERO";
        }

        switch (nv) {
            case "POISON": case "TOXIC":
                if (!H.aiCanPoison(ctx, m)) adj(SC.WORST, "can't poison");
                if (!H.shouldPoisonTarget(ctx)) adj(SC.AWFUL, "poison helps the foe");
                break;
            case "SLEEP":
                if (!H.aiCanPutToSleep(ctx, m)) adj(SC.WORST, "can't sleep");
                break;
            case "PARALYSIS":
                if (!H.aiCanParalyze(ctx, m)) adj(SC.WORST, "can't paralyze");
                if (!H.shouldParalyzeTarget(ctx)) adj(SC.AWFUL, "paralysis helps the foe");
                break;
            case "BURN":
                if (!H.aiCanBurn(ctx, m)) adj(SC.WORST, "can't burn");
                if (!H.shouldBurnTarget(ctx)) adj(SC.AWFUL, "burn helps the foe");
                break;
        }

        if (has(["CHOICE_BAND", "CHOICE_SCARF", "CHOICE_SPECS"], hold(ai)) && isStatus(m)
            && !has(["Memento", "Parting Shot", "Baton Pass", "Teleport", "Chilly Reception", "Sleep Talk", "Me First", "Copycat", "Mimic", "Transform", "Sketch", "Nature Power", "Assist", "Metronome"], m.name))
            adj(SC.DOMINATED, "status move with a Choice item");
        return null;
    }
    function anyHazards(side) { return !!(side.isSR || side.spikes || side.tspikes || side.stickyWeb || side.steelsurge); }

    // ------------------------------------------------------------------
    // Ability-changing moves (battle_ai_util.c CanEffectChangeAbility,
    // AbilityChangeScore, BattlerBenefitsFromAbilityScore), singles subset.
    function abilityInfo(ctx, name) { return (ctx.abilities && ctx.abilities[name]) || { r: 0 }; }
    function abilityFlag(ctx, name, f) { var a = abilityInfo(ctx, name); return !!(a.f && a.f.indexOf(f) !== -1); }
    function overwriteAbility(m) { return (m.d && m.d.ow) || ""; }
    function canEffectChangeAbility(ctx, m) {
        var e = eff(m), atkAb = ctx.ai.ability, defAb = ctx.pl.ability, same = atkAb === defAb;
        if (!defAb) return false;
        if (!atkAb && has(["DOODLE", "ENTRAINMENT", "ROLE_PLAY", "SKILL_SWAP"], e)) return false;
        switch (e) {
            case "DOODLE": case "ROLE_PLAY":
                if (same || abilityFlag(ctx, atkAb, "cantBeSuppressed") || abilityFlag(ctx, defAb, "cantBeCopied")) return false;
                break;
            case "SKILL_SWAP":
                if (same || abilityFlag(ctx, atkAb, "cantBeSwapped") || abilityFlag(ctx, defAb, "cantBeSwapped")) return false;
                break;
            case "GASTRO_ACID":
                if (abilityFlag(ctx, defAb, "cantBeSuppressed")) return false;
                break;
            case "ENTRAINMENT":
                if (same || abilityFlag(ctx, defAb, "cantBeOverwritten") || abilityFlag(ctx, atkAb, "cantBeCopied")) return false;
                break;
            case "OVERWRITE_ABILITY":
                if (defAb === overwriteAbility(m) || abilityFlag(ctx, defAb, "cantBeOverwritten")) return false;
                break;
            default: return false;
        }
        if (hold(ctx.pl) === "ABILITY_SHIELD" && has(["ENTRAINMENT", "GASTRO_ACID", "ROLE_PLAY", "SKILL_SWAP", "OVERWRITE_ABILITY"], e)) return false;
        if (hold(ctx.ai) === "ABILITY_SHIELD" && has(["DOODLE", "ROLE_PLAY", "SKILL_SWAP"], e)) return false;
        return true;
    }
    function hasMoveChangingOwnStats(b, dir) {
        return movesOf(b).some(function (mm) {
            return fx(mm).some(function (f) {
                var st = H.parseStatFx(f[0]);
                if (!f[2]) return false;
                if (dir < 0) return (st && st.dir < 0) || has(["ATK_DEF_DOWN", "DEF_SPDEF_DOWN", "V_CREATE"], f[0]);
                return (st && st.dir > 0) || f[0] === "ALL_STATS_UP";
            });
        });
    }
    // battlerIsAi: score the ability for the AI (true) or for the player (false)
    function benefitsFromAbilityScore(ctx, battlerIsAi, ability) {
        var b = battlerIsAi ? ctx.ai : ctx.pl, foe = battlerIsAi ? ctx.pl : ctx.ai;
        if (abilityInfo(ctx, ability).r < 0) return SC.WORST;
        switch (ability) {
            case "Clear Body": case "Good as Gold": case "Magic Guard": case "Moody": case "Purifying Salt": case "Speed Boost": case "White Smoke":
                return SC.GOOD;
            case "Compound Eyes": case "No Guard": {
                var accCheck = ability === "No Guard" ? CFG.LOW_ACCURACY_THRESHOLD : 90;
                var lowAcc = movesOf(b).some(function (mm) {
                    if (!isStatus(mm) && mm.d && mm.d.acc === 0) return false;
                    if (H.target(mm) === "USER" || H.target(mm) === "OPPONENTS_FIELD") return false;
                    return mm.accv <= accCheck;
                });
                if (lowAcc) return SC.GOOD;
                break;
            }
            case "Contrary":
                if (hasMoveChangingOwnStats(b, -1)) return SC.BEST;
                if (hasMoveChangingOwnStats(b, 1)) return SC.AWFUL;
                break;
            case "Guts":
                if (H.hasMoveWithCategory(b, "Physical") && H.statusIs(b, ["psn", "tox", "brn", "par"])) return SC.GOOD;
                break;
            case "Huge Power": case "Pure Power":
                if (H.hasMoveWithCategory(b, "Physical")) return SC.BEST;
                break;
            case "Insomnia": case "Vital Spirit":
                if (H.hasMoveEffect(b, "REST")) return SC.WORST;
                break;
            case "Intimidate": {
                if (has(["Competitive", "Contrary", "Defiant", "Guard Dog", "Rattled"], foe.ability)) return SC.AWFUL;
                var swapped = battlerIsAi ? ctx : { ai: ctx.pl, pl: ctx.ai, field: ctx.field, opts: ctx.opts };
                return H.statDownScore(swapped, "atk");
            }
            case "Poison Heal":
                if (b.status === "psn") return SC.WEAK;
                if (b.status === "tox") return SC.BEST;
                if (b.status) return 0;
                break;
            case "Simple":
                return hasMoveChangingOwnStats(b, 1) ? SC.GOOD : 0;
            case "Beads of Ruin": case "Sword of Ruin": case "Tablets of Ruin": case "Vessel of Ruin":
                return SC.GOOD;
            case "":
                return 0;
        }
        return SC.WEAK;
    }
    function abilityChangeScore(ctx, m) {
        var e = eff(m), s = 0;
        var atkAb = ctx.ai.ability, defAb = ctx.pl.ability;
        var attackerHasBadAbility = abilityInfo(ctx, atkAb).r < 0;
        if (e === "GASTRO_ACID") atkAb = "";
        else if (e === "OVERWRITE_ABILITY") atkAb = overwriteAbility(m);
        if (e === "DOODLE" || e === "ROLE_PLAY" || e === "SKILL_SWAP") {
            if (attackerHasBadAbility) s += SC.DECENT;
            s += benefitsFromAbilityScore(ctx, true, defAb) - benefitsFromAbilityScore(ctx, true, atkAb);
        }
        // Targeting the opponent: do we want them to lose their ability?
        if (has(["ENTRAINMENT", "GASTRO_ACID", "SKILL_SWAP", "OVERWRITE_ABILITY"], e))
            s += benefitsFromAbilityScore(ctx, false, defAb) - benefitsFromAbilityScore(ctx, false, atkAb);
        return s;
    }
    function hasBeneficialTeatimeBerry(b) { return has(["RESTORE_HP", "RESTORE_PCT_HP", "ATTACK_UP", "DEFENSE_UP", "SPEED_UP", "SP_ATTACK_UP", "SP_DEFENSE_UP", "CRITICAL_UP", "RANDOM_STAT_UP"], hold(b)); }
    function thawsTarget(m) { return H.moveType(m) === "Fire" && !isStatus(m) || H.hasFx(m, "BURN", false) || flag(m, "thawsUser"); }
    function isTwoTurnNotSemiInvulnerable(ctx, m) {
        var e = eff(m);
        if (e !== "SOLAR_BEAM" && e !== "TWO_TURNS_ATTACK") return false;
        if (hold(ctx.ai) === "POWER_HERB") return false;
        var cw = m.d && m.d.chargeWeather;
        if (cw === "SUN" && H.weatherIs(ctx.field, H.SUN)) return false;
        if (cw === "RAIN" && H.weatherIs(ctx.field, H.RAIN)) return false;
        return true;
    }
    function restCanSleep(ctx) {
        var ai = ctx.ai, f = ctx.field;
        if (H.terrainAffected(ai, f, "Electric") || H.terrainAffected(ai, f, "Misty")) return false;
        if (has(["Comatose", "Purifying Salt", "Vital Spirit", "Insomnia", "Sweet Veil"], ai.ability)) return false;
        if (ai.ability === "Leaf Guard" && H.weatherIs(f, H.SUN)) return false;
        return true;
    }

    // ------------------------------------------------------------------
    // AI_TryToFaint
    function tryToFaint(ctx, rng, m, score, adj) {
        var ai = ctx.ai;
        if (isStatus(m.np || m)) return; // Nature Power counts as the attack it calls
        var faster = H.aiIsFaster(ctx, m, null, true);
        if (H.canIndexMoveFaintTarget(ctx, m) && (!H.isSelfSacrifice(m) || H.shouldConsiderSelfSacrifice(ctx, m, faster))) {
            adj(faster ? SC.FAST_KILL : SC.SLOW_KILL, faster ? "KOs and moves first" : "KOs but moves second");
            if (has(H.MOXIE_ABILITIES, ai.ability)) adj(SC.WEAK, "Moxie-type KO bonus");
        } else if (H.canTargetFaintAi(ctx) && speedOnlyOrder(ctx) !== 1 && H.movePriority(ai, m, ctx.field) > 0) {
            var isHDM = movesOf(ai).every(function (mm) { return dmgOf(mm) <= dmgOf(m); });
            if (isHDM) adj(SC.SLOW_KILL + 2, "priority move while outsped and KO'd (best damage)");
            else adj(SC.LAST_CHANCE + 9, "priority move while outsped and KO'd");
        } else if (speedOnlyOrder(ctx) !== 1 && hold(ai) === "EJECT_BUTTON") {
            adj(SC.LAST_CHANCE + 9, "Eject Button while slower");
        }
    }
    // GetWhichBattlerFasterOrTies with ignoreChosenMoves: pure speed, ties are 0 (not "faster")
    function speedOnlyOrder(ctx) {
        var a = ctx.ai.speed, p = ctx.pl.speed;
        if (a === p) return 0;
        var first = a > p ? 1 : -1;
        return ctx.field.trickRoom ? -first : first;
    }

    // ------------------------------------------------------------------
    // AI_CheckViability = damage check + effect score + additional effects + hold effect
    function checkViability(ctx, rng, m, score, adj) {
        if (power(m.np || m) !== 0) {
            if (H.hitsToKOBattler(ctx.ai, ctx.pl, m, true) === 0) { adj(SC.NO_DAMAGE_OR_FAILS, "does no damage"); return "RET"; }
        }
        moveEffectScore(ctx, rng, m, adj);
        additionalEffectScore(ctx, rng, m, adj);
        if (hold(ctx.ai) === "BLUNDER_POLICY") adj(m.accv <= CFG.LOW_ACCURACY_THRESHOLD ? SC.GOOD : SC.AWFUL, "Blunder Policy");
        return null;
    }

    function moveEffectScore(ctx, rng, m, adj) {
        var ai = ctx.ai, pl = ctx.pl, field = ctx.field;
        var e = eff(m), nv = H.nonVolatile(m), predicted = ctx.playerLastMove;
        var effv = m.effv;

        if (predictedEncourageEncore(m) && H.hasMoveEffect(pl, "ENCORE") && hold(ai) !== "MENTAL_HERB") {
            if (ai.ability !== "Aroma Veil" || H.isMoldBreaker(pl) || pl.ability === "Mycelium Might") return;
        }
        if (H.statusIs(ai, ["frz"]) && flag(m, "thawsUser")) adj(SC.PERFECT + 2, "thaws self");
        if (m.name === "Brutal Swing" && has(["Slow Start", "Truant", "Defeatist"], ai.ability)) adj(8, "Brutal Swing with bad ability");
        if (ai.ability === "Natural Cure" && ((ai.status === "brn" && H.hasOnlyMovesWithCategory(ai, "Physical")) || (ai.status === "frz" && H.hasOnlyMovesWithCategory(ai, "Special")))) adj(SC.DOMINATED, "Natural Cure: wants to switch");
        if (H.isFlinchGuaranteed(ctx, m) && e !== "FIRST_TURN_ONLY") adj(SC.BEST, "guaranteed flinch");
        if (m.name === "Relic Song") {
            if (ai.mon.name === "Meloetta") adj(SC.PERFECT, "Relic Song (Aria)");
            else if (ai.mon.name === "Meloetta-Pirouette" && rng.pct(25, "Relic Song roll")) adj(SC.WEAK, "Relic Song (Pirouette)");
        }

        switch (nv) {
            case "POISON": case "TOXIC": H.increasePoisonScore(ctx, rng, m, adj); break;
            case "SLEEP": H.increaseSleepScore(ctx, rng, m, adj); break;
            case "PARALYSIS": H.increaseParalyzeScore(ctx, rng, m, adj); break;
            case "BURN": H.increaseBurnScore(ctx, rng, m, adj); break;
        }

        switch (e) {
            case "YAWN":
                // Yawn carries a sleep status argument too, so the ROM scores it twice (nonvolatile switch above, then this).
                H.increaseSleepScore(ctx, rng, m, function (v, label) { adj(v, label + " (Yawn effect, counted again)"); });
                break;
            case "ABSORB": case "DREAM_EATER": if (H.shouldAbsorb(ctx, rng, m)) adj(SC.DECENT, "drain worth it"); break;
            case "AQUA_RING": if (hold(ai) === "BIG_ROOT") adj(SC.DECENT, "Aqua Ring + Big Root"); break;
            case "STRENGTH_SAP": {
                var atkStat = Math.floor(pl.mon.rawStats.atk * H.STAT_STAGE_RATIO[stage(pl, "atk")][0] / H.STAT_STAGE_RATIO[stage(pl, "atk")][1]);
                if (H.shouldRecover(ctx, rng, m, Math.floor(atkStat * 100 / ai.maxHp))) { adj(SC.GOOD_STATUS, "Strength Sap heals enough"); if (hold(ai) === "BIG_ROOT") adj(SC.WEAK, "Big Root"); }
                else adj(SC.DEFAULT_STATUS, "Strength Sap (not needed yet)");
                break;
            }
            case "PAIN_SPLIT": {
                // Null: scored as recovery, only when it restores more than 30% of max HP
                var hpAfterSplit = Math.floor((ai.hp + pl.hp) / 2);
                var splitHeal = hpAfterSplit > ai.hp ? Math.floor((hpAfterSplit - ai.hp) * 100 / ai.maxHp) : 0;
                if (splitHeal > 30) adj(H.shouldRecover(ctx, rng, m, splitHeal) ? SC.GOOD_STATUS : SC.DEFAULT_STATUS, "Pain Split heals " + splitHeal + "%");
                break;
            }
            case "MIRROR_MOVE": break;
            case "ATTACK_UP": case "ATTACK_UP_2":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.offensiveSetupScore(ctx, rng, true, false), "offensive setup");
                break;
            case "STUFF_CHEEKS": case "DEFENSE_UP": case "DEFENSE_UP_2": case "DEFENSE_UP_3":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.defensiveSetupScore(ctx, rng, true, false), "defensive setup");
                break;
            case "SPEED_UP": case "AUTOTOMIZE": case "SPEED_UP_2":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.speedSetupScore(ctx, rng), "speed setup");
                break;
            case "SPECIAL_ATTACK_UP": case "SPECIAL_ATTACK_UP_2": case "SPECIAL_ATTACK_UP_3":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.offensiveSetupScore(ctx, rng, false, true), "offensive setup");
                break;
            case "SPECIAL_DEFENSE_UP": case "SPECIAL_DEFENSE_UP_2":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.defensiveSetupScore(ctx, rng, false, true), "defensive setup");
                break;
            case "ACCURACY_UP": case "ACCURACY_UP_2": adj(H.statUp(ctx, rng, "acc", 1), "accuracy up"); break;
            case "EVASION_UP": case "EVASION_UP_2": case "MINIMIZE":
                if (H.statUp(ctx, rng, "eva", 1) > 0) {
                    adj(SC.BASE_STATUS, "evasion setup");
                    if (ai.hpPct > 90) { if (rng.pct(80, "evasion: healthy")) adj(SC.WEAK, "evasion at high HP"); }
                    else if (ai.hpPct > 60) { if (rng.pct(60, "evasion: fairly healthy")) adj(SC.WEAK, "evasion above 60% HP"); }
                }
                break;
            case "ATTACK_DOWN": case "ATTACK_DOWN_2": statDownStatusMove(ctx, rng, "atk", adj, "lower Attack"); break;
            case "DEFENSE_DOWN": case "DEFENSE_DOWN_2": statDownStatusMove(ctx, rng, "def", adj, "lower Defense"); break;
            case "SPEED_DOWN": case "SPEED_DOWN_2": statDownStatusMove(ctx, rng, "spe", adj, "lower Speed"); break;
            case "SPECIAL_ATTACK_DOWN": case "SPECIAL_ATTACK_DOWN_2": statDownStatusMove(ctx, rng, "spa", adj, "lower Sp. Atk"); break;
            case "SPECIAL_DEFENSE_DOWN": case "SPECIAL_DEFENSE_DOWN_2": statDownStatusMove(ctx, rng, "spd", adj, "lower Sp. Def"); break;
            case "ACCURACY_DOWN": case "ACCURACY_DOWN_2": statDownStatusMove(ctx, rng, "acc", adj, "lower accuracy"); break;
            case "EVASION_DOWN": case "EVASION_DOWN_2": statDownStatusMove(ctx, rng, "eva", adj, "lower evasion"); break;
            case "BIDE":
                if (ai.hpPct < 90) adj(SC.BAD, "Bide");
                adj(H.statUp(ctx, rng, "atk", 2), "Attack +2"); adj(H.statUp(ctx, rng, "spa", 2), "Sp. Atk +2");
                break;
            case "ACUPRESSURE":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.offensiveSetupScore(ctx, rng, false, false), "offensive setup");
                break;
            case "GEAR_UP":
                if (ai.ability === "Plus" || ai.ability === "Minus") { adj(H.statUp(ctx, rng, "atk", 1), "Attack +1"); adj(H.statUp(ctx, rng, "spa", 1), "Sp. Atk +1"); }
                break;
            case "MAGNETIC_FLUX":
                if (ai.ability === "Plus" || ai.ability === "Minus") { adj(H.statUp(ctx, rng, "def", 1), "Defense +1"); adj(H.statUp(ctx, rng, "spd", 1), "Sp. Def +1"); }
                break;
            case "ATTACK_ACCURACY_UP":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.offensiveSetupScore(ctx, rng, true, false), "offensive setup");
                break;
            case "GROWTH": case "ATTACK_SPATK_UP":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.offensiveSetupScore(ctx, rng, true, true), "offensive setup");
                break;
            case "ROTOTILLER":
                if (hasType(ai, "Grass") && H.isGrounded(ai, field)) { adj(H.statUp(ctx, rng, "atk", 1), "Attack +1"); adj(H.statUp(ctx, rng, "spa", 1), "Sp. Atk +1"); }
                if (hasType(pl, "Grass") && H.isGrounded(pl, field)) adj(pl.ability === "Contrary" ? SC.WEAK : SC.AWFUL, "also boosts foe");
                break;
            case "FLOWER_SHIELD":
                if (hasType(ai, "Grass")) adj(H.statUp(ctx, rng, "def", 1), "Defense +1");
                if (hasType(pl, "Grass")) adj(pl.ability === "Contrary" ? SC.WEAK : SC.AWFUL, "also boosts foe");
                break;
            case "HAZE": adj(H.tryToClearStats(ctx), "clears foe boosts"); break;
            case "ROAR":
                if ((H.isSound(m) && pl.ability === "Soundproof") || pl.ability === "Suction Cups") break;
                if (H.tryToClearStats(ctx) > 0 || anyHazards(pl.side)) adj(SC.BASE_STATUS, "phazing gains something");
                adj(H.tryToClearStats(ctx), "clears foe boosts");
                break;
            case "CONVERSION":
                if (movesOf(ai).length && !hasType(ai, H.moveType(movesOf(ai)[0]))) { adj(SC.WEAK, "Conversion"); if (ai.ability === "Adaptability") adj(SC.WEAK, "Adaptability"); }
                break;
            case "SWALLOW":
                if (ai.vol.stockpile) { var hp = [0, 25, 50, 100][Math.min(3, ai.vol.stockpile)]; if (H.shouldRecover(ctx, rng, m, hp)) adj(SC.DECENT, "Swallow heals"); }
                break;
            // Run & Bun recovery: +7 when it should heal, +5 otherwise
            case "RESTORE_HP": case "SOFTBOILED": case "ROOST":
                if (H.shouldRecover(ctx, rng, m, 50)) adj(SC.GOOD_STATUS, "recovery wins the 1v1 / safe heal");
                else adj(SC.DEFAULT_STATUS, "recovery (not needed yet)");
                break;
            case "MORNING_SUN": case "SYNTHESIS": case "MOONLIGHT":
                if ((H.weatherIs(field, H.SUN) && H.shouldRecover(ctx, rng, m, 67)) || H.shouldRecover(ctx, rng, m, 50)) adj(SC.GOOD_STATUS, "recovery wins the 1v1 / safe heal");
                else adj(SC.DEFAULT_STATUS, "recovery (not needed yet)");
                break;
            case "LIFE_DEW":
                if (H.shouldRecover(ctx, rng, m, 25)) adj(SC.GOOD_STATUS, "recovery");
                else adj(SC.DEFAULT_STATUS, "recovery (not needed yet)");
                break;
            case "LIGHT_SCREEN": case "REFLECT": case "AURORA_VEIL":
                // Run & Bun: +6, +1 with Light Clay, +1 half the time
                if (H.isScreenUseful(ctx, e)) {
                    adj(SC.BASE_STATUS, "screen vs foe's attacks");
                    if (hold(ai) === "LIGHT_CLAY") adj(SC.WEAK, "Light Clay");
                    if (rng.pct(50, "screen roll")) adj(SC.WEAK, "screen roll");
                    if (H.hasMoveWithAiEffect(pl, "breakScreens")) adj(SC.SLIGHT_BAD, "foe can break screens");
                    if (ai.hpPct <= 70) adj(SC.SLIGHT_BAD, "AI at 70% HP or less");
                }
                break;
            case "REST":
                if (!restCanSleep(ctx)) break;
                if (H.shouldRecover(ctx, rng, m, 100)) {
                    if (has(["CURE_SLP", "CURE_STATUS"], hold(ai)) || H.hasUsableWhileAsleepMove(ai) || ai.ability === "Shed Skin" || ai.ability === "Early Bird" || (H.weatherIs(field, H.RAIN) && ai.ability === "Hydration" && hold(ai) !== "UTILITY_UMBRELLA")) adj(SC.GREAT_STATUS, "Rest with a wake-up plan");
                    else adj(SC.GOOD_STATUS, "Rest");
                } else adj(SC.DEFAULT_STATUS, "Rest (not needed yet)");
                break;
            case "OHKO": if (ai.vol.lockOn) adj(SC.BEST, "OHKO after Lock-On"); break;
            case "MEAN_LOOK": case "OCTOLOCK": if (H.shouldTrap(ctx, false)) adj(6, "trap the foe"); break;
            case "FOCUS_ENERGY": case "LASER_FOCUS":
                if (pl.ability === "Shell Armor" || pl.ability === "Battle Armor") adj(SC.WORST, "foe can't be crit");
                else if (ai.ability === "Super Luck" || ai.ability === "Sniper" || hold(ai) === "SCOPE_LENS" || movesOf(ai).some(function (mm) { return mm.d && mm.d.crit > 0; })) adj(SC.GOOD_STATUS, "crit synergy");
                else adj(SC.BASE_STATUS, "Focus Energy");
                break;
            case "CONFUSE": H.increaseConfusionScore(ctx, rng, m, adj); break;
            case "SUBSTITUTE":
                // Run & Bun: never at 50% HP or lower
                if (ai.hpPct <= 50) { adj(SC.DOMINATED, "too little HP for Substitute"); break; }
                adj(SC.BASE_STATUS, "Substitute");
                if (pl.status === "slp") adj(SC.DECENT, "foe asleep");
                if (pl.side.isSeeded && H.aiIsFaster(ctx, m, null, true)) adj(SC.DECENT, "foe seeded and AI faster");
                if (rng.pct(50, "Substitute roll")) adj(SC.SLIGHT_BAD, "Substitute roll");
                break;
            case "SHED_TAIL": adj(H.substituteMoveScore(ctx, m), "Substitute value"); break;
            case "MIMIC": break;
            case "LEECH_SEED":
                if (hasType(pl, "Grass") || pl.side.isSeeded || H.hasMoveEffect(pl, "RAPID_SPIN") || pl.ability === "Liquid Ooze" || pl.ability === "Magic Guard") break;
                adj(SC.BASE_STATUS, "Leech Seed");
                break;
            case "TELEPORT": case "HIT_ESCAPE": case "PARTING_SHOT": case "WEATHER_AND_SWITCH": {
                if (isStatus(m)) adj(SC.BASE_STATUS, "status pivot");
                var p = H.shouldPivot(ctx, rng, m);
                if (p === "DONT") adj(SC.AWFUL, "no reason to pivot");
                else if (p === "SHOULD") adj(SC.BEST, "good pivot");
                break;
            }
            case "BATON_PASS":
                // Run & Bun: +14 when there is a successor and something worth passing
                if (!ctx.opts.aiLastMon && (ai.vol.substitute || ai.vol.powerTrick || ai.vol.magnetRise || ai.vol.aquaRing || ai.vol.root || H.anyStatRaised(ai))) adj(14, "Baton Pass boosts/Substitute");
                break;
            case "DISABLE":
                if (!pl.vol.disabled && predicted && hold(pl) !== "MENTAL_HERB" && H.aiIsFaster(ctx, m, null, true) && H.canTargetMoveFaintAi(ctx, predicted, 1)) adj(SC.BASE_STATUS, "Disable the KO move");
                break;
            case "ENCORE": {
                // Run & Bun: faster +7 when the last move is worth locking in; slower +6 or +5 (50%)
                var enc = predicted && (predictedEncourageEncore(predicted) || H.nonVolatile(predicted) === "POISON" || H.nonVolatile(predicted) === "PARALYSIS");
                if (!pl.vol.encored && hold(pl) !== "MENTAL_HERB") {
                    if (H.aiIsFaster(ctx, m, null, true)) adj(enc ? SC.GOOD_STATUS : SC.DEFAULT_STATUS, enc ? "Encore a setup/status move" : "Encore (nothing worth locking)");
                    else adj(rng.pct(50, "Encore while slower") ? SC.BASE_STATUS : SC.DEFAULT_STATUS, "Encore while slower");
                }
                break;
            }
            case "SLEEP_TALK": case "SNORE": if (!H.isWakeupTurn(ai) && ai.status === "slp") adj(15, "usable while asleep (Null)"); break;
            case "LOCK_ON":
                if (H.hasMoveEffect(ai, "OHKO")) adj(SC.GOOD, "Lock-On for OHKO");
                else if (H.hasMoveWithLowAccuracy(ctx, 85, true)) adj(SC.GOOD, "Lock-On for inaccurate move");
                break;
            case "DESTINY_BOND":
                // Run & Bun: faster and about to faint +7 (81%) / +6; slower +5 or +6 (50%)
                if (H.aiIsFaster(ctx, m, null, true)) {
                    if (H.canTargetFaintAi(ctx)) adj(rng.pct(81, "Destiny Bond roll") ? SC.GOOD_STATUS : SC.BASE_STATUS, "Destiny Bond before the KO");
                    else adj(SC.DEFAULT_STATUS, "Destiny Bond (not about to faint)");
                } else adj(rng.pct(50, "Destiny Bond while slower") ? SC.DEFAULT_STATUS : SC.BASE_STATUS, "Destiny Bond while slower");
                break;
            case "WISH": case "HEAL_BELL": if (H.shouldUseWishAromatherapy(ctx, m)) adj(SC.BASE_STATUS, "team support"); break;
            case "PURIFY":
                if (pl.status) { if (H.shouldCureTargetStatus(ctx)) adj(SC.GOOD, "Purify"); if (H.shouldRecover(ctx, rng, m, 50)) adj(SC.WEAK, "Purify heal"); }
                break;
            case "CURSE":
                if (hasType(ai, "Ghost")) adj(SC.BASE_STATUS, "Ghost Curse");
                else if (H.shouldBlockSetup(ctx, m)) adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)");
                else if (H.hasMoveWithCategory(pl, "Physical") && !H.hasMoveWithCategory(pl, "Special")) adj(H.defensiveSetupScore(ctx, rng, true, false), "defensive setup");
                else adj(H.offensiveSetupScore(ctx, rng, true, false), "offensive setup");
                break;
            case "PROTECT": {
                var method = m.d && m.d.protect;
                if (method === "QUICK_GUARD") { if (predicted && H.basePriority(predicted) > 0) adj(H.protectChecks(ctx, rng, m, predicted), "Quick Guard"); }
                else if (method === "WIDE_GUARD") { if (predicted && (H.target(predicted) === "BOTH" || H.target(predicted) === "FOES_AND_ALLY")) adj(H.protectChecks(ctx, rng, m, predicted), "Wide Guard"); }
                else if (method === "CRAFTY_SHIELD") { if (predicted && isStatus(predicted) && H.target(predicted) !== "USER") adj(H.protectChecks(ctx, rng, m, predicted), "Crafty Shield"); }
                else if (method === "MAT_BLOCK") { if (ctx.opts.firstTurn && predicted && !isStatus(predicted) && H.target(predicted) !== "USER") adj(H.protectChecks(ctx, rng, m, predicted), "Mat Block"); }
                else if (method === "KINGS_SHIELD" && ai.ability === "Stance Change" && ai.mon.name === "Aegislash-Blade" && !H.incapacitated(pl)) adj(SC.GOOD, "King's Shield (Blade)");
                else adj(H.protectChecks(ctx, rng, m, predicted), "Protect");
                break;
            }
            case "ENDURE":
                if (H.canTargetFaintAi(ctx)) {
                    if (ai.hp > Math.floor(ai.maxHp / 4) && has(H.PINCH_BERRIES, hold(ai))) adj(SC.BASE_STATUS, "Endure into pinch berry");
                    else if (ai.hp > 1 && (H.hasMoveEffect(ai, "FLAIL") || H.hasMoveEffect(ai, "ENDEAVOR"))) adj(SC.BASE_STATUS, "Endure into Flail/Endeavor");
                }
                break;
            case "CEASELESS_EDGE": case "STONE_AXE":
                if (H.shouldSetUpHazards(ctx, m)) adj(ctx.opts.firstTurn ? SC.BEST : SC.DECENT, ctx.opts.firstTurn ? "hazards on first turn" : "hazards");
                break;
            case "SPIKES": case "STEALTH_ROCK": case "TOXIC_SPIKES":
                if (H.shouldSetUpHazards(ctx, m)) {
                    // Run & Bun: +8 (25%) / +9 on the setter's first turn out, +6 (25%) / +7 after
                    if (ctx.opts.firstTurn) adj(rng.pct(25, "hazard roll") ? SC.GREAT_STATUS : SC.HIGH_PRIORITY, "hazards on first turn");
                    else adj(rng.pct(25, "hazard roll") ? SC.BASE_STATUS : SC.GOOD_STATUS, "hazards");
                    if ((e === "SPIKES" && pl.side.spikes > 0) || (e === "TOXIC_SPIKES" && pl.side.tspikes > 0)) adj(SC.SLIGHT_BAD, "a layer is already down");
                }
                break;
            case "STICKY_WEB":
                if (H.shouldSetUpHazards(ctx, m)) {
                    // Run & Bun: +9 (25%) / +12 on the setter's first turn out, +6 (25%) / +9 after
                    if (ctx.opts.firstTurn) adj(rng.pct(25, "Sticky Web roll") ? SC.HIGH_PRIORITY : SC.FIRST_TURN_HAZARD_HIGH, "Sticky Web on first turn");
                    else adj(rng.pct(25, "Sticky Web roll") ? SC.BASE_STATUS : SC.HIGH_PRIORITY, "Sticky Web");
                }
                break;
            case "FORESIGHT":
                if (ai.ability === "Scrappy" || ai.ability === "Mind's Eye") break;
                if (stage(pl, "eva") > 6 || (hasType(pl, "Ghost") && (H.hasMoveWithType(ai, "Normal") || H.hasMoveWithType(ai, "Fighting")))) adj(SC.DECENT, "Foresight");
                break;
            case "MIRACLE_EYE": if (stage(pl, "eva") > 6 || (hasType(pl, "Dark") && H.hasMoveWithType(ai, "Psychic"))) adj(SC.DECENT, "Miracle Eye"); break;
            case "PERISH_SONG": if (H.isTrapped(ctx)) adj(SC.BASE_STATUS, "Perish Song on a trapped foe"); break;
            case "NIGHTMARE": adj(SC.BASE_STATUS, "Nightmare"); break; // CheckBadMove rules out a target that isn't asleep
            case "WEATHER": if (H.weatherScore(ctx, m) > 0) adj(SC.BASE_STATUS, "weather worth setting"); break;
            case "FELL_STINGER": if (stage(ai, "atk") < 12 && ai.ability !== "Contrary" && H.canIndexMoveFaintTarget(ctx, m)) adj(SC.BEST, "Fell Stinger KO"); break;
            case "BELLY_DRUM": {
                if (stage(ai, "atk") >= 10 || !H.hasMoveWithCategory(ai, "Physical") || ai.ability === "Contrary") { adj(SC.DOMINATED, "Belly Drum pointless"); break; }
                var hpAfter = ai.hp - Math.floor(ai.maxHp / 2);
                if (hold(ai) === "RESTORE_HP") hpAfter += Math.floor(ai.maxHp / 4);
                var hpMod = hpAfter - ai.hp;
                var bd;
                if (H.incapacitated(pl)) bd = 9;
                else if (!H.canTargetFaintAiWithMod(ctx, hpMod, 1)) bd = 8;
                else if (H.aiIsSlower(ctx, m, null, true)) bd = 7;
                else bd = -20;
                adj(bd, "Belly Drum");
                break;
            }
            case "FILLET_AWAY":
                if (hasHPForDamagingSetup(ctx, 50)) {
                    if (H.shouldBlockSetup(ctx, m)) adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)");
                    else adj(H.offensiveSetupScore(ctx, rng, true, true), "offensive setup");
                }
                break;
            case "PSYCH_UP": if (H.shouldCopyStatChanges(ctx)) adj(SC.BASE_STATUS, "copy boosts"); break;
            case "SEMI_INVULNERABLE":
                if (predicted && !(ai.ability === "No Guard" || pl.ability === "No Guard")) {
                    var pe = eff(predicted);
                    if (H.aiIsFaster(ctx, m, null, true) && (H.isExplosion(predicted) || pe === "PROTECT")) adj(SC.GOOD, "dodge foe's move");
                    else if (pe === "SEMI_INVULNERABLE") adj(SC.GOOD, "dodge foe's move");
                }
                break;
            case "DEFENSE_CURL":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.defensiveSetupScore(ctx, rng, true, false), "defensive setup");
                if (H.hasMoveEffect(ai, "ROLLOUT") && !ai.vol.defenseCurl) adj(SC.WEAK, "Defense Curl + Rollout");
                break;
            case "FIRST_TURN_ONLY":
                if (ctx.opts.firstTurn) {
                    if (pl.ability !== "Shield Dust" && pl.ability !== "Inner Focus" && hold(pl) !== "COVERT_CLOAK") adj(SC.HIGH_PRIORITY, "Fake Out on first turn");
                    else if (!H.canIndexMoveFaintTarget(ctx, m)) adj(-30, "Fake Out can't flinch");
                }
                break;
            case "STOCKPILE":
                if (ai.ability === "Contrary") break;
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.defensiveSetupScore(ctx, rng, true, true), "defensive setup");
                if (H.hasMoveEffect(ai, "SWALLOW") || H.hasMoveEffect(ai, "SPIT_UP")) adj(SC.WEAK, "Stockpile with Swallow/Spit Up");
                break;
            case "SWAGGER":
                if (H.hasMoveEffect(ai, "FOUL_PLAY") || H.hasMoveEffect(ai, "PSYCH_UP") || H.hasMoveWithFx(ai, "STEAL_STATS") || hold(ai) === "MIRROR_HERB") adj(SC.WEAK, "Swagger synergy");
                if (pl.ability === "Contrary") adj(SC.GOOD, "Swagger vs Contrary");
                H.increaseConfusionScore(ctx, rng, m, adj);
                break;
            case "FLATTER":
                if (H.hasMoveEffect(ai, "PSYCH_UP") || H.hasMoveWithFx(ai, "STEAL_STATS") || hold(ai) === "MIRROR_HERB") adj(SC.WEAK, "Flatter synergy");
                if (pl.ability === "Contrary") adj(SC.GOOD, "Flatter vs Contrary");
                H.increaseConfusionScore(ctx, rng, m, adj);
                break;
            case "FURY_CUTTER": if (hold(ai) === "METRONOME") adj(SC.GOOD, "Fury Cutter + Metronome"); break;
            case "ATTRACT":
                if (H.aiIsSlower(ctx, m, null, true) && H.willFaintFromSecondary(pl, field)) break;
                if (pl.status || pl.vol.confused || H.isTrapped(ctx)) adj(SC.GOOD_STATUS, "Attract"); else adj(SC.BASE_STATUS, "Attract");
                break;
            case "SAFEGUARD": if (!H.terrainAffected(ai, field, "Misty")) adj(SC.DECENT, "Safeguard"); break;
            case "COURT_CHANGE":
                if (pl.side.isReflect || pl.side.isLightScreen || pl.side.isAuroraVeil || pl.side.isTailwind) adj(SC.WEAK, "steal foe's screens");
                if (anyHazards(ai.side) && !ctx.opts.aiLastMon) adj(SC.DECENT, "swap hazards over");
                break;
            case "DEFOG":
                if ((anyHazards(ai.side) && !ctx.opts.aiLastMon) || pl.side.isReflect || pl.side.isLightScreen || pl.side.isAuroraVeil) adj(SC.GOOD, "Defog clears something");
                else if (!anyHazards(pl.side) || ctx.opts.playerLastMon) adj(H.statDownScore(ctx, "eva"), "Defog evasion drop");
                break;
            case "CHARGE":
                if (H.hasDamagingMoveOfType(ai, "Electric") && !H.canTargetFaintAi(ctx)) adj(SC.BASE_STATUS, "Charge");
                break;
            case "TAUNT":
                // Run & Bun: +9 to stop an unset Trick Room, or a Defog that would clear our Aurora Veil; +5 otherwise
                if (H.hasMoveEffect(pl, "TRICK_ROOM") && !field.trickRoom) adj(SC.HIGH_PRIORITY, "Taunt a Trick Room setter");
                else if (H.hasMoveEffect(pl, "DEFOG") && ai.side.isAuroraVeil && H.aiIsFaster(ctx, m, null, true)) adj(SC.HIGH_PRIORITY, "Taunt Defog to keep Aurora Veil");
                else adj(SC.DEFAULT_STATUS, "Taunt");
                break;
            case "TRICK": case "BESTOW":
                if (e === "TRICK") adj(SC.DEFAULT_STATUS, "Trick base");
                trickScore(ctx, m, adj);
                break;
            case "CORROSIVE_GAS": case "KNOCK_OFF":
                if (pl.item && pl.ability !== "Sticky Hold" && !(e === "KNOCK_OFF" && ai.ability === "Sticky Hold")) {
                    var h = hold(pl);
                    if (h === "IRON_BALL") { if (H.hasMoveEffect(pl, "FLING")) adj(SC.DECENT, "Knock Off Iron Ball"); }
                    else if (h !== "LAGGING_TAIL" && h !== "STICKY_BARB") adj(SC.DECENT, "removes foe's item");
                }
                break;
            case "INGRAIN": adj(SC.WEAK, "Ingrain"); if (hold(ai) === "BIG_ROOT") adj(SC.GOOD, "Ingrain + Big Root"); break;
            case "MAGIC_COAT": if (predicted && flag(predicted, "magicCoatAffected")) adj(SC.GOOD, "bounce the foe's move"); break;
            case "RECYCLE": if (ai.vol.usedItem) adj(SC.WEAK, "Recycle"); break;
            case "IMPRISON":
                if (predicted && H.hasMoveNamed(ai, predicted.name)) adj(SC.DECENT, "Imprison shared move");
                else if (!ctx.opts.firstTurn) adj(SC.WEAK, "Imprison");
                break;
            case "REFRESH": if (H.statusIs(ai, ["psn", "tox", "brn", "par"]) && H.shouldCureOwnStatus(ai)) adj(SC.BASE_STATUS, "Refresh"); break;
            case "TAKE_HEART": if (ai.status || H.statCanRise(ai, "spa") || H.statCanRise(ai, "spd")) adj(SC.DECENT, "Take Heart"); break;
            case "PSYCHO_SHIFT":
                if (H.statusIs(ai, ["psn", "tox"])) H.increasePoisonScore(ctx, rng, m, adj);
                else if (ai.status === "brn") H.increaseBurnScore(ctx, rng, m, adj);
                else if (ai.status === "par") H.increaseParalyzeScore(ctx, rng, m, adj);
                else if (ai.status === "slp") H.increaseSleepScore(ctx, rng, m, adj);
                break;
            case "SNATCH": if (predicted && flag(predicted, "snatchAffected")) adj(SC.GOOD, "Snatch"); break;
            case "MUD_SPORT": if (!H.hasMoveWithType(ai, "Electric") && H.hasMoveWithType(pl, "Electric")) adj(SC.BASE_STATUS, "Mud Sport"); break;
            case "WATER_SPORT": if (!H.hasMoveWithType(ai, "Fire") && H.hasMoveWithType(pl, "Fire")) adj(SC.BASE_STATUS, "Water Sport"); break;
            case "TICKLE": {
                // The ROM scores both drops and keeps the better one (each may roll the repeat-drop penalty)
                var tickleAtk = 0, tickleDef = 0;
                statDownStatusMove(ctx, rng, "atk", function (v) { tickleAtk += v; }, "");
                statDownStatusMove(ctx, rng, "def", function (v) { tickleDef += v; }, "");
                adj(Math.max(tickleAtk, tickleDef), "lower Attack and Defense");
                break;
            }
            case "COSMIC_POWER":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.defensiveSetupScore(ctx, rng, true, true), "defensive setup");
                break;
            case "BULK_UP":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                if (H.hasMoveWithCategory(pl, "Physical") && !H.hasMoveWithCategory(pl, "Special")) adj(H.defensiveSetupScore(ctx, rng, true, false), "defensive setup");
                else adj(H.offensiveSetupScore(ctx, rng, true, false), "offensive setup");
                break;
            case "CALM_MIND":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                if (H.hasMoveWithCategory(pl, "Special") && !H.hasMoveWithCategory(pl, "Physical")) adj(H.defensiveSetupScore(ctx, rng, false, true), "defensive setup");
                else adj(H.offensiveSetupScore(ctx, rng, false, true), "offensive setup");
                break;
            case "GEOMANCY":
                if (hold(ai) === "POWER_HERB") adj(SC.GOOD, "Geomancy + Power Herb");
                /* falls through */
            case "QUIVER_DANCE": // Run & Bun: scored like Calm Mind
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                if (H.hasMoveWithCategory(pl, "Special") && !H.hasMoveWithCategory(pl, "Physical")) adj(H.defensiveSetupScore(ctx, rng, false, true), "defensive setup");
                else adj(H.offensiveSetupScore(ctx, rng, false, true), "offensive setup");
                break;
            case "COIL": case "VICTORY_DANCE": // Run & Bun: scored like Bulk Up
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                if (H.hasMoveWithCategory(pl, "Physical") && !H.hasMoveWithCategory(pl, "Special")) adj(H.defensiveSetupScore(ctx, rng, true, false), "defensive setup");
                else adj(H.offensiveSetupScore(ctx, rng, true, false), "offensive setup");
                break;
            case "SHELL_SMASH":
                if (stage(ai, "atk") > 6 || stage(ai, "atk") === 12 || stage(ai, "spa") === 12) { adj(SC.DOMINATED, "already smashed"); break; }
                adj(SC.BASE_STATUS, "Shell Smash");
                if (H.incapacitated(pl)) adj(SC.GOOD, "foe incapacitated");
                adj(H.canTargetFaintAi(ctx) ? SC.BAD : SC.DECENT, H.canTargetFaintAi(ctx) ? "foe can KO" : "foe can't KO");
                break;
            case "TIDY_UP":
                if (anyHazards(ai.side) && !ctx.opts.aiLastMon) adj(SC.GOOD, "clears own hazards");
                if (anyHazards(pl.side) && !ctx.opts.playerLastMon) adj(-2, "clears foe hazards");
                if (ai.vol.substitute && H.aiIsFaster(ctx, m, null, false)) adj(-10, "breaks own Substitute");
                if (pl.vol.substitute) adj(SC.GOOD, "breaks foe's Substitute");
                if (ai.side.isSeeded) adj(SC.DECENT, "clears Leech Seed");
                if (pl.side.isSeeded) adj(-2, "frees the foe");
                /* falls through */
            case "DRAGON_DANCE": case "SHIFT_GEAR":
                if (H.shouldBlockSetup(ctx, m)) { adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)"); break; }
                adj(H.offensiveSetupScore(ctx, rng, true, false), "offensive setup");
                break;
            case "GUARD_SWAP":
                if ((stage(pl, "def") > stage(ai, "def") && stage(pl, "spd") >= stage(ai, "spd")) || (stage(pl, "spd") > stage(ai, "spd") && stage(pl, "def") >= stage(ai, "def"))) adj(SC.DECENT, "Guard Swap");
                break;
            case "POWER_SWAP":
                if ((stage(pl, "atk") > stage(ai, "atk") && stage(pl, "spa") >= stage(ai, "spa")) || (stage(pl, "spa") > stage(ai, "spa") && stage(pl, "atk") >= stage(ai, "atk"))) adj(SC.DECENT, "Power Swap");
                break;
            case "POWER_TRICK": if (!ai.vol.powerTrick && ai.mon.rawStats.def > ai.mon.rawStats.atk && H.hasMoveWithCategory(ai, "Physical")) adj(SC.BASE_STATUS, "Power Trick"); break;
            case "HEART_SWAP": {
                var higher = false, ok = true;
                H.STAT_NAMES.forEach(function (s) { if (!ok) return; if ((pl.boosts[s] || 0) < (ai.boosts[s] || 0)) ok = false; if ((pl.boosts[s] || 0) > (ai.boosts[s] || 0)) higher = true; });
                if (ok && higher) adj(SC.DECENT, "Heart Swap");
                break;
            }
            case "SPEED_SWAP": if (pl.speed > ai.speed) adj(SC.DECENT, "Speed Swap"); break;
            case "GUARD_SPLIT": {
                var nd = (ai.mon.rawStats.def + pl.mon.rawStats.def) * 50, nsd = (ai.mon.rawStats.spd + pl.mon.rawStats.spd) * 50;
                if (nd > ai.mon.rawStats.def * 200 || nsd > ai.mon.rawStats.spd * 200 || nd < pl.mon.rawStats.def * 50 || nsd < pl.mon.rawStats.spd * 50) adj(SC.GOOD, "Guard Split");
                else adj(SC.WORST, "Guard Split pointless");
                break;
            }
            case "POWER_SPLIT": {
                var na = (ai.mon.rawStats.atk + pl.mon.rawStats.atk) * 50, nsa = (ai.mon.rawStats.spa + pl.mon.rawStats.spa) * 50;
                if ((H.hasMoveWithCategory(ai, "Physical") && na > ai.mon.rawStats.atk * 150) || (H.hasMoveWithCategory(ai, "Special") && nsa > ai.mon.rawStats.spa * 150) || na < pl.mon.rawStats.atk * 50 || nsa < pl.mon.rawStats.spa * 50) adj(SC.GOOD, "Power Split");
                else adj(SC.WORST, "Power Split pointless");
                break;
            }
            case "ELECTRIC_TERRAIN": case "MISTY_TERRAIN": case "GRASSY_TERRAIN": case "PSYCHIC_TERRAIN": {
                var tName = { ELECTRIC_TERRAIN: "Electric", MISTY_TERRAIN: "Misty", GRASSY_TERRAIN: "Grassy", PSYCHIC_TERRAIN: "Psychic" }[e];
                if (H.shouldSetFieldStatus(ctx, tName)) {
                    adj(SC.GREAT_STATUS, tName + " Terrain helps (Run & Bun +8)");
                    if ((tName === "Electric" || tName === "Misty") && ai.vol.yawn && H.isGrounded(ai, field)) adj(SC.BEST, "blocks own Yawn");
                    if (hold(ai) === "TERRAIN_EXTENDER" || H.hasMoveEffect(ai, "TERRAIN_PULSE")) adj(SC.WEAK, "terrain synergy");
                }
                break;
            }
            case "STEEL_ROLLER": case "ICE_SPINNER":
                if (field.terrain) { if (H.shouldClearFieldStatus(ctx, field.terrain)) adj(SC.GOOD, "clears a bad terrain"); if (terrainHelpsFoe(ctx)) adj(SC.DECENT, "removes foe's terrain"); }
                break;
            case "TRICK_ROOM":
                if (field.trickRoom) break;
                adj(ai.speed < pl.speed ? SC.PERFECT : SC.DEFAULT_STATUS, ai.speed < pl.speed ? "Trick Room while slower" : "Trick Room while faster");
                break;
            case "MAGIC_ROOM": adj(SC.WEAK, "Magic Room"); if (hold(ai) === "NONE" && hold(pl) !== "NONE") adj(SC.WEAK, "foe loses item"); break;
            case "WONDER_ROOM":
                if ((H.hasMoveWithCategory(pl, "Physical") && ai.mon.rawStats.def < ai.mon.rawStats.spd) || (H.hasMoveWithCategory(pl, "Special") && ai.mon.rawStats.spd < ai.mon.rawStats.def)) adj(SC.DECENT, "Wonder Room");
                break;
            case "GRAVITY":
                if (!(field.gravity || H.shouldClearFieldStatus(ctx, "Gravity"))) {
                    if (H.hasSleepMoveWithLowAccuracy(ctx)) H.increaseSleepScore(ctx, rng, m, adj);
                    if (H.hasMoveWithLowAccuracy(ctx, 90, true)) adj(SC.WEAK, "Gravity accuracy");
                    if (H.shouldSetFieldStatus(ctx, "Gravity")) adj(SC.DECENT, "Gravity helps");
                }
                break;
            case "ION_DELUGE": if (has(["Volt Absorb", "Motor Drive", "Lightning Rod"], ai.ability) && predicted && H.moveType(predicted) === "Normal") adj(SC.DECENT, "Ion Deluge"); break;
            case "EMBARGO": if (hold(pl) !== "NONE") adj(SC.DECENT, "Embargo"); break;
            case "POWDER": if (predicted && !isStatus(predicted) && H.moveType(predicted) === "Fire") adj(SC.DECENT, "Powder"); break;
            case "TELEKINESIS": if (H.hasMoveWithLowAccuracy(ctx, 90, false) || !H.isGrounded(pl, field)) adj(SC.DECENT, "Telekinesis"); break;
            case "HEAL_BLOCK":
                if (H.aiIsFaster(ctx, m, null, true) && predicted && H.isHealing(predicted)) adj(SC.DECENT, "cancel foe's heal");
                else if (H.hasHealingEffect(pl) || hold(pl) === "LEFTOVERS" || (hold(pl) === "BLACK_SLUDGE" && hasType(pl, "Poison"))) adj(SC.DECENT, "Heal Block");
                break;
            case "SOAK": if (H.hasMoveWithType(ai, "Electric") || H.hasMoveWithType(ai, "Grass")) adj(SC.BASE_STATUS, "Soak for coverage"); break;
            case "THIRD_TYPE": if (pl.ability === "Wonder Guard") adj(SC.BASE_STATUS, "Third type vs Wonder Guard"); break;
            case "ELECTRIFY": if (predicted && has(["Volt Absorb", "Motor Drive", "Lightning Rod"], ai.ability)) adj(SC.DECENT, "Electrify"); break;
            case "TOPSY_TURVY": if (H.countPositive(pl) > H.countNegative(pl)) adj(SC.DECENT, "Topsy-Turvy"); break;
            case "FAIRY_LOCK": if (H.shouldTrap(ctx, false)) adj(SC.BEST, "Fairy Lock"); break;
            case "TAILWIND":
                if (field.trickRoom) break;
                // Run & Bun: +9 if the AI is slower than the foe, +5 otherwise
                adj(ai.speed < pl.speed ? SC.HIGH_PRIORITY : SC.DEFAULT_STATUS, ai.speed < pl.speed ? "Tailwind while slower" : "Tailwind while faster");
                if (!ai.side.isTailwind) { if (ai.ability === "Wind Rider") adj(H.statUp(ctx, rng, "atk", 1), "Wind Rider"); else if (ai.ability === "Wind Power" && !ai.vol.charged && H.hasDamagingMoveOfType(ai, "Electric")) adj(SC.DECENT, "Wind Power"); }
                break;
            case "LUCKY_CHANT": if (!ctx.opts.playerLastMon) adj(SC.GOOD, "Lucky Chant"); break;
            case "MAGNET_RISE":
                if (H.isGrounded(ai, field) && H.hasDamagingMoveOfType(pl, "Ground") && effv !== 0) {
                    if (H.aiIsFaster(ctx, m, null, true)) { if (predicted && H.moveType(predicted) === "Ground") adj(SC.GOOD_STATUS, "dodge Ground move"); }
                    else adj(SC.BASE_STATUS, "Magnet Rise");
                }
                break;
            case "CAMOUFLAGE": break;
            case "TOXIC_THREAD": H.increasePoisonScore(ctx, rng, m, adj); adj(H.statUp(ctx, rng, "spe", 1), "Speed +1"); break;
            case "REFLECT_DAMAGE": {
                var faster = H.aiIsFaster(ctx, m, null, true);
                var sashOrSturdy = H.atMaxHp(ai) && (hold(ai) === "FOCUS_SASH" || ai.ability === "Sturdy");
                var foeStatus = H.hasMoveWithCategory(pl, "Status");
                if (m.name === "Metal Burst") {
                    if (faster) { adj(SC.DOMINATED, "Metal Burst while faster"); break; }
                    adj(SC.BASE_STATUS, "Metal Burst base");
                    if (sashOrSturdy) adj(2, "Metal Burst with Sash/Sturdy");
                    if (rng.pct(25, "Metal Burst roll")) adj(1, "Metal Burst roll");
                    if (foeStatus && rng.pct(50, "Metal Burst vs status")) adj(-1, "foe has a status move");
                } else {
                    var relevant = m.name === "Counter" ? "Physical" : "Special", other = m.name === "Counter" ? "Special" : "Physical";
                    var only = H.hasMoveWithCategory(pl, relevant) && !H.hasMoveWithCategory(pl, other);
                    adj(SC.BASE_STATUS, "Counter/Mirror Coat base");
                    if (only && H.canTargetFaintAi(ctx) && sashOrSturdy) adj(2, "Counter with Sash/Sturdy");
                    else if (only && rng.pct(80, "Counter roll")) adj(2, "foe only has the countered category");
                    if (faster && rng.pct(25, "Counter while faster")) adj(-1, "Counter while faster");
                    if (foeStatus && rng.pct(25, "Counter vs status")) adj(-1, "foe has a status move");
                }
                break;
            }
            case "SHORE_UP":
                if ((H.weatherIs(field, H.SAND) && H.shouldRecover(ctx, rng, m, 67)) || H.shouldRecover(ctx, rng, m, 50)) adj(SC.GOOD_STATUS, "Shore Up");
                else adj(SC.DEFAULT_STATUS, "Shore Up (not needed yet)");
                break;
            case "ENDEAVOR": if (H.aiIsSlower(ctx, m, null, true) && !H.canTargetFaintAi(ctx)) adj(SC.DECENT, "Endeavor"); break;
            case "REVIVAL_BLESSING": if (ctx.opts.aiHasFainted) adj(SC.BASE_STATUS, "Revival Blessing"); break;
            case "CLANGOROUS_SOUL":
                if (hasHPForDamagingSetup(ctx, 67)) {
                    if (H.shouldBlockSetup(ctx, m)) adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)");
                    else adj(H.offensiveSetupScore(ctx, rng, true, true), "offensive setup");
                }
                break;
            case "NO_RETREAT":
                if (H.shouldBlockSetup(ctx, m)) adj(SC.DOMINATED, "setup blocked (KO'd / Unaware / Haze)");
                else adj(H.offensiveSetupScore(ctx, rng, true, true), "offensive setup");
                break;
            case "TORMENT": case "TRANSFORM": case "ASSIST":
                adj(SC.BASE_STATUS, "Run & Bun default");
                break;
            case "DOODLE": case "ENTRAINMENT": case "GASTRO_ACID": case "ROLE_PLAY": case "SKILL_SWAP": case "OVERWRITE_ABILITY": {
                if (!ctx.abilities) break; // already scored as unmodelled in checkBadMove
                // +6 once the change helps; a harmful change keeps its penalty
                var abilityScore = abilityChangeScore(ctx, m);
                adj(abilityScore > 0 ? SC.BASE_STATUS : abilityScore, abilityScore > 0 ? "ability change helps" : "ability change doesn't help");
                break;
            }
            case "JUNGLE_HEALING": if (H.shouldRecover(ctx, rng, m, 25) || (ai.status && H.shouldCureOwnStatus(ai))) adj(SC.GOOD, "Jungle Healing"); break;
            case "RAPID_SPIN": if ((anyHazards(ai.side) && !ctx.opts.aiLastMon) || ai.side.isSeeded || ai.vol.wrapped) adj(SC.GOOD, "Rapid Spin clears"); break;
            case "SMACK_DOWN": if (!H.isGrounded(pl, field) && H.hasDamagingMoveOfType(ai, "Ground") && !H.canTargetFaintAi(ctx)) adj(SC.DECENT, "ground the foe"); break;
            case "STEAL_ITEM": break; // trainers cannot steal in this ROM
        }
    }
    function predictedEncourageEncore(m) {
        // gBattleMoveEffects[].encourageEncore: setup, hazards, screens, weather, terrain, etc.
        var e = eff(m);
        return has(H.STAT_RAISING, e) || has(H.HAZARD_EFFECTS, e) || has(["LIGHT_SCREEN", "REFLECT", "AURORA_VEIL", "WEATHER", "SUBSTITUTE", "PROTECT", "ELECTRIC_TERRAIN", "GRASSY_TERRAIN", "MISTY_TERRAIN", "PSYCHIC_TERRAIN", "TRICK_ROOM", "TAILWIND", "SAFEGUARD", "MIST", "HAZE", "FOCUS_ENERGY", "RESTORE_HP", "SOFTBOILED", "ROOST", "MORNING_SUN", "SYNTHESIS", "MOONLIGHT", "REST", "WISH", "HEAL_BELL", "DEFOG", "RAPID_SPIN", "BELLY_DRUM", "TAUNT", "ENCORE", "SPLASH", "DO_NOTHING"], e);
    }
    function terrainHelpsFoe(ctx) {
        var swapped = { ai: ctx.pl, pl: ctx.ai, field: ctx.field, opts: ctx.opts };
        return H.shouldSetFieldStatus(swapped, ctx.field.terrain);
    }
    function hasHPForDamagingSetup(ctx, threshold) {
        var ai = ctx.ai;
        if (H.bestDmgFrom(ctx.pl) < Math.floor(threshold * ai.maxHp / 100)) return true;
        if (H.hasPhysicalBestMove(ctx.pl, ai) && ai.ability === "Ice Face" && ai.vol.iceFace && !H.isMoldBreaker(ctx.pl)) return true;
        if (ai.ability === "Disguise" && ai.vol.disguised && !H.isMoldBreaker(ctx.pl)) return true;
        return false;
    }
    function trickScore(ctx, m, adj) {
        var ai = ctx.ai, pl = ctx.pl;
        switch (hold(ai)) {
            case "CHOICE_SCARF": adj(SC.DECENT, "Trick Choice Scarf"); break;
            case "CHOICE_BAND": if (!H.hasMoveWithCategory(pl, "Physical")) adj(SC.DECENT, "Trick Choice Band"); break;
            case "CHOICE_SPECS": if (!H.hasMoveWithCategory(pl, "Special")) adj(SC.DECENT, "Trick Choice Specs"); break;
            case "TOXIC_ORB": if (!H.shouldPoisonSelf(ctx) || H.statusIs(ai, ["psn", "tox"])) adj(SC.DECENT, "Trick Toxic Orb"); break;
            case "FLAME_ORB": if (!H.shouldBurnSelf(ctx) || ai.status === "brn") adj(SC.DECENT, "Trick Flame Orb"); break;
            case "BLACK_SLUDGE": if (!hasType(pl, "Poison") && pl.ability !== "Magic Guard") adj(SC.DECENT, "Trick Black Sludge"); break;
            case "IRON_BALL": if (!H.hasMoveEffect(pl, "FLING") || !H.isGrounded(pl, ctx.field)) adj(SC.DECENT, "Trick Iron Ball"); break;
            case "LAGGING_TAIL": case "STICKY_BARB": adj(SC.DECENT, "Trick a bad item"); break;
            case "EJECT_BUTTON": if (H.hasDamagingMove(ai)) adj(SC.DECENT, "Trick Eject Button"); break;
            default:
                if (eff(m) !== "BESTOW" && !ai.item && pl.item) {
                    switch (hold(pl)) {
                        case "CHOICE_BAND": break;
                        case "TOXIC_ORB": if (H.shouldPoisonSelf(ctx)) adj(SC.DECENT, "take Toxic Orb"); break;
                        case "FLAME_ORB": if (H.shouldBurnSelf(ctx)) adj(SC.DECENT, "take Flame Orb"); break;
                        case "BLACK_SLUDGE": if (hasType(ai, "Poison") || ai.ability === "Magic Guard") adj(SC.DECENT, "take Black Sludge"); break;
                        case "IRON_BALL": if (H.hasMoveEffect(ai, "FLING")) adj(SC.DECENT, "take Iron Ball"); break;
                        case "LAGGING_TAIL": case "STICKY_BARB": break;
                        default: adj(SC.WEAK, "take foe's item"); break;
                    }
                }
        }
    }

    // ------------------------------------------------------------------
    // AI_CalcAdditionalEffectScore
    function additionalEffectScore(ctx, rng, m, adj) {
        var ai = ctx.ai, pl = ctx.pl, field = ctx.field, predicted = ctx.playerLastMove;
        if (H.sheerForceAffected(ai, m)) return;
        H.guaranteedEffects(ai, m).forEach(function (f) {
            var name = f[0], self = !!f[2];
            var st = H.parseStatFx(name);
            if (self) {
                if (ai.ability !== "Contrary") {
                    if (st && st.dir > 0) adj(H.statUp(ctx, rng, st.stat, st.stages), "self " + st.stat + " +" + st.stages);
                } else {
                    if (st && st.dir < 0) adj(H.statUpContrary(ctx, rng, st.stat, 1), "Contrary boost from " + st.stat + " drop");
                    else if (name === "DEF_SPDEF_DOWN") { adj(H.statUpContrary(ctx, rng, "def", 1), "Contrary Def"); adj(H.statUpContrary(ctx, rng, "spd", 1), "Contrary SpD"); }
                    else if (name === "ATK_DEF_DOWN") { adj(H.statUpContrary(ctx, rng, "atk", 1), "Contrary Atk"); adj(H.statUpContrary(ctx, rng, "def", 1), "Contrary Def"); }
                    else if (name === "V_CREATE") { adj(H.statUpContrary(ctx, rng, "def", 1), "Contrary Def"); adj(H.statUpContrary(ctx, rng, "spe", 1), "Contrary Spe"); adj(H.statUpContrary(ctx, rng, "spd", 1), "Contrary SpD"); }
                }
                return;
            }
            if (pl.ability === "Shield Dust" && !H.ignoresAbility(ai, m)) return;
            if (hold(pl) === "COVERT_CLOAK") return;
            switch (name) {
                case "FLINCH": if (H.shouldTryToFlinch(ctx, m)) adj(2, "flinch chance worth it"); break;
                case "POISON": case "TOXIC": H.increasePoisonScore(ctx, rng, m, adj); break;
                case "CLEAR_SMOG": adj(H.tryToClearStats(ctx), "clears foe boosts"); break;
                case "BUG_BITE": if (!pl.vol.substitute && pl.ability !== "Sticky Hold" && H.isBerry(pl)) adj(SC.DECENT, "eats foe's berry"); break;
                case "INCINERATE": if (!pl.vol.substitute && pl.ability !== "Sticky Hold" && (H.isBerry(pl) || hold(pl) === "GEMS")) adj(SC.DECENT, "burns foe's berry"); break;
                case "STEALTH_ROCK": if (H.shouldSetUpHazards(ctx, m)) adj(ctx.opts.firstTurn ? SC.BEST : SC.DECENT, "sets Stealth Rock"); break;
                case "FEINT": if (predicted && eff(predicted) === "PROTECT") adj(SC.GOOD, "Feint through Protect"); break;
                case "THROAT_CHOP": {
                    var best = H.bestDmgMoves(pl, ai);
                    for (var i = 0; i < best.length; i++) { if (H.isSound(best[i])) { adj(H.aiIsFaster(ctx, m, null, true) ? SC.GOOD : SC.DECENT, "Throat Chop vs sound move"); break; } }
                    break;
                }
                case "WRAP":
                    if (!H.hasMoveEffect(pl, "RAPID_SPIN") && H.shouldTrap(ctx, true)) { adj(rng.pct(80, "trap roll") ? 6 : 8, "trapping damage"); if (hold(ai) === "BINDING_BAND" || hold(ai) === "GRIP_CLAW") adj(1, "Binding Band/Grip Claw"); }
                    break;
                case "SALT_CURE": adj(rng.pct(80, "Salt Cure roll") ? 6 : 7, "Salt Cure"); if (hasType(pl, "Water") || hasType(pl, "Steel")) adj(SC.WEAK, "Salt Cure vs Water/Steel"); break;
                case "SUN": case "RAIN": case "SANDSTORM": case "HAIL": {
                    var w = { SUN: "Sun", RAIN: "Rain", SANDSTORM: "Sand", HAIL: "Hail" }[name];
                    if (H.shouldSetWeather(ctx, w)) adj(SC.DECENT, "sets " + w);
                    if (H.shouldClearWeather(ctx, w)) adj(SC.BAD, "bad weather for us");
                    break;
                }
                case "MISTY_TERRAIN": case "GRASSY_TERRAIN": case "ELECTRIC_TERRAIN": case "PSYCHIC_TERRAIN": {
                    var t = name.split("_")[0]; t = t.charAt(0) + t.slice(1).toLowerCase();
                    if (H.shouldClearFieldStatus(ctx, t)) { adj(SC.BAD, "bad terrain for us"); break; }
                    if (H.shouldSetFieldStatus(ctx, t) || (field.terrain && H.shouldClearFieldStatus(ctx, field.terrain))) adj(SC.DECENT, "sets " + t + " Terrain");
                    break;
                }
                case "GRAVITY": if (!field.gravity && H.shouldSetFieldStatus(ctx, "Gravity")) adj(SC.DECENT, "sets Gravity"); break;
                case "AURORA_VEIL": if (H.shouldSetScreen(ctx, "AURORA_VEIL")) adj(SC.DECENT, "sets Aurora Veil"); break;
                case "REMOVE_STATUS":
                    if (pl.status && (m.d.argStatus === "ANY" || (H.NORMAL_TYPE_STATUS[pl.status] || "").indexOf(m.d.argStatus || "") === 0)) {
                        if (H.shouldCureTargetStatus(ctx)) adj(SC.DECENT, "cures a helpful status");
                        else if (hold(pl) === "FLAME_ORB" || hold(pl) === "TOXIC_ORB") adj(SC.WEAK, "cures orb status");
                        else adj(SC.BAD, "cures foe's status");
                    }
                    break;
                case "BREAK_SCREEN":
                    if (pl.side.isReflect) adj(SC.DECENT, "breaks Reflect");
                    if (pl.side.isLightScreen) adj(SC.DECENT, "breaks Light Screen");
                    if (pl.side.isAuroraVeil) adj(SC.DECENT, "breaks Aurora Veil");
                    break;
                case "STEAL_STATS": adj(H.shouldCopyStatChanges(ctx) ? 1 : 0, "steals boosts"); break;
                default:
                    if (st && st.dir < 0 && (st.stat === "spe" || st.stat === "atk" || st.stat === "spa")) {
                        // Run & Bun: scored in compareDamagingMoves when this isn't the strongest attack
                    } else if (st && st.dir < 0 && st.stat === "spd" && st.stages === 2) {
                        // Run & Bun: a guaranteed -2 Sp. Def drop (Acid Spray) is worth +6 on top of its damage score
                        if (H.canLowerStat(ctx, m, "spd")) adj(SC.BASE_STATUS, "lowers foe Sp. Def by 2");
                    } else if (st && st.dir < 0) {
                        if (H.canLowerStat(ctx, m, st.stat)) {
                            var inc = H.statDownScore(ctx, st.stat);
                            if (st.stat === "acc" && inc === SC.WEAK) inc = SC.DECENT;
                            adj(inc, "lowers foe " + st.stat);
                        }
                    } else if (/^RAISE_TEAM_/.test(name)) {
                        var ts = { RAISE_TEAM_ATTACK: "atk", RAISE_TEAM_DEFENSE: "def", RAISE_TEAM_SPEED: "spe", RAISE_TEAM_SP_ATK: "spa", RAISE_TEAM_SP_DEF: "spd" }[name];
                        if (ts) adj(H.statUp(ctx, rng, ts, 1), "team " + ts + " +1");
                    } else if (/^LOWER_.*_SIDE$/.test(name)) {
                        var ls = { LOWER_ATTACK_SIDE: "atk", LOWER_DEFENSE_SIDE: "def", LOWER_SPEED_SIDE: "spe", LOWER_SP_ATK_SIDE: "spa", LOWER_SP_DEF_SIDE: "spd" }[name];
                        if (ls && H.canLowerStat(ctx, m, ls)) adj(H.statDownScore(ctx, ls), "lowers foe " + ls);
                    }
            }
        });
    }

    // ------------------------------------------------------------------
    // Stat drops (AI_TryTo2HKO and AI_HPAware are no longer trainer flags)

    // Null: a stat that's already lowered is less worth lowering again (-2, 80%). Speed and accuracy have their own limits.
    function repeatStatDropPenalty(ctx, rng, s) {
        if (s !== "spe" && s !== "acc" && (ctx.pl.boosts[s] || 0) < 0 && rng.pct(80, "stat already lowered")) return SC.BAD;
        return 0;
    }
    // Run & Bun default for a stat-lowering status move: +6 when the drop would do something
    function statDownStatusMove(ctx, rng, s, adj, label) {
        if (H.statDownScore(ctx, s) === 0) return;
        adj(SC.BASE_STATUS, label);
        adj(repeatStatDropPenalty(ctx, rng, s), "stat already lowered");
        if (s === "acc") {
            if (stage(ctx.pl, "acc") <= 4 && rng.pct(80, "accuracy already -2")) adj(-2, "accuracy already -2");
            var hpPct = ctx.ai.hpPct;
            if (hpPct > 90) { if (rng.pct(80, "accuracy drop: healthy")) adj(2, "misses pay off at high HP"); }
            else if (hpPct > 60) { if (rng.pct(80, "accuracy drop: fairly healthy")) adj(1, "misses pay off above 60% HP"); }
            else adj(-1, "accuracy drop at low HP");
        }
    }
    // The Speed, Attack or Sp. Atk drop an attack always lands on the target, or null
    function guaranteedStatDropFromAttack(ctx, m) {
        var ai = ctx.ai, pl = ctx.pl, found = null;
        if (H.sheerForceAffected(ai, m)) return null;
        if ((pl.ability === "Shield Dust" && !H.ignoresAbility(ai, m)) || hold(pl) === "COVERT_CLOAK") return null;
        H.guaranteedEffects(ai, m).forEach(function (f) {
            if (found || f[2]) return;
            var st = H.parseStatFx(f[0]);
            if (st && st.dir < 0 && (st.stat === "spe" || st.stat === "atk" || st.stat === "spa")) found = st.stat;
        });
        return found;
    }
    // Run & Bun: a weaker attack whose Speed/Attack/Sp. Atk drop always lands gets +6 (+5 if the drop won't help)
    function guaranteedStatDropAttackScore(ctx, rng, m, s) {
        var pl = ctx.pl, score = SC.DEFAULT_STATUS;
        var dropLands = H.canLowerStat(ctx, m, s) && !has(["Contrary", "Defiant", "Competitive", "Mirror Armor"], pl.ability);
        if (s === "spe" && dropLands && !ctx.field.trickRoom && H.aiIsSlower(ctx, m, null, false)) score = SC.BASE_STATUS;
        else if (s === "atk" && dropLands && H.hasMoveWithCategory(pl, "Physical")) score = SC.BASE_STATUS;
        else if (s === "spa" && dropLands && H.hasMoveWithCategory(pl, "Special")) score = SC.BASE_STATUS;
        return score + repeatStatDropPenalty(ctx, rng, s);
    }

    // ------------------------------------------------------------------
    // AI_CompareDamagingMoves (Run & Bun / Null): the attack(s) with the highest damage roll this
    // turn get +6 (75%) or +8, rolled per attack. Every attack that KOs counts as highest; charge
    // moves and self-sacrifice moves the AI decided against are left out. No accuracy or effect
    // tie-breaks, except that a recoil move which would KO the user loses a highest-damage tie to
    // any other attack (upstream #10258). Weaker attacks with a guaranteed Speed/Attack/Sp. Atk
    // drop are scored here.
    function compareDamagingMoves(ctx, rng, scores, adjFor) {
        var ai = ctx.ai, pl = ctx.pl;
        var moves = ai.moves;
        function shouldCompare(i) {
            var m = moves[i];
            if (!m.present || power(m.np || m) === 0) return false;
            if (H.hitsToKOBattler(ai, pl, m, false) === 0) return false;
            if (has(["Relic Song", "Rollout", "Ice Ball", "Future Sight", "Doom Desire", "Meteor Beam"], m.name)) return false;
            return true;
        }
        var rolled = [0, 0, 0, 0], candidate = [false, false, false, false], recoilKO = [false, false, false, false], best = 0;
        for (var i = 0; i < 4; i++) {
            var m = moves[i];
            if (!shouldCompare(i)) continue;
            if (H.isSelfSacrifice(m) && !H.shouldConsiderSelfSacrifice(ctx, m, H.aiIsFaster(ctx, m, null, true))) continue;
            if (isTwoTurnNotSemiInvulnerable(ctx, m)) continue;
            candidate[i] = true;
            recoilKO[i] = H.doesBattlerKOItselfWithRecoil(ctx, m);
            rolled[i] = H.canIndexMoveFaintTarget(ctx, m) ? Infinity : H.dmgOf(m);
            if (rolled[i] > best) best = rolled[i];
        }
        var safeBest = false;
        for (var k = 0; k < 4; k++) if (candidate[k] && rolled[k] === best && !recoilKO[k]) safeBest = true;
        if (safeBest) {
            for (var k2 = 0; k2 < 4; k2++) {
                if (candidate[k2] && recoilKO[k2]) { candidate[k2] = false; adjFor(k2, 0, "recoil would KO the user, loses the highest-damage tie"); }
            }
        }
        for (var j = 0; j < 4; j++) {
            if (candidate[j] && rolled[j] === best) {
                var low = rng.pct(75, "highest-damage bonus");
                var why = rolled[j] === Infinity ? "KOs, counts as highest damage" : "highest damage roll (" + rolled[j] + ")";
                adjFor(j, low ? SC.BEST_DAMAGE_BONUS : SC.BEST_DAMAGE_BONUS_HIGH, why + (low ? " (+6, 75%)" : " (+8, 25%)"));
            } else if (shouldCompare(j)) {
                var dropped = guaranteedStatDropFromAttack(ctx, moves[j]);
                if (dropped) adjFor(j, guaranteedStatDropAttackScore(ctx, rng, moves[j], dropped), "weaker attack with a guaranteed " + dropped + " drop");
            }
        }
    }

    // ------------------------------------------------------------------
    // One deterministic scoring run given an rng
    function scoreOnce(ctx, rng) {
        var ai = ctx.ai;
        var scores = [], traces = [[], [], [], []];
        // SetupRandomRollsForAIMoveSelection rolls these every turn; only branch when a move can read them.
        var hasBoom = movesOf(ai).some(H.isExplosion), hasGambit = H.hasMoveEffect(ai, "FINAL_GAMBIT");
        ctx.roll = {
            explosion: hasBoom ? rng.pct(H.explosionChanceFromHP(ai.hpPct), "explosion HP chance") : false,
            finalGambit: hasGambit ? rng.pct(CFG.FINAL_GAMBIT_CHANCE, "Final Gambit chance") : false
        };
        for (var i = 0; i < 4; i++) scores[i] = ai.moves[i].present ? SC.DEFAULT : 0;
        var fns = [["bad", checkBadMove], ["faint", tryToFaint], ["viability", checkViability]];
        fns.forEach(function (pair) {
            var tag = pair[0], fn = pair[1];
            for (var i = 0; i < 4; i++) {
                var m = ai.moves[i];
                if (!m.present || scores[i] <= 0) { scores[i] = 0; continue; }
                var s = scores[i];
                var adj = function (v, label) { if (!v) return; s += v; traces[i].push({ fn: tag, delta: v, label: label }); };
                var r = fn(ctx, rng, m, s, adj);
                if (r === "ZERO") s = 0;
                if (tag === "bad" && s < 0) s = 0;
                scores[i] = s;
            }
        });
        compareDamagingMoves(ctx, rng, scores, function (i, v, label) { scores[i] += v; traces[i].push({ fn: "compare", delta: v, label: label }); });
        return { scores: scores, traces: traces };
    }

    // ------------------------------------------------------------------
    // Outcome enumeration
    function makeRng(prefix) {
        var path = [], idx = 0;
        return {
            path: path,
            pct: function (p, label) {
                var v;
                if (p >= 100) return true;
                if (p <= 0) return false;
                if (idx < prefix.length) v = prefix[idx].v; else v = true;
                path.push({ p: p, v: v, label: label });
                idx++;
                return v;
            },
            uniform100: function (label) {
                // three-way split used by the berry-cure rolls: <40, <60, else
                if (this.pct(40, label + " (<40)")) return 0;
                if (this.pct(Math.round(100 * 20 / 60), label + " (<60)")) return 50;
                return 99;
            }
        };
    }
    function enumeratePaths(run, maxPaths) {
        var results = [], stack = [[]], count = 0;
        while (stack.length) {
            var prefix = stack.pop();
            var rng = makeRng(prefix);
            var out = run(rng);
            var path = rng.path, prob = 1;
            for (var k = 0; k < path.length; k++) prob *= path[k].v ? path[k].p / 100 : 1 - path[k].p / 100;
            results.push({ out: out, prob: prob, path: path });
            for (var i = path.length - 1; i >= prefix.length; i--) {
                if (path[i].v) stack.push(path.slice(0, i).concat([{ p: path[i].p, v: false }]));
            }
            if (++count > maxPaths) return null;
        }
        return results;
    }
    function monteCarlo(run, n) {
        var results = [];
        for (var i = 0; i < n; i++) {
            var path = [];
            var rng = {
                path: path,
                pct: function (p, label) { var v = Math.random() * 100 < p; path.push({ p: p, v: v, label: label }); return v; },
                uniform100: function (label) { var r = Math.random() * 100; path.push({ p: 100, v: true, label: label }); return r; }
            };
            results.push({ out: run(rng), prob: 1 / n, path: path });
        }
        return results;
    }

    // The AI's damage roll: AI_CalcDamage draws one of 16 rolls for each of its attacks every turn.
    // Walking all 16^4 combinations through enumeratePaths would be far too slow, so combinations
    // are grouped by everything the scorer reads from AI damage: hits to KO per attack, the
    // order of the attacks' damage, and the exact amount for drain moves (heal size). Each group
    // is scored once with a representative roll and weighted by how many combinations it covers.
    function damageRollOutcomes(ctx) {
        var moves = ctx.ai.moves, hp = ctx.pl.hp, count = moves.length;
        // Per attack: its distinct rolls (v = null means no roll, damage stays fixed), with weights
        var lists = moves.map(function (m) {
            var rolls = m.present && m.sim && m.sim.rolls;
            var fixed = H.dmgOf(m);
            if (!rolls || rolls.length < 2) return [{ v: null, d: fixed, w: 1, tag: H.hitsToKO(fixed, hp) + (H.recoilKOsSelfAt(ctx, m, fixed) ? "r" : "") + "," }];
            var counts = {};
            rolls.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
            var drain = eff(m) === "ABSORB" || eff(m) === "DREAM_EATER";
            return Object.keys(counts).map(function (k) {
                var v = +k;
                return { v: v, d: v, w: counts[k] / rolls.length, tag: H.hitsToKO(v, hp) + (drain ? ":" + v : "") + (H.recoilKOsSelfAt(ctx, m, v) ? "r" : "") + "," };
            });
        });
        var groups = {}, order = [], pick = [];
        for (var i = 0; i < count; i++) pick.push(0);
        for (;;) {
            var key = "", weight = 1;
            for (var a = 0; a < count; a++) {
                var oa = lists[a][pick[a]];
                key += oa.tag;
                weight *= oa.w;
                for (var b = a + 1; b < count; b++) {
                    var db = lists[b][pick[b]].d;
                    key += oa.d > db ? ">" : oa.d < db ? "<" : "=";
                }
            }
            var group = groups[key];
            if (!group) {
                group = groups[key] = { values: pick.map(function (p, k) { return lists[k][p].v; }), prob: 0 };
                order.push(group);
            }
            group.prob += weight;
            // next combination
            var pos = 0;
            while (pos < count && ++pick[pos] === lists[pos].length) pick[pos++] = 0;
            if (pos === count) break;
        }
        return order;
    }
    function applyDamageRolls(ctx, values) {
        ctx.ai.moves.forEach(function (m, i) { if (m.sim) m.sim.roll = values ? values[i] : null; });
    }

    function evaluate(model) {
        var ctx = model;
        var run = function (rng) { return scoreOnce(ctx, rng); };
        var MAX_PATHS = 20000;
        applyDamageRolls(ctx, null);
        var rollGroups = damageRollOutcomes(ctx);
        var results = [], approx = false;
        try {
            for (var g = 0; g < rollGroups.length && results; g++) {
                applyDamageRolls(ctx, rollGroups[g].values);
                var part = enumeratePaths(run, MAX_PATHS - results.length);
                if (!part) { results = null; break; }
                part.forEach(function (r) { r.prob *= rollGroups[g].prob; results.push(r); });
            }
            if (!results) {
                // Sample the damage rolls along with every other roll
                approx = true;
                results = [];
                var SAMPLES = 4000;
                for (var n = 0; n < SAMPLES; n++) {
                    applyDamageRolls(ctx, ctx.ai.moves.map(function (m) {
                        var rolls = m.present && m.sim && m.sim.rolls;
                        return rolls && rolls.length ? rolls[Math.floor(Math.random() * rolls.length)] : null;
                    }));
                    monteCarlo(run, 1).forEach(function (r) { r.prob = 1 / SAMPLES; results.push(r); });
                }
            }
        } finally {
            applyDamageRolls(ctx, null);
        }
        var chance = [0, 0, 0, 0];
        var byMove = [{}, {}, {}, {}], bestTrace = [null, null, null, null], bestTraceProb = [0, 0, 0, 0];
        results.forEach(function (r) {
            var s = r.out.scores, max = -Infinity, winners = [];
            for (var i = 0; i < 4; i++) {
                if (i > 0 && !ctx.ai.moves[i].present) continue;
                if (s[i] > max) { max = s[i]; winners = [i]; }
                else if (s[i] === max) winners.push(i);
            }
            winners.forEach(function (w) { chance[w] += r.prob / winners.length; });
            for (var j = 0; j < 4; j++) {
                byMove[j][s[j]] = (byMove[j][s[j]] || 0) + r.prob;
                if (r.prob > bestTraceProb[j]) { bestTraceProb[j] = r.prob; bestTrace[j] = { score: s[j], trace: r.out.traces[j] }; }
            }
        });
        var moves = ctx.ai.moves.map(function (m, i) {
            var dist = Object.keys(byMove[i]).map(function (k) { return { score: +k, prob: byMove[i][k] }; }).sort(function (a, b) { return b.score - a.score; });
            return { name: m.name, present: m.present, chance: chance[i], scores: dist, trace: bestTrace[i] };
        });
        return { moves: moves, paths: results.length, approximate: approx };
    }

    root.KudzuAI = { evaluate: evaluate, scoreOnce: scoreOnce, enumeratePaths: enumeratePaths };
})(typeof window !== "undefined" ? window : this);
