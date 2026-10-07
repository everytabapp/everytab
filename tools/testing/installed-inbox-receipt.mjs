// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Pure checks for the synthetic installed Dashboard Inbox measurement. */
import assert from "node:assert/strict";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = value => Number.isFinite(value) && value > 0;

/**
 * Validate observed rows and geometry, not compositor paint or trusted input.
 * The runner owns trial/navigation identity and observes selection on the first
 * and last DOM rows. These endpoints are distinct at either allowed fixture size.
 * @param {{count:250|1000,trial:number,token:string,rows:Array<{key:string,title:string,url:string}>,
 * timing:{firstRowsMs:number,allRowsMs:number,nextFrameMs:number},
 * visible:{width:number,height:number,firstRowHeight:number,firstRowTop:number,
 * firstRowBottom:number,viewportHeight:number,documentVisible:boolean,focused:boolean},
 * selected:{first:boolean,last:boolean,count:number,classKeys:string[],checkedKeys:string[]},
 * disclosures:number,motion:{nativeDefault:boolean,injected:boolean,frame:boolean}}} receipt
 * @returns {object} The validated receipt, unchanged.
 */
export function validateInboxTrial(receipt) {
  assert.ok(isRecord(receipt), "Inbox receipt must be an object");
  assert.ok(isRecord(receipt.motion) && ["nativeDefault", "injected", "frame"].every(field => receipt.motion[field] === true),
    "Inbox measurement requires native and observed reduced motion throughout navigation");
  assert.ok([250, 1000].includes(receipt.count), "Inbox fixture count is invalid");
  assert.ok([1, 2, 3].includes(receipt.trial), "Inbox trial number is invalid");
  assert.ok(receipt.token === `${receipt.count}/${receipt.trial}`,
    "Inbox document token must match its fixture count and trial");
  assert.ok(Array.isArray(receipt.rows) && receipt.rows.length === receipt.count,
    "Inbox receipt must contain every fixture row");
  for (let index = 0; index < receipt.count; index++) {
    const row = receipt.rows[index];
    const suffix = String(index).padStart(4, "0");
    // fromInboxItems retains the item id; tablist appends the tab's local index.
    assert.ok(isRecord(row) && row.key === `inbox-fixture-${suffix}::0` &&
      row.title === `Inbox fixture ${suffix}` && row.url === `https://inbox-fixture.invalid/item/${suffix}`,
    "Inbox rows must retain exact fixture identity, content and order");
  }
  const { timing, visible, selected } = receipt;
  assert.ok(isRecord(timing), "Inbox timing receipt is missing");
  const times = [timing.firstRowsMs, timing.allRowsMs, timing.nextFrameMs];
  assert.ok(times.every(value => Number.isFinite(value) && value >= 0) &&
    times[0] <= times[1] && times[1] <= times[2], "Inbox timings must be finite, nonnegative and ordered");
  assert.ok(isRecord(visible), "Inbox visibility receipt is missing");
  assert.ok([visible.width, visible.height, visible.firstRowHeight, visible.viewportHeight].every(positive) &&
    Number.isFinite(visible.firstRowTop) && Number.isFinite(visible.firstRowBottom) &&
    visible.firstRowBottom > visible.firstRowTop && visible.firstRowBottom > 0 &&
    visible.firstRowTop < visible.viewportHeight, "Inbox first row must have layout and intersect the viewport");
  assert.ok(visible.documentVisible === true && visible.focused === true,
    "Inbox measurement must be visible and focused");
  assert.ok(isRecord(selected) && selected.first === true && selected.last === true && selected.count === 2,
    "Inbox selection must contain exactly the first and last rows");
  const endpoints = [receipt.rows[0].key, receipt.rows.at(-1).key];
  for (const keys of [selected.classKeys, selected.checkedKeys]) {
    assert.ok(Array.isArray(keys) && keys.length === endpoints.length &&
      keys.every((key, index) => key === endpoints[index]),
    "Inbox selection classes and checkboxes must each match the ordered endpoints");
  }
  assert.ok(receipt.disclosures === 0, "Inbox rows must be available without disclosures");
  return receipt;
}
