// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value) => Number.isInteger(value) && value >= 0;
const isIdList = (value) => Array.isArray(value) && value.every(isId);
const isText = (value) => typeof value === "string";
const isNonEmptyText = (value) => isText(value) && value.trim().length > 0;
const isOptionalText = (value) => value === undefined || isText(value);
const isOrganizationAssignment = (value) => value == null || (
  isRecord(value) &&
  Array.isArray(value.groupIds) && value.groupIds.every(isNonEmptyText) &&
  Array.isArray(value.createNames) && value.createNames.every(isNonEmptyText)
);
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});
const identity = (session) => ({
  id: session?.id ?? null,
  name: session?.name ?? null
});

/**
 * Describe saved-Session creation, membership, and rename messages. Session
 * storage, journaling, and group assignment remain in the domain adapter; this
 * module owns public validation and the create-versus-add decision.
 *
 * @param {{
 *   tabs: {
 *     create: (tabIds: number[], name?: string, organization?: object|null) => Promise<object|null>,
 *     add: (sessionId: string, tabIds: number[]) => Promise<object|null>
 *   },
 *   windows: {
 *     create: (windowId: number, name?: string, organization?: object|null) => Promise<object|null>,
 *     add: (sessionId: string, windowId: number) => Promise<object|null>
 *   },
 *   rename: (sessionId: string, name: string) => Promise<object|null>
 * }} sessions
 */
export function createSessionMessageHandlers(sessions) {
  const validTarget = (message) => isOptionalText(message.name) &&
    isOptionalText(message.sessionId) && isOrganizationAssignment(message.organization);

  return [
    handler(
      "save-tabs-session",
      (message) => isIdList(message.tabIds) && validTarget(message),
      async (message) => identity(message.sessionId
        ? await sessions.tabs.add(message.sessionId, message.tabIds)
        : await sessions.tabs.create(message.tabIds, message.name, message.organization)),
      { id: null, name: null }
    ),
    handler(
      "save-window-session",
      (message) => isId(message.windowId) && validTarget(message),
      async (message) => identity(message.sessionId
        ? await sessions.windows.add(message.sessionId, message.windowId)
        : await sessions.windows.create(message.windowId, message.name, message.organization)),
      { id: null, name: null }
    ),
    handler(
      "rename-session",
      (message) => isNonEmptyText(message.id) && isText(message.name),
      async (message) => {
        const session = await sessions.rename(message.id, message.name);
        return { ok: !!session, name: session?.name ?? null };
      },
      { ok: false, name: null }
    )
  ];
}
