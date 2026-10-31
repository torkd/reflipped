import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, readCapturedRoute } from "./helpers";
import { deleteAccountSessionsOfType, deletePlayerSync, getAccountPlayers, getSession } from "../src/data/wdfpData";
import { SessionType } from "../src/data/types";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

function gameHeaders(udid: string): Record<string, string> {
    const captured = readCapturedRoute("load").requestHeaders
    return {
        "content-type": "application/x-www-form-urlencoded",
        "udid": udid,
        "short_udid": captured["short_udid"],
        "app_ver": captured["app_ver"],
        "res_ver": captured["res_ver"],
        "device": captured["device"],
        "device_lang": captured["device_lang"]
    }
}

/** Logs a new guest in and returns what the API calls below need. */
async function newPlayer() {
    const deviceId = randomUUID()
    const udid = randomUUID().toUpperCase()
    const login = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json;charset=UTF-8" },
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey: randomUUID(), accessToken: "" }
    })
    const zat = login.json().zat as string
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tool/signup`,
        headers: gameHeaders(udid),
        payload: encodeGameBody({
            app_secret: captured.app_secret,
            access_token: zat,
            storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin,
            kakao_pid: captured.kakao_pid,
            device_id: captured.device_id,
            idp_code: "zd3"
        })
    })
    const viewerId = decodeGameBody(signup.body).data_headers.viewer_id as number
    return { udid, zat, viewerId }
}

async function load(player: { udid: string, zat: string, viewerId: number }) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/load`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function updateStep(player: { udid: string, viewerId: number }, step: number, gachaId?: number, skip = false) {
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tutorial/update_step`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, step, api_count: 1, skip, statistics: {}, name: "Tester", ...(gachaId === undefined ? {} : { gacha_id: gachaId }) })
    })
}

// While `user_tutorial` is in /load the client locks its game systems (Events, Boss Battles, ...) and
// skips its own unlock checks; once the last step is done the saved game must look like a finished player's.
test("the opening tutorial ends with its last step", async (t) => {
    const player = await newPlayer()

    await t.test("a new player is in the tutorial", async () => {
        const data = await load(player)
        assert.equal(data.user_tutorial.tutorial_step, 0)
        assert.ok(!data.user_triggered_tutorial.includes(12))
    })

    await t.test("steps before the last one keep the tutorial going", async () => {
        const response = await updateStep(player, 5)
        assert.equal(response.statusCode, 200, response.body)
        const data = await load(player)
        assert.equal(data.user_tutorial.tutorial_step, 6)
    })

    await t.test("the last step finishes it", async () => {
        const response = await updateStep(player, 16)
        assert.equal(response.statusCode, 200, response.body)
        const data = await load(player)
        assert.equal(data.user_tutorial, null)
        // the "guide to quest" popup (12) is still the game's to show and report
        assert.ok(!data.user_triggered_tutorial.includes(12))
    })

    await t.test("it can't be replayed", async () => {
        const response = await updateStep(player, 3)
        assert.equal(response.statusCode, 400)
    })
})

// The game signs up once and then keeps its viewer id, so after the server forgets it (player deleted from the
// admin page, database replaced) every launch used to get "Invalid viewer ID provided." and an H400 error.
test("load signs the device up again when the server forgot its viewer id", async (t) => {
    const player = await newPlayer()
    await load(player)
    await updateStep(player, 16)

    const accountId = (await getSession(player.zat))!.accountId
    deletePlayerSync((await getAccountPlayers(accountId))[0])
    await deleteAccountSessionsOfType(accountId, SessionType.VIEWER)

    await t.test("an id the server could not have issued is refused", async () => {
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/load`,
            headers: gameHeaders(player.udid),
            payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: 5 })
        })
        assert.equal(response.statusCode, 400)
    })

    await t.test("the same viewer id works again, with a fresh player", async () => {
        const data = await load(player)
        assert.equal(data.user_tutorial.tutorial_step, 0)
        assert.equal((await getAccountPlayers(accountId)).length, 1)
    })

    await t.test("a viewer id that is not a viewer session is still refused", async () => {
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/load`,
            headers: gameHeaders(player.udid),
            payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: player.zat as unknown as number })
        })
        assert.equal(response.statusCode, 400)
    })
})

// Guards: whatever the server clock or a lost reply does, the tutorial has to be able to finish.
test("the tutorial pull works even if the client names a portal the server doesn't have", async () => {
    const player = await newPlayer()
    const response = await updateStep(player, 14, 999999999)
    assert.equal(response.statusCode, 200, response.body)
    const data = decodeGameBody(response.body).data
    assert.equal(data.step, 15)
    assert.equal(data.character_list.length, 1)
})

// The client keeps the drawn character in memory; restarting on the result screen threw C2605 without this.
test("load returns the drawn character while the pull result is pending", async () => {
    const player = await newPlayer()
    assert.equal((await load(player)).tutorial_gacha, null)

    const pull = await updateStep(player, 14, 999999999)
    const drawn = decodeGameBody(pull.body).data.character_list[0].character_id
    assert.deepEqual((await load(player)).tutorial_gacha, { character_id: drawn })

    await updateStep(player, 15)
    assert.equal((await load(player)).tutorial_gacha, null)
})

test("a resent tutorial step doesn't grant the gift twice", async () => {
    const player = await newPlayer()
    const first = await updateStep(player, 15)
    assert.equal(first.statusCode, 200, first.body)
    const second = await updateStep(player, 15)
    assert.equal(second.statusCode, 200, second.body)

    const vmoney = (response: { body: string }) => decodeGameBody(response.body).data.user_info.free_vmoney
    assert.equal(vmoney(second), vmoney(first))
})

test("the server clock can't be moved to a time with no summoning portal open", async () => {
    const refused = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2030-01-01T00:00" } })
    assert.equal(refused.statusCode, 400)

    const allowed = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2024-12-31T15:00" } })
    assert.equal(allowed.statusCode, 302)

    const forced = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2030-01-01T00:00", force: "1" } })
    assert.equal(forced.statusCode, 302)

    await admin.inject({ method: "POST", url: "/api/server/resetTime" })
})

test("a skipped tutorial ends too", async () => {
    const player = await newPlayer()
    const response = await updateStep(player, 5, undefined, true)
    assert.equal(response.statusCode, 200, response.body)
    const data = await load(player)
    assert.equal(data.user_tutorial, null)
})

// The game reports the guide popups it has shown through finish_trigger and resends them when a reply is lost.
test("finish_trigger takes the same id twice", async () => {
    const player = await newPlayer()
    const finish = async (ids: number[]) => await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tutorial/finish_trigger`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 1, tutorial_ids: ids })
    })
    assert.equal((await finish([12, 4])).statusCode, 200)
    assert.equal((await finish([12, 4, 4])).statusCode, 200)
    assert.deepEqual((await load(player)).user_triggered_tutorial.filter((id: number) => id === 12 || id === 4).sort((a: number, b: number) => a - b), [4, 12])
})

test("load starts a new player when only the player was deleted", async () => {
    const player = await newPlayer()
    await load(player)
    await updateStep(player, 16)

    const accountId = (await getSession(player.zat))!.accountId
    deletePlayerSync((await getAccountPlayers(accountId))[0])

    const data = await load(player)
    assert.equal(data.user_tutorial.tutorial_step, 0)
})
