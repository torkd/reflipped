// The server data pack (SH-13 step 3): the builder against a tiny fake CDN, and the checks the server runs when it opens a
// pack. Synthetic fixtures only; no game data.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { CdnIndex, digestPath, masterAssetPath, readArchiveMember, readCentralDirectory } from "../src/lib/cdnIndex";
import { assetsDigest, DataPack, DataPackError, masterPackPath, PackDescriptor, parseManifest, sha256Hex } from "../src/lib/dataPack";
import { buildDataPack, packTables } from "../src/datapack/build";
import { SCHEDULE_MASTER_TABLES } from "../src/lib/scheduleOverlay";
import { writeZip } from "../src/lib/zipWriter";

let tmp: string
let cdnRoot: string
let assetsDir: string
let built: ReturnType<typeof buildDataPack>

const master = (table: string, text: string) => ({ name: digestPath(masterAssetPath(table)), data: Buffer.from(text) })

before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "datapack-test-"))
    cdnRoot = path.join(tmp, "cdn", "en")
    mkdirSync(path.join(cdnRoot, "archive-common-full"), { recursive: true })
    mkdirSync(path.join(cdnRoot, "archive-common-diff"), { recursive: true })
    const { required } = packTables()
    // every required table in the full archive (2.1.0) ...
    writeFileSync(path.join(cdnRoot, "archive-common-full", "asset-2.1.0-1-aaaaaaaa.zip"),
        writeZip(required.map(t => master(t, `${t} v0`))))
    // ... one of them changed by a diff (2.1.5), and a file the server doesn't read
    writeFileSync(path.join(cdnRoot, "archive-common-diff", "asset-2.1.4-2.1.5-1-bbbbbbbb.zip"),
        writeZip([master("item/item", "item/item v5"), master("not/read", "x")]))
    assetsDir = path.join(tmp, "assets")
    mkdirSync(path.join(assetsDir, "asset_lists"), { recursive: true })
    writeFileSync(path.join(assetsDir, "a.json"), "[1,2]")
    writeFileSync(path.join(assetsDir, "asset_lists", "b.json"), '{"b":true}')
    built = buildDataPack({ index: CdnIndex.build(cdnRoot), region: "en", assetsDir, outDir: path.join(tmp, "out") })
})

after(() => rmSync(tmp, { recursive: true, force: true }))

test("the pack holds the latest copy of each master the server reads, and only those", () => {
    assert.equal(built.manifest.cdnVersion, "2.1.5")
    const masters = built.manifest.files.filter(f => f.path.startsWith("master/"))
    // the balance tables are optional and not in this CDN
    assert.equal(masters.length, new Set(SCHEDULE_MASTER_TABLES).size)
    assert.ok(built.missingOptional.length > 0)
    assert.ok(!built.manifest.files.some(f => f.path.includes("not/read")))
    const pack = DataPack.open(built.folder)
    assert.equal(pack.readMaster("item/item")?.toString(), "item/item v5")
    assert.equal(pack.readMaster("/item/item")?.toString(), "item/item v5")
    assert.equal(pack.readMaster("gacha/gacha")?.toString(), "gacha/gacha v0")
    assert.equal(pack.readMaster("not/read"), undefined)
    assert.equal(built.manifest.files.find(f => f.path === masterPackPath("item/item"))?.version, "2.1.5")
    assert.equal(built.manifest.files.find(f => f.path === masterPackPath("gacha/gacha"))?.version, "2.1.0")
})

test("the assets are in the pack, under assets/, with a digest over them", () => {
    assert.deepEqual(built.manifest.files.filter(f => f.path.startsWith("assets/")).map(f => f.path), ["assets/a.json", "assets/asset_lists/b.json"])
    assert.equal(built.manifest.assetsDigest, assetsDigest(built.manifest.files))
    assert.equal(readFileSync(path.join(built.folder, "assets", "asset_lists", "b.json"), "utf8"), '{"b":true}')
})

