import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    writeFileSync(path.join(process.env.CDN_DIR!, "probe.txt"), "cdn-probe")
})

after(async () => {
    await cleanup()
})

test("CDN files are served under /patch/Live/2.0.0", async () => {
    const response = await fastify.inject({ method: "GET", url: "/patch/Live/2.0.0/probe.txt" })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, "cdn-probe")
})

test("web static files are served under /public", async () => {
    const response = await fastify.inject({ method: "GET", url: "/public/img/logo.svg" })
    assert.equal(response.statusCode, 200)
    assert.match(String(response.headers["content-type"]), /^image\/svg\+xml/)
})

test("admin panel is branded Reflipped and links Credits instead of the source code", async () => {
    for (const url of ["/", "/player", "/credits"]) {
        const page = await admin.inject({ method: "GET", url })
        assert.equal(page.statusCode, 200, url)
        assert.match(page.body, /class="brand-name">Reflipped</, url)
        assert.match(page.body, /href="\/credits"/, url)
        assert.doesNotMatch(page.body, /Source Code|logo\.png/, url)
    }
    const credits = await admin.inject({ method: "GET", url: "/credits" })
    assert.match(credits.body, /href="\/credits" class="nav-link nav-link-active"/, "Credits highlighted on its page")
    for (const name of ["Dav", "Taene", "Duosion", "Jolt"]) assert.match(credits.body, new RegExp(`>${name}<`), name)
})

test("static mounts don't escape their root", async () => {
    for (const url of [
        "/patch/Live/2.0.0/../../../package.json",
        "/patch/Live/2.0.0/%2e%2e/%2e%2e/%2e%2e/package.json",
        "/patch/Live/2.0.0/..%2f..%2f..%2fpackage.json",
        "/public/..%2f..%2fpackage.json"
    ]) {
        const response = await fastify.inject({ method: "GET", url })
        assert.notEqual(response.statusCode, 200, `${url} returned 200`)
        assert.ok(!response.body.includes('"name": "reflipped"'), `${url} leaked package.json`)
    }
})

test("the news page the game's urlHomeNews points at is served", async () => {
    const response = await fastify.inject({ method: "GET", url: "/news" })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"] as string, /text\/html/)
    assert.match(response.body, /Reflipped news/)
    assert.match(response.body, /2025-01-03 12:00:00 UTC/)
})

test("the game server has no admin routes; they are only on the admin server", async () => {
    const adminRoutes: { method: "GET" | "POST", url: string }[] = [
        { method: "GET", url: "/" },
        { method: "GET", url: "/player" },
        { method: "GET", url: "/credits" },
        { method: "GET", url: "/api/catalog" },
        { method: "POST", url: "/api/server/time" },
        { method: "POST", url: "/api/server/resetTime" },
        { method: "GET", url: "/api/player/save?id=1" },
        { method: "POST", url: "/api/player/save?id=1" },
        { method: "POST", url: "/api/player/mail?id=1" },
        { method: "POST", url: "/api/player/developer-mode?id=1&state=on" }
    ]
    for (const { method, url } of adminRoutes) {
        const response = await fastify.inject({ method, url })
        assert.equal(response.statusCode, 404, `${method} ${url} is reachable on the game server`)
    }
    assert.equal((await admin.inject({ method: "GET", url: "/api/catalog" })).statusCode, 200)
    assert.equal((await admin.inject({ method: "GET", url: "/news" })).statusCode, 404, "news is a game page")
})
