/* Two-level navigation: a short row of sections, and the pages of the open one.
 *
 * Twelve tabs in one row stopped fitting beside the cap, sync and data-status
 * pills ("Bottle Caps" wrapped onto a second line at 1400px), and a flat row
 * says nothing about which pages belong together. So the header holds
 * SECTIONS, and a slim second row holds the PAGES of the section that is open.
 *
 * Nothing else in the app had to learn about this, by keeping three things
 * exactly as they were:
 *
 *   - every page is still a <button data-tab="..."> inside #tabs, so a lookup
 *     such as '#tabs button[data-tab="calc"]' (calcui.js hangs the calculator's
 *     lazy load on that button's click) still finds it;
 *   - showTab(id) is still the one way to change page, and 'kudzu.tab' still
 *     holds a page id. showTab calls navSync() so the rows follow it, whoever
 *     asked - a jump from another tab, the restore at boot, the self-test;
 *   - a section button CLICKS the page button rather than calling showTab, so
 *     every listener on that page button runs, the calculator's included.
 *
 * The grouping is data (NAV_SECTIONS). A page id that is missing from it is
 * not lost: it is appended to the last section, and said so in the console.
 *
 * How a section button behaves:
 *   - Run always opens the Overview: it is the hub, and works as Home.
 *   - the section you are ALREADY in opens its first page, so a remembered
 *     page you did not want is one click from undone;
 *   - any other section reopens on the page you last CLICKED there. A jump made
 *     by the app itself (a species link, a boss row, the save pill) changes
 *     the page but not what a section remembers - otherwise one stray link
 *     to Trainers would make "Route" open on Trainers for the rest of the day;
 *   - Calc and Pokédex are sections of one page. No second row is drawn for
 *     them, which is what gives the calculator its height back, and clicking
 *     the one you are on does nothing (it must not reload the calculator).
 */
'use strict';

/* By the thing each page is about, in the order of a play session: where the
   run stands, the route ahead, your own side, the fight, the reference book.
   Save file sits under Run rather than in a section of its own - it is opened
   about once per install, and the save pill in the bar reaches it in one click
   from anywhere. */
const NAV_SECTIONS = [
  { id: 'run', label: 'Run', pages: ['home', 'splits', 'runs', 'sav'] },
  { id: 'route', label: 'Route', pages: ['enc', 'trainers'] },
  { id: 'team', label: 'Team', pages: ['box', 'items', 'caps', 'frags'] },
  { id: 'battle', label: 'Calc', pages: ['calc'] },
  { id: 'dex', label: 'Pokédex', pages: ['dex', 'glossary'] },
];
/* What a page is called in the second row, where that differs from its id's
   old tab name: "Run > Run" reads as a stutter, and Runs / Save say more with
   one more word. Ids, section ids and 'kudzu.tab' values are unchanged. */
const NAV_PAGE_LABEL = { home: 'Overview', runs: 'All runs', sav: 'Save file', glossary: 'Glossary' };

const NAV_LAST_KEY = 'kudzu.nav.last';      // { sectionId: pageId } - the page each section reopens on
let navLast = {};

const navSectionOf = (page) => NAV_SECTIONS.find((s) => s.pages.includes(page)) || null;

function navRemember(section, page) {
  navLast[section.id] = page;
  try { localStorage.setItem(NAV_LAST_KEY, JSON.stringify(navLast)); } catch { /* private mode */ }
}

/** Make both rows agree with the page that is showing. Called by showTab. */
function navSync(page) {
  const section = navSectionOf(page);
  if (!section) return;
  $$('#groups button').forEach((b) => {
    const on = b.dataset.group === section.id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'true' : 'false');
  });
  $$('#tabs button').forEach((b) => { b.hidden = !section.pages.includes(b.dataset.tab); });
  // A section with one page has nothing to choose between, so its row is not
  // drawn at all - which is also what gives the calculator its height back.
  const sub = $('#subbar');
  if (sub) sub.classList.toggle('single', section.pages.length < 2);
  document.body.dataset.section = section.id;
}

/** Which page a click on a section button opens - see the header comment. */
function navTargetOf(section) {
  const here = document.body.dataset.section === section.id;
  if (here && section.pages.length < 2) return null;
  if (section.id === 'run' || here) return section.pages[0];
  return section.pages.includes(navLast[section.id]) ? navLast[section.id] : section.pages[0];
}

/** A width-neutral warning dot on a section button (see style.css). */
function navFlag(sectionId, name, on) {
  const b = document.querySelector(`#groups button[data-group="${sectionId}"]`);
  if (!b) return;
  if (on) b.dataset.flag = name; else if (b.dataset.flag === name) delete b.dataset.flag;
}

