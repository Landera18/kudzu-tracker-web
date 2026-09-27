"use strict";
exports.__esModule = true;

var helpers_1 = require("../helpers");

// Ogerpon's mask forms (mask-holding AND Tera) all share the exact in-game ability name
// "Embody Aspect" in this hack (unlike the calc's own upstream Ogerpon data, which disambiguates
// via names like "Embody Aspect (Wellspring)"), so which stat gets boosted has to be determined
// from the species name instead of the ability string. Covers both the original Tera-locked
// abilities and the mask-holding "hidden slot" hybrids (which also carry Water Absorb/Mold
// Breaker/Sturdy/Defiant in their primary ability slot - only the stat-boost half of those
// hybrids is modeled here, not the absorb/ignore/survive half).
function applyOgerponEmbodyAspect(source) {
    if (!source || source.ability !== "Embody Aspect" || !source.name || source.name.indexOf("Ogerpon") !== 0)
        return;
    if (source.name.indexOf("Wellspring") !== -1)
        source.boosts.spd = Math.min(6, source.boosts.spd + 1);
    else if (source.name.indexOf("Hearthflame") !== -1)
        source.boosts.atk = Math.min(6, source.boosts.atk + 1);
    else if (source.name.indexOf("Cornerstone") !== -1)
        source.boosts.def = Math.min(6, source.boosts.def + 1);
    else
        source.boosts.spe = Math.min(6, source.boosts.spe + 1);
}

var kudzuProfile = (0, helpers_1.makeProfile)({
    id: "kudzu",
    gens: [9],
    titleMatchers: [
        { equals: "Kudzu" },
        { includes: "Kudzu" }
    ],
    hooks: {
        beforeStats: [
            function (ctx) {
                applyOgerponEmbodyAspect(ctx.attacker);
                applyOgerponEmbodyAspect(ctx.defender);
            }
        ],
        finalMods: [
            function (ctx, finalMods) {
                // Piercing Drill: contact moves that bypass protection this way only deal 1/4 damage.
                if (ctx.state.piercingDrillBypass) {
                    finalMods.push(1024);
                    ctx.desc.attackerAbility = ctx.attacker.ability;
                }
                return finalMods;
            }
        ]
    }
});
exports.kudzuProfile = kudzuProfile;
