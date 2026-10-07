// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * F14 — the shared Labels surface.
 *
 * Labels needs more than a generic `createTabList` config: it gathers and sorts
 * label groups, owns the additive label selector + persisted sort index bar,
 * and preserves N29's instant single-card quick pass
 * for cold cross-section jumps. Both the dashboard and side panel use this
 * per-document factory, with only their host/body, route, and sticky offset
 * injected. The list actions themselves remain in `buildLabelsListConfig`.
 */
import { collectLabels, intersectLabelGroups, sortLabelGroups } from "../lib/labels.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import { getSettings, patchSettings } from "../lib/store.js";
import { pspan } from "../lib/perf.js";
import { coalesce, settleAnchor, settleCue } from "./dom.js";
import { pointerDriven } from "./input-modality.js";
import { createIndexBar } from "./indexbar.js";
import { createTabList } from "./tablist.js";
import { listLabelMeta } from "./list-copy.js";
import { buildLabelsListConfig } from "./list-configs.js";
import { readOrganizationState, projectOrganization } from "../lib/organization.js";
import {
  ALL_ORGANIZATION_LENS, createOrganizationControls, membersForOrganizationLens,
  revealOrganizationLensResult
} from "./organization-controls.js";

/**
 * @typedef {object} LabelsSurfaceCtx
 * @property {() => Element} ctx.getBody active host for the index + list
 * @property {(heading: string) => void} ctx.setHeading
 * @property {() => boolean} ctx.shouldRenderBody
 * @property {() => boolean} ctx.isActive
 * @property {() => void} ctx.activate switch to Labels synchronously, without rendering
 * @property {() => number} ctx.stickyOffset pixels obscured by sticky host chrome
 * @property {(m: object) => Promise<any>} ctx.msg
 * @property {() => void} ctx.refreshLabelViews
 * @property {(refs: any[], heading?: string) => void} ctx.copyRefs
 * @property {(run: () => void) => Node} ctx.confirmDelete
 * @property {Function} ctx.cardLabelPanel F49r: the row-level "add a label" panel
 * @property {(message: string) => void} [ctx.showNotice]
 * @property {"default"|"compact"} [ctx.presentation]
 */

/**
 * @param {LabelsSurfaceCtx} ctx
 * @returns {{render: () => Promise<unknown>, goToLabel: (label: string) => Promise<void>,
 *   setGroupLens: (id: string) => Promise<void>, goToGroup: (id: string) => Promise<void>,
 *   positionLabelCard: (label: string) => void}}
 */
