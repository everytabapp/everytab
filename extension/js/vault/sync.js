/**
 * M5 — vault sync engine (PRD §4).
 * Two-way merge between chrome.storage.local and the vault folder.
 * Runs in extension page contexts (dashboard) — FSA is unavailable in the
 * MV3 service worker. The working store never depends on the vault: sync
 * always compares full state, so writes "queued" while disconnected are
 * implicit and flush on the next successful sync.
 *
 * `syncWithHandle(root)` takes the directory handle as a parameter so the
 * two-device merge suite can drive it in Node with an in-memory FSA mock.
 */

import { STORE_KEYS, SCHEMA_VERSION, ARCHIVE_OVERLAY_KEY } from "../lib/types.js";
import { listItems, withStoreLock, readFreshStoreMap } from "../lib/store.js";
import { mergeMaps, mergeRecord, mergeLabelMeta } from "../lib/merge.js";
import { buildJsonExport } from "../lib/export.js";
import {
  inspectPortableRecord, isPortableRecordId, isPortableVaultFile,
  portableStateEntries, portableVaultFileId, portableVaultFileName
} from "../lib/portable-state.js";
import { getVaultHandle, getVaultStatus } from "./vault.js";
import { bump } from "../lib/counters.js";
import { collectLabels } from "../lib/labels.js";
import { projectOrganization, readOrganizationState } from "../lib/organization.js";

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const BACKUP_FILE = /^tabvault-\d{4}-\d{2}-\d{2}\.json$/;
const BACKUPS_KEPT = 7;

/* ---------- small FS helpers ---------- */

async function readTextFromHandle(fileHandle) {
  try {
    return await (await fileHandle.getFile()).text();
  } catch {
    return null;
  }
}

function parseJson(text) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

const writeJson = (dir, name, obj) => writeText(dir, name, JSON.stringify(obj, null, 2));

/** All .json files in a dir: [{name, handle}]. */
async function jsonFiles(dir) {
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && name.endsWith(".json")) out.push({ name, handle });
  }
  return out;
}

async function getRawMap(key) {
  if (key === STORE_KEYS.archive) return readFreshStoreMap(key);
  const r = await chrome.storage.local.get(key);
  return r[key] ?? {};
}

/* ---------- per-item stores ---------- */

async function syncItemStore(root, entry, report) {
  const key = entry.key;
  const dir = await root.getDirectoryHandle(entry.vault.path, { create: true });

  /** @type {Record<string, object>} */
  const remote = {};
  /** conflict copies safe to fold only after their canonical id is writable */
  const conflictFiles = [];
  /** ids seen in conflict copies — their canonical file must be (re)written */
  const conflictIds = new Set();
  /** UUIDs occupied by opaque canonical/conflict files that sync cannot rewrite. */
  const protectedIds = new Set();

  for (const { name, handle } of await jsonFiles(dir)) {
    const data = parseJson(await readTextFromHandle(handle));
    const canonicalId = portableVaultFileId(entry, name);
    const inspected = inspectPortableRecord(entry, data);
    if (canonicalId && (inspected.status !== "current" || inspected.id !== canonicalId)) {
      protectedIds.add(canonicalId);
      if (inspected.id) protectedIds.add(inspected.id);
      continue;
    }
    if (inspected.status !== "current") {
      if (inspected.id) protectedIds.add(inspected.id);
      continue;
    }
    if (isPortableVaultFile(entry, name)) {
      remote[data.id] = mergeRecord(remote[data.id], data);
    } else {
      remote[data.id] = mergeRecord(remote[data.id], data);
      conflictFiles.push({ name, id: data.id });
      conflictIds.add(data.id);
    }
  }

  // E2-0d (§4.4): the merge phase — local read → in-memory merge → one set —
  // runs UNDER the store lock so a local mutation lands either before the read
  // (and is merged/pushed) or after the set (and survives, pushed next sync);
  // it can never fall in the read-set window and be dropped (R3). All FSA reads
  // are done above; all FSA writes are below — the lock holds only the merge.
  let merged;
  let pushed;
  let pulledCount = 0;
  await withStoreLock(async () => {
    const local = await getRawMap(key);
    const res = mergeMaps(local, remote);
    merged = res.merged;
    pushed = res.pushed.filter((id) => !protectedIds.has(id));
    pulledCount = res.pulled.length;
    if (res.pulled.length > 0) await chrome.storage.local.set({ [key]: merged });
  });

  const toWrite = new Set([...pushed, ...[...conflictIds].filter((id) => !protectedIds.has(id))]);
  for (const id of toWrite) {
    if (merged[id]) await writeJson(dir, portableVaultFileName(entry, id), merged[id]);
  }
  const handledConflicts = conflictFiles.filter(({ id }) => !protectedIds.has(id));
  for (const { name } of handledConflicts) {
    try {
      await dir.removeEntry(name);
    } catch {
      /* provider may have removed it already */
    }
  }

  report.pulled += pulledCount;
  report.pushed += pushed.length;
  report.conflictCopies += handledConflicts.length;
}

