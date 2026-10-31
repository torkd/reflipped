// SEC-6: request body schemas, body size limits and msgpack limits (src/routes/schemas.ts, src/lib/bodyLimits.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import type { FastifyInstance, RouteOptions } from "fastify";
import { createTestServer, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

const docsRoutesDir = path.join(__dirname, "..", "docs", "routes")

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

/** Builds a server (not started) and collects its routes, since Fastify doesn't expose a route's schema afterwards. */
async function collectRoutes(build: "buildServer" | "buildAdminServer"): Promise<RouteOptions[]> {
    const app = await import("../src/app")
    const instance = app[build]()
    const routes: RouteOptions[] = []
    instance.addHook("onRoute", route => { routes.push(route) })
    await instance.ready()
    await instance.close()
    return routes
}

/** Replaces every `"<redacted>"` viewer_id in a captured body with a number, as the client would send. */
function unredactViewerIds(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(unredactViewerIds)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
        [key, key === "viewer_id" && child === "<redacted>" ? 123456789 : unredactViewerIds(child)]))
}

interface Capture { name: string, url: string, body: unknown }

function captures(): Capture[] {
    const result: Capture[] = []
    for (const file of readdirSync(docsRoutesDir)) {
        const name = file.replace(/\.md$/, "")
        const url = readFileSync(path.join(docsRoutesDir, file), "utf-8").split("\n")[0].replace(/^#\s*/, "").trim()
        let body: unknown
        try {
            body = readCapturedRoute(name).requestBody
        } catch {
            continue // GET captures without a body block
        }
        if (body !== undefined) result.push({ name, url, body: unredactViewerIds(body) })
    }
    return result
}

function depth(value: unknown): number {
    if (value === null || typeof value !== "object") return 0
    return 1 + Math.max(0, ...Object.values(value).map(depth))
}

test("every game API route and every body-reading route declares a schema", async () => {
    const routes = await collectRoutes("buildServer")
    const missing = routes
        .filter(route => route.method === "POST" && route.schema?.body === undefined)
        .map(route => route.url)
    assert.deepEqual(missing, [], "POST routes without a body schema (use `ignoredBody` for routes that don't read it)")
})

test("every admin API route that takes input declares a schema", async () => {
    const routes = await collectRoutes("buildAdminServer")
    const missing = routes
        .filter(route => route.url.startsWith("/api/"))
        .filter(route => route.schema?.body === undefined && route.schema?.querystring === undefined)
        .map(route => `${route.method} ${route.url}`)
    assert.deepEqual(missing, [])
})

test("every captured client request passes its route's schema", async () => {
    let checked = 0
    for (const capture of captures()) {
        const isGame = capture.url.startsWith("/latest/api/index.php/")
        const response = isGame
            ? await fastify.inject({ method: "POST", url: capture.url, headers: gameHeaders("VALIDATION-TEST"), payload: encodeGameBody(capture.body) })
            : await fastify.inject({ method: "POST", url: `/openapi${capture.url}`, headers: { "content-type": "application/json;charset=UTF-8" }, payload: capture.body as object })
        if (response.statusCode === 404) continue // not implemented yet
        checked++
        const code = response.statusCode === 400 ? response.json().code : undefined
        assert.notEqual(code, "FST_ERR_VALIDATION", `${capture.name}: ${response.body}`)
    }
    assert.ok(checked >= 60, `only ${checked} captures reached a route`)
})

test("captured bodies are far inside the msgpack limits", async () => {
    const { MAX_BODY_DEPTH, GAME_BODY_LIMIT } = await import("../src/lib/bodyLimits")
    for (const capture of captures()) {
        assert.ok(depth(capture.body) <= MAX_BODY_DEPTH / 4, `${capture.name} is ${depth(capture.body)} deep`)
        assert.ok(encodeGameBody(capture.body).length <= GAME_BODY_LIMIT / 16, `${capture.name} is large`)
    }
})

test("a body with a wrong type is rejected with a validation error before auth", async () => {
    const response = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/shop/buy",
        headers: gameHeaders("VALIDATION-TEST"),
        payload: encodeGameBody({ viewer_id: 123456789, shop_type: "two", shop_item_id: 1, number: 1 })
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, "FST_ERR_VALIDATION")
})

test("a game body without viewer_id is rejected", async () => {
    const response = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/mail/index",
        headers: gameHeaders("VALIDATION-TEST"),
        payload: encodeGameBody({})
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, "FST_ERR_VALIDATION")
})

test("a msgpack body nested too deep is rejected", async () => {
    let nested: unknown = 1
    for (let i = 0; i < 40; i++) nested = [nested]
    const response = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/mail/index",
        headers: gameHeaders("VALIDATION-TEST"),
        payload: encodeGameBody({ viewer_id: 123456789, nested })
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, "FST_ERR_BODY_LIMITS")
})

test("a msgpack body with too many values is rejected", async () => {
    const response = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/mail/index",
        headers: gameHeaders("VALIDATION-TEST"),
        payload: encodeGameBody({ viewer_id: 123456789, values: new Array(150_000).fill(0) })
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, "FST_ERR_BODY_LIMITS")
})

test("a body that isn't msgpack is a 400, not a 500", async () => {
    const response = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/mail/index",
        headers: gameHeaders("VALIDATION-TEST"),
        payload: Buffer.from([0xc1, 0xc1, 0xc1]).toString("base64")
    })
    assert.equal(response.statusCode, 400)
})

test("a body over the limit is rejected with 413", async () => {
    const response = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/mail/index",
        headers: gameHeaders("VALIDATION-TEST"),
        payload: "A".repeat(1024 * 1024 + 4)
    })
    assert.equal(response.statusCode, 413)

    const adminResponse = await admin.inject({
        method: "POST",
        url: "/api/player/mail?id=1",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ padding: "x".repeat(1024 * 1024 + 4) })
    })
    assert.equal(adminResponse.statusCode, 413)
})

test("a JSON body nested too deep is rejected", async () => {
    const response = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json" },
        payload: "[".repeat(100) + "]".repeat(100)
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, "FST_ERR_BODY_LIMITS")
})

test("nullable() keeps a null as null under ajv's type coercion", async () => {
    const { default: Ajv } = await import("ajv")
    const { integer, nullable, object } = await import("../src/routes/schemas")
    const validate = new Ajv({ coerceTypes: "array" }).compile(object({ id: nullable(integer) }))
    const data: { id: unknown } = { id: null }
    assert.ok(validate(data))
    assert.equal(data.id, null)
})
