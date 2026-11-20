import { test } from "node:test";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";
import { Metrics } from "../src/lib/metrics";

test("health is minimal and metrics are authenticated, shared and use bounded labels", async () => {
    const token = "a".repeat(40)
    const metrics = new Metrics()
    const { fastify, admin, cleanup } = await createTestServer({ metrics, adminAuth: true, adminApiToken: token })
    try {
        const health = await fastify.inject({ url: "/healthz" })
        assert.equal(health.statusCode, 200)
        assert.deepEqual(health.json(), { status: "ok" })
        assert.equal(health.headers["cache-control"], "no-store")
        assert.equal((await fastify.inject({ url: "/api/server/metrics" })).statusCode, 404)
        assert.equal((await admin.inject({ url: "/api/server/metrics" })).statusCode, 401)
        assert.equal((await admin.inject({ url: "/api/server/metrics", headers: { authorization: "Bearer wrong" } })).statusCode, 401)
        await fastify.inject({ url: "/unknown-secret-one?token=secret" })
        await fastify.inject({ url: "/unknown-secret-two?token=secret" })
        const firstFile = "a".repeat(64) + ".zip"
        const secondFile = "b".repeat(64) + ".zip"
        await fastify.inject({ url: `/patch/Live/2.0.0/schedule/${firstFile}` })
        await fastify.inject({ url: `/patch/Live/2.0.0/schedule/${secondFile}` })
        const response = await admin.inject({ url: "/api/server/metrics", headers: { authorization: `Bearer ${token}` } })
        assert.equal(response.statusCode, 200)
        assert.equal(response.headers["cache-control"], "no-store")
        const body = response.json()
        assert.ok(body.uptimeSeconds > 0)
        assert.ok(body.eventLoopDelayMs.samples >= 0)
        assert.ok(body.routes.some((row: any) => row.listener === "game" && row.route === "/healthz" && row.count === 1 && row.totalMs >= 0))
        assert.ok(body.routes.some((row: any) => row.listener === "admin" && row.status === "4xx"))
        assert.ok(body.routes.some((row: any) => row.route === "/patch/Live/2.0.0/schedule/:file" && row.count === 2))
        assert.ok(!response.body.includes(firstFile))
        assert.ok(!response.body.includes(secondFile))
        assert.ok(!response.body.includes("unknown-secret"))
        assert.ok(!response.body.includes(token))
        assert.ok(!response.body.includes("?token"))
    } finally { await cleanup() }
})

test("health and metrics are rate limited like every other route", async () => {
    const { fastify, admin, cleanup } = await createTestServer({ rateLimit: { global: 2 } })
    try {
        const health = []
        const metrics = []
        for (let i = 0; i < 3; i++) {
            health.push((await fastify.inject({ url: "/healthz" })).statusCode)
            metrics.push((await admin.inject({ url: "/api/server/metrics" })).statusCode)
        }
        assert.deepEqual(health, [200, 200, 429])
        assert.deepEqual(metrics, [200, 200, 429])
    } finally { await cleanup() }
})

test("event loop monitoring stops after the last listener closes", async () => {
    const metrics = new Metrics()
    const game = Fastify()
    const admin = Fastify()
    metrics.register(game, "game")
    metrics.register(admin, "admin")
    await game.ready()
    await admin.ready()
    try {
        await new Promise(resolve => setTimeout(resolve, 100))
        const initial = metrics.snapshot().eventLoopDelayMs.samples
        assert.ok(initial > 0)
        await game.close()
        await new Promise(resolve => setTimeout(resolve, 100))
        assert.ok(metrics.snapshot().eventLoopDelayMs.samples > initial)
        await admin.close()
        const stopped = metrics.snapshot().eventLoopDelayMs.samples
        await new Promise(resolve => setTimeout(resolve, 100))
        assert.equal(metrics.snapshot().eventLoopDelayMs.samples, stopped)
    } finally { await game.close(); await admin.close() }
})