/* ---------- archive: append-only daily files ---------- */

function dayOf(record) {
  return new Date(record.archivedAt ?? record.modifiedAt).toISOString().slice(0, 10);
}

function safeDayOf(record) {
  try { return dayOf(record); }
  catch { return null; }
}

async function syncArchive(root, entry, report) {
  const dir = await root.getDirectoryHandle(entry.vault.path, { create: true });

  /** @type {Record<string, object>} */
  const remote = {};
  /** @type {Record<string, string>} raw text per day file, for change detection */
  const dayText = {};
  const conflictFiles = [];
  const protectedIds = new Set();
  const protectedDays = new Set();

  for (const { name, handle } of await jsonFiles(dir)) {
    const text = await readTextFromHandle(handle);
    const data = parseJson(text);
    const fileDay = /^\d{4}-\d{2}-\d{2}/.test(name) ? name.slice(0, 10) : null;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      if (fileDay) protectedDays.add(fileDay);
      continue;
    }
    const records = [];
    let opaque = false;
    for (const [mapId, record] of Object.entries(data)) {
      const inspected = inspectPortableRecord(entry, record);
      if (inspected.status !== "current" || inspected.id !== mapId) {
        opaque = true;
        if (isPortableRecordId(entry, mapId)) protectedIds.add(mapId);
        if (inspected.id) protectedIds.add(inspected.id);
        continue;
      }
      records.push(record);
    }
    if (opaque) {
      if (fileDay) protectedDays.add(fileDay);
      // A future conflict may not retain the provider's original day prefix.
      // Its own archive timestamp still reserves the day it belongs to.
      for (const record of Object.values(data)) {
        const recordDay = safeDayOf(record);
        if (recordDay) protectedDays.add(recordDay);
      }
      continue;
    }
    for (const rec of records) remote[rec.id] = mergeRecord(remote[rec.id], rec);
    if (DAY_FILE.test(name)) dayText[name.slice(0, 10)] = text;
    else conflictFiles.push({ name, ids: records.map((record) => record.id) });
  }

  // E2-0d (§4.4): merge phase under the store lock (FSA reads above, writes
  // below) — closes R3 for the archive store too.
  let merged;
  let pushed;
  let pulledCount = 0;
  await withStoreLock(async () => {
    const local = await getRawMap(STORE_KEYS.archive);
    const res = mergeMaps(local, remote);
    merged = res.merged;
    pushed = res.pushed.filter((id) => {
      if (protectedIds.has(id)) return false;
      const record = res.merged[id];
      return record && !protectedDays.has(dayOf(record));
    });
    pulledCount = res.pulled.length;
    if (res.pulled.length > 0) {
      // The pull replaces the complete logical Archive snapshot, so fold any
      // local write overlay into it and clear that overlay at the same commit.
      await chrome.storage.local.set({
        [STORE_KEYS.archive]: merged,
        [ARCHIVE_OVERLAY_KEY]: {}
      });
    }
  });

  // Regroup by day and write back only days whose content changed.
  /** @type {Record<string, Record<string, object>>} */
  const byDay = {};
  for (const rec of Object.values(merged)) {
    if (protectedIds.has(rec.id)) continue;
    (byDay[dayOf(rec)] ??= {})[rec.id] = rec;
  }
  for (const [day, map] of Object.entries(byDay)) {
    if (protectedDays.has(day)) continue;
    const text = JSON.stringify(map, null, 2);
    if (dayText[day] !== text) await writeText(dir, `${day}.json`, text);
  }
  const handledConflicts = conflictFiles.filter(({ ids }) => ids.every((id) => {
    const record = merged[id];
    return !protectedIds.has(id) && record && !protectedDays.has(dayOf(record));
  }));
  for (const { name } of handledConflicts) {
    try {
      await dir.removeEntry(name);
    } catch {
      /* ignore */
    }
  }

  report.pulled += pulledCount;
  report.pushed += pushed.length;
  report.conflictCopies += handledConflicts.length;
}

