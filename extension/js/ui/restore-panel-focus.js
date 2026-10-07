// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Stable focus identities for controls replaced during the Restore workflow. */
export function markRestoreFocus(node, identity) {
  node.dataset.restoreFocusId = identity;
  return node;
}

/** Capture only focus owned by one of the Restore panel's replaceable hosts. */
export function captureRestoreFocus(document, hosts) {
  const active = document.activeElement;
  const inside = Boolean(active && hosts.some((host) => host?.contains?.(active)));
  return {
    active,
    inside,
    identity: inside ? active.dataset?.restoreFocusId ?? "" : ""
  };
}

/** Restore an equivalent control, or a deliberate workflow fallback, synchronously. */
export function restoreRestoreFocus({ document, snapshot, findIdentity, fallback = null }) {
  if (!snapshot?.inside) return null;
  const active = document.activeElement;
  const moved = active && active !== document.body && active !== snapshot.active &&
    active.isConnected !== false;
  if (moved) return null;
  const equivalent = snapshot.identity ? findIdentity(snapshot.identity) : null;
  const target = equivalent && equivalent.isConnected !== false ? equivalent : fallback;
  if (target?.isConnected !== false && typeof target?.focus === "function") target.focus();
  return target ?? null;
}
