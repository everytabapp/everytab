import { createChromeI18nMock } from "./message-fixture.mjs";

/**
 * Install the shared Chrome test double used by the smoke suites.
 *
 * Scenario data deliberately stays with the suite that owns it. The adapter
 * receives fresh state through functions so a test can replace an array or
 * map without leaving the Chrome API wired to an obsolete reference.
 *
 * @param {{
 *   storage: () => { local: Record<string, unknown>, session: Record<string, unknown> },
 *   windows: () => { live: Array<object>, created: Array<object>, removedIds: number[], currentId: number|null },
 *   tabs: () => { removedIds: number[], createdUrls: string[], updated: object[], discardedIds: number[], moves: object[] },
 *   effects: () => { alarms: Record<string, unknown>, notifications: object[], badgeTexts: string[] },
 *   groups: () => { records: Record<number, object>, groupCalls: object[], updateCalls: object[], fail: boolean },
 *   nextGroupId: () => number,
 *   permissions: () => { granted: Set<string>, requestGrants: boolean }
 * }} scenario
 */
export function installSmokeChrome(scenario) {
  const allWindows = () => {
    const { live, created } = scenario.windows();
    return [...live, ...created];
  };

  globalThis.chrome = {
    i18n: createChromeI18nMock(),
    runtime: {
      getURL: (path) => `chrome-extension://test-ext-id/${path}`
    },
    alarms: {
      create: async (name, info) => {
        scenario.effects().alarms[name] = info;
      },
      clear: async (name) => {
        delete scenario.effects().alarms[name];
      }
    },
    notifications: {
      create: async (id, opts) => {
        scenario.effects().notifications.push({ id, ...opts });
        return id;
      }
    },
    action: {
      setBadgeText: async ({ text }) => scenario.effects().badgeTexts.push(text),
      setBadgeBackgroundColor: async () => {}
    },
    storage: {
      local: {
        get: async (keys) => {
          const local = scenario.storage().local;
          if (typeof keys === "string") return keys in local ? { [keys]: local[keys] } : {};
          const out = {};
          for (const key of keys) if (key in local) out[key] = local[key];
          return out;
        },
        set: async (obj) => Object.assign(scenario.storage().local, obj)
      },
      session: {
        get: async (key) => {
          const session = scenario.storage().session;
          return key in session ? { [key]: session[key] } : {};
        },
        set: async (obj) => Object.assign(scenario.storage().session, obj),
        remove: async (key) => {
          delete scenario.storage().session[key];
        }
      }
    },
    windows: {
      getAll: async () => scenario.windows().live,
      getCurrent: async () => {
        const { live, currentId } = scenario.windows();
        const win = live.find((entry) => entry.id === currentId) ?? live[0];
        if (!win) throw new Error("no current window");
        return { ...win };
      },
      get: async (id) => {
        const win = allWindows().find((entry) => entry.id === id);
        if (!win) throw new Error("no such window " + id);
        return { ...win, tabs: (win.tabs ?? []).map((tab) => ({ ...tab, windowId: win.id })) };
      },
      create: async (arg) => {
        const windows = scenario.windows();
        if (arg && "tabId" in arg) {
          const win = { id: 100 + windows.created.length, tabs: [{ id: arg.tabId, index: 0 }] };
          windows.created.push(win);
          return { ...win, id: win.id };
        }
        const urls = Array.isArray(arg.url) ? arg.url : [arg.url];
        const win = {
          id: 100 + windows.created.length,
          tabs: urls.map((url, index) => ({ id: 1000 + index, index, url }))
        };
        windows.created.push(win);
        return win;
      },
      remove: async (id) => {
        const windows = scenario.windows();
        let index = windows.live.findIndex((entry) => entry.id === id);
        if (index >= 0) windows.live.splice(index, 1);
        else {
          index = windows.created.findIndex((entry) => entry.id === id);
          if (index < 0) throw new Error("no such window " + id);
          windows.created.splice(index, 1);
        }
        windows.removedIds.push(id);
      }
    },
    tabs: {
      query: async ({ windowId } = {}) => {
        if (windowId === undefined) {
          return allWindows().flatMap((win) =>
            win.tabs.map((tab) => ({ ...tab, windowId: win.id }))
          );
        }
        const win = allWindows().find((entry) => entry.id === windowId);
        return win ? win.tabs : [];
      },
      get: async (id) => {
        for (const win of allWindows()) {
          const tab = win.tabs.find((entry) => entry.id === id);
          if (tab) return { ...tab, windowId: win.id };
        }
        throw new Error("no such tab " + id);
      },
      update: async (id, props) => {
        scenario.tabs().updated.push({ id, ...props });
        return { id, ...props };
      },
      move: async (ids, props) => {
        scenario.tabs().moves.push({ ids, props });
        return Array.isArray(ids) ? ids.map((id) => ({ id })) : { id: ids };
      },
      group: async ({ tabIds, createProperties }) => {
        const groups = scenario.groups();
        if (groups.fail) throw new Error("group failed");
        const groupId = scenario.nextGroupId();
        groups.groupCalls.push({ tabIds, windowId: createProperties?.windowId, groupId });
        groups.records[groupId] = groups.records[groupId] ?? { id: groupId };
        return groupId;
      },
      remove: async (ids) => {
        const tabs = scenario.tabs();
        const removed = Array.isArray(ids) ? ids : [ids];
        tabs.removedIds.push(...removed);
        const removedSet = new Set(removed);
        for (const win of allWindows()) {
          win.tabs = (win.tabs ?? []).filter((tab) => !removedSet.has(tab.id));
          win.tabs.forEach((tab, index) => { tab.index = index; });
        }
      },
      create: async ({ url, windowId }) => {
        const tabs = scenario.tabs();
        tabs.createdUrls.push(url);
        const windows = scenario.windows();
        const tab = {
          id: 9000 + tabs.createdUrls.length,
          url,
          windowId: windowId ?? windows.live[0]?.id
        };
        const host = windows.live.find((entry) => entry.id === tab.windowId) ?? windows.live[0];
        host?.tabs?.push({ id: tab.id, index: host.tabs.length, windowId: host.id, url });
        return tab;
      },
      discard: async (id) => scenario.tabs().discardedIds.push(id)
    },
    tabGroups: {
      get: async (id) => {
        const record = scenario.groups().records[id];
        if (!record) throw new Error("no such group " + id);
        return { ...record };
      },
      update: async (id, props) => {
        const groups = scenario.groups();
        groups.updateCalls.push({ groupId: id, props });
        groups.records[id] = { ...(groups.records[id] ?? { id }), ...props };
        return { ...groups.records[id] };
      }
    },
    permissions: {
      contains: async ({ permissions }) => {
        const granted = scenario.permissions().granted;
        return (permissions ?? []).every((permission) => granted.has(permission));
      },
      request: async ({ permissions }) => {
        const state = scenario.permissions();
        if (state.requestGrants) {
          for (const permission of permissions ?? []) state.granted.add(permission);
        }
        return state.requestGrants;
      },
      remove: async ({ permissions }) => {
        const granted = scenario.permissions().granted;
        for (const permission of permissions ?? []) granted.delete(permission);
        return true;
      }
    }
  };

  return globalThis.chrome;
}
