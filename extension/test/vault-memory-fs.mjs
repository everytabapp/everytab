/** Synthetic in-memory File System Access folders for Vault protocol tests.
 * Two roots stand in for two devices' local views of one cloud folder;
 * `propagate` copies named paths between them to model delayed uploads.
 * No real folder, cloud client or browser profile is involved.
 */

export class MemFile {
  kind = "file";
  constructor(name, content = "") {
    this.name = name;
    this.content = content;
  }
  async getFile() {
    const captured = this.content;
    return {
      text: async () => typeof captured === "string"
        ? captured
        : new TextDecoder().decode(captured),
      arrayBuffer: async () => {
        const bytes = typeof captured === "string"
          ? new TextEncoder().encode(captured)
          : captured;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    };
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (value) => { chunks.push(value); },
      close: async () => {
        this.content = chunks.every((value) => typeof value === "string")
          ? chunks.join("")
          : new Uint8Array(await new Blob(chunks).arrayBuffer());
      }
    };
  }
}

export class MemDir {
  kind = "directory";
  constructor(name = "vault") {
    this.name = name;
    this.children = new Map();
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing || !create) {
      throw Object.assign(new Error(`Directory ${name} not found`), { name: "NotFoundError" });
    }
    const directory = new MemDir(name);
    this.children.set(name, directory);
    return directory;
  }
  async getFileHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing || !create) {
      throw Object.assign(new Error(`File ${name} not found`), { name: "NotFoundError" });
    }
    const file = new MemFile(name);
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name) {
    if (!this.children.has(name)) {
      throw Object.assign(new Error(`Entry ${name} not found`), { name: "NotFoundError" });
    }
    this.children.delete(name);
  }
  async *entries() {
    yield* this.children.entries();
  }
  async queryPermission() { return "granted"; }
}

/** Resolve a slash-separated path to its entry, or null. */
export function entryAt(root, path) {
  let current = root;
  for (const segment of path.split("/").filter(Boolean)) {
    if (current?.kind !== "directory") return null;
    current = current.children.get(segment) ?? null;
  }
  return current;
}

export function cloneEntry(entry) {
  if (entry.kind === "file") return new MemFile(entry.name, entry.content);
  const directory = new MemDir(entry.name);
  for (const [name, child] of entry.children) directory.children.set(name, cloneEntry(child));
  return directory;
}

/**
 * Copy one path from one device's view to another, as a cloud client would
 * after upload and download. Missing parents are created; an existing
 * directory at the destination is merged, an existing file is replaced.
 */
export function propagate(from, to, path) {
  const segments = path.split("/").filter(Boolean);
  const leaf = segments.pop();
  let source = from;
  let destination = to;
  for (const segment of segments) {
    source = source.children.get(segment);
    if (!destination.children.has(segment)) destination.children.set(segment, new MemDir(segment));
    destination = destination.children.get(segment);
  }
  const entry = source.children.get(leaf);
  if (!entry) throw new Error(`Nothing to propagate at ${path}`);
  if (entry.kind === "directory" && destination.children.get(leaf)?.kind === "directory") {
    const target = destination.children.get(leaf);
    for (const [name] of entry.children) propagate(entry, target, name);
    return;
  }
  destination.children.set(leaf, cloneEntry(entry));
}

/** Copy everything from one view to the other. */
export function propagateAll(from, to) {
  for (const [name] of from.children) propagate(from, to, name);
}

export const names = (directory) => [...directory.children.keys()].sort();
export const readJson = (directory, name) => JSON.parse(directory.children.get(name).content);