/* ---------- settings: whole-object LWW ---------- */

async function syncSettings(root, entry, now, report) {
  // FSA reads first: newest of settings.json + any provider conflict copies.
  let remote = null;
  const conflictNames = [];
  let hasOpaqueSettingsFile = false;
  for (const { name, handle } of await jsonFiles(root)) {
    const stem = entry.vault.path.replace(/\.json$/i, "");
    if (!(new RegExp(`^${stem}.*\\.json$`)).test(name)) continue;
    const data = parseJson(await readTextFromHandle(handle));
    if (!data || typeof data.modifiedAt !== "number" || typeof data.settings !== "object") {
      if (name === entry.vault.path) hasOpaqueSettingsFile = true;
      continue;
    }
    if ((data.schemaVersion ?? 1) > SCHEMA_VERSION) {
      hasOpaqueSettingsFile = true;
      continue;
    }
    if (!remote || data.modifiedAt > remote.modifiedAt) remote = data;
    if (name !== entry.vault.path) conflictNames.push(name);
  }

  // A future canonical or conflict settings file represents one opaque
  // whole-object value. Do not infer absence from filtering it, and do not
  // rewrite/delete any member of that provider conflict set.
  if (hasOpaqueSettingsFile) return;

  // E2-0d (§4.4): read local settings FRESH under the store lock and commit the
  // pull inside it, so a concurrent patchSettings/saveSettings can't be clobbered
  // by a stale-based pull. Whole-object LWW is unchanged. The push write is FSA,
  // so it happens after the lock releases (payload captured under the lock).
  let pushPayload = null;
  await withStoreLock(async () => {
    const r = await chrome.storage.local.get([entry.key, entry.vault.timestampKey]);
    const localSettings = r[entry.key] ?? null;
    const localTs = r[entry.vault.timestampKey] ?? (localSettings ? 1 : 0);
    if (remote && remote.modifiedAt > localTs) {
      await chrome.storage.local.set({
        [entry.key]: remote.settings,
        [entry.vault.timestampKey]: remote.modifiedAt
      });
      report.pulled += 1;
    } else if (localSettings && (!remote || localTs > remote.modifiedAt)) {
      pushPayload = {
        schemaVersion: SCHEMA_VERSION,
        modifiedAt: localTs || now,
        settings: localSettings
      };
    }
  });

  if (pushPayload) {
    await writeJson(root, entry.vault.path, pushPayload);
    report.pushed += 1;
  }
  for (const name of conflictNames) {
    try {
      await root.removeEntry(name);
      report.conflictCopies += 1;
    } catch {
      /* ignore */
    }
  }
}

/* ---------- label recency (F21): whole-map, per-key max merge ---------- */

/** Shallow equality of two `{label: number}` maps. */
function sameNumberMap(a, b) {
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b?.[k]) return false;
  return true;
}