function initNav() {
  const groups = $('#groups');
  const tabs = $('#tabs');
  if (!groups || !tabs) return;
  // boot() runs again after a data refresh; the rows are already built then.
  if (initNav.done) {
    const open = document.querySelector('.tab.on');
    navSync(open ? open.id.replace(/^tab-/, '') : 'home');
    return;
  }
  initNav.done = true;
  try { navLast = JSON.parse(localStorage.getItem(NAV_LAST_KEY) || '{}') || {}; } catch { navLast = {}; }

  // Any page the table forgot still has to be reachable.
  const known = new Set(NAV_SECTIONS.flatMap((s) => s.pages));
  for (const b of $$('#tabs button')) {
    if (!known.has(b.dataset.tab)) {
      console.warn(`nav: page "${b.dataset.tab}" is in no section; added to ${NAV_SECTIONS[NAV_SECTIONS.length - 1].label}`);
      NAV_SECTIONS[NAV_SECTIONS.length - 1].pages.push(b.dataset.tab);
    }
  }

  // Pages in section order, so the second row reads left to right as listed.
  for (const s of NAV_SECTIONS) {
    for (const page of s.pages) {
      const b = tabs.querySelector(`button[data-tab="${page}"]`);
      if (!b) continue;
      b.dataset.group = s.id;
      if (NAV_PAGE_LABEL[page]) b.textContent = NAV_PAGE_LABEL[page];
      tabs.append(b);
    }
  }

  groups.textContent = '';
  NAV_SECTIONS.forEach((s, i) => {
    const b = el('button', null, s.label);
    b.type = 'button';
    b.dataset.group = s.id;
    const names = s.pages.map((p) => (tabs.querySelector(`button[data-tab="${p}"]`) || {}).textContent || p);
    b.title = (s.pages.length > 1 ? names.join(' · ') : names[0]) + `  (Alt+${i + 1})`;
    b.addEventListener('click', () => {
      // The page button is clicked, not showTab() called, so whatever else
      // listens on that button still runs - the calculator's lazy load does.
      const want = navTargetOf(s);
      const page = want && tabs.querySelector(`button[data-tab="${want}"]`);
      if (page) page.click();
    });
    groups.append(b);
  });

  // What a section remembers is what was CLICKED - in its row, or through its
  // own button (so re-clicking Team to get back to Box also makes Box what Team
  // reopens on). Not where the app jumped to on its own. Run remembers nothing:
  // it always opens Overview.
  for (const b of $$('#tabs button')) {
    b.addEventListener('click', () => {
      // Reopening the page the app was closed on is not a choice the user made
      // today: if a boss link had jumped to Trainers, the restore would turn
      // that jump into what Route remembers - the very thing this rule prevents.
      if (initNav.restoring) return;
      const s = navSectionOf(b.dataset.tab);
      if (s && s.id !== 'run') navRemember(s, b.dataset.tab);
    });
  }

  // The cap pill is the way to "who is over it", as the save pill is the way
  // to the save file. Bound by id: renderCap rewrites the pill's className.
  const cap = $('#cap');
  if (cap) cap.addEventListener('click', () => showTab('box'));

  // Alt+1..n opens a section. Alt, because bare digits belong to the search
  // boxes and the level fields; ignored while the calculator's frame has focus.
  document.addEventListener('keydown', (ev) => {
    if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
    // By physical key: ev.key is also '1'-'9' for the numpad, so typing an
    // Alt-code (Alt+0233 for an e-acute in a nickname) used to change section
    // three times; and on layouts where the digit row needs Shift it never fired.
    const m = /^Digit([1-9])$/.exec(ev.code || '');
    const n = m ? Number(m[1]) : 0;
    if (n < 1 || n > NAV_SECTIONS.length) return;
    ev.preventDefault();
    // Once per press: a held key repeats, and the second "click" on a section
    // that is now open means "go to its first page" - a slightly long press
    // always landed on Box and rewrote what Team remembers.
    if (ev.repeat) return;
    // The refresh log and the run-ending dialog block the mouse; this too.
    if (document.querySelector('#dialog, #modal:not([hidden])')) return;
    const b = groups.querySelector(`button[data-group="${NAV_SECTIONS[n - 1].id}"]`);
    if (b) b.click();
  });

  const showing = document.querySelector('.tab.on');
  navSync(showing ? showing.id.replace(/^tab-/, '') : 'home');
}
window.initNav = initNav;

// Built now, not at the end of boot(). It needs nothing from the datasets - only
// the static buttons, which are parsed (the scripts sit at the end of <body>) -
// and boot() gets to its init list only after ~14 MB of fetches, or not at all
// when a dataset is missing. Until then the bar had no sections and the page row
// listed all twelve pages; and because showTab already called navSync, the first
// click on that row hid every other page with no section bar to get them back.
// boot() still lists initNav: the second call just re-syncs.
initNav();
