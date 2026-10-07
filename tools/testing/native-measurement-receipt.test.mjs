// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMeasurementReceipt } from './native-measurement-receipt.mjs';

const url = 'http://127.0.0.1:1234/test/native-search-benchmark.html?scenario=1&round=2';
const trial = { round: 2, records: 10_000, icons: 64 };
const timings = ['primaryResolvedMs', 'progressivePrimaryMs', 'completionResolvedMs',
  'primaryDomReadyMs', 'primaryFrameOpportunityMs', 'completionDomReadyMs', 'completionFrameOpportunityMs'];
function observation() {
  return { href: url, state: { status: 'pass', report: {
    result: { ...trial, phases: [
      'first', 'warm-immediate', 'warm-immediate', 'warm-immediate', 'warm-expired', 'after-edit'
    ].map(phase => ({ phase, ...Object.fromEntries(timings.map((field, index) => [field, index])),
      primaryRowsStillCurrentAtFrame: false, completionRowsStillCurrentAtFrame: true })) },
    cleanup: { deletedDatabases: 2 }
  } } };
}

test('old document success and failure cannot satisfy the current trial', () => {
  for (const status of ['pass', 'fail']) {
    const old = observation();
    old.href = url.replace('round=2', 'round=1');
    old.state.status = status;
    assert.equal(inspectMeasurementReceipt(old, url, trial), null);
  }
  const otherScenario = observation();
  otherScenario.href = url.replace('scenario=1', 'scenario=0');
  assert.equal(inspectMeasurementReceipt(otherScenario, url, trial), null);
});

test('navigation and running states remain pending', () => {
  for (const observed of [undefined, null, {}, { href: url }, { href: url, state: null },
    { href: url, state: { status: 'running', progress: { phase: 'seed' } } }]) {
    assert.equal(inspectMeasurementReceipt(observed, url, trial), null);
  }
});

test('a valid current trial returns its report unchanged, including superseded primary frames', () => {
  const observed = observation();
  const before = structuredClone(observed);
  assert.equal(inspectMeasurementReceipt(observed, url, trial), observed.state.report);
  assert.deepEqual(observed, before, 'inspection has no mutation or frame-current inference');
});

test('page failures do not leak page-provided error messages', () => {
  const observed = { href: url, state: { status: 'fail', error: 'private https://private.invalid/title' } };
  assert.throws(() => inspectMeasurementReceipt(observed, url, trial),
    { message: 'Native measurement page reported failure' });
});

test('malformed terminal states and reports are rejected', () => {
  for (const state of [{ status: 'unknown' }, {}, { status: 'pass' },
    { status: 'pass', report: null }, { status: 'pass', report: [] }]) {
    assert.throws(() => inspectMeasurementReceipt({ href: url, state }, url, trial), /Malformed/);
  }
  for (const result of [undefined, null, [], 'invalid']) {
    const observed = observation();
    observed.state.report.result = result;
    assert.throws(() => inspectMeasurementReceipt(observed, url, trial), /does not match/);
  }
});

test('each trial identity and database cleanup count must match exactly', () => {
  for (const field of ['round', 'records', 'icons']) for (const value of [undefined, trial[field] + 1, String(trial[field])]) {
    const observed = observation();
    observed.state.report.result[field] = value;
    assert.throws(() => inspectMeasurementReceipt(observed, url, trial), /does not match/);
  }
  for (const cleanup of [undefined, {}, { deletedDatabases: 1 }, { deletedDatabases: 3 }, { deletedDatabases: '2' }]) {
    const observed = observation();
    observed.state.report.cleanup = cleanup;
    assert.throws(() => inspectMeasurementReceipt(observed, url, trial), /database cleanup/);
  }
});

