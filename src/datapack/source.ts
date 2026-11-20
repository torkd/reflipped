/**
 * SH-29: what a server data pack takes from the game's files, for the app to build the pack on the phone from the files
 * it has installed (client/air-shell/java/.../service/DataPackBuilder.java). The list is the builder's own
 * (`packTables()`, `BALANCE_SCRIPT_SOURCES`), with each file's CDN member name: the path the game's archives extract
 * it to, `production/upload/<h[:2]>/<h[2:]>`.
 *
 * `scripts/bundle.mjs --no-assets` writes it into the server bundle as `datapack-source/source.json`, beside a copy of
 * the converted game data (`datapack-source/assets/`), and the app's pack holds exactly those: a pack built on the phone
 * is the one `npm run datapack` builds from the same CDN, which the bundle's pins (`assetsDigest`, SEC-19's
 * `mastersDigest`) check.
 *
 *   node --import tsx src/datapack/source.ts <out file>
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { digestPath, masterAssetPath } from "../lib/cdnIndex";
import { assetPackPath, DATA_PACK_FORMAT, masterPackPath } from "../lib/dataPack";
import { BALANCE_SCRIPT_SOURCES } from "../lib/balanceChanges";
import { scriptAssetPath } from "../lib/skillScripts";
import { packTables } from "./build";

export interface SourceFile {
    /** The file's path in the pack. */
    path: string
    /** Where the game's archives put it: its CDN member name. */
    member: string
    /** The pack can't be built without it (the scheduling masters); the others are left out when missing. */
    required: boolean
}

export interface PackSource {
    format: number
    /** The pinned pack's CDN version and region (src/datapack/pin.json), written into the manifest. */
    cdnVersion: string
    region: string
    files: SourceFile[]
}

export function packSources(pin: { cdnVersion: string, region: string }): PackSource {
    const { required, optional } = packTables()
    const files: SourceFile[] = []
    for (const table of [...required, ...optional])
        files.push({ path: masterPackPath(table), member: digestPath(masterAssetPath(table)), required: required.includes(table) })
    for (const source of BALANCE_SCRIPT_SOURCES) {
        const assetPath = scriptAssetPath(source)
        files.push({ path: assetPackPath(assetPath), member: digestPath(assetPath), required: false })
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1))
    return { format: DATA_PACK_FORMAT, cdnVersion: pin.cdnVersion, region: pin.region, files }
}

if (require.main === module) {
    const out = process.argv[2]
    if (!out) {
        console.error("usage: node --import tsx src/datapack/source.ts <out file>")
        process.exit(2)
    }
    const pin = JSON.parse(readFileSync(path.join(__dirname, "pin.json"), "utf8")) as { cdnVersion: string, region: string }
    writeFileSync(out, JSON.stringify(packSources(pin), null, 1) + "\n")
}
