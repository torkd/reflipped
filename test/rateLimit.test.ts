import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import { createTestServer, readCapturedRoute } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer({
        rateLimit: { global: 12, login: 3, signup: 2, gacha: 2, adminWrite: 2 }
    }))
    writeFileSync(path.join(process.env.CDN_DIR!, "probe.txt"), "cdn-probe")
})

after(async () => {
    await cleanup()
})

function login(remoteAddress: string) {
    return fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        remoteAddress,
        headers: { "content-type": "application/json;charset=UTF-8" },
        payload: readCapturedRoute("service_v4_auth_loginDevice").requestBody
    })
}

test("loginDevice returns 429 with a JSON body after its limit, per IP", async () => {
    for (let i = 0; i < 3; i++) assert.notEqual((await login("10.0.0.1")).statusCode, 429)
    const limited = await login("10.0.0.1")
    assert.equal(limited.statusCode, 429)
    assert.match(String(limited.headers["content-type"]), /json/)
    assert.equal(limited.json().statusCode, 429)

    // another IP has its own bucket
    assert.notEqual((await login("10.0.0.2")).statusCode, 429)
})

test("signup has its own stricter limit", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
        const response = await fastify.inject({
            method: "POST",
            url: "/latest/api/index.php/tool/signup",
            remoteAddress: "10.0.0.3",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: ""
        })
        statuses.push(response.statusCode)
    }
    assert.notEqual(statuses[1], 429)
    assert.equal(statuses[2], 429)
})

test("the global limit applies to ordinary routes", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 14; i++) {
        statuses.push((await fastify.inject({ method: "GET", url: "/news", remoteAddress: "10.0.0.4" })).statusCode)
    }
    assert.equal(statuses.slice(0, 12).includes(429), false)
    assert.equal(statuses[13], 429)
})

test("CDN files are not rate limited", async () => {
    for (let i = 0; i < 30; i++) {
        const response = await fastify.inject({ method: "GET", url: "/patch/Live/2.0.0/probe.txt", remoteAddress: "10.0.0.5" })
        assert.equal(response.statusCode, 200)
    }
})

test("mutating admin routes have a stricter limit", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
        statuses.push((await admin.inject({ method: "POST", url: "/api/server/resetTime", remoteAddress: "10.0.0.6" })).statusCode)
    }
    assert.notEqual(statuses[1], 429)
    assert.equal(statuses[2], 429)

    // reading still works for the same IP
    assert.notEqual((await admin.inject({ method: "GET", url: "/api/catalog", remoteAddress: "10.0.0.6" })).statusCode, 429)
})

test("trustProxy makes X-Forwarded-For the client IP", async () => {
    const proxied = await createTestServer({ rateLimit: { global: 2 }, trustProxy: true })
    try {
        const get = (forwarded: string) => proxied.fastify.inject({ method: "GET", url: "/news", headers: { "x-forwarded-for": forwarded } })
        await get("1.1.1.1")
        await get("1.1.1.1")
        assert.equal((await get("1.1.1.1")).statusCode, 429)
        assert.notEqual((await get("2.2.2.2")).statusCode, 429)
    } finally {
        await proxied.cleanup()
    }
})
