/* Checks for the switch-in predictor's port of GetBestMonIntegrated.
 *
 *   node js/calc_ui/kudzu_ai/kudzu_ai_switch.test.js
 *
 * Only the decision logic is exercised - the parts that are a line-for-line port of
 * src/battle_ai_switch.c and that a refactor could quietly bend. The damage numbers
 * come from the calculator at run time and are not this module's to get right.
 */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");

var sandbox = { console: console, localStorage: { getItem: function () { return null; }, setItem: function () {} } };
sandbox.window = sandbox;
vm.createContext(sandbox);
// the engine core first: the weather checks below run against its real helpers, not a stub
vm.runInContext(fs.readFileSync(path.join(__dirname, "kudzu_ai_engine.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "kudzu_ai_switch.js"), "utf8"), sandbox);
var S = sandbox.KudzuAISwitch;

var failures = 0;
function check(name, got, want) {
    var ok = JSON.stringify(got) === JSON.stringify(want);
    console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : "  got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
    if (!ok) failures++;
}

console.log("CanSwitchinWin1v1:");
// (hitsToKOAI, hitsToKOPlayer, isSwitchinFirst, isFreeSwitch)
check("the player cannot hurt it at all", S._canWin1v1(0, 3, false, true), true);
check("it cannot hurt the player", S._canWin1v1(3, 0, true, true), false);
check("neither can hurt the other", S._canWin1v1(0, 0, true, true), false);
check("free switch, equal hits, moves first", S._canWin1v1(2, 2, true, true), true);
check("free switch, equal hits, moves second", S._canWin1v1(2, 2, false, true), false);
check("free switch, takes one more hit than it needs", S._canWin1v1(3, 2, false, true), true);
check("mid-battle, one extra hit, moves first", S._canWin1v1(3, 2, true, false), true);
check("mid-battle, one extra hit, moves second", S._canWin1v1(3, 2, false, false), false);
check("mid-battle, two extra hits, moves second", S._canWin1v1(4, 2, false, false), true);
check("mid-battle, equal hits, moves first", S._canWin1v1(2, 2, true, false), false);

console.log("category priority and tie-breaks:");
function cand(o) { return Object.assign({ hitsAI: 2, matchup: 2 }, o); }
function res(cats, maxDamage) { var c = {}; cats.forEach(function (k) { c[k] = 1; }); return { cats: c, maxDamage: maxDamage || 0 }; }
var three = [cand({}), cand({}), cand({})];
check("a trapper outranks a revenge killer",
    S._pick([res(["revengeFast"]), res(["trapper"]), res(["revengeFast"])], three, true), { index: 1, cat: "trapper" });
check("revenge killers: the LAST in party order goes out",
    S._pick([res(["revengeFast"]), res(["revengeFast"]), res(["generic"])], three, true), { index: 1, cat: "revengeFast" });
check("a fast OHKO outranks a slow one",
    S._pick([res(["revengeFast"]), res([]), res(["revengeSlow"])], three, true), { index: 0, cat: "revengeFast" });
check("a slow OHKO outranks a fast 2HKO",
    S._pick([res(["threatenFast"]), res(["revengeSlow"]), res([])], three, true), { index: 1, cat: "revengeSlow" });
check("type matchup: the BEST resist, not the last",
    S._pick([res(["typeMatchup"]), res(["typeMatchup"]), res(["typeMatchup"])],
        [cand({ matchup: 1 }), cand({ matchup: 0.5 }), cand({ matchup: 1.5 })], true), { index: 1, cat: "typeMatchup" });
check("type matchup tie: the earliest slot keeps it",
    S._pick([res(["typeMatchup"]), res(["typeMatchup"])], [cand({ matchup: 1 }), cand({ matchup: 1 })], true), { index: 0, cat: "typeMatchup" });
check("a resist with a super-effective move outranks a plain resist",
    S._pick([res(["typeMatchup"]), res(["typeMatchup", "typeEffective"])],
        [cand({ matchup: 0.5 }), cand({ matchup: 1.5 })], true), { index: 1, cat: "typeEffective" });
check("best damage: the highest roll",
    S._pick([res(["damage"], 40), res(["damage"], 90), res(["damage"], 60)], three, true), { index: 1, cat: "damage" });
check("after a KO, nobody qualifies: the last healthy one",
    S._pick([res([]), res([]), res([])], three, true), { index: 2, cat: "fallback" });
check("mid-battle ignores revenge killers entirely",
    S._pick([res(["revengeFast"]), res(["generic"]), res([])], three, false), { index: 1, cat: "generic" });
check("mid-battle: the defensive pick is the one that takes the most hits",
    S._pick([res(["defensive"]), res(["defensive"])], [cand({ hitsAI: 4 }), cand({ hitsAI: 6 })], false), { index: 1, cat: "defensive" });
check("mid-battle, nobody qualifies: it stays in",
    S._pick([res(["damage"], 50), res([])], three.slice(0, 2), false), { index: -1, cat: "none" });

console.log("one pass over a candidate's moves:");
function mv(o) {
    return Object.assign({ status: false, rolls: [0], first: false, firstPri: false, batonPass: false,
        explosion: false, superEffective: false, endure: false }, o);
}
var first = function () { return 0; };          // always the lowest roll
var a = { free: true, hitsAI: 3, hitsAIPri: 0, matchup: 2, traps: false, moves: [mv({ rolls: [120, 130], first: true })] };
check("an OHKO from a faster bench Pokémon is a fast revenge kill",
    Object.keys(S._categorise(a, 100, first).cats).sort(), ["damage", "generic", "revengeFast", "threatenFast"]);
a.moves = [mv({ rolls: [50, 55], first: false })];
check("exactly half the player's HP threatens a 2HKO (odd HP rounds up)",
    [!!S._categorise(a, 100, first).cats.threatenSlow, !!S._categorise(a, 101, first).cats.threatenSlow], [true, false]);
a.moves = [mv({ rolls: [80], explosion: true, first: true })];
check("an Explosion that does not OHKO is not counted as damage at all",
    Object.keys(S._categorise(a, 100, first).cats).sort(), ["generic"]);
a.moves = [mv({ rolls: [100], first: true, endure: true })];
check("Focus Sash / Sturdy on the player turns a one-hit KO into two hits",
    !!S._categorise({ free: true, hitsAI: 1, hitsAIPri: 0, matchup: 2, traps: false, moves: a.moves }, 100, first).cats.generic, false);
a = { free: true, hitsAI: 1, hitsAIPri: 0, matchup: 2, traps: false, moves: [mv({ rolls: [30], first: true })] };
check("a bench Pokémon that dies to one hit is not even a damage pick",
    Object.keys(S._categorise(a, 100, first).cats), []);
a = { free: true, hitsAI: 3, hitsAIPri: 1, matchup: 2, traps: false, moves: [mv({ rolls: [60], first: true, firstPri: false })] };
check("it must also win against the player's best PRIORITY move",
    !!S._categorise(a, 100, first).cats.generic, false);
a = { free: true, hitsAI: 3, hitsAIPri: 0, matchup: 2, traps: true, moves: [mv({ status: true, rolls: [0] }), mv({ rolls: [60], first: true })] };
check("a trapper needs a damaging move that wins the 1v1", !!S._categorise(a, 100, first).cats.trapper, true);

console.log("GetSwitchinWeatherImpact:");
// 160 max HP, so a sixteenth is 10 and an eighth is 20; positive is damage, negative is healing
function mon(types, o) { return Object.assign({ types: types, maxHp: 160, ability: "", hold: "NONE", itemEnabled: true }, o); }
var hail = { weather: "Hail" }, sand = { weather: "Sand" };
check("hail chips a non-Ice type", S._weatherImpact(mon(["Water"]), hail), 10);
check("hail spares an Ice type", S._weatherImpact(mon(["Ice", "Water"]), hail), 0);
check("sandstorm chips a type that is not Rock, Ground or Steel", S._weatherImpact(mon(["Fire", "Flying"]), sand), 10);
check("sandstorm spares Rock, Ground and Steel",
    [S._weatherImpact(mon(["Rock"]), sand), S._weatherImpact(mon(["Water", "Ground"]), sand), S._weatherImpact(mon(["Steel", "Psychic"]), sand)], [0, 0, 0]);
check("an immune ability spares it", [S._weatherImpact(mon(["Water"], { ability: "Snow Cloak" }), hail),
    S._weatherImpact(mon(["Water"], { ability: "Sand Rush" }), sand), S._weatherImpact(mon(["Water"], { ability: "Magic Guard" }), sand)], [0, 0, 0]);
check("Safety Goggles spare it, unless the item is disabled",
    [S._weatherImpact(mon(["Water"], { hold: "SAFETY_GOGGLES" }), sand), S._weatherImpact(mon(["Water"], { hold: "SAFETY_GOGGLES", itemEnabled: false }), sand)], [0, 10]);
check("Ice Body heals in hail instead", S._weatherImpact(mon(["Water"], { ability: "Ice Body" }), hail), -10);
check("a sixteenth of tiny HP still costs 1", S._weatherImpact(mon(["Water"], { maxHp: 9 }), sand), 1);
check("no weather, or weather suppressed: nothing", [S._weatherImpact(mon(["Water"]), {}), S._weatherImpact(mon(["Water"]), { weather: "Sand", weatherEffect: false })], [0, 0]);

console.log("the bench (a Mega copy is not a party member):");
// The export files a stone-holder twice: as itself in its real slot, and under its Mega species at
// sub_index 6 with only the ability changed. InitializeSwitchinCandidate reads the party slot as it
// is, so only the first of those is something the AI can weigh - or send out.
function set(tr, sub, item, moves, o) {
    return Object.assign({ tr_id: tr, sub_index: sub, level: 50, item: item || "", nature: "Hardy",
        ivs: { hp: 31 }, evs: {}, moves: moves || ["Tackle"], ability: "Pressure" }, o);
}
var LABEL = " (Lvl 50 Leader Test )";
var starmie = set(7, 1, "Starmieite", ["Surf", "Psychic"], { ability: "Natural Cure" });
var zard = set(7, 3, "Charizardite X", ["Flare Blitz"], { ability: "Blaze" });
var sets = {};
sets["Empoleon" + LABEL] = set(7, 0, "Leftovers");
sets["Starmie" + LABEL] = starmie;
sets["Nidoqueen" + LABEL] = set(7, 2, "Black Sludge");
sets["Charizard" + LABEL] = zard;
sets["Togekiss" + LABEL] = set(7, 4);
sets["Quaquaval" + LABEL] = set(7, 5);
sets["Starmie-Mega" + LABEL] = Object.assign({}, starmie, { sub_index: 6, ability: "Huge Power" });
sets["Charizard-Mega-X" + LABEL] = Object.assign({}, zard, { sub_index: 6, ability: "Tough Claws" });
sets["Pidgey (Lvl 3 Youngster Other )"] = set(9, 0);
function lookup(id) { return sets[id] || null; }
// CURRENT_TRAINER_POKS spells an entry "Species (set)[n]"
var party = Object.keys(sets).map(function (id) { return id + "[" + sets[id].sub_index + "]"; });
function names(r) { return r.bench.map(function (b) { return b.species + ":" + (b.subIndex + 1); }); }

var r = S._bench(party, "Empoleon" + LABEL + "[0]", lookup, []);
check("no Mega copy is a candidate, and the base forms are",
    names(r), ["Starmie:2", "Nidoqueen:3", "Charizard:4", "Togekiss:5", "Quaquaval:6"]);
check("each copy that was left out is named with the form it is weighed as",
    r.formCopies, [{ species: "Starmie-Mega", base: "Starmie" }, { species: "Charizard-Mega-X", base: "Charizard" }]);
check("another trainer's Pokémon are not on this bench",
    names(r).filter(function (n) { return /Pidgey/.test(n); }), []);
r = S._bench(party, "Starmie-Mega" + LABEL + "[6]", lookup, []);
check("with the Mega loaded as the opponent, its base form is not on the bench either",
    names(r), ["Empoleon:1", "Nidoqueen:3", "Charizard:4", "Togekiss:5", "Quaquaval:6"]);
check("and only the OTHER stone-holder's copy is reported", r.formCopies, [{ species: "Charizard-Mega-X", base: "Charizard" }]);
r = S._bench(party, "Charizard-Mega-X" + LABEL + "[6]", lookup, []);
check("two stone-holders: each copy finds its own base form",
    names(r), ["Empoleon:1", "Starmie:2", "Nidoqueen:3", "Togekiss:5", "Quaquaval:6"]);
r = S._bench(party, "Empoleon" + LABEL + "[0]", lookup, ["Starmie-Mega" + LABEL]);
check("a Mega marked fainted takes its slot off the bench",
    names(r), ["Nidoqueen:3", "Charizard:4", "Togekiss:5", "Quaquaval:6"]);
r = S._bench(party, "Empoleon" + LABEL + "[0]", lookup, ["Starmie" + LABEL + "[1]", "Togekiss" + LABEL]);
check("fainted is honoured under either spelling of the id",
    names(r), ["Nidoqueen:3", "Charizard:4", "Quaquaval:6"]);
check("a trainer with no stone-holders is unchanged",
    names(S._bench(["Pidgey (Lvl 3 Youngster Other )[0]"], "", lookup, [])), ["Pidgey:1"]);

console.log(failures ? "\n" + failures + " failure(s)" : "\nall passed");
process.exit(failures ? 1 : 0);
