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
    delete process.env.SERVER_NAME
    delete process.env.SHELL_CDN
    await cleanup()
})

test("/shell/config identifies a Reflipped server without any auth", async () => {
    delete process.env.SERVER_NAME
    delete process.env.SHELL_CDN
    const response = await fastify.inject({ method: "GET", url: "/shell/config" })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"] as string, /application\/json/)
    assert.deepEqual(response.json(), { reflipped: 1, name: "Reflipped", cdn: null })
})

test("/shell/config reports SERVER_NAME and SHELL_CDN", async () => {
    process.env.SERVER_NAME = "My Flipper"
    process.env.SHELL_CDN = "https://cdn.example.org/wf"
    const response = await fastify.inject({ method: "GET", url: "/shell/config" })
    assert.deepEqual(response.json(), { reflipped: 1, name: "My Flipper", cdn: "https://cdn.example.org/wf" })
})
