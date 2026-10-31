/**
 * A small deterministic zip writer for the translation overlay (I18N-3, `src/i18n/overlay.ts`).
 *
 * Entries are laid out like the CDN archives: no directory entries, deflate (level 9) or stored when deflating
 * doesn't help, Unix attributes `0666`, no extra fields and no data descriptors. Entries are sorted by name and get
 * a fixed timestamp, so the same files always give the same bytes (and the same hashed archive name).
 */
import { deflateRawSync } from "zlib";

export interface ZipFile {
    name: string
    data: Buffer
}

// 2024-05-27 00:00:00, the date of the last content update (any fixed date would do)
const DOS_TIME = 0
const DOS_DATE = ((2024 - 1980) << 9) | (5 << 5) | 27
// like the originals: made by Unix (3) with zip spec 6.3, regular file rw-rw-rw-
const VERSION_MADE_BY = (3 << 8) | 63
const VERSION_NEEDED = 20
const EXTERNAL_ATTRIBUTES = (0o100666 << 16) >>> 0
const FLAG_UTF8 = 0x800
const FLAG_MAX_COMPRESSION = 0x2

let crcTable: Uint32Array | null = null

export function crc32(data: Buffer): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256)
        for (let n = 0; n < 256; n++) {
            let c = n
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
            crcTable[n] = c >>> 0
        }
    }
    let crc = 0xffffffff
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
}

/** Writes a zip of the given files. Throws on duplicate names or sizes beyond plain (non-zip64) zip limits. */
export function writeZip(files: readonly ZipFile[]): Buffer {
    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].name === sorted[i - 1].name) throw new Error(`duplicate zip entry ${sorted[i].name}`)
    }
    if (sorted.length > 0xfffe) throw new Error("too many zip entries")
    const parts: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0
    for (const file of sorted) {
        const name = Buffer.from(file.name, "utf8")
        const deflated = deflateRawSync(file.data, { level: 9 })
        const stored = deflated.length >= file.data.length
        const body = stored ? file.data : deflated
        const method = stored ? 0 : 8
        const flags = (/[^\x20-\x7e]/.test(file.name) ? FLAG_UTF8 : 0) | (stored ? 0 : FLAG_MAX_COMPRESSION)
        const crc = crc32(file.data)
        if (offset > 0xfffffffe || file.data.length > 0xfffffffe) throw new Error("zip64 is not supported")

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(VERSION_NEEDED, 4)
        local.writeUInt16LE(flags, 6)
        local.writeUInt16LE(method, 8)
        local.writeUInt16LE(DOS_TIME, 10)
        local.writeUInt16LE(DOS_DATE, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(body.length, 18)
        local.writeUInt32LE(file.data.length, 22)
        local.writeUInt16LE(name.length, 26)
        local.writeUInt16LE(0, 28)
        parts.push(local, name, body)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(VERSION_MADE_BY, 4)
        central.writeUInt16LE(VERSION_NEEDED, 6)
        central.writeUInt16LE(flags, 8)
        central.writeUInt16LE(method, 10)
        central.writeUInt16LE(DOS_TIME, 12)
        central.writeUInt16LE(DOS_DATE, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(body.length, 20)
        central.writeUInt32LE(file.data.length, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38)
        central.writeUInt32LE(offset, 42)
        centrals.push(central, name)
        offset += 30 + name.length + body.length
    }
    const cd = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(sorted.length, 8)
    eocd.writeUInt16LE(sorted.length, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...parts, cd, eocd])
}
