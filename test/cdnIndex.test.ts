// CDN index (I18N-1): newest archive entry per asset path, against a tiny fake CDN. Synthetic fixtures only.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { deflateRawSync } from "zlib";
import { archiveVersion, CdnIndex, digestPath, masterAssetPath, masterTableName, regionCdnDir } from "../src/lib/cdnIndex";

/** A minimal zip writer: stored or deflated entries, no data descriptors. */
function zip(entries: { name: string, data: Buffer, deflate?: boolean }[]): Buffer {
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0
    for (const e of entries) {
        const name = Buffer.from(e.name, "utf8")
        const body = e.deflate ? deflateRawSync(e.data) : e.data
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(e.deflate ? 8 : 0, 8)
        local.writeUInt32LE(0, 14) // crc is not checked by the reader
        local.writeUInt32LE(body.length, 18)
        local.writeUInt32LE(e.data.length, 22)
        local.writeUInt16LE(name.length, 26)
        locals.push(local, name, body)
        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(e.deflate ? 8 : 0, 10)
        central.writeUInt32LE(body.length, 20)
        central.writeUInt32LE(e.data.length, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt32LE(offset, 42)
        centrals.push(central, name)
        offset += 30 + name.length + body.length
    }
    const cd = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, cd, eocd])
}

let dir: string
let region: string

function archive(folder: string, name: string, files: Record<string, string>, deflate = false) {
    mkdirSync(path.join(region, folder), { recursive: true })
    writeFileSync(path.join(region, folder, name), zip(Object.entries(files).map(([p, text]) => ({
        name: digestPath(p), data: Buffer.from(text), deflate
    }))))
}

before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cdn-index-test-"))
    region = path.join(dir, "en")
    archive("archive-common-full", "asset-2.1.0-1-aaaaaaaa.zip", {
        "master/item/item.orderedmap": "full",
        "master/only/full.orderedmap": "only in the full archive"
    })
    archive("archive-common-diff", "asset-2.1.9-2.1.10-1-bbbbbbbb.zip", { "master/item/item.orderedmap": "v10" }, true)
    // 2.1.100 is newer than 2.1.9 and 2.1.10 although it sorts before them as text
    archive("archive-common-diff", "asset-2.1.99-2.1.100-1-cccccccc.zip", { "master/item/item.orderedmap": "v100" }, true)
    archive("archive-common-diff", "asset-2.1.10-2.1.11-1-dddddddd.zip", { "master/item/item.orderedmap": "v11" })
    archive("archive-medium-full", "s_asset-2.1.0-3-eeeeeeee.zip", { "image/banner.png": "png" })
    // a same-version copy in a later folder doesn't replace the first
    archive("archive-medium-full", "asset-2.1.0-4-ffffffff.zip", { "master/only/full.orderedmap": "second copy" })
    // not archives: other folders, other names, a broken zip
    archive("entities", "asset-2.1.0-9-99999999.zip", { "master/item/item.orderedmap": "ignored folder" })
    archive("archive-common-diff", "notes.zip", { "master/item/item.orderedmap": "ignored name" })
    writeFileSync(path.join(region, "archive-common-diff", "asset-2.1.200-2.1.201-1-12345678.zip"), "not a zip")
})

after(() => {
    rmSync(dir, { recursive: true, force: true })
})

test("digested names follow the CDN layout", () => {
    // sha1("master/item/item.orderedmap" + salt), split after two hex digits (same as extract_master.py)
    assert.equal(digestPath("master/item/item.orderedmap"), "production/upload/a4/731a843d4dc0c84120bf8c88784c1e74c03baa")
    assert.equal(masterAssetPath("/string/ui_string"), "master/string/ui_string.orderedmap")
    assert.equal(masterTableName("master/item/item.orderedmap"), "item/item")
    assert.deepEqual(archiveVersion("asset-2.1.0-12-da17371c.zip"), [2, 1, 0])
    assert.deepEqual(archiveVersion("asset-2.1.107-2.1.108-1-b172793e.zip"), [2, 1, 108])
    assert.deepEqual(archiveVersion("s_asset-2.1.0-47-191d70b3.zip"), [2, 1, 0])
    assert.equal(archiveVersion("2.1.125-android_medium.csv"), null)
})

test("the newest asset version wins", () => {
    const bad: string[] = []
    const index = CdnIndex.build(region, { onBadArchive: a => bad.push(path.basename(a)) })
    assert.deepEqual(bad, ["asset-2.1.200-2.1.201-1-12345678.zip"])
    assert.equal(index.read("master/item/item.orderedmap")?.toString(), "v100")
    assert.deepEqual(index.entry("master/item/item.orderedmap")?.version, [2, 1, 100])
    assert.equal(index.readMaster("item/item")?.toString(), "v100")
    assert.equal(index.read("master/only/full.orderedmap")?.toString(), "only in the full archive")
    assert.equal(index.read("image/banner.png")?.toString(), "png")
    assert.equal(index.read("master/missing.orderedmap"), undefined)
    assert.equal(index.has("master/missing.orderedmap"), false)
    assert.deepEqual(index.stats, { members: 3, archives: 6 })
})

test("maxVersion ignores newer archives", () => {
    const index = CdnIndex.build(region, { maxVersion: "2.1.11", onBadArchive: () => {} })
    assert.equal(index.read("master/item/item.orderedmap")?.toString(), "v11")
    const full = CdnIndex.build(region, { maxVersion: "2.1.0", onBadArchive: () => {} })
    assert.equal(full.read("master/item/item.orderedmap")?.toString(), "full")
})

test("regionCdnDir takes the region folder when it exists", () => {
    assert.equal(regionCdnDir("en", dir), region)
    assert.equal(regionCdnDir("ko", dir), path.resolve(dir))
    assert.throws(() => CdnIndex.build(path.join(dir, "nope")), /not found/)
})
