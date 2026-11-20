/**
 * The server data pack (SH-13 step 3, docs/on-device-server.md "Server data pack"): the game-derived data a server
 * needs, kept in one folder so a build of the server (the app's) can ship without any game content.
 *
 *   manifest.json                       what the pack holds (below)
 *   master/<table>.orderedmap           the latest copy of each master file the event scheduling reads
 *   assets/<name>.json                  the converted game data of the repository's `assets/` (bundles built with
 *                                       `--no-assets` read it from here)
 *   files/production/upload/<h>         other CDN assets the server reads, under their CDN member name: the battle
 *                                       scripts balance changes patch (src/lib/skillScripts.ts)
 *
 * `npm run datapack` builds it from the CDN (`src/datapack/`). The server reads the pack from the folder `DATA_PACK_DIR`
 * names (unset: nothing changes, masters come from `CDN_DIR` and assets from the app's own folder).
 * `src/dataPackStartup.ts` opens and verifies it before any other module loads.
 *
 * This module is shared by the builder and the server and has no dependency on either's data.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { dataPath } from "./paths";
import { digestPath } from "./cdnIndex";

export const DATA_PACK_FORMAT = 1
export const MANIFEST_FILE = "manifest.json"
export const MASTER_DIR = "master"
export const ASSETS_DIR = "assets"
export const FILES_DIR = "files"

export interface PackFile {
    /** Forward-slash path relative to the pack folder, e.g. `master/item/item.orderedmap`. */
    path: string
    size: number
    /** SHA-256, hex. */
    sha256: string
    /** Masters only: the CDN asset version the copy came from. */
    version?: string
}

export interface PackManifest {
    format: number
    /** The newest asset version among the CDN archives read; the pack holds the latest copy of each master up to it. */
    cdnVersion: string
    /** The CDN region folder the masters came from (`en`). */
    region: string
    /** SHA-256 over the `assets/` entries of `files` (`assetsDigest`): a bundle without assets refuses a pack for other data. */
    assetsDigest: string
    files: PackFile[]
}

/** The file next to the archive: what an app needs to download and check it. */
export interface PackDescriptor {
    format: number
    cdnVersion: string
    /** File name of the archive, beside the descriptor. */
    archive: string
    size: number
    /** SHA-256 of the archive, hex. */
    sha256: string
    /** SHA-256 of `manifest.json`, hex: the pack's identity (`DataPack.id`). */
    manifestSha256: string
    assetsDigest: string
}

export class DataPackError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "DataPackError"
    }
}

export function sha256Hex(data: Buffer | string): string {
    return createHash("sha256").update(data).digest("hex")
}

/** The digest `PackManifest.assetsDigest` holds: over the sorted `assets/` files as `path sha256\n` lines. */
export function assetsDigest(files: readonly PackFile[]): string {
    const hash = createHash("sha256")
    const lines = files.filter(f => f.path.startsWith(ASSETS_DIR + "/")).map(f => `${f.path} ${f.sha256}\n`).sort()
    for (const line of lines) hash.update(line)
    return hash.digest("hex")
}

/**
 * SEC-19: the digest over the sorted `master/` and `files/` files (the game's own data) as `path sha256\n` lines. A
 * bundle built `--no-assets` names the one of the official pack (src/datapack/pin.json), so a pack with altered master
 * tables or scripts is refused, not just one with altered converted data.
 */
export function mastersDigest(files: readonly PackFile[]): string {
    const hash = createHash("sha256")
    const lines = files.filter(f => f.path.startsWith(MASTER_DIR + "/") || f.path.startsWith(FILES_DIR + "/"))
        .map(f => `${f.path} ${f.sha256}\n`).sort()
    for (const line of lines) hash.update(line)
    return hash.digest("hex")
}

/** The pack path of a master table: `item/item` -> `master/item/item.orderedmap`. */
export function masterPackPath(table: string): string {
    const name = table.replace(/^\/+|\/+$/g, "").replace(/^master\//, "").replace(/\.orderedmap$/, "")
    return `${MASTER_DIR}/${name}.orderedmap`
}

/** The pack path of another CDN asset: `files/` and its CDN member name (`production/upload/<h[:2]>/<h[2:]>`). */
export function assetPackPath(assetPath: string): string {
    return `${FILES_DIR}/${digestPath(assetPath)}`
}

/** `DATA_PACK_DIR`, absolute, or undefined when no pack is in use. */
export function dataPackDir(): string | undefined {
    const setting = (process.env.DATA_PACK_DIR ?? "").trim()
    return setting === "" ? undefined : dataPath(setting)
}

function safePackPath(file: string): boolean {
    return /^(master|assets|files)\/[\w./-]+$/.test(file) && !file.split("/").some(part => part === "" || part === "." || part === "..")
}

export function parseManifest(text: string): PackManifest {
    let manifest: PackManifest
    try {
        manifest = JSON.parse(text)
    } catch {
        throw new DataPackError(`${MANIFEST_FILE} is not valid JSON`)
    }
    if (!manifest || typeof manifest !== "object") throw new DataPackError(`${MANIFEST_FILE} is not an object`)
    if (manifest.format !== DATA_PACK_FORMAT)
        throw new DataPackError(`unsupported data pack format ${manifest.format} (this server reads format ${DATA_PACK_FORMAT}); build or download a matching pack`)
    if (typeof manifest.cdnVersion !== "string" || typeof manifest.region !== "string" || typeof manifest.assetsDigest !== "string" || !Array.isArray(manifest.files))
        throw new DataPackError(`${MANIFEST_FILE} is missing fields`)
    const seen = new Set<string>()
    for (const f of manifest.files) {
        if (!f || typeof f.path !== "string" || !safePackPath(f.path) || !Number.isSafeInteger(f.size) || f.size < 0
            || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256) || seen.has(f.path))
            throw new DataPackError(`${MANIFEST_FILE} has a bad file entry: ${JSON.stringify(f)?.slice(0, 120)}`)
        seen.add(f.path)
    }
    return manifest
}

