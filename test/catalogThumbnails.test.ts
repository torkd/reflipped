import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { deflateRawSync } from "zlib";
import { createTestServer } from "./helpers";
import { digestPath, masterAssetPath } from "../src/lib/cdnIndex";
import { buildOrderedMap } from "../src/lib/orderedmap";
import { writeZip } from "../src/lib/zipWriter";
import { fakePng } from "./overlayFixtures";
import { CatalogImages, readAtlas } from "../src/lib/catalogImages";

// AMF3: dense array, dynamic object, and inline strings/integers.
const str = (s: string) => Buffer.concat([Buffer.from([s.length * 2 + 1]), Buffer.from(s)])
const field = (key: string, val: string | number | boolean) => Buffer.concat([str(key), typeof val === "string" ? Buffer.concat([Buffer.from([6]), str(val)]) : typeof val === "boolean" ? Buffer.from([val ? 3 : 2]) : Buffer.from([4, val])])
const row = (name: string, x: number, rotated = false) => Buffer.concat([Buffer.from([10, 11, 1]), field("n", name), field("x", x), field("y", 3), field("w", 10), field("h", 12), field("r", rotated), Buffer.from([1])])
const atlas = Buffer.concat([Buffer.from([9, 5, 1]), row("item/a", 4), row("item/b", 20, true)])

test("thumbnail catalog serves allowlisted assets only on authenticated admin listener", async () => {
    const token = "x".repeat(40)
    const { fastify, admin, cleanup } = await createTestServer({ adminAuth: true, adminApiToken: token })
    try {
        const dir = path.join(process.env.CDN_DIR!, "en", "archive-common-full")
        mkdirSync(dir, { recursive: true })
        const master = (rows: [string, string[][]][]) => buildOrderedMap(rows).encode()
        const medium = (name: string) => digestPath(name).replace("production/upload/", "production/medium_upload/")
        writeFileSync(path.join(dir, "asset-2.1.0-1-aaaa.zip"), writeZip([
            { name: digestPath(masterAssetPath("item/item")), data: master([["1", [["x", "test", "item/a"]]]]) },
            { name: digestPath(masterAssetPath("item/equipment")), data: master([["2010002", [["x", "test", "", "", "", "", "item/b"]]]]) },
            { name: digestPath(masterAssetPath("character/character")), data: master([["111001", [["test_unit"]]]]) },
            { name: digestPath("item/sprite_sheet.atlas.amf3.deflate"), data: deflateRawSync(atlas) },
            { name: digestPath("item/sprite_sheet.png"), data: fakePng(64, 64, 1) },
            { name: medium("character/test_unit/ui/square_132_132_0.png"), data: fakePng(32, 32, 2) }
        ]))
        const headers = { authorization: `Bearer ${token}` }
        assert.equal((await admin.inject({ url: "/api/catalog/sheet" })).statusCode, 401)
        assert.equal((await fastify.inject({ url: "/api/catalog/sheet" })).statusCode, 404)
        const catalog = (await admin.inject({ url: "/api/catalog", headers })).json()
        assert.deepEqual(catalog.items.find((v: any) => v.id === 1).thumbnail, { x: 4, y: 3, w: 10, h: 12, r: false })
        assert.deepEqual(catalog.equipment.find((v: any) => v.id === 2010002).thumbnail, { x: 20, y: 3, w: 10, h: 12, r: true })
        const sheet = await admin.inject({ url: "/api/catalog/sheet", headers })
        assert.equal(sheet.statusCode, 200)
        assert.equal(sheet.headers["content-type"], "image/png")
        assert.equal(sheet.rawPayload.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
        assert.equal((await admin.inject({ url: "/api/catalog/thumbnail/units/111001", headers })).statusCode, 200)
        for (const url of ["/api/catalog/thumbnail/units/999999", "/api/catalog/thumbnail/items/1", "/api/catalog/thumbnail/units/abc", "/api/catalog/thumbnail/units/1%2f..%2fsecret"]) assert.equal((await admin.inject({ url, headers })).statusCode, 404)
    } finally { await cleanup() }
})

test("invalid atlas and unavailable CDN fall back safely", () => {
    const missing = new CatalogImages("/tmp/reflipped-thumbnail-nonexistent")
    assert.equal(missing.image("sheet"), undefined)
    assert.equal(missing.rect("items", 1), undefined)
    assert.throws(() => readAtlas(Buffer.from([9, 3, 1, 10])))
    assert.throws(() => readAtlas(Buffer.from([9, 255, 255, 255, 255, 1])))
})


test("catalog without CDN keeps its existing item and armament response shape", async () => {
    const { admin, cleanup } = await createTestServer()
    try {
        const response = await admin.inject({ url: "/api/catalog" })
        assert.equal(response.statusCode, 200)
        const catalog = response.json()
        const { getItemCatalog } = await import("../src/lib/catalog")
        assert.deepEqual(catalog.items, getItemCatalog().items)
        assert.deepEqual(catalog.equipment, getItemCatalog().equipment)
    } finally { await cleanup() }
})
