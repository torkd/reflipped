import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

// The admin listener's browser protection (SEC-10, src/lib/adminGuard.ts) and the admin-only clock (SEC-11).

let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ admin, cleanup } = await createTestServer())
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

/** The dashboard's clock form as a browser posts it. */
function setClock(time: string, headers: Record<string, string> = {}) {
    return admin.inject({
        method: "POST",
        url: "/api/server/time",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "127.0.0.1:8001", ...headers },
        payload: new URLSearchParams({ time }).toString()
    })
}

test("the clock moves only by POST from the admin site", async () => {
    const sameSite = await setClock("2025-01-05T08:30", { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:8001" })
    assert.equal(sameSite.statusCode, 302, sameSite.body)
    assert.equal(await currentServerTime(), "2025-01-05T08:30:00.000Z")

    // a link or <img> on another page can no longer move it
    for (const url of ["/api/server/time?time=2025-01-04T00:00", "/api/server/resetTime"]) {
        assert.equal((await admin.inject({ method: "GET", url })).statusCode, 404, url)
    }
    assert.equal(await currentServerTime(), "2025-01-05T08:30:00.000Z")
})

test("a state-changing request from another site is refused", async () => {
    const crossSite: Record<string, string>[] = [
        { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
        { "sec-fetch-site": "same-site", origin: "http://other.localhost:8001" },
        { origin: "https://evil.example" },
        { origin: "null" }
    ]
    for (const headers of crossSite) {
        const response = await setClock("2025-01-06T00:00", headers)
        assert.equal(response.statusCode, 403, JSON.stringify(headers))
    }
    const reset = await admin.inject({ method: "POST", url: "/api/server/resetTime", headers: { "sec-fetch-site": "cross-site" } })
    assert.equal(reset.statusCode, 403)
    const developerMode = await admin.inject({ method: "POST", url: "/api/player/developer-mode?id=1&state=on", headers: { origin: "https://evil.example" } })
    assert.equal(developerMode.statusCode, 403)
    assert.equal(await currentServerTime(), "2025-01-03T12:00:00.000Z")

    // an older browser without Sec-Fetch-Site, on the admin site; and curl, which sends neither header
    assert.equal((await setClock("2025-01-06T00:00", { origin: "http://127.0.0.1:8001" })).statusCode, 302)
    assert.equal((await setClock("2025-01-07T00:00")).statusCode, 302)
    assert.equal(await currentServerTime(), "2025-01-07T00:00:00.000Z")
})

test("the admin site answers only to an IP address, localhost or an allowed name", async () => {
    const { isAllowedAdminHost } = await import("../src/lib/adminGuard")
    for (const host of ["127.0.0.1:8001", "localhost", "localhost:8001", "192.168.1.20:8001", "[::1]:8001"]) {
        assert.equal((await admin.inject({ method: "GET", url: "/", headers: { host } })).statusCode, 200, host)
    }
    // DNS rebinding: an attacker's name that resolves to this machine
    for (const host of ["evil.example:8001", "localhost.evil.example"]) {
        assert.equal((await admin.inject({ method: "GET", url: "/api/player/save?id=1", headers: { host } })).statusCode, 403, host)
    }
    assert.equal(isAllowedAdminHost("admin.lan:8001", new Set(["admin.lan"])), true)
    assert.equal(isAllowedAdminHost("evil.example", new Set(["admin.lan"])), false)
    assert.equal(isAllowedAdminHost(undefined), false)
})

test("admin pages get a CSP that allows only their own scripts, and use no inline handlers", async () => {
    const page = await admin.inject({ method: "GET", url: "/" })
    const csp = String(page.headers["content-security-policy"])
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /script-src-attr 'none'/)
    assert.match(csp, /form-action 'self'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.doesNotMatch(csp, /upgrade-insecure-requests/, "the admin site is plain HTTP")
    assert.equal(page.headers["x-content-type-options"], "nosniff")
    assert.equal(page.headers["strict-transport-security"], undefined)
    // with no-referrer, the browser's own form posts carry `Origin: null` and the CSRF check refuses them
    assert.equal(page.headers["referrer-policy"], "same-origin")

    // the dashboard's clock form posts, and Reset is a button of it
    assert.match(page.body, /<form class="card" method="post" action="\/api\/server\/time">/)
    assert.match(page.body, /formaction="\/api\/server\/resetTime"/)

    const { readdirSync, readFileSync } = await import("fs")
    for (const name of readdirSync("web/pages")) {
        const html = readFileSync(`web/pages/${name}`, "utf-8")
        assert.doesNotMatch(html, /\son[a-z]+="/, `${name} has an inline event handler`)
        assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/, `${name} has an inline script`)
    }
})
