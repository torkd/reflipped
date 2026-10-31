// OPS-2: request IDs, no tokens or save data in the request log, generic 5xx bodies (src/lib/logging.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

let cleanup: () => Promise<void>
let app: FastifyInstance
const lines: string[] = []

before(async () => {
    ({ cleanup } = await createTestServer())

    // a game server of our own with a logger, plus routes that fail on purpose
    const { buildServer } = await import("../src/app")
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            lines.push(...chunk.toString().split("\n").filter((line: string) => line !== ""))
            callback()
        }
    })
    app = buildServer({ logger: { level: "info", stream } })
    app.get("/test/boom", async () => {
        throw new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: sessions.token")
    })
    app.get("/test/token", async (request) => {
        request.log.info({ zat: "zat-secret", session: { token: "nested-secret" }, viewerId: 7 }, "test entry")
        return { ok: true }
    })
    await app.ready()
})

after(async () => {
    await app.close()
    await cleanup()
})

test("every reply carries a request ID that matches its log lines", async () => {
    const first = await app.inject({ method: "GET", url: "/test/token" })
    const second = await app.inject({ method: "GET", url: "/test/token" })
    const id = first.headers["x-request-id"]
    assert.match(String(id), /^[0-9a-f]{16}$/)
    assert.notEqual(id, second.headers["x-request-id"])
    assert.ok(lines.some(line => JSON.parse(line).reqId === id), "the log has lines with that reqId")
})

test("a 5xx body is generic and names the request ID; the log has the real error", async () => {
    const response = await app.inject({ method: "GET", url: "/test/boom" })
    assert.equal(response.statusCode, 500)
    const body = response.json()
    assert.equal(body.message, "Internal Server Error")
    assert.equal(body.requestId, response.headers["x-request-id"])
    assert.doesNotMatch(response.body, /SQLITE|sessions/)

    const logged = lines.map(line => JSON.parse(line)).find(entry => entry.reqId === body.requestId && entry.err)
    assert.match(logged?.err?.message ?? "", /UNIQUE constraint failed/)
})

test("a 4xx keeps its message", async () => {
    const response = await app.inject({ method: "GET", url: "/no/such/route" })
    assert.equal(response.statusCode, 404)
    assert.ok(response.headers["x-request-id"])

    const bad = await app.inject({
        method: "POST", url: "/latest/api/index.php/load",
        headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "%%%not-msgpack"
    })
    assert.equal(bad.statusCode, 400)
    assert.notEqual(bad.json().message, "Internal Server Error")
})

test("sensitive query values and log fields are masked", async () => {
    // secret values no number or hex request ID can contain: a response time once matched a numeric one ("…999888…")
    await app.inject({ method: "GET", url: "/test/token?zat=query-zat-secret&link_code=query-link-secret&page=2" })
    const text = lines.join("\n")
    assert.doesNotMatch(text, /query-zat-secret|query-link-secret|zat-secret|nested-secret/)
    assert.match(text, /zat=\[redacted\]&link_code=\[redacted\]&page=2/)
    const entry = lines.map(line => JSON.parse(line)).find(e => e.msg === "test entry")
    assert.equal(entry.viewerId, 7)
    assert.equal(entry.zat, "[redacted]")
})

test("redactUrl keeps paths and harmless keys, and caps the length", async () => {
    const { redactUrl } = await import("../src/lib/logging")
    assert.equal(redactUrl("/infodesk/v2/appGroup?appGroupId=wdfp_service"), "/infodesk/v2/appGroup?appGroupId=wdfp_service")
    assert.equal(redactUrl("/x?accessToken=t&flag&f=a.png"), "/x?accessToken=[redacted]&flag&f=a.png")
    assert.equal(redactUrl("/x?%74oken=t"), "/x?%74oken=[redacted]")
    assert.ok(redactUrl("/" + "a".repeat(2000)).length <= 513)
})
