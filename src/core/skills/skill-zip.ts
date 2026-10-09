import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Skill package zip codec, shared between the upload/download routes and the
 * self-hosted worker that materializes a package over the wire.
 *
 * Entries record their POSIX mode in the central directory's external
 * attributes (version-made-by unix, `0o100xxx` in the high bits) so an
 * executable script survives the download — the official worker contract
 * preserves execute bits on `<workdir>/skills/<name>/` materialization.
 */

export interface SkillZipEntry {
  path: string;
  content: Buffer;
  /** Whether the entry's stored mode carries a user-execute bit. */
  executable: boolean;
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const MODE_FILE_MASK = 0o100000;
const MODE_USER_EXEC = 0o100;

export function isIgnoredArchiveEntry(path: string): boolean {
  return path.startsWith('__MACOSX/') || path.split('/').some((part) => part === '.DS_Store');
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const start = Math.max(0, zip.length - 65_557);
  for (let index = zip.length - 22; index >= start; index -= 1) {
    if (zip.readUInt32LE(index) === ZIP_EOCD) {
      return index;
    }
  }
  return -1;
}

/**
 * Read a skill package zip. Supports the stored and deflate methods — stored
 * is what `buildSkillZip` emits, deflate covers archives produced elsewhere.
 * `maxBytes` bounds the total uncompressed payload, matching the upload-side
 * ceiling so a download cannot expand past what the runtime accepts.
 */
export function extractSkillZipEntries(zip: Buffer, maxBytes: number): SkillZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  if (eocdOffset < 0) {
    throw new Error('Zip package is invalid.');
  }

  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let cursor = zip.readUInt32LE(eocdOffset + 16);
  const entries: SkillZipEntry[] = [];
  let totalUncompressedBytes = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (zip.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER) {
      throw new Error('Zip central directory is invalid.');
    }

    const versionMadeBy = zip.readUInt16LE(cursor + 4);
    const compression = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const fileNameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const externalAttrs = zip.readUInt32LE(cursor + 38);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const path = zip.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8');
    cursor += 46 + fileNameLength + extraLength + commentLength;

    if (!path || path.endsWith('/') || isIgnoredArchiveEntry(path)) {
      continue;
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > maxBytes) {
      throw new Error(`Total skill package size must be ${Math.round(maxBytes / (1024 * 1024))}MB or less.`);
    }
    if (zip.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
      throw new Error('Zip local file header is invalid.');
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    const content = compression === 0
      ? Buffer.from(compressed)
      : compression === 8
        ? inflateRawSync(compressed)
        : null;
    if (!content) {
      throw new Error(`Unsupported zip compression method for ${path}.`);
    }
    if (content.length !== uncompressedSize) {
      throw new Error(`Zip entry size mismatch for ${path}.`);
    }
    // High byte of version-made-by == 3 means the external attributes carry a
    // unix mode in their high 16 bits. Anything else reports not-executable.
    const unixMode = (versionMadeBy >>> 8) === 3 ? externalAttrs >>> 16 : 0;
    entries.push({ path, content, executable: (unixMode & MODE_FILE_MASK) === MODE_FILE_MASK && (unixMode & MODE_USER_EXEC) !== 0 });
  }

  return entries;
}

/**
 * Serialize entries as a stored-method zip archive — the inverse of
 * `extractSkillZipEntries`, so anything this produces is readable by the
 * upload path and a downloading worker. Entries are stored uncompressed:
 * packages are already small (the upload ceiling bounds them) and a stored
 * archive keeps the encoder free of compression-state bugs. Timestamps are
 * fixed to the DOS epoch minimum so the bytes are deterministic for
 * identical content.
 */
export function buildSkillZip(entries: Array<{ path: string; content: Buffer; executable?: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
    const checksum = crc32(entry.content);
    const mode = MODE_FILE_MASK | (entry.executable ? 0o755 : 0o644);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_HEADER, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(0, 8); // stored
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.content.length, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length
    localParts.push(localHeader, name, entry.content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_HEADER, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(0, 10); // stored
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x21, 14); // mod date
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.content.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs: all zero
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38); // external attrs: unix mode
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + entry.content.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_EOCD, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}