test('missing, extra, reordered and mislabeled Search phases are rejected', () => {
  const variants = [
    phases => phases.slice(1),
    phases => [...phases, phases[0]],
    phases => [...phases].reverse(),
    phases => phases.map((phase, index) => index === 2 ? { ...phase, phase: 'warm-expired' } : phase),
    phases => phases.map((phase, index) => index === 4 ? null : phase),
    () => null
  ];
  for (const change of variants) {
    const observed = observation();
    observed.state.report.result.phases = change(observed.state.report.result.phases);
    assert.throws(() => inspectMeasurementReceipt(observed, url, trial), /phase sequence/);
  }
});

test('all six phases require every resolved, DOM and frame timing to be finite numeric values', () => {
  for (let index = 0; index < 6; index++) for (const field of timings) {
    for (const invalid of [undefined, null, '1', NaN, Infinity, -1]) {
      const observed = observation();
      observed.state.report.result.phases[index][field] = invalid;
      assert.throws(() => inspectMeasurementReceipt(observed, url, trial), /timing value/,
        `phase ${index}, field ${field}, invalid ${String(invalid)}`);
    }
  }
});

test('Library mode retains its aggregate receipt and rejects missing results or cleanup', () => {
  const report = { results: [{ round: 1, records: 1000 }], cleanup: { deletedDatabases: 12 } };
  assert.equal(inspectMeasurementReceipt({ href: url, state: { status: 'pass', report } }, url), report);
  for (const invalid of [{}, { results: [], cleanup: report.cleanup },
    { results: report.results }, { results: report.results, cleanup: { deletedDatabases: -1 } }]) {
    assert.throws(() => inspectMeasurementReceipt({ href: url, state: { status: 'pass', report: invalid } }, url),
      /Malformed Library/);
  }
});

test('only fixed fixture failure codes and phases survive diagnostics', () => {
  const state = { status: 'fail', failureCode: 'warm-cadence', failedPhase: 'warm-immediate' };
  assert.throws(() => inspectMeasurementReceipt({ href: url, state }, url, trial),
    { message: 'Native measurement page reported failure (warm-cadence, warm-immediate)' });
  state.failureCode = 'private https://private.invalid/title';
  assert.throws(() => inspectMeasurementReceipt({ href: url, state }, url, trial),
    { message: 'Native measurement page reported failure' });
});

function mixedObservation(workload) {
  const mixedTrial = { round: 2, records: 1000, icons: 64, inboxTabs: 100,
    namedSessions: 10, snapshots: 20, tabsPerSession: 30, workload };
  const expectedUrl = `http://127.0.0.1:1234/test/native-mixed-search-benchmark.html?scenario=0&workload=${workload}&round=2`;
  const observed = observation();
  observed.href = expectedUrl;
  Object.assign(observed.state.report.result, mixedTrial);
  observed.state.report.result.phases = observed.state.report.result.phases.map(phase => {
    if (workload === 'facets') return { phase: phase.phase, resolvedMs: 1, calls: [], requests: {} };
    return { ...phase, calls: [], requests: { 'assets.get': 0 }, ...(workload === 'broad' ? {
      completionResolvedMs: null, completionDomReadyMs: null, completionFrameOpportunityMs: null,
      completionRowsStillCurrentAtFrame: null
    } : {}) };
  });
  return { observed, expectedUrl, mixedTrial };
}

test('mixed selective, broad and facet receipts retain their distinct timing contracts', () => {
  for (const workload of ['selective', 'broad', 'facets']) {
    const { observed, expectedUrl, mixedTrial } = mixedObservation(workload);
    assert.equal(inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), observed.state.report);
    observed.href = expectedUrl.replace(`workload=${workload}`, 'workload=previous');
    assert.equal(inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), null,
      'a previous workload document cannot satisfy this workload');
  }
});

test('every mixed scenario dimension and workload must match the current trial', () => {
  for (const workload of ['selective', 'broad', 'facets']) {
    const valid = mixedObservation(workload);
    for (const key of Object.keys(valid.mixedTrial)) {
      const { observed, expectedUrl, mixedTrial } = mixedObservation(workload);
      observed.state.report.result[key] = key === 'workload' ? 'another-workload' : mixedTrial[key] + 1;
      assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /does not match/, key);
      delete observed.state.report.result[key];
      assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /does not match/, key);
    }
  }
  const { observed, expectedUrl, mixedTrial } = mixedObservation('unrecognized');
  assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /does not match/);
});