/**
 * F21 — the label-recency register (`label → lastUsedAt`) syncs as a single
 * whole-map file, `labelMeta.json`, merged per-key by max (mergeLabelMeta), NOT
 * through syncItemStore (which is per-record + UUID-keyed; a label-name key would
 * collide with its conflict-copy detection). Same E2-0d lock discipline as
 * syncSettings: FSA read first, merge under the store lock, capture the push
 * payload under the lock, write after. Grow-only, so this never loses a key or
 * moves a timestamp backward.
 */
async function syncPerKeyMax(root, policy, report) {
  const entry = (await jsonFiles(root)).find((f) => f.name === policy.vault.path);
  const parsed = entry ? parseJson(await readTextFromHandle(entry.handle)) : null;
  const remote = parsed && typeof parsed === "object" ? parsed : {};

  let pushMap = null;
  await withStoreLock(async () => {
    const local = await getRawMap(policy.key);
    const merged = mergeLabelMeta(local, remote);
    if (!sameNumberMap(merged, local)) {
      await chrome.storage.local.set({ [policy.key]: merged });
      report.pulled += 1;
    }
    if (!sameNumberMap(merged, remote)) pushMap = merged;
  });

  if (pushMap) {
    await writeJson(root, policy.vault.path, pushMap);
    report.pushed += 1;
  }
}

/* ---------- rolling backups ---------- */

async function writeBackup(root, now, report) {
  const dir = await root.getDirectoryHandle("backups", { create: true });
  const today = new Date(now).toISOString().slice(0, 10);
  const name = `tabvault-${today}.json`;

  const names = (await jsonFiles(dir)).map((f) => f.name).filter((n) => BACKUP_FILE.test(n));
  if (!names.includes(name)) {
    await writeText(dir, name, await buildJsonExport());
    report.backedUp = true;
    names.push(name);
  }
  for (const old of names.sort().reverse().slice(BACKUPS_KEPT)) {
    try {
      await dir.removeEntry(old);
    } catch {
      /* ignore */
    }
  }
}

/* ---------- index.md ---------- */

async function buildIndexMd(now) {
  /** @type {import("../lib/types.js").Session[]} */
  const sessions = await listItems(STORE_KEYS.sessions);
  const named = sessions.filter((s) => !s.auto);
  const snapshots = sessions.length - named.length;
  /** @type {import("../lib/types.js").Collection[]} */
  const collections = await listItems(STORE_KEYS.collections);
  const [labelEntries, labelState, sessionState] = await Promise.all([
    collectLabels(),
    readOrganizationState("label"),
    readOrganizationState("session")
  ]);
  const labelOrganization = projectOrganization("label", labelEntries, labelState);
  const sessionOrganization = projectOrganization("session", named, sessionState);

  const day = new Date(now).toISOString().slice(0, 10);
  const lines = [
    "# EveryTab vault",
    "",
    `_Generated ${day}. Regenerated on every sync, do not edit._`,
    ""
  ];

  lines.push(`## Collections (${collections.length})`, "");
  for (const c of collections) {
    lines.push(`### ${c.name} (${c.tabs.length} tabs)`, "");
    for (const t of c.tabs) lines.push(`- [${t.title}](${t.url})`);
    lines.push("");
  }

  const appendOrganization = (title, projection, display) => {
    lines.push(`## ${title} (${projection.groups.length})`, "");
    for (const group of projection.groups) {
      lines.push(`### ${group.name} (${group.members.length})`, "");
      for (const member of group.members) lines.push(`- ${display(member.member)}`);
      lines.push("");
    }
    if (projection.ungrouped.length > 0) {
      lines.push(`### Ungrouped (${projection.ungrouped.length})`, "");
      for (const member of projection.ungrouped) lines.push(`- ${display(member.member)}`);
      lines.push("");
    }
  };

  appendOrganization("Label groups", labelOrganization, (entry) => entry.label);
  appendOrganization("Session groups", sessionOrganization, (session) => session.name);

  lines.push(`## Sessions (${named.length} named, ${snapshots} auto-snapshots)`, "");
  for (const s of named) {
    const tabCount = s.windows.reduce((n, w) => n + w.length, 0);
    lines.push(
      `### ${s.name} · ${s.windows.length} window${s.windows.length === 1 ? "" : "s"}, ${tabCount} tabs`,
      ""
    );
    for (const w of s.windows) for (const t of w) lines.push(`- [${t.title}](${t.url})`);
    lines.push("");
  }

  return lines.join("\n");
}