export interface OpenOptions {
    /** Check every file's size and SHA-256 (default true). */
    verify?: boolean
    /** The `assetsDigest` the running server was built for; a pack with another one is refused. */
    expectedAssetsDigest?: string
    /** SEC-19: the `mastersDigest` of the pack the server was built for; a pack with other master tables is refused. */
    expectedMastersDigest?: string
}

/** A data pack on disk. */
export class DataPack {
    readonly dir: string
    readonly manifest: PackManifest
    /** SHA-256 of `manifest.json`: changes whenever any file of the pack does. */
    readonly id: string
    private readonly byPath: Map<string, PackFile>

    private constructor(dir: string, manifest: PackManifest, id: string) {
        this.dir = dir
        this.manifest = manifest
        this.id = id
        this.byPath = new Map(manifest.files.map(f => [f.path, f]))
    }

    /** Opens and (by default) verifies the pack in `dir`; throws a `DataPackError` saying what is wrong. */
    static open(dir: string, options: OpenOptions = {}): DataPack {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new DataPackError(`data pack folder not found: ${dir}`)
        const manifestFile = path.join(dir, MANIFEST_FILE)
        if (!existsSync(manifestFile)) throw new DataPackError(`${manifestFile} is missing: not a data pack, or the download is incomplete`)
        const text = readFileSync(manifestFile)
        const manifest = parseManifest(text.toString("utf8"))
        if (options.expectedAssetsDigest !== undefined && manifest.assetsDigest !== options.expectedAssetsDigest)
            throw new DataPackError(`the data pack's game data (assets) is not the one this server was built with; get the data pack that belongs to this version of the server (pack for CDN ${manifest.cdnVersion})`)
        if (options.expectedMastersDigest !== undefined && mastersDigest(manifest.files) !== options.expectedMastersDigest)
            throw new DataPackError(`the data pack's master tables are not the ones this server was built for; get the official data pack for this version of the server (pack for CDN ${manifest.cdnVersion})`)
        if (assetsDigest(manifest.files) !== manifest.assetsDigest)
            throw new DataPackError(`${MANIFEST_FILE} is inconsistent: its assets digest does not match its file list`)
        const pack = new DataPack(dir, manifest, sha256Hex(text))
        if (options.verify !== false) pack.verify()
        return pack
    }

    /** Checks that every file the manifest lists is present, whole and unchanged. */
    verify(): void {
        const problems: string[] = []
        for (const f of this.manifest.files) {
            const file = path.join(this.dir, ...f.path.split("/"))
            let data: Buffer
            try {
                data = readFileSync(file)
            } catch {
                problems.push(`${f.path}: missing`)
                continue
            }
            if (data.length !== f.size) problems.push(`${f.path}: ${data.length} bytes, expected ${f.size}`)
            else if (sha256Hex(data) !== f.sha256) problems.push(`${f.path}: checksum differs`)
            if (problems.length >= 5) break
        }
        if (problems.length > 0)
            throw new DataPackError(`the data pack in ${this.dir} does not match its manifest (${problems.join("; ")}${problems.length >= 5 ? "; …" : ""}); download or build it again`)
    }

    /** Number of master files in the pack. */
    get masterCount(): number {
        return this.manifest.files.filter(f => f.path.startsWith(MASTER_DIR + "/")).length
    }

    has(packPath: string): boolean {
        return this.byPath.has(packPath)
    }

    /** The latest copy of a master table (`item/item`), or undefined when the pack doesn't hold it. */
    readMaster(table: string): Buffer | undefined {
        const packPath = masterPackPath(table)
        return this.byPath.has(packPath) ? readFileSync(path.join(this.dir, ...packPath.split("/"))) : undefined
    }

    /** Another CDN asset the pack carries (`files/`), or undefined. */
    readAsset(assetPath: string): Buffer | undefined {
        const packPath = assetPackPath(assetPath)
        return this.byPath.has(packPath) ? readFileSync(path.join(this.dir, ...packPath.split("/"))) : undefined
    }
}

let active: { dir: string, pack: DataPack } | null = null

/** `DATA_PACK_DIR` as a `DataPack`, opened once; null when the variable is unset. Throws a `DataPackError` on a bad pack. */
export function activeDataPack(): DataPack | null {
    const dir = dataPackDir()
    if (!dir) return null
    if (active?.dir !== dir) {
        active = null
        active = { dir, pack: DataPack.open(dir, { expectedAssetsDigest: expectedAssetsDigest(), expectedMastersDigest: expectedMastersDigest() }) }
    }
    return active.pack
}

declare const REFLIPPED_PACK_ASSETS: string | undefined
declare const REFLIPPED_PACK_MASTERS: string | undefined

/** Set in a bundle built `--no-assets` with a pin (src/datapack/pin.json): the master tables it expects. */
export function expectedMastersDigest(): string | undefined {
    return typeof REFLIPPED_PACK_MASTERS !== "undefined" ? REFLIPPED_PACK_MASTERS : undefined
}

/** Set in a bundle built `--no-assets`: the digest of the `assets/` it expects the pack to hold. */
export function expectedAssetsDigest(): string | undefined {
    return typeof REFLIPPED_PACK_ASSETS !== "undefined" ? REFLIPPED_PACK_ASSETS : undefined
}