test('mixed phase sequence and two-database cleanup are mandatory for each workload', () => {
  for (const workload of ['selective', 'broad', 'facets']) {
    const { observed, expectedUrl, mixedTrial } = mixedObservation(workload);
    observed.state.report.cleanup.deletedDatabases = 1;
    assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /database cleanup/);
    observed.state.report.cleanup.deletedDatabases = 2;
    observed.state.report.result.phases.pop();
    assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /phase sequence/);
    const reordered = mixedObservation(workload);
    reordered.observed.state.report.result.phases.reverse();
    assert.throws(() => inspectMeasurementReceipt(reordered.observed, reordered.expectedUrl, reordered.mixedTrial), /phase sequence/);
  }
});

test('mixed workloads reject missing or invalid required timings in every phase', () => {
  const fields = {
    selective: timings,
    broad: ['primaryResolvedMs', 'progressivePrimaryMs', 'primaryDomReadyMs', 'primaryFrameOpportunityMs'],
    facets: ['resolvedMs']
  };
  for (const [workload, required] of Object.entries(fields)) for (let index = 0; index < 6; index++) {
    for (const field of required) for (const value of [undefined, null, NaN, Infinity, -1, '1']) {
      const { observed, expectedUrl, mixedTrial } = mixedObservation(workload);
      observed.state.report.result.phases[index][field] = value;
      assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /timing value/,
        `${workload}, phase ${index}, ${field}`);
    }
  }
});

test('broad results cannot invent completion timing and facets cannot invent DOM or frame observations', () => {
  for (let index = 0; index < 6; index++) {
    for (const field of ['completionResolvedMs', 'completionDomReadyMs', 'completionFrameOpportunityMs']) {
      for (const value of [undefined, 0, 1, '0']) {
        const { observed, expectedUrl, mixedTrial } = mixedObservation('broad');
        observed.state.report.result.phases[index][field] = value;
        assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /must not claim completion/);
      }
    }
    for (const field of [...timings, 'primaryRowsStillCurrentAtFrame', 'completionRowsStillCurrentAtFrame']) {
      const { observed, expectedUrl, mixedTrial } = mixedObservation('facets');
      observed.state.report.result.phases[index][field] = field.endsWith('Frame') ? false : 0;
      assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /must not claim mounted/);
      observed.state.report.result.phases[index][field] = null;
      assert.equal(inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), observed.state.report,
        'an explicit null makes no DOM or frame claim');
    }
  }
});

test('all mixed phases require request evidence with no asset reads', () => {
  for (const workload of ['selective', 'broad', 'facets']) for (let index = 0; index < 6; index++) {
    for (const count of [1, -1, '0', null, undefined]) {
      const { observed, expectedUrl, mixedTrial } = mixedObservation(workload);
      observed.state.report.result.phases[index].requests['assets.get'] = count;
      assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /zero asset reads/);
    }
    for (const field of ['calls', 'requests']) {
      const { observed, expectedUrl, mixedTrial } = mixedObservation(workload);
      delete observed.state.report.result.phases[index][field];
      assert.throws(() => inspectMeasurementReceipt(observed, expectedUrl, mixedTrial), /request evidence/);
    }
  }
});

test('mixed contract failure is reported only with a fixed phase label', () => {
  const state = { status: 'fail', failureCode: 'mixed-contract', failedPhase: 'seed' };
  assert.throws(() => inspectMeasurementReceipt({ href: url, state }, url, trial),
    { message: 'Native measurement page reported failure (mixed-contract, seed)' });
  state.failedPhase = 'private user data';
  assert.throws(() => inspectMeasurementReceipt({ href: url, state }, url, trial),
    { message: 'Native measurement page reported failure (mixed-contract)' });
});
