/**
 * SH-29: the base game files as a fresh install leaves them on the phone, file by file. An exported game data pack
 * (format 2, the Reflipped app's "Export game data") holds extracted files rather than the CDN's archives, so the app
 * checks it against a list of every base file: `path<TAB>size<TAB>sha256 hex\n` lines sorted by path, whose digest it
 * pins per language (GamePack.java `OFFICIAL_FILES`, printed by `npm run gamefiles -- --digest`).
 *
 * The set is what the app's extraction (ArchiveExtractor.java) leaves after the language's Android asset list, the full
 * archives and then every diff in order: a later copy replaces an earlier one, writing `a/b/c` deletes its shortened
 * twin `a/hash/b/c.hash` and vice versa, and a `.removed.csv` deletes the paths it lists.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { readArchiveMember, readCentralDirectory } from "../lib/cdnIndex";
import { removedPaths, shortenedTwin } from "../lib/baseRestore";
import { assetPath } from "../lib/paths";

export interface BaseFile {
    path: string
    size: number
    /** hex */
    sha256: string
}

/** The base archives of a language in extraction order, as files under `cdnDir`. */
export function baseArchiveFiles(lang: string, cdnDir: string): string[] {
    const list = JSON.parse(readFileSync(assetPath("asset_lists", `${lang}-android-full.json`), "utf8")) as {
        full: { archive: { location: string }[] }, diff: { archive: { location: string }[] }[]
    }
    return [...list.full.archive, ...list.diff.flatMap(d => d.archive)].map(a => {
        if (!a.location.startsWith("{$cdnAddress}/")) throw new Error(`unexpected location ${a.location}`)
        return path.join(cdnDir, a.location.slice("{$cdnAddress}/".length))
    })
}

/** Every base file of a language with its size and SHA-256, sorted by path. Reads (and hashes) about 9 GB. */
export function baseFiles(lang: string, cdnDir: string, onArchive?: (done: number, of: number) => void): BaseFile[] {
    return filesOfArchives(baseArchiveFiles(lang, cdnDir), onArchive)
}

/** What extracting these archives in order leaves, sorted by path. */
export function filesOfArchives(archives: readonly string[], onArchive?: (done: number, of: number) => void): BaseFile[] {
    const files = new Map<string, BaseFile>()
    archives.forEach((archive, i) => {
        for (const member of readCentralDirectory(archive)) {
            const data = readArchiveMember(archive, member)
            if (member.name === ".removed.csv") {
                for (const p of removedPaths(data.toString("utf8"))) files.delete(p)
                continue
            }
            files.set(member.name, { path: member.name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") })
            const twin = shortenedTwin(member.name)
            if (twin !== null) files.delete(twin)
        }
        onArchive?.(i + 1, archives.length)
    })
    return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The list's text, as an exported pack carries it and the app hashes it. */
export function fileListText(files: readonly BaseFile[]): string {
    return files.map(f => `${f.path}\t${f.size}\t${f.sha256}\n`).join("")
}

/** sha256 hex of the list's text: what the app pins. */
export function fileListDigest(files: readonly BaseFile[]): string {
    return createHash("sha256").update(fileListText(files), "utf8").digest("hex")
}
