import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createTestServer } from "./helpers";

// ADMIN_TRUST_PROXY: the admin site believes X-Forwarded-Proto: https from the web servers listed there (an HTTPS
// reverse proxy in front of it), for the login cookie's Secure flag and the unencrypted connection warning. Nothing
// else from those headers.

const WARNING = "This connection isn't encrypted"

let admin: FastifyInstance
// imported once the helper has pointed the database at a temp folder
let isHttpsAdminRequest: (request: FastifyRequest) => boolean
let cleanup: () => Promise<void>

before(async () => {
    ({ admin, cleanup } = await createTestServer({ adminAuth: true }))
    ;({ isHttpsAdminRequest } = await import("../src/lib/adminAuth"))
})

after(async () => {
    delete process.env.ADMIN_TRUST_PROXY
    await cleanup()
})

beforeEach(() => {
    delete process.env.ADMIN_TRUST_PROXY
})

function fakeRequest(remoteAddress: string, proto?: string | string[]): FastifyRequest {
    return { protocol: "http", socket: { remoteAddress }, headers: proto === undefined ? {} : { "x-forwarded-proto": proto } } as unknown as FastifyRequest
}

function setupPage(remoteAddress: string, headers: Record<string, string> = {}) {
    return admin.inject({ method: "GET", url: "/setup", remoteAddress, headers: { host: "192.0.2.1:8001", ...headers } })
}

test("without ADMIN_TRUST_PROXY, X-Forwarded-Proto is ignored", async () => {
    assert.equal(isHttpsAdminRequest(fakeRequest("172.28.42.1", "https")), false)
    const page = await setupPage("172.28.42.1", { "x-forwarded-proto": "https" })
    assert.ok(page.body.includes(WARNING))
})

test("a listed proxy's https is believed, by address or CIDR, IPv4-mapped too", async () => {
    process.env.ADMIN_TRUST_PROXY = "10.0.0.5, 172.28.42.0/24, fd00::/8"
    assert.equal(isHttpsAdminRequest(fakeRequest("10.0.0.5", "https")), true)
    assert.equal(isHttpsAdminRequest(fakeRequest("172.28.42.1", "HTTPS")), true)
    assert.equal(isHttpsAdminRequest(fakeRequest("::ffff:172.28.42.7", "https, http")), true)
    assert.equal(isHttpsAdminRequest(fakeRequest("fd00::1", ["https"])), true)
    const page = await setupPage("172.28.42.1", { "x-forwarded-proto": "https" })
    assert.equal(page.statusCode, 200)
    assert.ok(!page.body.includes(WARNING))
})

test("other addresses, other schemes and a missing header stay unencrypted", async () => {
    process.env.ADMIN_TRUST_PROXY = "172.28.42.0/24"
    assert.equal(isHttpsAdminRequest(fakeRequest("172.28.43.1", "https")), false)
    assert.equal(isHttpsAdminRequest(fakeRequest("172.28.42.1", "http")), false)
    assert.equal(isHttpsAdminRequest(fakeRequest("172.28.42.1", "http, https")), false)
    assert.equal(isHttpsAdminRequest(fakeRequest("172.28.42.1")), false)
    const page = await setupPage("192.0.2.9", { "x-forwarded-proto": "https" })
    assert.ok(page.body.includes(WARNING))
})

test("entries that aren't addresses are skipped", () => {
    process.env.ADMIN_TRUST_PROXY = "proxy.example, 10.0.0.0/33, 10.0.0.0/x, 10.1.0.0/16"
    const warn = console.warn
    console.warn = () => {}
    try {
        assert.equal(isHttpsAdminRequest(fakeRequest("10.0.0.1", "https")), false)
        assert.equal(isHttpsAdminRequest(fakeRequest("10.1.2.3", "https")), true)
    } finally {
        console.warn = warn
    }
})

test("the forwarded scheme never opens the host check", async () => {
    process.env.ADMIN_TRUST_PROXY = "172.28.42.0/24"
    const response = await admin.inject({
        method: "GET", url: "/setup", remoteAddress: "172.28.42.1",
        headers: { host: "evil.example", "x-forwarded-proto": "https", "x-forwarded-host": "localhost" }
    })
    assert.equal(response.statusCode, 403)
})
