/**
 * SH-27: the base copies of the game files another server's layers changed, so the app can keep its ~9 GB of game files
 * when it moves to another server. A layer (translation overlay, mods, schedule layer, the Chinese CDN's files) is a zip
 * the app extracts over the base files; the app records each path a layer archive wrote or deleted, and at a switch
 * asks the new server (`POST /shell/restore`) for an archive that puts exactly those paths back as the base download
 * left them: the base copy of each, and a `.removed.csv` for the paths the base doesn't have. Then the new server's own
 * layers go on top as after a fresh download.
 *
 * "The base" is what a fresh device extracts: the archives of the language's Android asset list (`assets/asset_lists/
 * <lang>-android-full.json`, the full archives and then every diff, in order; a later copy overwrites an earlier one and
 * a diff's `.removed.csv` deletes), read from this server's CDN folder. Paths are archive member names
 * (`production/upload/08/1563…`). Writing `a/b/c` deletes its shortened twin `a/hash/b/c.hash` and vice versa (the
 * client's AssetShortenedTools), so a path is looked up under both names and sent under the name the base has; the
 * app's extraction then deletes the layer's twin.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { readArchiveMember, readCentralDirectory, ZipMember } from "./cdnIndex";
import { downloadsDisabled } from "./gameDataDownload";
import { assetPath, cdnDir } from "./paths";
import { writeZip, ZipFile } from "./zipWriter";

export const RESTORE_LANGS = ["en", "ko", "th"] as const
export type RestoreLang = typeof RESTORE_LANGS[number]
/** The most paths one request may name (a translation overlay writes a few thousand; a zip holds at most 65,534). */
export const MAX_RESTORE_PATHS = 60_000
/** The most bytes of base copies one archive may hold. */
export const MAX_RESTORE_BYTES = 512 * 1024 * 1024
/** How long an index stays in memory after its last use. */
const INDEX_IDLE_MS = 10 * 60 * 1000

interface BaseEntry {
    archive: string
    member: ZipMember
}

interface BaseIndex {
    /** The base's last copy of each member name. */
    entries: Map<string, BaseEntry>
    /** `2.1.<n>`, the list's target version. */
    version: string
}

interface AssetList {
    info?: { target_asset_version?: string }
    full?: { archive?: { location: string }[] }
    diff?: { archive?: { location: string }[] }[]
}

const CDN_PREFIX = "{$cdnAddress}/"

/** The base archives of a language, in the order a fresh device extracts them, as files of this server's CDN folder. */
function baseArchives(lang: RestoreLang): { files: string[], version: string } {
    const list = JSON.parse(readFileSync(assetPath("asset_lists", `${lang}-android-full.json`), "utf8")) as AssetList
    const locations = [...(list.full?.archive ?? []), ...(list.diff ?? []).flatMap(d => d.archive ?? [])].map(a => a.location)
    const root = cdnDir()
    const files = locations.map(location => {
        if (!location.startsWith(CDN_PREFIX)) throw new Error(`unexpected archive location ${location}`)
        const file = path.resolve(root, location.slice(CDN_PREFIX.length))
        if (!file.startsWith(root + path.sep)) throw new Error(`archive location outside the CDN folder: ${location}`)
        return file
    })
    return { files, version: list.info?.target_asset_version ?? "" }
}

/**
 * Whether this server can restore `lang`: its CDN folder holds every base archive of the language (cheap: one stat per
 * archive, cached until a restart), and base files aren't turned off (`GAME_DATA_DOWNLOAD=off`).
 */
const availability = new Map<string, boolean>()
export function restoreAvailable(lang: RestoreLang): boolean {
    // GAME_DATA_DOWNLOAD=off: the owner hands out no base files, not even these few
    if (downloadsDisabled()) return false
    const key = `${cdnDir()}\0${lang}`
    let known = availability.get(key)
    if (known === undefined) {
        try {
            known = baseArchives(lang).files.every(file => existsSync(file))
        } catch {
            known = false
        }
        availability.set(key, known)
    }
    return known
}

