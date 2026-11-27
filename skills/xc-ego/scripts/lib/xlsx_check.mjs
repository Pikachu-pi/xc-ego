import fs from 'node:fs/promises';
import path from 'node:path';

const LOCAL_HEADER_SIG = 0x04034b50;
const EOCD_SIG = 0x06054b50;
const CD_HEADER_SIG = 0x02014b50;

function findEocdOffset(tailBuffer) {
  for (let offset = tailBuffer.length - 22; offset >= 0; offset -= 1) {
    if (tailBuffer.readUInt32LE(offset) !== EOCD_SIG) continue;
    const commentLength = tailBuffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tailBuffer.length) {
      return offset;
    }
  }
  return -1;
}

function parseCentralDirectoryEntries(cdBuffer) {
  const entries = new Set();
  let offset = 0;
  while (offset + 46 <= cdBuffer.length) {
    const signature = cdBuffer.readUInt32LE(offset);
    if (signature !== CD_HEADER_SIG) {
      throw new Error(`XLSX_CORRUPT_CENTRAL_DIRECTORY: invalid signature at ${offset}`);
    }
    const flags = cdBuffer.readUInt16LE(offset + 8);
    const fileNameLen = cdBuffer.readUInt16LE(offset + 28);
    const extraLen = cdBuffer.readUInt16LE(offset + 30);
    const commentLen = cdBuffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLen;
    if (nameEnd > cdBuffer.length) {
      throw new Error('XLSX_CORRUPT_CENTRAL_DIRECTORY: truncated entry filename');
    }
    const encoding = (flags & 0x0800) !== 0 ? 'utf8' : 'latin1';
    entries.add(cdBuffer.toString(encoding, nameStart, nameEnd));
    offset = nameEnd + extraLen + commentLen;
  }
  return entries;
}

/**
 * Pure-Node structural check for .xlsx workbooks without loading compressed sheets into memory.
 */
export async function verifyXlsxFile(filePath, { minBytes = 512 } = {}) {
  if (!filePath || path.extname(filePath).toLowerCase() !== '.xlsx') {
    throw new Error(`XLSX_EXTENSION_INVALID: ${filePath}`);
  }

  const stat = await fs.stat(filePath);
  if (stat.size < minBytes) {
    throw new Error(`XLSX_TOO_SMALL: size=${stat.size} < ${minBytes}; file=${filePath}`);
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead: headRead } = await handle.read(head, 0, 4, 0);
    if (headRead < 4 || head.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
      throw new Error(`XLSX_NOT_ZIP: missing ZIP local header; file=${filePath}`);
    }

    const tailSize = Math.min(stat.size, 65557);
    const tailOffset = stat.size - tailSize;
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, tailOffset);

    const eocdPos = findEocdOffset(tail);
    if (eocdPos < 0) {
      throw new Error(`XLSX_NOT_ZIP: missing ZIP EOCD record; file=${filePath}`);
    }

    const cdSize = tail.readUInt32LE(eocdPos + 12);
    const cdOffset = tail.readUInt32LE(eocdPos + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error(`XLSX_ZIP64_UNSUPPORTED: file=${filePath}`);
    }
    if (cdSize === 0 || cdOffset + cdSize > stat.size) {
      throw new Error(`XLSX_CORRUPT_CENTRAL_DIRECTORY: invalid range; file=${filePath}`);
    }

    const cdBuffer = Buffer.alloc(cdSize);
    await handle.read(cdBuffer, 0, cdSize, cdOffset);
    const entries = parseCentralDirectoryEntries(cdBuffer);

    if (!entries.has('[Content_Types].xml') || !entries.has('xl/workbook.xml')) {
      throw new Error(`XLSX_MISSING_WORKBOOK_ENTRIES: not a valid Excel workbook; file=${filePath}`);
    }

    return {
      ok: true,
      filePath,
      size: stat.size,
      entryCount: entries.size,
    };
  } finally {
    await handle.close();
  }
}