test("the archive holds the same files, and the descriptor carries its size and SHA-256", () => {
    const descriptor: PackDescriptor = JSON.parse(readFileSync(built.descriptorFile, "utf8"))
    const archive = readFileSync(built.archive)
    assert.equal(descriptor.size, archive.length)
    assert.equal(descriptor.sha256, sha256Hex(archive))
    assert.equal(descriptor.archive, path.basename(built.archive))
    assert.equal(descriptor.manifestSha256, sha256Hex(readFileSync(path.join(built.folder, "manifest.json"))))
    const members = readCentralDirectory(built.archive)
    assert.deepEqual(members.map(m => m.name).sort(), [...built.manifest.files.map(f => f.path), "manifest.json"].sort())
    for (const m of members) {
        const data = readArchiveMember(built.archive, m)
        if (m.name === "manifest.json") assert.equal(sha256Hex(data), descriptor.manifestSha256)
        else assert.equal(sha256Hex(data), built.manifest.files.find(f => f.path === m.name)?.sha256)
    }
})

test("the same CDN gives the same bytes", () => {
    const again = buildDataPack({ index: CdnIndex.build(cdnRoot), region: "en", assetsDir, outDir: path.join(tmp, "out2") })
    assert.equal(again.descriptor.sha256, built.descriptor.sha256)
})

test("a CDN missing a master the server needs fails the build, naming it", () => {
    const empty = path.join(tmp, "cdn2", "en")
    mkdirSync(path.join(empty, "archive-common-full"), { recursive: true })
    writeFileSync(path.join(empty, "archive-common-full", "asset-2.1.0-1-cccccccc.zip"), writeZip([master("item/item", "x")]))
    assert.throws(() => buildDataPack({ index: CdnIndex.build(empty), region: "en", assetsDir: null, outDir: path.join(tmp, "out3") }),
        /missing \d+ master file\(s\).*gacha\/gacha/)
})

test("opening a pack checks every file against the manifest", () => {
    DataPack.open(built.folder) // intact
    // a changed file
    const folder = path.join(tmp, "tampered")
    buildDataPack({ index: CdnIndex.build(cdnRoot), region: "en", assetsDir, outDir: folder })
    const dir = path.join(folder, "datapack")
    writeFileSync(path.join(dir, "master", "item", "item.orderedmap"), "item/item v6")
    assert.throws(() => DataPack.open(dir), (e: Error) => e instanceof DataPackError && /master\/item\/item\.orderedmap: checksum differs/.test(e.message))
    assert.doesNotThrow(() => DataPack.open(dir, { verify: false }))
    // a missing file
    rmSync(path.join(dir, "assets", "a.json"))
    assert.throws(() => DataPack.open(dir), /assets\/a\.json: missing/)
    // no manifest, no folder
    rmSync(path.join(dir, "manifest.json"))
    assert.throws(() => DataPack.open(dir), /manifest\.json is missing/)
    assert.throws(() => DataPack.open(path.join(tmp, "nothing")), /not found/)
})

test("a pack built for other assets, or another format, is refused", () => {
    assert.throws(() => DataPack.open(built.folder, { expectedAssetsDigest: "0".repeat(64) }), /not the one this server was built with/)
    assert.doesNotThrow(() => DataPack.open(built.folder, { expectedAssetsDigest: built.manifest.assetsDigest }))
    const text = readFileSync(path.join(built.folder, "manifest.json"), "utf8")
    assert.throws(() => parseManifest(text.replace('"format": 1', '"format": 2')), /unsupported data pack format 2/)
    assert.throws(() => parseManifest("{"), /not valid JSON/)
    // a manifest can't point outside the pack
    const evil = JSON.parse(text)
    evil.files[0].path = "master/../../etc/passwd"
    assert.throws(() => parseManifest(JSON.stringify(evil)), /bad file entry/)
})
