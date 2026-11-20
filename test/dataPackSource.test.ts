// SH-29: the list the app builds Local play's data pack from (src/datapack/source.ts) is the pack builder's own, so a
// pack built on the phone holds exactly what `npm run datapack` puts in from the same CDN. Synthetic fixtures only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { CdnIndex, digestPath, masterAssetPath } from "../src/lib/cdnIndex";
import { buildDataPack, packTables } from "../src/datapack/build";
import { packSources } from "../src/datapack/source";
import { writeZip } from "../src/lib/zipWriter";

let tmp: string

before(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "datapack-source-test-")) })
after(() => rmSync(tmp, { recursive: true, force: true }))

test("the source lists every master and script file the builder takes, under its CDN member name", () => {
    const { required, optional } = packTables()
    const source = packSources({ cdnVersion: "2.1.125", region: "en" })
    assert.equal(source.format, 1)
    assert.deepEqual(source.files.map(f => f.path), [...source.files.map(f => f.path)].sort())
    for (const table of required) {
        const entry = source.files.find(f => f.member === digestPath(masterAssetPath(table)))
        assert.ok(entry?.required, `${table} is required`)
    }
    for (const table of optional) assert.equal(source.files.find(f => f.member === digestPath(masterAssetPath(table)))?.required, false)
    for (const file of source.files) {
        assert.match(file.member, /^production\/upload\/[0-9a-f]{2}\/[0-9a-f]{38}$/)
        assert.match(file.path, /^(master|files)\//)
    }

    // a CDN holding every listed file gives a pack of exactly the listed paths (besides assets/)
    const cdnRoot = path.join(tmp, "cdn", "en")
    mkdirSync(path.join(cdnRoot, "archive-common-full"), { recursive: true })
    writeFileSync(path.join(cdnRoot, "archive-common-full", "asset-2.1.0-1-aaaaaaaa.zip"),
        writeZip(source.files.map(f => ({ name: f.member, data: Buffer.from(f.path) }))))
    const built = buildDataPack({ index: CdnIndex.build(cdnRoot), region: "en", assetsDir: null, outDir: path.join(tmp, "out") })
    assert.deepEqual(built.manifest.files.map(f => f.path), source.files.map(f => f.path))
    assert.deepEqual(built.missingOptional, [])
})
