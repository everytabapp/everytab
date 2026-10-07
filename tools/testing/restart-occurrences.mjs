// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';

/** Select synthetic pages without treating ordinary extension tabs as fixtures. */
export function fixtureTabs(snapshot, origin) {
  return snapshot.tabs.flatMap(tab => {
    const raw = tab.pendingUrl || tab.url || '';
    const suspended = raw.includes('/suspend.html?');
    const url = suspended ? new URL(raw).searchParams.get('originalUrl') : raw;
    return url?.startsWith(origin + '/') ? [{ ...tab, original: url, suspended,
      occurrence: suspended ? new URL(raw).searchParams.get('recoveryOccurrenceId') : null }] : [];
  });
}

/** Chrome renumbers windows on restart; compare their complete member identities. */
export function assertOccurrences(snapshot, expected, origin) {
  const tabs = fixtureTabs(snapshot, origin);
  assert.deepEqual(tabs.map(t => t.original).sort(), expected.map(t => t.original).sort(),
    'exact original-URL multiplicity survives');
  assert.deepEqual(tabs.filter(t => t.suspended).map(t => t.occurrence).sort(),
    expected.filter(t => t.suspended).map(t => t.occurrence).sort(),
    'exact suspended occurrences survive once each');
  assert.equal(tabs.filter(t => !t.suspended).length, expected.filter(t => !t.suspended).length,
    'awake fixture tabs remain awake');
  const windows = values => [...Map.groupBy(values, t => t.windowId).values()]
    .map(group => JSON.stringify(group.map(t =>
      JSON.stringify([t.original, t.suspended ? t.occurrence : null])).sort())).sort();
  assert.deepEqual(windows(tabs), windows(expected),
    'each suspended occurrence retains its source-window membership');
}
