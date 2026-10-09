const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_HEADER_BYTES = 30;
const CENTRAL_DIRECTORY_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_VERSION = 20;
const METHOD_STORE = 0;
const NO_FLAGS = 0;
const NONE = 0;
const FIXED_TIMESTAMP = { year: 2026, month: 1, day: 1 };

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(): { date: number; time: number } {
  const { year, month, day } = FIXED_TIMESTAMP;
  return { date: ((year - 1980) << 9) | (month << 5) | day, time: 0 };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function writeZip(entries: ZipEntry[]): Uint8Array {
  const { date, time } = dosDateTime();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(LOCAL_FILE_HEADER_BYTES + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
    lv.setUint16(4, ZIP_VERSION, true);
    lv.setUint16(6, NO_FLAGS, true);
    lv.setUint16(8, METHOD_STORE, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, NONE, true);
    local.set(nameBytes, LOCAL_FILE_HEADER_BYTES);
    localParts.push(local, entry.data);

    const central = new Uint8Array(CENTRAL_DIRECTORY_HEADER_BYTES + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
    cv.setUint16(4, ZIP_VERSION, true);
    cv.setUint16(6, ZIP_VERSION, true);
    cv.setUint16(8, NO_FLAGS, true);
    cv.setUint16(10, METHOD_STORE, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, NONE, true);
    cv.setUint16(32, NONE, true);
    cv.setUint16(34, NONE, true);
    cv.setUint16(36, NONE, true);
    cv.setUint32(38, NONE, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, CENTRAL_DIRECTORY_HEADER_BYTES);
    centralParts.push(central);

    offset += local.length + entry.data.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);

  const end = new Uint8Array(END_OF_CENTRAL_DIRECTORY_BYTES);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  ev.setUint16(4, NONE, true);
  ev.setUint16(6, NONE, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, NONE, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
