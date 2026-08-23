import { getVaultStatus, pickVaultFolder, reconnectVault } from "../vault/vault.js";
import { syncNow } from "../vault/sync.js";
import { coalesce, el, timeAgo } from "./dom.js";
import { shellSectionTitle } from "./shell-copy.js";

function stateForPill(status, meta, inFlight) {
  if (inFlight && status.state === "connected") return { cls: "", text: "syncing…" };
  switch (status.state) {
    case "connected":
      if (meta && !meta.ok) {
        return {
          cls: "warn",
          text: "sync failed" + (meta.lastSyncAt ? " · " + timeAgo(meta.lastSyncAt) : "")
        };
      }
      return {
        cls: "",
        text: "vault synced" + (meta?.lastSyncAt ? " · " + timeAgo(meta.lastSyncAt) : "")
      };
    case "needs-permission": return { cls: "warn", text: "vault: reconnect" };
    case "error": return { cls: "warn", text: "vault: error" };
    default: return { cls: "unset", text: "no vault" };
  }
}

/**
 * Owns Vault status, sync scheduling, recovery, banner copy, and its settings
 * surface. The Dashboard sees only the rendered pill projection and four
 * lifecycle methods.
 */
export function createVaultSurface({
  getBody, setHeading, getBanner, onStateChange, showNotice, goToVault
}) {
  let syncTimer = 0;
  let syncing = false;
  let lastSyncNoticeAt = 0;
  const render = coalesce(renderInner);

  async function currentMeta() {
    return (await chrome.storage.local.get("vaultMeta")).vaultMeta;
  }

  async function pillState() {
    const [status, meta] = await Promise.all([getVaultStatus(), currentMeta()]);
    return { ...stateForPill(status, meta, syncing), status };
  }

  function schedule() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(run, 3000);
  }

  async function run() {
    if (syncing) {
      schedule();
      return;
    }
    syncing = true;
    onStateChange();
    try {
      await syncNow();
    } finally {
      syncing = false;
    }
    await render();
    onStateChange();
    const meta = await currentMeta();
    if (meta?.ok === false && meta.lastSyncAt && meta.lastSyncAt > lastSyncNoticeAt) {
      lastSyncNoticeAt = meta.lastSyncAt;
      showNotice(
        "Vault sync failed. Your data is safe on this device.",
        goToVault,
        "Details"
      );
    }
  }

  function renderBanner(status, meta) {
    const banner = getBanner();
    if (status.state === "needs-permission") {
      banner.classList.remove("hidden");
      banner.replaceChildren(
        el("span", {}, `Chrome dropped access to your vault folder “${status.name}” after restart.`),
        el("button", { onclick: async () => {
          const next = await reconnectVault();
          if (next.state === "connected") await run();
          else await render();
        } }, "Reconnect vault")
      );
      return;
    }
    const failed = status.state === "error" ||
      (status.state === "connected" && meta?.ok === false);
    if (failed) {
      const why = status.state === "error" ? status.message : meta?.error;
      banner.classList.remove("hidden");
      banner.replaceChildren(
        el("span", {}, `Vault sync didn’t finish${why ? ` (${why})` : ""}. Your data is safe on this device. Nothing was lost.`),
        el("button", { onclick: run }, "Try again"),
        el("button", { class: "mini2", onclick: goToVault }, "Details")
      );
      return;
    }
    banner.classList.add("hidden");
    banner.replaceChildren();
  }

  async function renderInner() {
    const [status, meta] = await Promise.all([getVaultStatus(), currentMeta()]);
    renderBanner(status, meta);
    setHeading(shellSectionTitle("vault"));

    const badge = status.state === "connected"
      ? el("span", { class: "status ok" }, `connected: ${status.name}`)
      : status.state === "needs-permission"
        ? el("span", { class: "status warn" }, `needs reconnect: ${status.name}`)
        : status.state === "error"
          ? el("span", { class: "status danger" }, `error: ${status.message}`)
          : el("span", { class: "status unset" }, "not configured");

    const lastSync = !meta
      ? "Never synced."
      : meta.ok
        ? `Last sync ${timeAgo(meta.lastSyncAt)}: pulled ${meta.pulled}, pushed ${meta.pushed}` +
          (meta.conflictCopies
            ? `, merged ${meta.conflictCopies} conflict cop${meta.conflictCopies === 1 ? "y" : "ies"}`
            : "") +
          (meta.backedUp ? ", backup written" : "")
        : `Last sync ${timeAgo(meta.lastSyncAt)} didn't complete: ${meta.error}. ` +
          "Try Sync now, or reconnect the folder if the permission was lost.";

    const actions = el("div", { class: "vault-row" },
      el("button", { onclick: async () => {
        await pickVaultFolder();
        await run();
      } }, status.state === "unset" ? "Connect folder…" : "Change folder…"));
    if (status.state === "needs-permission") {
      actions.append(el("button", { onclick: async () => {
        const next = await reconnectVault();
        if (next.state === "connected") await run();
        else await render();
      } }, "Reconnect"));
    }
    if (status.state === "connected") {
      actions.append(el("button", { onclick: run }, "Sync now"));
    }

    getBody().replaceChildren(
      el("div", {}, badge),
      actions,
      el("div", { class: meta && !meta.ok ? "note bad" : "note" }, lastSync),
      el("div", { class: "note" },
        "Plain JSON in a folder you own. Sync it with Dropbox/GDrive/iCloud. Auto-syncs while this dashboard is open; daily backups kept in backups/, browsable index.md included.")
    );
  }

  return {
    render,
    pillState,
    start: () => { void run(); },
    schedule
  };
}
