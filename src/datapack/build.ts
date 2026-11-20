/**
 * Builds the server data pack (SH-13 step 3, src/lib/dataPack.ts): the latest copy of every master file the server
 * reads from the CDN, plus the converted game data of `assets/`. The master list is not kept here: it is the
 * server's own (`SCHEDULE_MASTER_TABLES`, `BALANCE_MASTER_TABLES` of src/lib/scheduleOverlay.ts), so a table the
 * server starts reading is in the next pack. Output (`<out>/`):
 *
 *   datapack/                          the folder `DATA_PACK_DIR` points at
 *   reflipped-datapack-<cdn>.zip       the same files in one archive (deterministic: the same input gives the same bytes)
 *   reflipped-datapack-<cdn>.json      the descriptor (`PackDescriptor`): the archive's size and SHA-256 for the download check
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { CdnIndex, formatAssetVersion, masterAssetPath } from "../lib/cdnIndex";
import {
    assetPackPath, assetsDigest, ASSETS_DIR, DATA_PACK_FORMAT, DataPack, MANIFEST_FILE, masterPackPath, PackDescriptor, PackFile, PackManifest, sha256Hex
} from "../lib/dataPack";
import { BALANCE_MASTER_TABLES, SCHEDULE_MASTER_TABLES } from "../lib/scheduleOverlay";
import { BALANCE_SCRIPT_SOURCES } from "../lib/balanceChanges";
import { scriptAssetPath } from "../lib/skillScripts";
import { writeZip, ZipFile } from "../lib/zipWriter";

export interface BuildPackOptions {
    index: CdnIndex
    /** The CDN region the index covers (recorded in the manifest). */
    region: string
    /** The converted game data (`assets/`); null leaves it out of the pack. */
    assetsDir: string | null
    outDir: string
}

export interface BuiltPack {
    folder: string
    archive: string
    descriptorFile: string
    descriptor: PackDescriptor
    manifest: PackManifest
    masters: number
    missingOptional: string[]
}

/** The master tables the server reads: the ones it can't schedule without, and the optional balance tables. */
export function packTables(): { required: string[], optional: string[] } {
    const required = [...new Set(SCHEDULE_MASTER_TABLES)].sort()
    return { required, optional: [...new Set(BALANCE_MASTER_TABLES)].filter(t => !required.includes(t)).sort() }
}

function listFiles(dir: string, base = ""): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir).sort()) {
        const rel = base ? `${base}/${name}` : name
        if (statSync(path.join(dir, name)).isDirectory()) out.push(...listFiles(path.join(dir, name), rel))
        else out.push(rel)
    }
    return out
}

export function buildDataPack(options: BuildPackOptions): BuiltPack {
    const { index } = options
    const { required, optional } = packTables()
    const cdnVersion = formatAssetVersion(index.latestVersion)
    if (cdnVersion === "0.0.0") throw new Error("the CDN has no asset archives")

    const contents = new Map<string, Buffer>()
    const files: PackFile[] = []
    const add = (packPath: string, data: Buffer, version?: string) => {
        contents.set(packPath, data)
        files.push({ path: packPath, size: data.length, sha256: sha256Hex(data), ...(version ? { version } : {}) })
    }

    const missing: string[] = []
    const missingOptional: string[] = []
    for (const table of [...required, ...optional]) {
        const entry = index.entry(masterAssetPath(table))
        const data = entry ? index.read(masterAssetPath(table)) : undefined
        if (!entry || !data) {
            (required.includes(table) ? missing : missingOptional).push(table)
            continue
        }
        add(masterPackPath(table), data, formatAssetVersion(entry.version))
    }
    if (missing.length > 0) throw new Error(`the CDN is missing ${missing.length} master file(s) the server needs: ${missing.join(", ")}`)
    // the battle scripts balance changes patch (optional like the balance tables: without them the overlay can't be built
    // for a time before those changes)
    for (const source of BALANCE_SCRIPT_SOURCES) {
        const assetPath = scriptAssetPath(source)
        const entry = index.entry(assetPath)
        const data = entry ? index.read(assetPath) : undefined
        if (!entry || !data) missingOptional.push(assetPath)
        else add(assetPackPath(assetPath), data, formatAssetVersion(entry.version))
    }

    if (options.assetsDir)
        for (const rel of listFiles(options.assetsDir)) add(`${ASSETS_DIR}/${rel}`, readFileSync(path.join(options.assetsDir, rel)))

    files.sort((a, b) => (a.path < b.path ? -1 : 1))
    const manifest: PackManifest = { format: DATA_PACK_FORMAT, cdnVersion, region: options.region, assetsDigest: assetsDigest(files), files }
    const manifestData = Buffer.from(JSON.stringify(manifest, null, 1) + "\n")

    // the folder
    const folder = path.join(options.outDir, "datapack")
    rmSync(folder, { recursive: true, force: true })
    for (const [packPath, data] of [...contents, [MANIFEST_FILE, manifestData] as const]) {
        const file = path.join(folder, ...packPath.split("/"))
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, data)
    }

    // the archive and its descriptor
    const zipFiles: ZipFile[] = [...contents].map(([name, data]) => ({ name, data }))
    zipFiles.push({ name: MANIFEST_FILE, data: manifestData })
    const zip = writeZip(zipFiles)
    const base = `reflipped-datapack-${cdnVersion}`
    const archive = path.join(options.outDir, `${base}.zip`)
    writeFileSync(archive, zip)
    const descriptor: PackDescriptor = {
        format: DATA_PACK_FORMAT, cdnVersion, archive: `${base}.zip`, size: zip.length, sha256: sha256Hex(zip),
        manifestSha256: sha256Hex(manifestData), assetsDigest: manifest.assetsDigest
    }
    const descriptorFile = path.join(options.outDir, `${base}.json`)
    writeFileSync(descriptorFile, JSON.stringify(descriptor, null, 1) + "\n")

    DataPack.open(folder) // the folder must pass the check the server runs
    return { folder, archive, descriptorFile, descriptor, manifest, masters: files.filter(f => !f.path.startsWith(ASSETS_DIR + "/")).length, missingOptional }
}
