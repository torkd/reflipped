import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, readCapturedRoute } from "./helpers";

// The account page's "Player ID (PID)" is the number the game's Account Info shows: the account number the server
// sends as `playerId` at login, not the internal player row number.

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})
after(async () => {
    await cleanup()
})

async function loginDevice() {
    const response = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json;charset=UTF-8" },
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId: randomUUID(), idpId: randomUUID(), whiteKey: randomUUID(), accessToken: "" }
    })
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as { playerId: string }
}

test("the portal shows the PID the game shows, not the internal player number", async () => {
    const data = await import("../src/data/wdfpData")
    const users = await import("../src/data/users")
    // accounts without a player push the account numbers ahead of the player numbers
    await loginDevice()
    await loginDevice()
    const player = await createTestPlayer(fastify)
    const accountId = (await data.getSession(String(player.viewerId)))!.accountId
    const playerId = data.getPlayerFromAccountIdSync(accountId)!.id
    assert.notEqual(accountId, playerId)

    const password = "correct horse battery"
    const registered = await fastify.inject({
        method: "POST", url: "/portal/register",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ username: "pidcheck", password, confirm: password }).toString()
    })
    assert.equal(registered.statusCode, 302, registered.body)
    const cookie = String(registered.headers["set-cookie"]).split(";")[0]
    users.setAccountUserSync(accountId, users.getUserByUsernameSync("pidcheck")!.id)

    const body = (await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })).body
    assert.match(body, new RegExp(`Player ID \\(PID\\)</span>\\s*<span class="stat-value text-base">${accountId}</span>`))
    assert.doesNotMatch(body, new RegExp(`<span class="stat-value text-base">${playerId}</span>`))
})
