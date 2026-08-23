/**
 * RETIRED by F34-4 (2026-07-31). SAFE TO DELETE.
 *
 * This module decided the scroll effect for the Dashboard's inline collection
 * navigator. Both that navigator and the Home route are gone: the left pane is
 * now the single navigation, Open tabs is the landing, and every route change
 * is orienting, so `dashboard.js` needs no scroll policy beyond starting at the
 * top.
 *
 * The side panel keeps its own switcher (`js/ui/sidepanel.js`, `.switcher`),
 * which is the surviving instance of this navigation idea per
 * `f34-command-box-spec.md` §9. It never imported this module.
 *
 * The build environment cannot unlink files, so this tombstone stands in for
 * the deletion. Nothing imports it, and a smoke contract holds that.
 */
export {};
