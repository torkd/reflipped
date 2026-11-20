import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

// The admin mail picker opens one thumbnail request per unit tile and one sprite sheet request per item tile on a cold
// browser cache. Those read-only image routes have their own, much higher limit instead of the admin listener's global one.

const API_TOKEN = "t".repeat(40)

let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ admin, cleanup } = await createTestServer({
        rateLimit: { global: 5, adminWrite: 2 },
        adminAuth: true,
        adminApiToken: API_TOKEN
    }))
})
after(async () => {
    await cleanup()
})

const authorised = { authorization: `Bearer ${API_TOKEN}` }

function get(url: string, remoteAddress: string, headers: Record<string, string> = authorised) {
    return admin.inject({ method: "GET", url, remoteAddress, headers })
}

test("catalogue thumbnails and the sprite sheet are not held to the global limit", async () => {
    for (let i = 1; i <= 60; i++) {
        const thumbnail = await get(`/api/catalog/thumbnail/units/${i}`, "10.1.0.1")
        assert.notEqual(thumbnail.statusCode, 429, `thumbnail ${i}`)
        const sheet = await get("/api/catalog/sheet?tile=" + i, "10.1.0.1")
        assert.notEqual(sheet.statusCode, 429, `sheet ${i}`)
    }
})

test("the catalogue image routes still need the admin login", async () => {
    for (let i = 0; i < 20; i++) {
        for (const url of ["/api/catalog/thumbnail/units/1", "/api/catalog/sheet"]) {
            const response = await get(url, "10.1.0.2", {})
            assert.notEqual(response.statusCode, 429, url)
            assert.notEqual(response.statusCode, 200, url)
            assert.notEqual(response.statusCode, 404, url)
        }
    }
})

test("other admin routes keep their limit for the same client", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 8; i++) statuses.push((await get("/api/catalog", "10.1.0.3")).statusCode)
    assert.equal(statuses[7], 429)
    assert.equal(statuses.slice(0, 5).includes(429), false)

    // while the images of that client's picker keep loading
    assert.notEqual((await get("/api/catalog/thumbnail/units/1", "10.1.0.3")).statusCode, 429)
    assert.notEqual((await get("/api/catalog/sheet", "10.1.0.3")).statusCode, 429)
})

test("the catalogue images still have a limit of their own", async () => {
    const limited = await createTestServer({ rateLimit: { global: 100, adminImages: 3 }, adminAuth: true, adminApiToken: API_TOKEN })
    try {
        const statuses: number[] = []
        for (let i = 1; i <= 5; i++) {
            statuses.push((await limited.admin.inject({ method: "GET", url: `/api/catalog/thumbnail/units/${i}`, remoteAddress: "10.1.0.4", headers: authorised })).statusCode)
        }
        assert.equal(statuses.slice(0, 3).includes(429), false)
        assert.equal(statuses[4], 429)
    } finally {
        await limited.cleanup()
    }
})
