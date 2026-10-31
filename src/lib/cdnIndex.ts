/**
 * Index of the assets in a region's CDN archives (I18N-1), ported from `scripts/extract_master.py`.
 *
 * Every asset is stored under a digested name, `production/upload/<h[:2]>/<h[2:]>` with
 * `h = sha1(<path> + SALT)`, e.g. path `master/item/item.orderedmap`. The archives are the zips in the
 * `archive-*` folders of `<CDN_DIR>/<region>/`; when an asset is in several, the newest asset version wins:
 * a full archive (`asset-2.1.0-<n>-<hash>.zip`) counts as 2.1.0, a diff (`asset-A-B-<n>-<hash>.zip`) as B.
 * Between archives of the same version the first in (folder, file name) order wins.
 *
 * Building the index reads only each zip's central directory; `read()` then reads one entry.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { inflateRawSync } from "zlib";

export const ASSET_SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"
const ARCHIVE_RE = /^s?_?asset-(\d+\.\d+\.\d+)-(?:(\d+\.\d+\.\d+)-)?\d+-[0-9a-f]+\.zip$/

/** The archive member name of an asset path. */
export function digestPath(assetPath: string): string {
    const h = createHash("sha1").update(assetPath + ASSET_SALT, "utf8").digest("hex")
    return `production/upload/${h.slice(0, 2)}/${h.slice(2)}`
}

/** The asset path of a master table or scenario: `item/item` or `/item/item` -> `master/item/item.orderedmap`. */
export function masterAssetPath(table: string): string {
    return `master/${masterTableName(table)}.orderedmap`
}

/** A table name without leading slash, `master/` prefix or `.orderedmap` suffix. */
export function masterTableName(name: string): string {
    let t = name.replace(/^\/+|\/+$/g, "")
    if (t.startsWith("master/")) t = t.slice("master/".length)
    if (t.endsWith(".orderedmap")) t = t.slice(0, -".orderedmap".length)
    return t
}

export type AssetVersion = [number, number, number]

export function parseAssetVersion(text: string): AssetVersion {
    const parts = text.split(".").map(Number)
    if (parts.length !== 3 || parts.some(p => !Number.isInteger(p) || p < 0)) throw new Error(`bad asset version: ${text}`)
    return parts as AssetVersion
}

export function compareAssetVersions(a: AssetVersion, b: AssetVersion): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function formatAssetVersion(v: AssetVersion): string {
    return v.join(".")
}

/** The asset version an archive file name stands for, or null if the name isn't an asset archive. */
export function archiveVersion(fileName: string): AssetVersion | null {
    const m = ARCHIVE_RE.exec(fileName)
    return m ? parseAssetVersion(m[2] ?? m[1]) : null
}

export interface CdnEntry {
    /** Member name inside the archive (the digested path). */
    member: string
    version: AssetVersion
    /** Absolute path of the zip. */
    archive: string
    method: number
    compressedSize: number
    size: number
    localHeaderOffset: number
}

export interface CdnIndexOptions {
    /** Ignore archives newer than this version, like `extract_master.py --version`. */
    maxVersion?: string
    /** Called for an archive that can't be read (default: a console warning). */
    onBadArchive?: (archive: string, error: Error) => void
}

/** The CDN folder of a region: `CDN_DIR` (default `.cdn`, relative to the working directory) + region. */
export function regionCdnDir(region = "en", cdnDir = process.env.CDN_DIR || ".cdn"): string {
    const root = path.resolve(cdnDir)
    const sub = path.join(root, region)
    return existsSync(sub) ? sub : root
}

export class CdnIndex {
    readonly root: string
    private readonly entries = new Map<string, CdnEntry>()
    private archiveCount = 0

    private constructor(root: string) {
        this.root = root
    }

