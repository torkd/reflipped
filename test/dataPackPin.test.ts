// SEC-19: a bundle built --no-assets pins the master tables of the official data pack (src/datapack/pin.json), and a
// pack with other masters is refused. Synthetic fixtures only; no game data.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { CdnIndex, digestPath, masterAssetPath } from "../src/lib/cdnIndex";
import { DataPack, masterPackPath, mastersDigest } from "../src/lib/dataPack";
import { buildDataPack, packTables } from "../src/datapack/build";
import { writeZip } from "../src/lib/zipWriter";

let tmp: string
let built: ReturnType<typeof buildDataPack>

before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "datapack-pin-test-"))
    const cdnRoot = path.join(tmp, "cdn", "en")
    mkdirSync(path.join(cdnRoot, "archive-common-full"), { recursive: true })
    const master = (table: string) => ({ name: digestPath(masterAssetPath(table)), data: Buffer.from(`${table} v0`) })
    writeFileSync(path.join(cdnRoot, "archive-common-full", "asset-2.1.0-1-aaaaaaaa.zip"), writeZip(packTables().required.map(master)))
    built = buildDataPack({ index: CdnIndex.build(cdnRoot), region: "en", assetsDir: null, outDir: path.join(tmp, "out") })
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test("a pack is refused when its master tables aren't the pinned ones, whatever its assets", () => {
    const digest = mastersDigest(built.manifest.files)
    assert.doesNotThrow(() => DataPack.open(built.folder, { expectedMastersDigest: digest }))
    assert.throws(() => DataPack.open(built.folder, { expectedMastersDigest: "0".repeat(64) }), /master tables are not the ones/)
    // the assets digest alone wouldn't notice altered masters
    assert.doesNotThrow(() => DataPack.open(built.folder, { expectedAssetsDigest: built.manifest.assetsDigest }))
})

test("the committed pin lists the master tables the server reads", () => {
    const pin = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "datapack", "pin.json"), "utf8")) as { tables: string[], mastersDigest: string }
    const { required, optional } = packTables()
    const known = new Set([...required, ...optional].map(masterPackPath))
    for (const table of required) assert.ok(pin.tables.includes(masterPackPath(table)),
        `${table} is read by the server but not in src/datapack/pin.json: run npm run datapack -- --write-pin src/datapack/pin.json`)
    for (const table of pin.tables) assert.ok(known.has(table), `${table} is pinned but no longer read by the server: refresh the pin`)
    assert.match(pin.mastersDigest, /^[0-9a-f]{64}$/)
})
