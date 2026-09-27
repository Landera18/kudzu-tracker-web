// Highlights opposing party members the ROM's AI classifies as "Support" Pokemon.
//
// This is a direct port of IsSupportMoveset in pkmn-np's src/battle_ai_util.c. The ROM uses that
// classification to decide whether a mon is allowed to pivot out once it has done its job
// (ShouldSwitchIfSupportMon), so knowing which of a trainer's mons are Support tells you which ones
// are liable to switch on you rather than stay in and attack.
//
// Unlike the box-filter highlights (faster / killer / defender / ohko) this is a static property of
// the set - its moves and ability - so it needs no damage calculation and no player Pokemon.
(function () {
    const STORAGE_KEY = "supportHighlight";
    const HIGHLIGHT_CLASS = "support";
    const OPPOSING_SELECTOR = ".opposing.trainer-pok-list .trainer-pok.right-side";

    // Damaging moves the ROM treats as pure utility: they don't count toward the damaging-move
    // total even though they deal damage. Keep in sync with IsSupportMoveset.
    const UTILITY_MOVES = {
        "Fake Out": true,
        "Feint": true,
        "Upper Hand": true,
        "Endeavor": true,
        "Super Fang": true,
        "Dragon Tail": true,
        "Circle Throw": true,
        "Knock Off": true,
        "Foul Play": true,
        "Future Sight": true,
        "Bug Bite": true,
        "Pollen Puff": true
    };

    // Legacy spellings in the set data that aren't just punctuation drift from the AI move table.
    const MOVE_NAME_ALIASES = {
        "Faint Attack": "Feint Attack"
    };

    const SUPPORT_CACHE = {};
    let LOOSE_MOVE_INDEX = null;
    let LOOSE_MOVE_INDEX_SOURCE = null;

    function getAiMoveTable() {
        if (typeof backup_data === "undefined" || !backup_data || !backup_data.ai) {
            return null;
        }
        return backup_data.ai.moves || null;
    }

    function looseKey(name) {
        return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    // The AI move table is keyed by display name, but set data carries a few raw MOVE_* constants
    // and older punctuation ("Self Destruct" vs "Self-Destruct"). Resolve both rather than dropping
    // the move, since a dropped move would silently change the classification.
    function getMoveData(rawName) {
        const table = getAiMoveTable();
        if (!table || !rawName || rawName === "-" || rawName === "(No Move)") {
            return null;
        }

        if (table[rawName]) {
            return table[rawName];
        }

        let name = MOVE_NAME_ALIASES[rawName] || rawName;
        if (/^MOVE_[A-Z0-9_]+$/.test(name)) {
            name = name.slice(5).toLowerCase().split("_").map(function (word) {
                return word.charAt(0).toUpperCase() + word.slice(1);
            }).join(" ");
        }
        if (table[name]) {
            return table[name];
        }

        if (LOOSE_MOVE_INDEX === null || LOOSE_MOVE_INDEX_SOURCE !== table) {
            LOOSE_MOVE_INDEX = {};
            LOOSE_MOVE_INDEX_SOURCE = table;
            Object.keys(table).forEach(function (key) {
                const loose = looseKey(key);
                if (loose && !LOOSE_MOVE_INDEX[loose]) {
                    LOOSE_MOVE_INDEX[loose] = table[key];
                }
            });
        }

        return LOOSE_MOVE_INDEX[looseKey(name)] || null;
    }

    // Port of IsSupportMoveset (src/battle_ai_util.c). Returns null when the move data needed to
    // decide isn't available, so callers can leave the mon unmarked instead of guessing.
    function isSupportMoveset(moves, ability) {
        if (!getAiMoveTable()) {
            return null;
        }
        if (ability === "Imposter") {
            return false;
        }

        const moveList = Array.isArray(moves) ? moves : [];
        let damagingMoves = 0;
        let knownMoves = 0;

        for (let i = 0; i < moveList.length; i++) {
            const rawName = moveList[i];
            if (!rawName || rawName === "-" || rawName === "(No Move)") {
                continue;
            }
            knownMoves++;

            const data = getMoveData(rawName);
            if (!data) {
                // Unknown move: refuse to claim Support rather than risk marking an attacker
                return null;
            }

            const power = Number(data.pow) || 0;

            // Status moves don't count
            if (power === 0) {
                continue;
            }

            // Utility damaging moves are excluded from the damaging-move count
            if (UTILITY_MOVES[rawName] || UTILITY_MOVES[MOVE_NAME_ALIASES[rawName] || rawName]) {
                continue;
            }

            // Speed-lowering moves excluded
            if (data.e === "SPEED_DOWN" || data.e === "SPEED_DOWN_2") {
                continue;
            }

            // Cramorant's Surf/Dive excluded
            if ((rawName === "Surf" || rawName === "Dive") && ability === "Gulp Missile") {
                continue;
            }

            // Any remaining damaging move with BP > 75 disqualifies
            if (power > 75) {
                return false;
            }

            damagingMoves++;
        }

        // A set with no listed moves isn't a Support mon, it's a set the data doesn't know the
        // moves for. The ROM never sees this case - gBattleMons always holds real moves - and
        // without the guard every such set trivially passes the "at most one damaging move" test.
        if (knownMoves === 0) {
            return null;
        }

        return damagingMoves <= 1;
    }

    function getSetData(setId) {
        const id = String(setId || "");
        const species = id.split(" (")[0];
        const labelPart = id.split(" (")[1];
        if (!species || !labelPart) {
            return null;
        }
        const label = labelPart.split(")")[0];
        if (typeof setdex === "undefined" || !setdex || !setdex[species]) {
            return null;
        }
        return setdex[species][label] || null;
    }

    function isSupportSetId(setId) {
        const id = String(setId || "");
        if (!id) {
            return null;
        }
        if (Object.prototype.hasOwnProperty.call(SUPPORT_CACHE, id)) {
            return SUPPORT_CACHE[id];
        }

        const setData = getSetData(id);
        const result = setData ? isSupportMoveset(setData.moves, setData.ability) : null;
        SUPPORT_CACHE[id] = result;
        return result;
    }

    function isSupportHighlightEnabled() {
        return typeof localStorage !== "undefined"
            && localStorage[STORAGE_KEY] == "1"
            && !!getAiMoveTable();
    }

    function clearSupportHighlights() {
        $(OPPOSING_SELECTOR).removeClass(HIGHLIGHT_CLASS);
    }

    function refreshSupportHighlights() {
        clearSupportHighlights();

        if (!isSupportHighlightEnabled()) {
            return;
        }

        $(OPPOSING_SELECTOR).each(function () {
            const setId = $(this).attr("data-id");
            if (!setId) {
                return;
            }
            if (isSupportSetId(setId) === true) {
                $(this).addClass(HIGHLIGHT_CLASS);
            }
        });
    }

    function refreshSupportHighlightsSafely() {
        try {
            refreshSupportHighlights();
        } catch (error) {
            console.warn("Support highlight refresh failed", error);
            try {
                clearSupportHighlights();
            } catch (_clearError) {
                // The preview isn't rendered yet; nothing to clear.
            }
        }
    }

    // The toggle is only meaningful for data that carries the ROM's AI move table.
    function syncSupportHighlightToggle() {
        const row = $("#toggle-support-highlight");
        if (!row.length) {
            return;
        }
        row.css("display", getAiMoveTable() ? "" : "none");
        row.find("input").prop("checked", localStorage[STORAGE_KEY] == "1");
    }

    // backup_data arrives from a large separate script, so at DOM ready it usually isn't there yet.
    // Syncing once at boot would hide the toggle for the rest of the session on a game that does
    // have the AI table, so wait for the data before deciding.
    function syncSupportHighlightToggleWhenReady() {
        const DEADLINE = Date.now() + 60000;

        (function attempt() {
            if (getAiMoveTable() || Date.now() > DEADLINE) {
                syncSupportHighlightToggle();
                refreshSupportHighlightsSafely();
                return;
            }
            setTimeout(attempt, 250);
        })();
    }

    if (typeof localStorage !== "undefined" && typeof localStorage[STORAGE_KEY] === "undefined") {
        localStorage[STORAGE_KEY] = "0";
    }

    window.isSupportMoveset = isSupportMoveset;
    window.isSupportSetId = isSupportSetId;
    window.isSupportHighlightEnabled = isSupportHighlightEnabled;
    window.clearSupportHighlights = clearSupportHighlights;
    window.refreshSupportHighlights = refreshSupportHighlightsSafely;
    window.syncSupportHighlightToggle = syncSupportHighlightToggle;

    $(function () {
        syncSupportHighlightToggleWhenReady();
    });
})();
