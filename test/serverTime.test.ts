import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
})

afterEach(async () => {
    await admin.inject({ method: "POST", url: "/api/server/resetTime" })
})

after(async () => {
    await cleanup()
})

async function currentServerTime(): Promise<string> {
    const { getServerDate } = await import("../src/utils")
    return getServerDate().toISOString()
}

test("server time accepts a time with seconds", async () => {
    const response = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2025-01-03T12:00:00" } })
    assert.equal(response.statusCode, 302)
    assert.equal(await currentServerTime(), "2025-01-03T12:00:00.000Z")
})

test("server time accepts the date picker format without seconds", async () => {
    const response = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2025-01-03T12:00" } })
    assert.equal(response.statusCode, 302)
    assert.equal(await currentServerTime(), "2025-01-03T12:00:00.000Z")
})

test("an invalid server time is rejected and the previous time is kept", async () => {
    await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2025-01-03T12:00:00" } })
    for (const bad of ["garbage", "2025-13-45T99:99:99", "2025-01-03"]) {
        const response = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: bad } })
        assert.equal(response.statusCode, 400, bad)
    }
    assert.equal(await currentServerTime(), "2025-01-03T12:00:00.000Z")
    assert.equal((await admin.inject({ method: "GET", url: "/" })).statusCode, 200)
})

test("the default clock is a fixed time with content, and reset returns to it", async () => {
    assert.equal(process.env.SERVER_TIME, undefined)
    assert.equal(await currentServerTime(), "2025-01-03T12:00:00.000Z")
    await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2025-01-05T08:30:00" } })
    assert.equal(await currentServerTime(), "2025-01-05T08:30:00.000Z")
    await admin.inject({ method: "POST", url: "/api/server/resetTime" })
    assert.equal(await currentServerTime(), "2025-01-03T12:00:00.000Z")
})

test("SERVER_TIME values are parsed, with \"real\" handled by the caller", async () => {
    const { parseServerTime } = await import("../src/utils")
    assert.equal(parseServerTime("2025-01-03T12:00")?.toISOString(), "2025-01-03T12:00:00.000Z")
    assert.equal(parseServerTime("2025-01-03T12:00:00Z")?.toISOString(), "2025-01-03T12:00:00.000Z")
    assert.equal(parseServerTime("real"), null)
    assert.equal(parseServerTime("2025-13-45T99:99:99"), null)
})