export function createLabelsSurface(ctx) {
  /** Exact additive labels selected in the local combobox. */
  let selectedLabels = [];
  let restoreFacetFocus = false;
  let activeGroupLens = ALL_ORGANIZATION_LENS;

  /** N29: a cold cross-section jump paints this one card before the full list. */
  let jumpLabel = null;

  /** E3-0 §9: first anchored paint is measured inside the cold quick pass. */
  let jumpAnchorMark = null;

  /** Only an explicit jump gets the decorative arrival cue, never a render anchor. */
  let jumpCueLabel = null;

  const jumpCueFrames = new WeakMap();
  const jumpCueCleanups = new WeakMap();
  const jumpCueTimers = new WeakMap();

  /** Restartable, non-moving cue for the card reached by an explicit jump. */
  function cueJumpArrival(card) {
    if (!card?.isConnected) return;
    cancelAnimationFrame(jumpCueFrames.get(card));
    clearTimeout(jumpCueTimers.get(card));
    const oldCleanup = jumpCueCleanups.get(card);
    if (oldCleanup) card.removeEventListener("animationend", oldCleanup);
    card.classList.remove("jump-arrival");
    const frame = requestAnimationFrame(() => {
      jumpCueFrames.delete(card);
      if (!card.isConnected) return;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        card.classList.add("jump-arrival");
        const timer = setTimeout(() => {
          jumpCueTimers.delete(card);
          card.classList.remove("jump-arrival");
        }, 540);
        jumpCueTimers.set(card, timer);
        return;
      }
      const cleanup = (event) => {
        if (event.animationName !== "jump-arrival") return;
        card.removeEventListener("animationend", cleanup);
        jumpCueCleanups.delete(card);
        card.classList.remove("jump-arrival");
      };
      jumpCueCleanups.set(card, cleanup);
      card.addEventListener("animationend", cleanup);
      card.classList.add("jump-arrival");
    });
    jumpCueFrames.set(card, frame);
  }

  const labelCardEl = (label) => ctx.getBody().querySelector(
    `[data-tablist-card="label::${CSS.escape(label)}"]`);

  /** Instant card positioning, offset by the host's sticky chrome. */
  function positionLabelCard(label, { cue = false } = {}) {
    const card = labelCardEl(label);
    if (!card) return;
    card.style.scrollMarginTop = `${ctx.stickyOffset() + 12}px`;
    card.scrollIntoView({ block: "start", behavior: "auto" });
    if (cue) cueJumpArrival(card);
  }

  /**
   * An index chip already represents a card inside the active lens and current
   * filter. Keep both intact; only cross-surface/deep-link jumps use goToLabel.
   */
  function jumpWithinLabelLens(label) {
    positionLabelCard(label, { cue: pointerDriven() });
  }

  /**
   * Jump from any row chip or host navigation. A present card is anchored in the
   * same frame as the section switch; a cold list gets N29's one-card quick pass.
   */
  async function goToLabel(label) {
    const settledSpan = pspan("goToLabel:refresh-settled");
    const anchorSpan = pspan("goToLabel:first-anchor");
    // N42: the cue belongs to POINTER arrivals. `:focus-visible` on the active
    // element answered a different question and wrongly said "keyboard" while
    // the auto-focused search box held focus, killing the first jump's cue.
    const cue = pointerDriven();
    let anchored = false;
    const anchorNow = (how) => { if (!anchored) { anchored = true; anchorSpan(how); } };
    const already = ctx.isActive();
    const hadFacets = selectedLabels.length > 0;
    const hadGroupLens = activeGroupLens !== ALL_ORGANIZATION_LENS;
    selectedLabels = [];
    activeGroupLens = ALL_ORGANIZATION_LENS;
    ctx.activate();
    if (already && (hadGroupLens || hadFacets)) {
      await render();
      positionLabelCard(label);
      settleAnchor(() => positionLabelCard(label));
      if (cue) settleCue(() => labelCardEl(label), cueJumpArrival);
      anchorNow(hadGroupLens ? "group-lens-reset" : "label-facets-reset");
      settledSpan(`label=${label}`);
      return;
    }
    const presentCard = ctx.getBody().querySelector(
      `[data-tablist-card="label::${CSS.escape(label)}"]`);
    const present = !!presentCard;
    if (present) {
      positionLabelCard(label);
      if (already && cue) cueJumpArrival(presentCard);
      anchorNow("stale-dom-same-frame");
    }
    if (!already) {
      // A retained hidden section can contain the card, but render() replaces
      // that stale subtree. Carry the jump through the refresh in every case so
      // the arrival cue lands on the final card rather than a detached one.
      jumpLabel = label;
      jumpAnchorMark = anchorNow;
      jumpCueLabel = cue ? label : null;
      await render();
      jumpLabel = null;
      jumpAnchorMark = null;
      positionLabelCard(label);
      anchorNow("after-full-refresh");
      // A cold arrival is still laying out around this card; hold the landing.
      settleAnchor(() => positionLabelCard(label));
      // N43: `render()` above resolves on the run that was already in flight
      // when this jump routed, so a queued run can still replace the card the
      // render pass cued. Hold the cue until it lands on one that survives.
      if (cue) settleCue(() => labelCardEl(label), cueJumpArrival);
      settledSpan(`label=${label}`);
    } else if (!present) {
      requestAnimationFrame(() => {
        positionLabelCard(label, { cue });
        anchorNow("same-page-raf");
        settledSpan(`label=${label}`);
      });
    } else {
      settledSpan(`label=${label} (already anchored)`);
    }
  }

  /** Search and same-page group navigation share this exact lens setter. */
  async function setGroupLens(id) {
    activeGroupLens = id || ALL_ORGANIZATION_LENS;
    selectedLabels = [];
    ctx.activate();
    await render();
    revealOrganizationLensResult(ctx.getBody(), ctx.stickyOffset());
    settleAnchor(() => revealOrganizationLensResult(ctx.getBody(), ctx.stickyOffset()));
  }

  /** Shared compact index: filter, sort, and label jump chips. */
  async function navigateWithinLabelLens(label) {
    if (!selectedLabels.length) {
      jumpWithinLabelLens(label);
      return;
    }
    selectedLabels = [];
    jumpLabel = label;
    jumpCueLabel = pointerDriven() ? label : null;
    await render();
    settleAnchor(() => positionLabelCard(label));
  }

  function buildLabelIndex(sortedGroups, sortMode, groupRow) {
    return createIndexBar({
      placeholder: localeMessage("list_filter_label_facets_placeholder"),
      filterAria: localeMessage("list_filter_label_facets_aria"),
      sortModes: [
        { id: "az", label: localeMessage("list_sort_az") },
        { id: "count", label: localeMessage("list_sort_most_tabs") },
        { id: "recent", label: localeMessage("list_sort_recent") }
      ],
      sortMode, sortAria: localeMessage("list_sort_labels"),
      onSort: async (mode) => {
        await patchSettings({ uiLabelSort: mode });
        render();
      },
      items: sortedGroups.map((g) => ({ key: g.label, text: g.label, count: g.tabs })),
      onJump: navigateWithinLabelLens,
      chipLabel: localeMessage("list_jump_to_labels"),
      emptyText: (q) => q
        ? localeMessage("list_no_labels_match", [q])
        : localeMessage("list_no_labels_view"),
      groupRow,
      facetSelection: {
        selectedKeys: selectedLabels,
        onChange: async (labels) => {
          selectedLabels = labels;
          restoreFacetFocus = true;
          await render();
        }
      }
    });
  }

  const render = coalesce(async () => {
    const rawGroups = await collectLabels();
    const sortMode = (await getSettings()).uiLabelSort ?? "recent";
    const groups = sortLabelGroups(rawGroups, sortMode);
    const organizationState = await readOrganizationState("label");
    const projection = projectOrganization("label", groups, organizationState,
      { memberKey: (group) => group.label });
    if (activeGroupLens !== ALL_ORGANIZATION_LENS &&
        activeGroupLens !== "ungrouped" && !projection.groupById.has(activeGroupLens)) {
      activeGroupLens = ALL_ORGANIZATION_LENS;
    }
    const visibleGroups = membersForOrganizationLens(projection, activeGroupLens);
    const visibleByName = new Map(visibleGroups.map((group) => [
      group.label.toLocaleLowerCase(), group.label
    ]));
    selectedLabels = selectedLabels
      .map((label) => visibleByName.get(label.toLocaleLowerCase()))
      .filter(Boolean);
    const heading = localeMessage("list_labels_heading", [formatNumber(groups.length)]);
    if (!ctx.shouldRenderBody()) return { heading, node: null };
    ctx.setHeading(heading);

    // One list group per label; rows are the exact tabs carrying that label.
    const controls = createOrganizationControls({
      kind: "label", members: groups, memberKey: (group) => group.label,
      projection, activeLens: activeGroupLens,
      onLensChange: setGroupLens,
      onChange: render, showNotice: ctx.showNotice, focusRoot: ctx.getBody
    });

    let tlGroups = visibleGroups.map((g) => {
      const refs = [];
      const locs = [];
      for (const e of g.entries) {
        for (const t of e.tabs) {
          refs.push(t.ref);
          locs.push({ store: e.store, item: e.item, wi: t.wi, i: t.i });
        }
      }
      return {
        id: `label::${g.label}`,
        kind: "label",
        title: g.label,
        glyph: "labels",
        meta: listLabelMeta(g.tabs, g.entries.length),
        refs, loose: false,
        data: { label: g.label, locs }
      };
    });

    if (selectedLabels.length === 1) {
      const selected = selectedLabels[0].toLocaleLowerCase();
      tlGroups = tlGroups.filter((group) =>
        group.data.label.toLocaleLowerCase() === selected);
    } else if (selectedLabels.length > 1) {
      const intersection = intersectLabelGroups(visibleGroups, selectedLabels);
      const title = intersection.labels.join(" + ");
      const places = new Set(intersection.locs.map((loc) =>
        `${loc.store}:${loc.item.id}`)).size;
      tlGroups = intersection.refs.length ? [{
        id: "label::intersection",
        kind: "label-intersection",
        title,
        glyph: "labels",
        meta: listLabelMeta(intersection.refs.length, places),
        refs: intersection.refs,
        loose: false,
        data: {
          label: title,
          labels: intersection.labels,
          locs: intersection.locs,
          combined: true
        }
      }] : [];
    }

    // The quick and full passes use the same config and therefore the same rows,
    // actions, chips, and location metadata in both hosts.
    const buildList = (gs) => createTabList(buildLabelsListConfig({
      presentation: ctx.presentation ?? "default",
      data: { groups: gs },
      renderLabels: render, goToLabel, msg: ctx.msg,
      refreshLabelViews: ctx.refreshLabelViews, showNotice: ctx.showNotice,
      cardLabelPanel: ctx.cardLabelPanel,
      organizationCardAction: controls.cardAction,
      empty: selectedLabels.length > 1
        ? localeMessage("list_labels_intersection_empty")
        : activeGroupLens === ALL_ORGANIZATION_LENS
          ? localeMessage("list_labels_empty")
          : localeMessage("list_labels_group_empty"),
      copyRefs: ctx.copyRefs, confirmDelete: ctx.confirmDelete
    }));

    const body = ctx.getBody();
    const jump = jumpLabel; jumpLabel = null;
    const cueJump = jump != null && jumpCueLabel === jump;
    jumpCueLabel = null;
    if (jump) {
      const quickTarget = tlGroups.find((g) => g.data.label === jump);
      if (quickTarget) {
        body.replaceChildren(buildList([quickTarget]));
        // The quick card supplies the immediate anchor only. The full pass
        // replaces it, so consuming the decorative cue here would make the
        // cross-route arrival invisible.
        positionLabelCard(jump);
        await new Promise((r) => requestAnimationFrame(r));
        jumpAnchorMark?.("cold-quick-pass");
        jumpAnchorMark = null;
        if (!ctx.shouldRenderBody()) return { heading, node: null };
      }
    }

    const tablist = buildList(tlGroups);

    body.replaceChildren(
      buildLabelIndex(visibleGroups, sortMode, controls.groupRow),
      tablist
    );
    if (restoreFacetFocus) {
      restoreFacetFocus = false;
      requestAnimationFrame(() => body.querySelector(".label-facet-field .label-filter")
        ?.focus({ preventScroll: true }));
    }
    if (jump) {
      positionLabelCard(jump, { cue: cueJump });
    }
    return { heading, node: tablist };
  });

  return { render, goToLabel, positionLabelCard, setGroupLens, goToGroup: setGroupLens };
}
