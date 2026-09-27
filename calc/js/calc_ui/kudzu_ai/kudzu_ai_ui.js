/* Kudzu AI move-choice preview: UI glue.
 *
 * Builds the battler model from the calculator's current state (damageResults,
 * createField, the Pokémon 2 = AI side), runs KudzuAI.evaluate, and renders:
 *   - a percentage beside each of the AI's four moves (.kz-ai-rate)
 *   - an "AI options" panel for the battle state the calc UI cannot express
 *     (first turn out, last mons, Trick Room, the player's last move, ...)
 *   - an optional scoring breakdown under the main result
 * Only active when TITLE is "Kudzu" and backup_data.ai exists.
 */
(function (root) {
    "use strict";
    var STORAGE_KEY = "kudzuAiOptions";
    var H = null;
    var state = { options: null, lastResult: null, detailOpen: false };

    // GetNaturePowerMove: terrain first, otherwise the battle background (src/data/battle_environment.h)
    var NATURE_POWER_ENV = [
        ["Tri Attack", "Tri Attack (building, plain, gym)"], ["Energy Ball", "Energy Ball (grass)"], ["Earth Power", "Earth Power (sand, mountain)"],
        ["Hydro Pump", "Hydro Pump (water)"], ["Power Gem", "Power Gem (cave)"], ["Ice Beam", "Ice Beam (snow, ice)"],
        ["Mud Bomb", "Mud Bomb (marsh, puddle)"], ["Shadow Ball", "Shadow Ball (burial ground)"], ["Lava Plume", "Lava Plume (volcano)"]
    ];
    var NATURE_POWER_TERRAIN = { Misty: "Moonblast", Electric: "Thunderbolt", Grassy: "Energy Ball", Psychic: "Psychic" };
    function naturePowerMoveName(field, o) {
        if (NATURE_POWER_TERRAIN[field.terrain]) return NATURE_POWER_TERRAIN[field.terrain];
        var env = NATURE_POWER_ENV[o.naturePowerEnv] || NATURE_POWER_ENV[0];
        return env[0];
    }

    var OPTION_DEFS = [
        { key: "enabled", label: "Show AI %", type: "check", def: true, always: true },
        { key: "firstTurn", label: "AI's first turn out", type: "check", def: false, always: true },
        { key: "aiLastMon", label: "AI's last mon", type: "check", def: false, always: true },
        { key: "playerLastMon", label: "Player's last mon", type: "check", def: false, always: true },
        { key: "trickRoom", label: "Trick Room up", type: "check", def: false, always: true },
        { key: "playerLastMove", label: "Player's last move", type: "lastmove", def: -1, always: true },
        { key: "protectStreak", label: "AI protected", type: "select", def: 0, choices: [[0, "not last turn"], [1, "last turn"], [2, "2+ turns"]], when: function (ai) { return hasEffect(ai, "PROTECT") || hasEffect(ai, "ENDURE"); } },
        { key: "playerConfused", label: "Player confused / infatuated", type: "check", def: false, when: function (ai) { return ai.moves.some(function (m) { return m.present && (m.d && (m.d.cat === "Status" || (m.d.fx || []).some(function (f) { return f[0] === "FLINCH"; }))); }); } },
        { key: "playerSub", label: "Player behind Substitute", type: "check", def: false, when: function (ai) { return ai.moves.some(function (m) { return m.present && m.d && m.d.cat === "Status"; }); } },
        { key: "playerTaunted", label: "Player taunted", type: "check", def: false, when: function (ai) { return hasEffect(ai, "TAUNT"); } },
        { key: "playerEncored", label: "Player encored", type: "check", def: false, when: function (ai) { return hasEffect(ai, "ENCORE"); } },
        { key: "playerTrapped", label: "Player trapped", type: "check", def: false, when: function (ai) { return ai.moves.some(function (m) { return m.present && (H.isTrappingMove(m) || hasEffectNamed(m, "PERISH_SONG") || hasEffectNamed(m, "LEECH_SEED")); }); } },
        { key: "tspikes", label: "Toxic Spikes on player", type: "select", def: 0, choices: [[0, "0"], [1, "1"], [2, "2"]], when: function (ai) { return hasEffect(ai, "TOXIC_SPIKES"); } },
        { key: "stickyWeb", label: "Sticky Web on player", type: "check", def: false, when: function (ai) { return hasEffect(ai, "STICKY_WEB"); } },
        { key: "aiMagnetRise", label: "AI Magnet Risen", type: "check", def: false, when: function (ai) { return hasEffect(ai, "MAGNET_RISE"); } },
        { key: "aiFocusEnergy", label: "AI Focus Energy up", type: "check", def: false, when: function (ai) { return hasEffect(ai, "FOCUS_ENERGY"); } },
        { key: "aiGoodSwitchin", label: "AI has a good switch-in", type: "check", def: false, when: function (ai) { return ["HIT_ESCAPE", "PARTING_SHOT", "TELEPORT", "WEATHER_AND_SWITCH", "SHED_TAIL", "BATON_PASS"].some(function (e) { return hasEffect(ai, e); }); } },
        { key: "aiHasFainted", label: "AI has a fainted teammate", type: "check", def: false, when: function (ai) { return hasEffect(ai, "REVIVAL_BLESSING"); } },
        { key: "naturePowerEnv", label: "Nature Power becomes (no terrain)", type: "select", def: 0,
          choices: NATURE_POWER_ENV.map(function (c, i) { return [i, c[1]]; }), when: function (ai) { return hasEffect(ai, "NATURE_POWER"); } }
    ];
    function hasEffect(ai, e) { return ai.moves.some(function (m) { return m.present && m.d && m.d.e === e; }); }
    function hasEffectNamed(m, e) { return !!(m.d && m.d.e === e); }

    // ------------------------------------------------------------------
    function isKudzu() { return typeof TITLE !== "undefined" && TITLE === "Kudzu" && typeof backup_data !== "undefined" && backup_data && backup_data.ai; }
    function loadOptions() {
        var o = {};
        OPTION_DEFS.forEach(function (d) { o[d.key] = d.def; });
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) { var saved = JSON.parse(raw); OPTION_DEFS.forEach(function (d) { if (saved.hasOwnProperty(d.key)) o[d.key] = saved[d.key]; }); }
        } catch (e) { /* ignore */ }
        o.playerLastMove = -1; // never persist: it is per matchup
        return o;
    }
    function saveOptions() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.options)); } catch (e) { /* ignore */ } }
    function opts() { if (!state.options) state.options = loadOptions(); return state.options; }

    // ------------------------------------------------------------------
    // Model building
    // min/med/max plus every roll: the AI's own attacks use one random roll per turn (AI_CalcDamage)
    function rollsOf(damage) {
        if (typeof damage === "number") return { min: damage, med: damage, max: damage, rolls: [damage] };
        if (!damage || !damage.length) return { min: 0, med: 0, max: 0, rolls: [] };
        if (typeof damage[0] === "number") {
            var arr = damage.slice().sort(function (a, b) { return a - b; });
            var n = arr.length;
            return { min: arr[0], med: arr[Math.min(n - 1, 8)], max: arr[n - 1], rolls: arr };
        }
        var sum = null;
        damage.forEach(function (d) {
            if (!d || !d.length) return;
            var s = d.slice().sort(function (a, b) { return a - b; });
            if (!sum) sum = s.slice(); else for (var i = 0; i < sum.length; i++) sum[i] += s[Math.min(i, s.length - 1)];
        });
        return rollsOf(sum || [0]);
    }
    function aiMoveData(name) {
        if (!name || name === "(No Move)") return null;
        var t = backup_data.ai.moves;
        return t[name] || null;
    }
    function itemData(name) { return name && backup_data.ai.items ? backup_data.ai.items[name] || null : null; }

    // ShouldCalcCritDamage: the ROM's AI damage calc assumes a critical hit when one is guaranteed - always-crit
    // moves, Merciless on a poisoned foe, or a crit stage of 3+ under the Gen 6+ table (upstream #10700).
    // Battle Armor / Shell Armor block it unless the attacker breaks the mold.
    function aiCalcsCrit(atkB, defB, d) {
        if (!d || d.pow === 0) return false;
        var breaksMold = ["Mold Breaker", "Teravolt", "Turboblaze"].indexOf(atkB.ability) !== -1;
        if (["Battle Armor", "Shell Armor"].indexOf(defB.ability) !== -1 && !breaksMold) return false;
        if ((d.f || []).indexOf("alwaysCriticalHit") !== -1) return true;
        if (atkB.ability === "Merciless" && (defB.status === "psn" || defB.status === "tox")) return true;
        var hold = atkB.itemEnabled ? atkB.hold : "NONE", name = atkB.name || "";
        var holdStage = hold === "SCOPE_LENS" ? 1 : (hold === "LUCKY_PUNCH" && /^Chansey/.test(name)) || (hold === "LEEK" && /^(Farfetch|Sirfetch)/.test(name)) ? 2 : 0;
        var stage = ((atkB.vol && atkB.vol.focusEnergy) ? 2 : 0) + (d.crit || 0) + (atkB.ability === "Super Luck" ? 1 : 0) + holdStage;
        return stage >= 3;
    }

    function simulate(attackerRes, moveName, present, d, atkB, defB, field, extraOpts, moveOverride) {
        // Recalculate with a single hit (crit only where the ROM's AI assumes one), then apply the ROM's multi-hit rules.
        var sim = { min: 0, med: 0, max: 0, rolls: [] };
        if (!present || !attackerRes) return sim;
        var mv = moveOverride ? moveOverride : attackerRes.move.clone();
        mv.isCrit = aiCalcsCrit(atkB, defB, d);
        var isTripleKick = d && d.e === "TRIPLE_KICK";
        mv.hits = isTripleKick ? 3 : 1;
        var r;
        try { r = calc.calculate(settings.damageGen, attackerRes.attacker, attackerRes.defender, mv, attackerRes.field); }
        catch (e) { return sim; }
        sim = rollsOf(r.damage);
        if (!d || d.pow === 0) return sim;
        var sc = d.sc || 1;
        function scaleRolls(f) { sim.rolls = sim.rolls.map(f); }
        if (sc > 1 && !isTripleKick) { sim.min *= sc; sim.med *= sc; sim.max *= sc; scaleRolls(function (v) { return v * sc; }); }
        else if (d.mh) {
            if (atkB.ability === "Skill Link") { sim.min *= 5; sim.med *= 5; sim.max *= 5; scaleRolls(function (v) { return v * 5; }); }
            else if (atkB.hold === "LOADED_DICE") { sim.med = Math.floor(sim.med * 9 / 2); sim.min *= 4; sim.max *= 5; scaleRolls(function (v) { return Math.floor(v * 9 / 2); }); }
            else { sim.med *= 3; sim.min *= 2; sim.max *= 5; scaleRolls(function (v) { return v * 3; }); }
        } else if (atkB.ability === "Parental Bond" && sc === 1 && typeof r.damage[0] === "number") {
            sim.min += Math.floor(sim.min / 4); sim.med += Math.floor(sim.med / 4); sim.max += Math.floor(sim.max / 4);
            scaleRolls(function (v) { return v + Math.floor(v / 4); });
        }
        // IsDamageMoveUnusable
        var unusable = false;
        if (d.e === "FIRST_TURN_ONLY" && !extraOpts.firstTurn) unusable = true;
        if (d.e === "DREAM_EATER" && !(defB.status === "slp" || defB.ability === "Comatose")) unusable = true;
        if (d.e === "STEEL_ROLLER" && !field.terrain) unusable = true;
        if (d.e === "POLTERGEIST" && !defB.item) unusable = true;
        if (d.e === "BELCH" && !atkB.holdIsBerry) unusable = true;
        if ((d.f || []).indexOf("dampBanned") !== -1 && (defB.ability === "Damp" || atkB.ability === "Damp") && !(atkB.ability === "Mold Breaker")) unusable = true;
        if (field.weather === "Harsh Sunshine" && d.type === "Water") unusable = true;
        if (field.weather === "Heavy Rain" && d.type === "Fire") unusable = true;
        if (unusable) return { min: 0, med: 0, max: 0, rolls: [] };
        if (sim.max > 0) {
            sim.min = Math.max(1, sim.min); sim.med = Math.max(1, sim.med); sim.max = Math.max(1, sim.max);
            scaleRolls(function (v) { return Math.max(1, v); });
        }
        return sim;
    }

    function buildBattler(mon, speed, side, isAi, o, field) {
        var it = itemData(mon.item);
        var itemEnabled = !!mon.item && !field.magicRoom && mon.ability !== "Klutz";
        var b = {
            isAi: isAi, mon: mon, name: mon.name,
            hp: mon.curHP(), maxHp: mon.maxHP(), level: mon.level,
            types: (mon.types || []).filter(function (t) { return t && t !== "???"; }),
            ability: mon.ability || "", item: mon.item || "",
            hold: it ? it.he : "NONE", holdParam: it ? it.p : 0, holdIsBerry: !!(it && it.berry), itemEnabled: itemEnabled,
            status: mon.status || "", toxicCounter: mon.toxicCounter || 0,
            boosts: mon.boosts || {}, gender: mon.gender || "N", speed: speed,
            side: side, vol: {}, moves: []
        };
        b.hpPct = Math.floor(100 * b.hp / b.maxHp);
        if (isAi) {
            b.vol = { magnetRise: !!o.aiMagnetRise, focusEnergy: !!o.aiFocusEnergy };
        } else {
            b.vol = { confused: !!o.playerConfused, infatuated: !!o.playerConfused, substitute: !!o.playerSub, taunted: !!o.playerTaunted, encored: !!o.playerEncored, trapped: !!o.playerTrapped };
        }
        return b;
    }

    // `results` defaults to the matchup on screen; the switch-in predictor passes the bench's, with the
    // options a Pokémon that has just come in would have (its first turn, no volatiles of its own).
    function buildModel(results, optOverride) {
        var dr = results || damageResults;
        if (!dr || !dr[0] || !dr[1] || !dr[1][0]) return null;
        var o = optOverride || opts();
        var aiRes = dr[1], plRes = dr[0];
        var aiMon = aiRes[0].attacker, plMon = plRes[0].attacker;
        var f = aiRes[0].field;
        var eitherNeutralizesWeather = ["Cloud Nine", "Air Lock"].indexOf(aiMon.ability) !== -1 || ["Cloud Nine", "Air Lock"].indexOf(plMon.ability) !== -1;
        var field = {
            weather: f.weather || "", weatherEffect: !eitherNeutralizesWeather, terrain: f.terrain || "",
            gravity: !!f.isGravity, magicRoom: !!f.isMagicRoom, wonderRoom: !!f.isWonderRoom, inverse: !!f.isInverse,
            trickRoom: !!o.trickRoom
        };
        function sideOf(s, extra) {
            return {
                isReflect: !!s.isReflect, isLightScreen: !!s.isLightScreen, isAuroraVeil: !!s.isAuroraVeil, isTailwind: !!s.isTailwind,
                isSeeded: !!s.isSeeded, isSR: !!s.isSR, spikes: s.spikes || 0, steelsurge: !!s.steelsurge, isForesight: !!s.isForesight,
                isProtected: !!s.isProtected, tspikes: extra.tspikes || 0, stickyWeb: !!extra.stickyWeb, isSafeguard: false, isMist: false
            };
        }
        var aiSide = sideOf(f.attackerSide, {}), plSide = sideOf(f.defenderSide, { tspikes: o.tspikes, stickyWeb: o.stickyWeb });
        var ai = buildBattler(aiMon, aiMon.stats.spe, aiSide, true, o, field);
        var pl = buildBattler(plMon, plMon.stats.spe, plSide, false, o, field);
        var ctx = { ai: ai, pl: pl, field: field, opts: o, playerLastMove: null, roll: {}, abilities: backup_data.ai.abilities || null };

        function slot(res, atkB, defB, i) {
            var name = res && res.move ? (res.move.originalName || res.move.name) : "(No Move)";
            var present = !!(res && res.move) && name !== "(No Move)" && !!aiMoveData(name);
            var d = present ? aiMoveData(name) : null;
            var m = { name: name, d: d, present: present, calc: res ? res.move : null, sim: { min: 0, med: 0, max: 0 }, eff: 1, effv: 1, accv: 101, blocked: false, index: i };
            if (!present) return m;
            if (d.e === "NATURE_POWER") {
                // The ROM simulates Nature Power as the move it calls (AI_CalcDamage), so score that move's damage
                var npName = naturePowerMoveName(field, o), npD = aiMoveData(npName), npCalc = null;
                try { npCalc = npD ? new calc.Move(settings.damageGen, npName, { ability: res.attacker.ability, item: res.attacker.item, species: res.attacker.name }) : null; }
                catch (e) { npCalc = null; }
                if (npCalc) {
                    var np = { name: npName, d: npD, present: true, calc: npCalc, sim: { min: 0, med: 0, max: 0 }, eff: 1, effv: 1, accv: 101, blocked: false, index: i };
                    np.sim = simulate(res, npName, true, npD, atkB, defB, field, o, npCalc);
                    np.effv = np.eff = H.typeEffectiveness(np, atkB, defB, field);
                    if (np.sim.max === 0 && np.effv !== 0) np.blocked = true;
                    if (np.effv === 0) np.sim = { min: 0, med: 0, max: 0 };
                    m.np = np; m.sim = np.sim; m.effv = m.eff = np.effv;
                    return m;
                }
            }
            m.sim = simulate(res, name, present, d, atkB, defB, field, o);
            m.effv = H.typeEffectiveness(m, atkB, defB, field);
            if (d.pow !== 0) {
                m.eff = m.effv;
                if (m.sim.max === 0 && m.effv !== 0) m.blocked = true; // damage-less through an ability: Levitate, Volt Absorb, ...
                if (m.effv === 0) m.sim = { min: 0, med: 0, max: 0 };
            }
            return m;
        }
        for (var i = 0; i < 4; i++) {
            ai.moves.push(slot(aiRes[i], ai, pl, i));
            pl.moves.push(slot(plRes[i], pl, ai, i));
        }
        ai.moves.forEach(function (m) { m.accv = H.moveAccuracy(ai, pl, m, field); if (m.np) m.np.accv = H.moveAccuracy(ai, pl, m.np, field); });
        pl.moves.forEach(function (m) { m.accv = H.moveAccuracy(pl, ai, m, field); m.effOnAi = m.effv; if (m.np) m.np.accv = H.moveAccuracy(pl, ai, m.np, field); });
        if (o.playerLastMove >= 0 && pl.moves[o.playerLastMove] && pl.moves[o.playerLastMove].present) ctx.playerLastMove = pl.moves[o.playerLastMove];
        return ctx;
    }

    // ------------------------------------------------------------------
    // DOM
    function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function fmtPct(p) { var v = Math.round(p * 1000) / 10; return (v === 100 || v === 0 ? v.toFixed(0) : v.toFixed(1)) + "%"; }

    function ensureDom() {
        var rows = $(".move-result-subgroup.results-right > div").not(".result-move-header");
        rows.each(function (i) {
            if (!$(this).find(".kz-ai-rate").length) $(this).append('<span class="kz-ai-rate" id="kzAiRateR' + (i + 1) + '" title=""></span>');
        });
        if (!$("#kz-ai-panel").length) {
            var panel = $('<div id="kz-ai-panel" class="kz-ai-panel" role="group" title="" aria-label="AI move chance options">'
                + '<div class="kz-ai-head"><span class="kz-ai-title">AI move chance</span><span class="kz-ai-note"></span>'
                + '<button type="button" class="kz-ai-detail-btn" id="kz-ai-detail-btn">Scoring</button></div>'
                + '<div class="kz-ai-opts"></div></div>');
            $(".move-result-group").append(panel);
            panel.on("change", "input, select", function (ev) {
                ev.stopPropagation();
                var key = $(this).data("key");
                var d = OPTION_DEFS.filter(function (x) { return x.key === key; })[0];
                if (!d) return;
                var o = opts();
                if (d.type === "check") o[key] = $(this).is(":checked");
                else o[key] = parseInt($(this).val(), 10);
                saveOptions();
                refresh();
            });
            $("#kz-ai-detail-btn").on("click", function () { state.detailOpen = !state.detailOpen; renderDetail(); });
        }
        if (!$("#kz-ai-detail").length) $(".main-result-group").after('<div id="kz-ai-detail" class="kz-ai-detail" hidden></div>');
        placePanel();
    }
    function placePanel() {
        var panel = $("#kz-ai-panel");
        if (!panel.length) return;
        var mobile = window.innerWidth <= 960;
        var group = $(".move-result-group");
        if (mobile) {
            if (panel.parent()[0] !== group.parent()[0]) group.after(panel);
            panel.addClass("kz-ai-panel-static").css({ left: "", right: "" });
            return;
        }
        if (panel.parent()[0] !== group[0]) group.append(panel);
        panel.removeClass("kz-ai-panel-static");
        // Fit between the two floated move columns: measure their content edges.
        // Client rects come back SCALED by CSS zoom (Chromium 128+), while the left/right written below
        // are unzoomed px that the zoom multiplies again. The tracker fits this page with body zoom, so
        // without the division the panel sat inside both move columns at any zoom under 100%.
        var z = group[0].currentCSSZoom || 1;
        var groupRect = group[0].getBoundingClientRect();
        var groupWidth = groupRect.width / z;
        var leftEdge = 0, rightEdge = groupWidth;
        group.find(".move-result-subgroup").not(".results-right").find("label, span").each(function () {
            var r = this.getBoundingClientRect(); if (r.width) leftEdge = Math.max(leftEdge, (r.right - groupRect.left) / z);
        });
        group.find(".results-right").find("label, span").not(".kz-ai-rate").each(function () {
            var r = this.getBoundingClientRect(); if (r.width) rightEdge = Math.min(rightEdge, (r.left - groupRect.left) / z);
        });
        var gap = 14;
        var width = rightEdge - leftEdge - gap * 2;
        if (width < 260) {
            // No room between the columns: sit under them instead of over them.
            group.after(panel);
            panel.addClass("kz-ai-panel-static").css({ left: "", right: "", width: "" });
            return;
        }
        panel.css({ left: (leftEdge + gap) + "px", right: (groupWidth - rightEdge + gap) + "px", width: "auto" });
    }
    function renderOptions(ctx) {
        var o = opts(), box = $("#kz-ai-panel .kz-ai-opts"), html = "";
        OPTION_DEFS.forEach(function (d) {
            var show = d.always || (ctx && d.when && d.when(ctx.ai));
            if (!show) return;
            if (!o.enabled && d.key !== "enabled") return;
            var id = "kzopt-" + d.key;
            if (d.type === "check") {
                html += '<label class="kz-ai-opt" for="' + id + '"><input type="checkbox" id="' + id + '" data-key="' + d.key + '"' + (o[d.key] ? " checked" : "") + '> ' + esc(d.label) + '</label>';
            } else if (d.type === "select") {
                html += '<label class="kz-ai-opt" for="' + id + '">' + esc(d.label) + ' <select id="' + id + '" data-key="' + d.key + '">';
                d.choices.forEach(function (c) { html += '<option value="' + c[0] + '"' + (o[d.key] === c[0] ? " selected" : "") + '>' + esc(c[1]) + '</option>'; });
                html += '</select></label>';
            } else if (d.type === "lastmove" && ctx) {
                html += '<label class="kz-ai-opt" for="' + id + '">' + esc(d.label) + ' <select id="' + id + '" data-key="' + d.key + '"><option value="-1"' + (o[d.key] < 0 ? " selected" : "") + '>none / switched in</option>';
                ctx.pl.moves.forEach(function (m, i) { if (m.present) html += '<option value="' + i + '"' + (o[d.key] === i ? " selected" : "") + '>' + esc(m.name) + '</option>'; });
                html += '</select></label>';
            }
        });
        box.html(html);
    }
    function renderRates(result) {
        for (var i = 0; i < 4; i++) {
            var el = $("#kzAiRateR" + (i + 1));
            if (!result || !result.moves[i] || !result.moves[i].present) { el.text("").attr("title", ""); continue; }
            var mv = result.moves[i];
            el.text(fmtPct(mv.chance));
            el.attr("title", "Score " + mv.scores.map(function (s) { return s.score + " (" + fmtPct(s.prob) + ")"; }).join(", "));
            el.toggleClass("kz-ai-rate-top", mv.chance >= 0.5);
        }
    }
    function renderDetail() {
        var box = $("#kz-ai-detail"), r = state.lastResult;
        $("#kz-ai-detail-btn").toggleClass("active", state.detailOpen);
        if (!state.detailOpen || !r || !opts().enabled) { box.attr("hidden", true).empty(); return; }
        var html = '<div class="kz-ai-detail-head">AI scoring breakdown <span>(' + (r.approximate ? "sampled" : r.paths + " outcome" + (r.paths === 1 ? "" : "s")) + ')</span></div>';
        r.moves.forEach(function (mv) {
            if (!mv.present) return;
            html += '<div class="kz-ai-detail-move"><div class="kz-ai-detail-title"><b>' + esc(mv.name) + '</b> <span class="kz-ai-detail-chance">' + fmtPct(mv.chance) + '</span> <span class="kz-ai-detail-scores">score ' + mv.scores.map(function (s) { return s.score + " (" + fmtPct(s.prob) + ")"; }).join(" / ") + '</span></div>';
            if (mv.trace && mv.trace.trace.length) {
                html += '<div class="kz-ai-detail-trace">' + mv.trace.trace.map(function (t) {
                    return '<span class="kz-ai-step"><span class="kz-ai-delta ' + (t.delta > 0 ? "pos" : "neg") + '">' + (t.delta > 0 ? "+" : "") + t.delta + '</span>' + esc(t.label) + '</span>';
                }).join("") + '</div>';
            } else html += '<div class="kz-ai-detail-trace kz-ai-muted">no adjustments (base 100)</div>';
            html += '</div>';
        });
        box.html(html).removeAttr("hidden");
    }
    function setNote(text, warn) { $("#kz-ai-panel .kz-ai-note").text(text || "").toggleClass("warn", !!warn); }

    function refresh() {
        if (!H) H = root.KudzuAIEngineCore;
        if (!isKudzu() || !root.KudzuAI || !H) { $("#kz-ai-panel, #kz-ai-detail").hide(); $(".kz-ai-rate").text(""); $(".move-result-group").removeClass("kz-ai-on"); return; }
        ensureDom();
        var o = opts();
        $("#kz-ai-panel").show();
        if (!o.enabled) { renderOptions(null); renderRates(null); state.lastResult = null; renderDetail(); $(".move-result-group").removeClass("kz-ai-on"); setNote(""); if (root.KudzuAISwitch) root.KudzuAISwitch.refresh(); return; }
        $(".move-result-group").addClass("kz-ai-on");
        var ctx, result;
        try {
            ctx = buildModel();
            if (!ctx) { renderOptions(null); renderRates(null); setNote("waiting for a calculation"); return; }
            renderOptions(ctx);
            result = root.KudzuAI.evaluate(ctx);
        } catch (e) {
            console.error("[Kudzu AI]", e);
            renderRates(null); setNote("AI preview error: " + (e && e.message ? e.message : e), true); return;
        }
        state.lastResult = result;
        state.lastModel = ctx;
        renderRates(result);
        placePanel();
        var notes = [];
        if ($("#doubles-format").is(":checked")) notes.push("doubles not modelled, scored as singles");
        if (result.approximate) notes.push("sampled");
        setNote(notes.join(" · "), notes.length > 0);
        renderDetail();
        if (root.KudzuAISwitch) root.KudzuAISwitch.queueRefresh();
    }

    root.KudzuAIUI = { refresh: refresh, options: opts, buildModel: buildModel, model: function () { return state.lastModel; }, result: function () { return state.lastResult; } };
    $(window).on("resize.kudzuAi", function () { if (isKudzu()) placePanel(); });
})(typeof window !== "undefined" ? window : this);
