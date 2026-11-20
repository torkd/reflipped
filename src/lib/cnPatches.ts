/**
 * Client files taken from the Chinese version's CDN (FT-79). The global client is the final build, but a few of the
 * global CDN's files are older than the features that build has: Score Scramble's party select reads a `record` and a
 * `best_score` container from the party select's top panel, and the global copy of that layout (asset 2.1.0) has
 * neither, so tapping a Score Scramble quest fails with U_bd3902. The Chinese CDN has the later layout, a superset
 * of the global one that uses only sprites the global client already has.
 *
 * These files are game data, so they are never part of the repository. A server gets them in one of two ways:
 *  - automatically: with the Chinese CDN in `<CDN_DIR>/cn` (or `CN_CDN_DIR`), the server builds an archive of these
 *    files at startup and sends it to every device as an asset layer (src/lib/assetLayers.ts); `CN_PATCHES=off`
 *    turns it off;
 *  - by hand: `npm run cn:patch` writes the same archive into `<CDN_DIR>/mods/`, for a server without the Chinese
 *    CDN (copy the zip there from a machine that has it).
 *
 * Each file is pinned to the SHA-256 of the copy that was checked: a different copy is left out with a warning.
 * Nothing here reaches the data layer, so tests can import it on its own.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { CdnIndex, digestPath } from "./cdnIndex";
import { cdnDir, databaseDir, dataPath } from "./paths";
import { writeZip, ZipFile } from "./zipWriter";

export interface CnPatch {
    /** the asset path the client asks for */
    assetPath: string
    /** hex SHA-256 of the archive member's bytes (as stored in the CDN archive) */
    sha256: string
    /** why the global copy doesn't do */
    reason: string
}

export const CN_PATCHES: readonly CnPatch[] = [
    {
        assetPath: "scene/party_select/party_select_top_panel.ui.amf3.deflate",
        sha256: "619e62cdac7fc21608b63cb930a56b270d2c9cc62f3654eb939c515aa11e7d7e",
        reason: "Score Scramble's party select needs the top panel's record and best_score containers (U_bd3902)"
    }
]

/** URL folder of the generated archive under the CDN address (`/patch/Live/2.0.0/cn-patches/<file>`). */
export const CN_PATCH_URL_DIR = "cn-patches"
const FILE_RE = /^cn-patches-[0-9a-f]{16}\.zip$/

export interface CnPatchArchive {
    data: Buffer
    /** the asset paths it holds */
    included: string[]
    /** asset paths left out, with the reason */
    skipped: { assetPath: string, reason: string }[]
}

/** `CN_PATCHES`: `auto` (the default: use the Chinese CDN when it is there) or `off`. */
export function cnPatchMode(): "auto" | "off" {
    return (process.env.CN_PATCHES ?? "").trim().toLowerCase() === "off" ? "off" : "auto"
}

/** The Chinese CDN folder: `CN_CDN_DIR`, else `<CDN_DIR>/cn`. */
export function cnCdnDir(): string {
    return process.env.CN_CDN_DIR ? dataPath(process.env.CN_CDN_DIR) : path.join(cdnDir(), "cn")
}

/** Where the server keeps the archive it builds (`<DATABASE_DIR>/cn-assets`; the CDN folder stays read-only). */
export function cnPatchDir(): string {
    return path.join(databaseDir(), "cn-assets")
}

/** Builds the archive of the patches from a Chinese CDN folder; null when it holds none of them. */
export function buildCnPatchArchive(cnRoot: string, patches: readonly CnPatch[] = CN_PATCHES): CnPatchArchive | null {
    const index = CdnIndex.build(cnRoot, { onBadArchive: () => {} })
    const files: ZipFile[] = []
    const included: string[] = []
    const skipped: CnPatchArchive["skipped"] = []
    for (const patch of patches) {
        const data = index.read(patch.assetPath)
        if (!data) {
            skipped.push({ assetPath: patch.assetPath, reason: "not in the Chinese CDN" })
            continue
        }
        const sha256 = createHash("sha256").update(data).digest("hex")
        if (sha256 !== patch.sha256) {
            skipped.push({ assetPath: patch.assetPath, reason: `a different copy (SHA-256 ${sha256})` })
            continue
        }
        files.push({ name: digestPath(patch.assetPath), data })
        included.push(patch.assetPath)
    }
    return files.length === 0 ? null : { data: writeZip(files), included, skipped }
}

/** The archive's file name: named by its content, so a device fetches a changed archive anew. */
export function cnPatchFileName(data: Buffer): string {
    return `cn-patches-${createHash("sha256").update(data).digest("hex").slice(0, 16)}.zip`
}

/**
 * At startup: the archive to send, built from the Chinese CDN into `cnPatchDir()` (older archives there are removed),
 * or null without a Chinese CDN, with `CN_PATCHES=off`, or when it holds none of the files.
 */
export function prepareCnPatchArchive(log: (line: string) => void = console.warn, patches: readonly CnPatch[] = CN_PATCHES): { file: string, data: Buffer } | null {
    if (cnPatchMode() === "off") return null
    const root = cnCdnDir()
    if (!existsSync(root) || !statSync(root).isDirectory()) return null
    let built: CnPatchArchive | null
    try {
        built = buildCnPatchArchive(root, patches)
    } catch (error) {
        log(`can't read the Chinese CDN in ${root}: ${(error as Error).message}`)
        return null
    }
    for (const skip of built?.skipped ?? []) log(`Chinese CDN patch ${skip.assetPath} left out: ${skip.reason}`)
    if (!built) return null
    const dir = cnPatchDir()
    const name = cnPatchFileName(built.data)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    if (!existsSync(file)) writeFileSync(file, built.data)
    for (const old of readdirSync(dir)) if (old !== name && FILE_RE.test(old)) rmSync(path.join(dir, old), { force: true })
    return { file: name, data: built.data }
}

/** The path of a generated archive the CDN route may serve, or null. */
export function cnPatchArchivePath(file: string): string | null {
    if (!FILE_RE.test(file)) return null
    const full = path.join(cnPatchDir(), file)
    return existsSync(full) ? full : null
}
