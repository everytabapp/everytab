// Paste into the EveryTab Dashboard DevTools console before another reload.
// Read-only: logs JSON once. Promise {<fulfilled>: undefined} is normal console output.
(async () => {
  const result = {
    diagnostic: 'unavailable',
    context: { document: false, extensionProtocol: false, runtime: false },
    version: null,
    steps: {
      context: { status: 'skipped' }, version: { status: 'skipped' },
      import: { status: 'skipped' }, storeRead: { status: 'skipped' },
      notifications: { status: 'skipped' }
    },
    cycle: null,
    retained: { final: null, starting: null }
  };
  const get = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const length = value => {
    try { return Array.isArray(value) ? count(get(value, 'length')) : null; }
    catch { return null; }
  };
  const record = value => {
    try { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    catch { return false; }
  };
  const failure = error => {
    const name = get(error, 'name');
    const allowed = ['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'SecurityError',
      'NotAllowedError', 'AbortError', 'InvalidStateError', 'QuotaExceededError'];
    return { status: 'failed', error: allowed.includes(name) ? name : 'unknown' };
  };
  let cycleId = null;
  try {
    result.context.document = typeof document === 'object' && document !== null;
    result.context.extensionProtocol = typeof location === 'object' && location?.protocol === 'chrome-extension:';
    result.context.runtime = typeof chrome === 'object' && typeof chrome?.runtime?.getURL === 'function';
    if (!result.context.document || !result.context.extensionProtocol || !result.context.runtime) {
      result.steps.context = { status: 'wrong-context' };
      result.diagnostic = 'wrong-context';
      return;
    }
    result.steps.context = { status: 'ok' };
    try {
      const version = chrome.runtime.getManifest().version;
      if (typeof version === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(version) &&
          version.split('.').every(part => Number(part) <= 65535)) {
        result.version = version;
        result.steps.version = { status: 'ok' };
      } else result.steps.version = { status: 'invalid' };
    } catch (error) { result.steps.version = failure(error); }

    let store = null;
    try {
      const source = new URL(chrome.runtime.getURL('js/lib/store.js'));
      // Import only this document's owned Store module, never an arbitrary URL.
      if (source.protocol !== 'chrome-extension:' || source.host !== location.host ||
          source.pathname !== '/js/lib/store.js' || source.search || source.hash) {
        result.steps.import = { status: 'invalid' };
      } else {
        store = await import(source.href);
        result.steps.import = { status: 'ok' };
      }
    } catch (error) { result.steps.import = failure(error); }
    if (store) {
      try {
        if (typeof store.readStoreValue !== 'function') result.steps.storeRead = { status: 'unavailable' };
        else {
          const cycle = await store.readStoreValue('suspendRecoveryCycle');
          if (cycle != null && !record(cycle)) result.steps.storeRead = { status: 'invalid' };
          else {
            const id = get(cycle, 'id');
            cycleId = typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : null;
            const state = get(cycle, 'notificationState');
            result.cycle = {
              hasCycle: cycleId !== null, complete: get(cycle, 'complete') === true,
              repaired: count(get(cycle, 'total')), summary: count(get(cycle, 'summaryTotal')),
              initiallySuspended: length(get(cycle, 'initialOccurrenceIds')),
              alreadyReady: length(get(cycle, 'alreadyReadyOccurrenceIds')),
              state: ['collecting', 'pending', 'notified', 'failed', 'none'].includes(state) ? state : 'unknown',
              attempts: count(get(cycle, 'notificationAttempts'))
            };
            result.steps.storeRead = { status: 'ok' };
          }
        }
      } catch (error) { result.steps.storeRead = failure(error); }
    }
    try {
      if (typeof chrome.notifications?.getAll !== 'function') result.steps.notifications = { status: 'unavailable' };
      else {
        const notifications = await chrome.notifications.getAll();
        if (!record(notifications)) result.steps.notifications = { status: 'invalid' };
        else {
          // Never enumerate, log or serialize notification identities/payloads.
          if (cycleId !== null) result.retained = {
            final: Object.hasOwn(notifications, `suspend-recovered:${cycleId}`),
            starting: Object.hasOwn(notifications, `suspend-recovering:${cycleId}`)
          };
          result.steps.notifications = { status: 'ok' };
        }
      }
    } catch (error) { result.steps.notifications = failure(error); }
    result.diagnostic = Object.values(result.steps).every(step => step.status === 'ok') ? 'complete' : 'partial';
  } catch (error) {
    // Context property access can itself fail. Only its allowlisted class is retained.
    result.steps.context = failure(error);
  } finally {
    console.log(JSON.stringify(result, null, 2));
  }
})();
