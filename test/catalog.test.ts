import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

// ADM-1: the mail picker's catalog lists the master data's armaments and items with English names, item categories
// and armament rarities (assets/catalog_names.json)

let admin: FastifyInstance
let cleanup: () => Promise<void>
let catalog: any

before(async () => {
    ({ admin, cleanup } = await createTestServer())
    const response = await admin.inject({ method: "GET", url: "/api/catalog" })
    assert.equal(response.statusCode, 200)
    catalog = response.json()
})

after(async () => {
    await cleanup()
})

test("the catalog has names from the master data", () => {
    assert.equal(catalog.hasNames, true)
    assert.equal(catalog.units.find((unit: any) => unit.id === 111001)?.name, "Vagner")
    assert.deepEqual(catalog.items.find((item: any) => item.id === 1), { id: 1, name: "Ember Element", category: "Growth materials" })
    assert.deepEqual(catalog.equipment.find((armament: any) => armament.id === 100001), { id: 100001, name: "Smiles of the Forest", rarity: 5 })
    assert.equal(catalog.degrees.find((degree: any) => degree.id === 1)?.name, "World Voyager")
})

test("the catalog lists every master item and armament, not only those handed out", async () => {
    const { scanAssetItemAndEquipmentIds } = await import("../src/lib/catalog")
    const scanned = scanAssetItemAndEquipmentIds()
    const itemIds = new Set(catalog.items.map((item: any) => item.id))
    const equipmentIds = new Set(catalog.equipment.map((armament: any) => armament.id))
    assert.ok(scanned.items.every(id => itemIds.has(id)), "every item a reward or shop hands out is listed")
    assert.ok(scanned.equipment.every(id => equipmentIds.has(id)), "every armament a reward or shop hands out is listed")
    assert.ok(itemIds.size > scanned.items.length)
    assert.ok(equipmentIds.size > scanned.equipment.length)
})

test("every item has a category the picker offers, and every armament a rarity", () => {
    assert.ok(catalog.items.every((item: any) => catalog.itemCategories.includes(item.category)))
    assert.ok(catalog.equipment.every((armament: any) => armament.rarity >= 1 && armament.rarity <= 5))
    assert.ok(catalog.items.every((item: any) => typeof item.name === "string" && item.name.length > 0))
})
