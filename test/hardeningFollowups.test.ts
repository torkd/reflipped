import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, encodeGameBody, gameHeaders, readCapturedRoute, signedGameHeaders, TestPlayer } from "./helpers";
import { lobbyMate } from "./coopHelpers";

// SEC-16, the hardening follow-ups of the SEC-12 review: rate-limit buckets per IPv6 /64, security headers on the game
// listener, one reply for an unknown viewer id and a bad signature, a limit on how long game requests renew a viewer
// session, the co-op mate's role from the save and the admin save download's file name.

const apiPrefix = "/latest/api/index.php"
const DAY_MS = 24 * 60 * 60 * 1000

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let player: TestPlayer
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer({ paramCheck: "enforce" }))
    player = await createTestPlayer(fastify)
    data = await import("../src/data/wdfpData")
})

after(async () => {
    await cleanup()
})

function optionsUpdate(viewerId: number, signed: boolean) {
    const url = `${apiPrefix}/option/update`
    const payload = encodeGameBody({ api_count: 1, option_params: {}, viewer_id: viewerId })
    return fastify.inject({
        method: "POST", url, payload,
        headers: signed ? signedGameHeaders(player.udid, viewerId, url, payload) : gameHeaders(player.udid)
    })
}

async function viewerSession() {
    return (await data.getSession(String(player.viewerId)))!
}

test("rate limits count an IPv6 client by its /64, an IPv4-mapped one by its IPv4 address", async () => {
    const { rateLimitKey } = await import("../src/lib/rateLimit")
    assert.equal(rateLimitKey("203.0.113.7"), "203.0.113.7")
    assert.equal(rateLimitKey("::ffff:203.0.113.7"), "203.0.113.7")
    assert.equal(rateLimitKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64")
    assert.equal(rateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64", "the same bucket anywhere in the /64")
    assert.equal(rateLimitKey("2001:db8::1"), "2001:db8:0:0::/64")
    assert.equal(rateLimitKey("fe80::1%eth0"), "fe80:0:0:0::/64")
    assert.notEqual(rateLimitKey("2001:db8:1:3::1"), rateLimitKey("2001:db8:1:2::1"))
})

test("loopback listen addresses are told from public ones", async () => {
    const { isLoopbackHost } = await import("../src/lib/rateLimit")
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) assert.ok(isLoopbackHost(host), host)
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) assert.ok(!isLoopbackHost(host), host)
})

test("game listener replies forbid MIME sniffing and framing; the portal keeps its own policy", async () => {
    const news = await fastify.inject({ method: "GET", url: "/game/news" })
    assert.equal(news.headers["x-content-type-options"], "nosniff")
    assert.match(String(news.headers["content-security-policy"]), /frame-ancestors 'none'/, "the game pages' own policy also forbids framing")

    const api = await optionsUpdate(player.viewerId, true)
    assert.equal(api.statusCode, 200, api.body)
    assert.equal(api.headers["x-content-type-options"], "nosniff")

    const portal = await fastify.inject({ method: "GET", url: "/portal/login" })
    const csp = String(portal.headers["content-security-policy"])
    assert.match(csp, /default-src 'self'/, "the portal's helmet policy, not replaced")
    assert.match(csp, /frame-ancestors 'none'/)
})

test("an unknown viewer id and a bad signature get the same reply", async () => {
    const unknown = await optionsUpdate(987654321, false)
    const unsigned = await optionsUpdate(player.viewerId, false)
    assert.equal(unsigned.statusCode, unknown.statusCode)
    assert.deepEqual(unsigned.json(), unknown.json())
    assert.equal(unknown.statusCode, 400)
})

test("game requests renew a viewer session only up to 30 days after its last /load", async () => {
    const { VIEWER_SESSION_MAX_MS } = await import("../src/lib/gameAuth")
    // last /load 29.5 days ago, about to expire: a game request may renew it by half a day only
    const authenticatedAt = new Date(Date.now() - VIEWER_SESSION_MAX_MS + DAY_MS / 2)
    data.updateSessionAuthenticatedSync(String(player.viewerId), authenticatedAt)
    data.updateSessionExpirySync(String(player.viewerId), new Date(Date.now() + 60_000))
    assert.equal((await optionsUpdate(player.viewerId, true)).statusCode, 200)
    assert.equal((await viewerSession()).expires.getTime(), authenticatedAt.getTime() + VIEWER_SESSION_MAX_MS)

    // past the limit: refused until the game's /load proves the zat again
    data.updateSessionAuthenticatedSync(String(player.viewerId), new Date(Date.now() - VIEWER_SESSION_MAX_MS - DAY_MS))
    data.updateSessionExpirySync(String(player.viewerId), new Date(Date.now() - 1000))
    assert.equal((await optionsUpdate(player.viewerId, true)).statusCode, 400)

    const load = await fastify.inject({
        method: "POST", url: `${apiPrefix}/load`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: player.viewerId })
    })
    assert.equal(load.statusCode, 200, load.body)
    const renewed = await viewerSession()
    assert.ok(Date.now() - renewed.authenticatedAt!.getTime() < 60_000, "/load restarts the limit")
    assert.ok(renewed.expires.getTime() > Date.now() + 6 * DAY_MS)
    assert.equal((await optionsUpdate(player.viewerId, true)).statusCode, 200)
})

test("a session from before the limit starts it at its next game request", async () => {
    data.updateSessionExpirySync(String(player.viewerId), new Date(Date.now() + 60_000))
    // what the version 12 migration leaves: no authenticated_at
    const { default: getDatabase, Database } = await import("../src/data")
    const db = getDatabase(Database.WDFP_DATA)
    db.prepare(`UPDATE sessions SET authenticated_at = NULL WHERE token = ?`).run(String(player.viewerId))
    assert.equal((await viewerSession()).authenticatedAt, null)
    assert.equal((await optionsUpdate(player.viewerId, true)).statusCode, 200)
    const session = await viewerSession()
    assert.ok(Date.now() - session.authenticatedAt!.getTime() < 60_000)
    assert.ok(session.expires.getTime() > Date.now() + 6 * DAY_MS)
})

test("a co-op mate's role comes from the save, so a player can't pose as an AI companion", async () => {
    const { checkMateAgainstSave } = await import("../src/lib/coop/mateCheck")
    const session = await viewerSession()
    const playerId = (await data.getAccountPlayers(session.accountId))[0]
    const forged = { ...lobbyMate("Forged", 111), playerRoleKind: 99 }
    assert.equal(checkMateAgainstSave(playerId, forged).playerRoleKind, data.getPlayerSync(playerId)!.role)
    assert.notEqual(checkMateAgainstSave(playerId, forged).playerRoleKind, 99)
})

test("the admin save download names its file", async () => {
    const session = await viewerSession()
    const playerId = (await data.getAccountPlayers(session.accountId))[0]
    const download = await admin.inject({ method: "GET", url: `/api/player/save?id=${playerId}` })
    assert.equal(download.statusCode, 200)
    assert.equal(download.headers["content-disposition"], `attachment; filename="reflipped-save-${playerId}.json"`)
})
