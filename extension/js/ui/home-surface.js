/**
 * RETIRED by F34-4 (2026-07-31). SAFE TO DELETE.
 *
 * The Home surface held Starred, four "What's happening" pointers, and a Focus
 * footer. Every one of those was a shortcut to somewhere else, which is why it
 * duplicated a left pane that already lists those destinations with live
 * counts, and why scrolling up from a collection landed back in it.
 *
 * Its content now lives in the command box (`js/ui/command-box.js`), which is
 * present on every route rather than only on one. See
 * `f34-command-box-spec.md`.
 *
 * The build environment cannot unlink files, so this tombstone stands in for
 * the deletion. Nothing imports it, and a smoke contract holds that.
 */
export {};