/** The languages this server can restore, for `/shell/config` `assets.restore`. */
export function restoreLangs(): RestoreLang[] {
    return RESTORE_LANGS.filter(restoreAvailable)
}

/** The paths a `.removed.csv` lists (`rowid,path` header, then one path per row). */
export function removedPaths(csv: string): string[] {
    const paths: string[] = []
    for (const line of csv.split(/\r?\n/)) {
        if (line.startsWith("rowid,")) continue
        const comma = line.indexOf(",")
        const p = (comma >= 0 ? line.slice(comma + 1) : line).trim()
        if (p !== "") paths.push(p)
    }
    return paths
}

const cache = new Map<string, { index: BaseIndex, timer: NodeJS.Timeout }>()

function buildIndex(lang: RestoreLang): BaseIndex {
    const { files, version } = baseArchives(lang)
    const entries = new Map<string, BaseEntry>()
    for (const archive of files) {
        for (const member of readCentralDirectory(archive)) {
            if (member.name === ".removed.csv") {
                for (const p of removedPaths(readArchiveMember(archive, member).toString("utf8"))) entries.delete(p)
            } else {
                entries.set(member.name, { archive, member })
            }
        }
    }
    return { entries, version }
}

function baseIndex(lang: RestoreLang): BaseIndex {
    const key = `${cdnDir()}\0${lang}`
    const known = cache.get(key)
    if (known) clearTimeout(known.timer)
    const index = known?.index ?? buildIndex(lang)
    const timer = setTimeout(() => cache.delete(key), INDEX_IDLE_MS)
    timer.unref()
    cache.set(key, { index, timer })
    return index
}

// The client's AssetShortenedTools rules (client/air-shell/java/.../pinball/ArchiveExtractor.java).
export function shortenedTwin(p: string): string | null {
    if (p.endsWith(".hash")) {
        const m = /^(.*)\/hash\/([^/]+\/[^/]+)\.hash$/.exec(p)
        return m ? `${m[1]}/${m[2]}` : null
    }
    const m = /^(.*)\/([^/]+\/[^/]+)$/.exec(p)
    return m ? `${m[1]}/hash/${m[2]}.hash` : null
}

/** The base copies of the paths asked for would be more than {@link MAX_RESTORE_BYTES}. */
export class RestoreTooLargeError extends Error {
    constructor() { super("the restore archive would be too large") }
}

export interface RestoreArchive {
    archive: Buffer
    /** base copies sent */
    restored: number
    /** paths the base doesn't have, listed in `.removed.csv` */
    removed: number
    /** the base version, `2.1.<n>` */
    version: string
}

/** The archive that puts `paths` back as the base download of `lang` left them. */
export function buildRestoreArchive(lang: RestoreLang, paths: readonly string[]): RestoreArchive {
    const index = baseIndex(lang)
    const files = new Map<string, ZipFile>()
    const removed = new Set<string>()
    let bytes = 0
    for (const p of new Set(paths)) {
        const twin = shortenedTwin(p)
        const name = index.entries.has(p) ? p : twin !== null && index.entries.has(twin) ? twin : null
        if (name === null) {
            removed.add(p)
            continue
        }
        if (files.has(name)) continue
        const entry = index.entries.get(name)!
        bytes += entry.member.size
        if (bytes > MAX_RESTORE_BYTES) throw new RestoreTooLargeError()
        files.set(name, { name, data: readArchiveMember(entry.archive, entry.member) })
    }
    for (const name of files.keys()) removed.delete(name)
    const list: ZipFile[] = [...files.values()]
    // ".removed.csv" sorts before "production/…", so the deletions run first
    if (removed.size > 0) list.push({ name: ".removed.csv", data: Buffer.from(["rowid,path", ...[...removed].sort().map((p, i) => `${i + 1},${p}`)].join("\n") + "\n", "utf8") })
    return { archive: writeZip(list, 1), restored: files.size, removed: removed.size, version: index.version }
}

/** Forgets the cached indexes and availability (tests). */
export function resetRestoreCache(): void {
    for (const { timer } of cache.values()) clearTimeout(timer)
    cache.clear()
    availability.clear()
}