    /** Indexes the archives under `root` (a region folder such as `.cdn/en`). */
    static build(root: string, options: CdnIndexOptions = {}): CdnIndex {
        const index = new CdnIndex(root)
        const max = options.maxVersion ? parseAssetVersion(options.maxVersion) : null
        const onBad = options.onBadArchive ?? ((archive, error) => console.warn(`skipping unreadable archive ${archive}: ${error.message}`))
        if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`CDN directory not found: ${root}`)
        for (const category of readdirSync(root).sort()) {
            const folder = path.join(root, category)
            if (!category.startsWith("archive-") || !statSync(folder).isDirectory()) continue
            for (const name of readdirSync(folder).sort()) {
                const version = archiveVersion(name)
                if (!version || (max && compareAssetVersions(version, max) > 0)) continue
                const archive = path.join(folder, name)
                let members: ZipMember[]
                try {
                    members = readCentralDirectory(archive)
                } catch (error) {
                    onBad(archive, error as Error)
                    continue
                }
                index.archiveCount++
                for (const m of members) {
                    const known = index.entries.get(m.name)
                    if (known && compareAssetVersions(version, known.version) <= 0) continue
                    index.entries.set(m.name, {
                        member: m.name, version, archive, method: m.method,
                        compressedSize: m.compressedSize, size: m.size, localHeaderOffset: m.localHeaderOffset
                    })
                }
            }
        }
        return index
    }

    /** Number of distinct members and of archives read. */
    get stats(): { members: number, archives: number } {
        return { members: this.entries.size, archives: this.archiveCount }
    }

    /** The newest entry of an asset path (e.g. `master/item/item.orderedmap`). */
    entry(assetPath: string): CdnEntry | undefined {
        return this.entries.get(digestPath(assetPath))
    }

    has(assetPath: string): boolean {
        return this.entries.has(digestPath(assetPath))
    }

    /** The bytes of the newest copy of an asset path, or undefined. */
    read(assetPath: string): Buffer | undefined {
        const e = this.entry(assetPath)
        return e ? readEntry(e) : undefined
    }

    /** The newest entry of an archive member name (any folder, e.g. `production/medium_upload/…` images). */
    entryByMember(member: string): CdnEntry | undefined {
        return this.entries.get(member)
    }

    /** The bytes of the newest copy of an archive member, or undefined. */
    readMember(member: string): Buffer | undefined {
        const e = this.entries.get(member)
        return e ? readEntry(e) : undefined
    }

    /** A master table or scenario by name (`item/item`, `/string/ui_string`, `story/…/scenario`). */
    readMaster(table: string): Buffer | undefined {
        return this.read(masterAssetPath(table))
    }
}

// ---- minimal zip reader (stored and deflate entries, no zip64; enough for the CDN archives) ----

export interface ZipMember {
    name: string
    method: number
    compressedSize: number
    size: number
    localHeaderOffset: number
}

function readAt(fd: number, position: number, length: number): Buffer {
    const buf = Buffer.alloc(length)
    let done = 0
    while (done < length) {
        const n = readSync(fd, buf, done, length - done, position + done)
        if (n === 0) throw new Error("unexpected end of file")
        done += n
    }
    return buf
}

export function readCentralDirectory(file: string): ZipMember[] {
    const fd = openSync(file, "r")
    try {
        const size = fstatSync(fd).size
        const tailLength = Math.min(size, 22 + 0xffff)
        const tail = readAt(fd, size - tailLength, tailLength)
        let eocd = -1
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) {
                eocd = i
                break
            }
        }
        if (eocd < 0) throw new Error("not a zip file")
        const count = tail.readUInt16LE(eocd + 10)
        const cdSize = tail.readUInt32LE(eocd + 12)
        const cdOffset = tail.readUInt32LE(eocd + 16)
        if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 is not supported")
        const cd = readAt(fd, cdOffset, cdSize)
        const members: ZipMember[] = []
        let p = 0
        for (let i = 0; i < count; i++) {
            if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory")
            const flags = cd.readUInt16LE(p + 8)
            const method = cd.readUInt16LE(p + 10)
            const compressedSize = cd.readUInt32LE(p + 20)
            const uncompressedSize = cd.readUInt32LE(p + 24)
            const nameLength = cd.readUInt16LE(p + 28)
            const extraLength = cd.readUInt16LE(p + 30)
            const commentLength = cd.readUInt16LE(p + 32)
            const localHeaderOffset = cd.readUInt32LE(p + 42)
            const name = cd.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1")
            p += 46 + nameLength + extraLength + commentLength
            if (flags & 1) continue // encrypted
            if (name.endsWith("/")) continue // directory
            members.push({ name, method, compressedSize, size: uncompressedSize, localHeaderOffset })
        }
        return members
    } finally {
        closeSync(fd)
    }
}

function readEntry(e: CdnEntry): Buffer {
    const fd = openSync(e.archive, "r")
    try {
        const local = readAt(fd, e.localHeaderOffset, 30)
        if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${e.member} in ${e.archive}`)
        const dataStart = e.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
        const data = readAt(fd, dataStart, e.compressedSize)
        if (e.method === 0) return data
        if (e.method === 8) return inflateRawSync(data)
        throw new Error(`unsupported zip method ${e.method} for ${e.member} in ${e.archive}`)
    } finally {
        closeSync(fd)
    }
}
