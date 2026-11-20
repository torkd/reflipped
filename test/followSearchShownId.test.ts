// SH-28: Search Players finds a player by the ID the game shows ("Your ID" on the Following/Followers screen), which is
// the Kakao player ID that openapi's loginDevice hands out (Reflipped's account number), not only by viewer ID.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

interface ShownPlayer {
    udid: string
    viewerId: number
    /** The Kakao player ID: what the game shows the player as their ID. */
    shownId: string
}

/** Logs in a new guest device and signs it up, keeping the player ID loginDevice gave the client. */
async function newPlayer(): Promise<ShownPlayer> {
    const deviceId = randomUUID()
    const udid = randomUUID().toUpperCase()
    const login = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json;charset=UTF-8" },
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey: randomUUID(), accessToken: "" }
    })
    assert.equal(login.statusCode, 200, login.body)
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tool/signup`,
        headers: gameHeaders(udid),
        payload: encodeGameBody({
            app_secret: captured.app_secret,
            access_token: login.json().zat,
            storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin,
            kakao_pid: captured.kakao_pid,
            device_id: captured.device_id,
            idp_code: "zd3"
        })
    })
    assert.equal(signup.statusCode, 200, signup.body)
    return { udid, viewerId: decodeGameBody(signup.body).data_headers.viewer_id, shownId: login.json().player.playerId }
}

async function search(player: ShownPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/follow/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body) as any
}

test("the search finds a player by the ID the game shows, with or without leading zeros", async () => {
    const a = await newPlayer(), b = await newPlayer()
    assert.match(b.shownId, /^\d+$/)
    assert.notEqual(Number(b.shownId), b.viewerId)

    for (const typed of [b.shownId, b.shownId.padStart(12, "0"), Number(b.shownId)]) {
        const found = await search(a, "search_kakao_pid", { search_kakao_pid: typed })
        assert.equal(found.data_headers.result_code, 1, String(typed))
        assert.equal(found.data.search_result.viewer_id, b.viewerId)
        assert.equal(found.data.search_result.kakao_pid, b.shownId)
    }
    // the same search under its other name
    const byOtherName = await search(a, "search_id", { search_id: b.shownId })
    assert.equal(byOtherName.data.search_result.viewer_id, b.viewerId)
})

test("a viewer ID still finds the player; your own ID and unknown IDs don't", async () => {
    const a = await newPlayer(), b = await newPlayer()
    const byViewerId = await search(a, "search_kakao_pid", { search_kakao_pid: String(b.viewerId) })
    assert.equal(byViewerId.data.search_result.viewer_id, b.viewerId)

    for (const typed of [a.shownId, String(a.viewerId), "99999", "123456789012", "", "12a", "1".repeat(16)]) {
        const missing = await search(a, "search_kakao_pid", { search_kakao_pid: typed })
        assert.equal(missing.data_headers.result_code, 1455, typed)
    }
})
