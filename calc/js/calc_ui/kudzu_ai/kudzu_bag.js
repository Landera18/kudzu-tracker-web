/* Kudzu item bag.
 *
 * The calculator's item picker lists every item in the game - several hundred -
 * when the player owns a few dozen. The Kudzu tracker reads the real bag out of
 * the save and hands it over (localStorage "kudzu.calc.bag", same origin), and
 * this does two things with it for the PLAYER's side only:
 *
 *   the picker   options the player does not own are hidden, so the dropdown is
 *                the bag. Hidden, not removed: loading a set still has to be
 *                able to select an item that is not in the bag (an old import, a
 *                what-if), and that item is shown again while it is selected.
 *   the bag      a button beside the picker opens the bag as a grid of icons,
 *                grouped as the game's pockets are, with who is holding what.
 *                One click equips. Modelled on the item box in ForwardFeed's
 *                Run & Bun calc, but filled from the save instead of a fixed list.
 *
 * Without a tracker (the calc opened on its own) there is no bag data: the picker
 * is left alone and the button says where the bag comes from.
 */
(function (root) {
    "use strict";
    var BAG_KEY = "kudzu.calc.bag", PREF_KEY = "kudzuBagOnly";
    var KIND_LABEL = { held: "Held items", berry: "Berries", mega: "Mega Stones" };
    var state = { bag: null, byId: {}, only: true, open: false };

    function isKudzu() { return typeof TITLE !== "undefined" && TITLE === "Kudzu"; }
    function toId(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
    function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

    function readBag() {
        var bag = null;
        try { bag = JSON.parse(localStorage.getItem(BAG_KEY) || "null"); } catch (e) { bag = null; }
        if (!bag || !Array.isArray(bag.items)) bag = null;
        state.bag = bag;
        state.byId = {};
        if (bag) bag.items.forEach(function (i) { state.byId[toId(i.name)] = i; });
        try { state.only = localStorage.getItem(PREF_KEY) !== "0"; } catch (e) { state.only = true; }
    }
    function hasBag() { return !!(state.bag && state.bag.items.length); }

    // The calc's own spelling for a bag item: its option in the picker. The ROM says "Never-Melt Ice",
    // an older table says "NeverMeltIce"; comparing letters and digits only joins them.
    function optionFor(item) {
        var want = toId(item.name), found = null;
        $("#itemL1 option").each(function () { if (!found && toId(this.value) === want) found = this.value; });
        return found;
    }

    function applyFilter() {
        var sel = document.getElementById("itemL1");
        if (!sel) return;
        var on = isKudzu() && hasBag() && state.only;
        var current = sel.value;
        for (var i = 0; i < sel.options.length; i++) {
            var o = sel.options[i];
            var owned = !!state.byId[toId(o.value)];
            o.hidden = on && o.value !== "" && !owned && o.value !== current;
            // A selected item that is not in the bag stays visible, and says so.
            if (on && o.value !== "" && !owned && o.value === current) {
                if (!o.getAttribute("data-kz-label")) o.setAttribute("data-kz-label", o.textContent);
                o.textContent = o.getAttribute("data-kz-label") + "  (not in your bag)";
            } else if (o.getAttribute("data-kz-label")) {
                o.textContent = o.getAttribute("data-kz-label");
                o.removeAttribute("data-kz-label");
            }
        }
        $("#kz-bag-btn").toggleClass("kz-bag-empty", !hasBag())
            .attr("title", hasBag()
                ? "Your bag: " + state.bag.items.length + " items you can hold, read from the save by the Kudzu tracker"
                : "No bag yet - open the calc from the Kudzu tracker after it has read your save");
    }

    function iconFor(name) {
        return "./img/items/" + String(name).toLowerCase().replace(/ /g, "_").replace(/['’.]/g, "").replace(/-/g, "_") + ".png";
    }

    function renderPopup() {
        var box = $("#kz-bag-popup");
        if (!box.length) return;
        if (!state.open) { box.attr("hidden", true); return; }
        var html = '<div class="kz-bag-head"><b>Your bag</b>';
        if (hasBag()) {
            html += '<span class="kz-bag-sub">' + state.bag.items.length + " items" + (state.bag.fromSave ? " · from the save" : " · ticked by hand") + "</span>"
                + '<button type="button" class="kz-bag-only" id="kz-bag-only" aria-pressed="' + (state.only ? "true" : "false") + '" title="When on, the item picker for your side lists only what is in your bag">'
                + (state.only ? "Picker: bag only" : "Picker: every item") + "</button>";
        }
        html += '<button type="button" class="kz-bag-close" aria-label="Close">×</button></div>';
        if (!hasBag()) {
            html += '<div class="kz-bag-none">The bag comes from the Kudzu tracker: point its Save tab at the emulator\'s .sav, '
                + "then open the calculator from the tracker. Until then the picker lists every item.</div>";
        } else {
            var current = toId($("#itemL1").val());
            ["held", "berry", "mega"].forEach(function (kind) {
                var list = state.bag.items.filter(function (i) { return i.kind === kind; });
                if (!list.length) return;
                html += '<div class="kz-bag-group">' + KIND_LABEL[kind] + '</div><div class="kz-bag-grid">';
                list.forEach(function (i) {
                    var heldBy = (i.heldBy || []).join(", ");
                    var free = (i.inBag || 0) > 0 || !(i.heldBy || []).length;
                    var tip = i.name + (i.effect ? "\n" + i.effect : "")
                        + "\n" + ((i.inBag || 0) > 0 ? "In the bag ×" + i.inBag : "None spare in the bag")
                        + (heldBy ? "\nHeld by " + heldBy : "");
                    html += '<button type="button" class="kz-bag-item' + (toId(i.name) === current ? " on" : "") + (free ? "" : " held")
                        + '" data-name="' + esc(i.name) + '" title="' + esc(tip) + '">'
                        + '<img src="' + esc(iconFor(i.name)) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
                        + '<span class="kz-bag-name">' + esc(kind === "berry" ? i.name.replace(/ Berry$/, "") : i.name) + "</span>"
                        + ((i.inBag || 0) > 1 ? '<span class="kz-bag-qty">×' + i.inBag + "</span>" : "")
                        + (heldBy ? '<span class="kz-bag-who">' + esc(heldBy) + "</span>" : "")
                        + "</button>";
                });
                html += "</div>";
            });
            html += '<div class="kz-bag-foot"><button type="button" class="kz-bag-item kz-bag-clear" data-name="">No item</button></div>';
        }
        box.html(html).removeAttr("hidden");
    }

    function ensureDom() {
        if ($("#kz-bag-btn").length || !$("#itemL1").length) return;
        var btn = $('<button type="button" id="kz-bag-btn" class="kz-bag-btn" aria-haspopup="dialog">Bag</button>');
        $("#itemL1").after(btn);
        // Anchored to the picker's own row, so it needs no coordinates - the tracker scales this page
        // with body zoom, and client rects under zoom are not worth depending on.
        $("#itemL1").parent().addClass("kz-bag-anchor")
            .append('<div id="kz-bag-popup" class="kz-bag-popup" role="dialog" aria-label="Your bag" hidden></div>');
        btn.on("click", function (ev) {
            ev.preventDefault();
            state.open = !state.open;
            readBag();
            renderPopup();
        });
        $("#kz-bag-popup").on("click", ".kz-bag-close", function () { state.open = false; renderPopup(); })
            .on("click", "#kz-bag-only", function () {
                state.only = !state.only;
                try { localStorage.setItem(PREF_KEY, state.only ? "1" : "0"); } catch (e) { /* ignore */ }
                applyFilter();
                renderPopup();
            })
            .on("click", ".kz-bag-item", function () {
                var name = $(this).attr("data-name");
                var value = name ? optionFor({ name: name }) : "";
                if (name && value == null) return;
                // Un-hide first: a hidden option can be selected, but the select should show it.
                $("#itemL1").val(value).trigger("change");
                state.open = false;
                renderPopup();
            });
        $(document).on("keydown.kzBag", function (ev) { if (ev.key === "Escape" && state.open) { state.open = false; renderPopup(); } });
        $(document).on("mousedown.kzBag", function (ev) {
            if (!state.open) return;
            if ($(ev.target).closest("#kz-bag-popup, #kz-bag-btn").length) return;
            state.open = false; renderPopup();
        });
        $("#itemL1").on("change.kzBag", function () { applyFilter(); });
        // The picker is refilled whenever the calc reloads its data; hide again when it is.
        var sel = document.getElementById("itemL1");
        if (sel && typeof MutationObserver !== "undefined") {
            var timer = null;
            new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(applyFilter, 30); })
                .observe(sel, { childList: true });
        }
    }

    function refresh() {
        if (!isKudzu()) { $("#kz-bag-btn, #kz-bag-popup").remove(); return; }
        ensureDom();
        readBag();
        applyFilter();
        if (state.open) renderPopup();
    }

    // The tracker writes the bag whenever it reads the save; an open calculator follows along.
    root.addEventListener("storage", function (ev) { if (ev.key === BAG_KEY) refresh(); });
    $(function () { setTimeout(refresh, 0); setTimeout(refresh, 1500); });
    // A set loading changes the item after this module last looked.
    $(document).on("change.kzBag", "#p1 .set-selector, #p1 input.set-selector", function () { setTimeout(applyFilter, 50); });

    root.KudzuBag = { refresh: refresh, bag: function () { return state.bag; }, applyFilter: applyFilter };
})(typeof window !== "undefined" ? window : this);