async function writeIndexMd(root, now) {
  const content = await buildIndexMd(now);
  let existing = null;
  try {
    existing = await readTextFromHandle(await root.getFileHandle("index.md"));
  } catch {
    /* not there yet */
  }
  if (existing !== content) await writeText(root, "index.md", content);
}

/* ---------- entry points ---------- */

/**
 * Full two-way sync against a directory handle. Idempotent: a second run
 * with no changes writes nothing (this also terminates the dashboard's
 * onChanged → sync → onChanged loop).
 * E2-0d (§4.4): the whole run holds "everytab-vault-sync" with ifAvailable, so
 * a second dashboard context that boots/schedules a sync while one is already
 * running SKIPS instead of queueing a redundant, RMW-doubling pass (sync is
 * idempotent; the next scheduled sync picks up anything new). A skipped run
 * returns `skipped: true` and touches nothing. This is acquired OUTSIDE the
 * per-store "everytab-store" lock (which the merge phases take), so the lock
 * order is always vault-sync → store — no other path acquires them the other
 * way, so there is no deadlock.
 * @param {FileSystemDirectoryHandle} root
 * @param {number} [now] injectable for tests
 * @returns {Promise<{pulled:number, pushed:number, conflictCopies:number, backedUp:boolean, skipped?:boolean}>}
 */
export async function syncWithHandle(root, now = Date.now()) {
  return navigator.locks.request(
    "everytab-vault-sync",
    { ifAvailable: true },
    async (lock) => {
      if (lock === null) {
        return { pulled: 0, pushed: 0, conflictCopies: 0, backedUp: false, skipped: true };
      }
      const report = { pulled: 0, pushed: 0, conflictCopies: 0, backedUp: false };
      for (const entry of portableStateEntries()) {
        if (entry.vault.kind === "items") await syncItemStore(root, entry, report);
        else if (entry.vault.kind === "archive") await syncArchive(root, entry, report);
        else if (entry.vault.kind === "settings") await syncSettings(root, entry, now, report);
        else if (entry.vault.kind === "per-key-max") await syncPerKeyMax(root, entry, report);
      }
      await writeBackup(root, now, report);
      await writeIndexMd(root, now);
      return report;
    }
  );
}

/**
 * Dashboard entry point: resolves the stored handle, checks permission,
 * syncs, and records the outcome in the `vaultMeta` storage key.
 * NOTE for callers watching storage.onChanged: never re-schedule a sync on
 * `vaultMeta` changes — that would loop forever.
 * @returns {Promise<{status: import("./vault.js").VaultStatus, report?: object}>}
 */
export async function syncNow() {
  const status = await getVaultStatus();
  if (status.state !== "connected") return { status };
  const handle = await getVaultHandle();
  try {
    const report = await syncWithHandle(handle);
    // A skipped run means another context is already syncing (it will record
    // its own vaultMeta) — don't overwrite the meta or double-count the sync.
    if (report.skipped) return { status, report };
    await chrome.storage.local.set({
      vaultMeta: { lastSyncAt: Date.now(), ok: true, ...report }
    });
    bump("vaultSyncs");
    return { status, report };
  } catch (e) {
    await chrome.storage.local.set({
      vaultMeta: { lastSyncAt: Date.now(), ok: false, error: String(e) }
    });
    return { status: { state: "error", message: String(e) } };
  }
}
