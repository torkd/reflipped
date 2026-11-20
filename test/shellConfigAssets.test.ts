import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

// SH-13: the app reuses game files from another server only when this tells it the layers can't leave anything behind
test("/shell/config reports the base game files, the server's layers and whether it offers a data pack", async () => {
    const response = await fastify.inject({ method: "GET", url: "/shell/config" })
    assert.equal(response.statusCode, 200)
    const { assets, datapack } = response.json()
    assert.equal(assets.base, "2.1.125")
    assert.equal(typeof assets.schedule, "boolean")
    assert.equal(typeof assets.layers, "boolean")
    assert.equal(datapack, 0) // no DATA_PACK_SERVE_DIR in tests
})
