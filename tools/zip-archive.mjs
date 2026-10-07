// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
const DEFLATED_METHOD = 8;
const VERSION_20 = 20;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(data) {
  let crc = MAX_UINT32;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ MAX_UINT32) >>> 0;
}

function checkedEntryName(value) {
  const name = String(value ?? "");
  const segments = name.split("/");
  if (!name || name.startsWith("/") || name.endsWith("/") || name.includes("\\") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe ZIP entry name: ${name || "<empty>"}`);
  }
  const encoded = Buffer.from(name, "utf8");
  if (encoded.length > MAX_UINT16) throw new Error(`ZIP entry name is too long: ${name}`);
  return { name, encoded };
}

function assertClassicZipSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error(`${label} exceeds the supported classic ZIP limit`);
  }
}

/**
 * Write a byte-stable classic ZIP without relying on platform archive tools.
 * Entries use ZIP's stored method so output remains identical across Node and
 * zlib versions. Runtime packages are small enough that ZIP64 is unnecessary.
 */
export function writeDeterministicZip(archivePath, files) {
  const ordered = files.map(({ name, data }) => {
    const checked = checkedEntryName(name);
    return { ...checked, data: Buffer.isBuffer(data) ? data : Buffer.from(data) };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (new Set(ordered.map(({ name }) => name)).size !== ordered.length) {
    throw new Error("ZIP entry names must be unique");
  }
  if (ordered.length > MAX_UINT16) throw new Error("ZIP has too many entries");

  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const { encoded, data } of ordered) {
    assertClassicZipSize(data.length, "ZIP entry");
    assertClassicZipSize(localOffset, "ZIP local-record offset");
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
    localHeader.writeUInt16LE(VERSION_20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(STORED_METHOD, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(encoded.length, 26);
    localRecords.push(localHeader, encoded, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_FILE_SIGNATURE, 0);
    centralHeader.writeUInt16LE(VERSION_20, 4);
    centralHeader.writeUInt16LE(VERSION_20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(STORED_METHOD, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(encoded.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, encoded);
    localOffset += localHeader.length + encoded.length + data.length;
  }

  const centralOffset = localOffset;
  const centralSize = centralRecords.reduce((total, chunk) => total + chunk.length, 0);
  assertClassicZipSize(centralOffset, "ZIP central-directory offset");
  assertClassicZipSize(centralSize, "ZIP central-directory size");

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  mkdirSync(path.dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, Buffer.concat([...localRecords, ...centralRecords, end]));
}

function findEndRecord(archive) {
  const earliest = Math.max(0, archive.length - 22 - MAX_UINT16);
  for (let offset = archive.length - 22; offset >= earliest; offset--) {
    if (archive.readUInt32LE(offset) !== END_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error("ZIP end record is missing");
}

function parseArchive(archivePath) {
  const archive = readFileSync(archivePath);
  const endOffset = findEndRecord(archive);
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskCount = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (disk || centralDisk || diskCount !== entryCount || entryCount === MAX_UINT16 ||
      centralSize === MAX_UINT32 || centralOffset === MAX_UINT32) {
    throw new Error("Multi-disk and ZIP64 archives are unsupported");
  }
  if (centralOffset + centralSize > endOffset) throw new Error("ZIP central directory is invalid");

  const entries = [];
  const seen = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error("ZIP central-directory entry is invalid");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > archive.length) {
      throw new Error("ZIP central-directory entry is truncated");
    }
    const name = archive.subarray(nameStart, nameEnd).toString("utf8");
    checkedEntryName(name);
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    if (flags & 1) throw new Error(`Encrypted ZIP entry is unsupported: ${name}`);
    seen.add(name);
    entries.push({
      name,
      flags,
      method,
      checksum: archive.readUInt32LE(cursor + 16),
      compressedSize: archive.readUInt32LE(cursor + 20),
      uncompressedSize: archive.readUInt32LE(cursor + 24),
      localOffset: archive.readUInt32LE(cursor + 42)
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central-directory size is invalid");
  return { archive, entries };
}

export function listZipEntries(archivePath) {
  return parseArchive(archivePath).entries.map(({ name }) => name);
}

export function extractZipArchive(archivePath, outputRoot) {
  const { archive, entries } = parseArchive(archivePath);
  const root = path.resolve(outputRoot);
  mkdirSync(root, { recursive: true });

  for (const entry of entries) {
    const offset = entry.localOffset;
    if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`ZIP local entry is invalid: ${entry.name}`);
    }
    const method = archive.readUInt16LE(offset + 8);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    const localName = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (localName !== entry.name || method !== entry.method || dataEnd > archive.length) {
      throw new Error(`ZIP local entry differs from its directory record: ${entry.name}`);
    }
    const compressed = archive.subarray(dataStart, dataEnd);
    const data = method === STORED_METHOD
      ? Buffer.from(compressed)
      : method === DEFLATED_METHOD
        ? inflateRawSync(compressed)
        : null;
    if (!data) throw new Error(`Unsupported ZIP compression method ${method}: ${entry.name}`);
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.checksum) {
      throw new Error(`ZIP entry failed size or checksum verification: ${entry.name}`);
    }
    const destination = path.resolve(root, ...entry.name.split("/"));
    if (!destination.startsWith(`${root}${path.sep}`)) {
      throw new Error(`ZIP entry escapes its output directory: ${entry.name}`);
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, data);
  }
}
