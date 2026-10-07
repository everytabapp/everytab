import assert from "node:assert/strict";
import { shouldRepositionAnchoredPanelOnScroll } from "../js/ui/tablist.js";
import {
  ALL_ORGANIZATION_LENS,
  organizationMembershipFocusTarget,
  organizationLensAfterMemberCreate,
  organizationLensAfterRootCreate,
  revealOrganizationLensResult,
  UNGROUPED_ORGANIZATION_LENS
} from "../js/ui/organization-controls.js";
import { installDomFixture } from "./dom-fixture.mjs";

assert.equal(shouldRepositionAnchoredPanelOnScroll(true), false,
  "scrolling inside the anchored palette needs no anchor work");
assert.equal(shouldRepositionAnchoredPanelOnScroll(false), true,
  "scrolling the underlying page repositions the anchored palette without dismissing it");

const createdId = "10000000-0000-4000-8000-000000000001";
assert.equal(organizationLensAfterRootCreate(ALL_ORGANIZATION_LENS, createdId),
  ALL_ORGANIZATION_LENS,
  "creating an empty group must preserve the populated lens instead of navigating to an empty page");
assert.equal(organizationLensAfterMemberCreate(ALL_ORGANIZATION_LENS, createdId),
  ALL_ORGANIZATION_LENS,
  "creating a group with selected members must preserve the populated lens too");
const existingLens = "20000000-0000-4000-8000-000000000002";
assert.equal(organizationLensAfterMemberCreate(existingLens, createdId), existingLens,
  "member-seeded creation inside another group must not switch lenses");

const dom = installDomFixture();
try {
  const root = document.createElement("section");
  const sticky = document.createElement("div");
  sticky.className = "section-local-sticky";
  sticky.setRect({ top: 80, height: 90 });
  const row = document.createElement("div");
  row.className = "organization-row";
  row.setAttribute("aria-label", "Session groups");
  row.setAttribute("data-organization-kind", "session");
  const ungrouped = document.createElement("button");
  ungrouped.setAttribute("data-organization-lens", UNGROUPED_ORGANIZATION_LENS);
  const create = document.createElement("button");
  create.setAttribute("data-organization-command", "create");
  row.append(ungrouped, create);
  sticky.append(row);
  root.append(sticky);
  document.body.append(root);

  assert.equal(organizationMembershipFocusTarget(root, "session", createdId,
    UNGROUPED_ORGANIZATION_LENS), create,
  "when Apply removes the Ungrouped card, focus must leave the clipped lens rail for + Group");

  const card = document.createElement("article");
  card.setAttribute("data-tablist-card", createdId);
  card.setRect({ top: -140, height: 48 });
  const groups = document.createElement("button");
  groups.setAttribute("data-action-id", "groups");
  card.append(groups);
  root.append(card);
  assert.equal(organizationMembershipFocusTarget(root, "session", createdId,
    UNGROUPED_ORGANIZATION_LENS), groups,
  "when the card survives Apply, focus must return to its Groups action");
  let reveal = null;
  card.scrollIntoView = (options) => { reveal = options; };
  assert.equal(revealOrganizationLensResult(root, 180), true,
    "opening the new one-member group must reveal its first card");
  assert.deepEqual(reveal, { block: "start", behavior: "auto" },
    "group navigation must use the established instant start anchor");
  assert.equal(card.style.scrollMarginTop, "192px",
    "the group result must clear the complete sticky stack");
} finally {
  dom.restore();
}

console.log("PASS: organization UI scroll and creation-context policies");
