// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOccurrences, fixtureTabs } from './restart-occurrences.mjs';

const origin = 'http://127.0.0.1:9000';
const rows = [
  ['awake-a', 1, null], ['shared', 1, 'shared-a'], ['sleep-a', 1, 'sleep-a'],
  ['awake-b', 2, null], ['shared', 2, 'shared-b'], ['sleep-b', 2, 'sleep-b']
];
const originalTabs = rows.map(([url, windowId, occurrence]) => ({ windowId,
  url: occurrence ? 'chrome-extension://fixture/suspend.html?' + new URLSearchParams({
    originalUrl: origin + '/' + url, recoveryOccurrenceId: occurrence
  }) : origin + '/' + url
}));
const expected = rows.map(([url, windowId, occurrence]) => ({
  original: origin + '/' + url, windowId, occurrence, suspended: Boolean(occurrence)
}));

test('restart permits numeric window changes and browser enumeration order changes', () => {
  const tabs = originalTabs.map(tab => ({ ...tab, windowId: tab.windowId + 100 })).reverse();
  tabs.push({ windowId: 999, url: 'chrome-extension://fixture/popup.html' });
  assertOccurrences({ tabs }, expected, origin);
});

test('equal-URL occurrences cannot trade windows while global counts stay correct', () => {
  const tabs = structuredClone(originalTabs);
  [tabs[1].url, tabs[4].url] = [tabs[4].url, tabs[1].url];
  assert.throws(() => assertOccurrences({ tabs }, expected, origin), /source-window membership/);
});

test('missing, duplicate, and collapsed-window occurrences are rejected', () => {
  assert.throws(() => assertOccurrences({ tabs: originalTabs.slice(1) }, expected, origin));
  assert.throws(() => assertOccurrences({ tabs: [...originalTabs, originalTabs[1]] }, expected, origin));
  const tabs = originalTabs.map((tab, index) => ({ ...tab,
    windowId: expected[index].suspended ? 2 : tab.windowId
  }));
  assert.throws(() => assertOccurrences({ tabs }, expected, origin), /source-window membership/);
});

test('closing one shared occurrence retains the other and rejects its resurrection', () => {
  const remaining = expected.filter(tab => tab.occurrence !== 'shared-a');
  const tabs = originalTabs.filter((_tab, index) => index !== 1);
  assertOccurrences({ tabs }, remaining, origin);
  assert.throws(() => assertOccurrences({ tabs: originalTabs }, remaining, origin));
});

test('pending navigation is the observed tab identity', () => {
  const tab = { ...originalTabs[1], pendingUrl: origin + '/navigated' };
  assert.deepEqual(fixtureTabs({ tabs: [tab] }, origin), [{ ...tab,
    original: origin + '/navigated', suspended: false, occurrence: null
  }]);
  const tabs = structuredClone(originalTabs);
  tabs[1] = tab;
  assert.throws(() => assertOccurrences({ tabs }, expected, origin));
});
