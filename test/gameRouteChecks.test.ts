import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, readCapturedRoute } from "./helpers";

// SEC-12: game routes that paid out without a cost, or stored whatever the client sent.

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

/** A new player: its viewer id and player id. */
async function signUp(): Promise<{ viewerId: number, playerId: number }> {
    const deviceId = randomUUID()
    const login = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey: randomUUID(), accessToken: "" }
    })
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tool/signup`,
        headers: { "content-type": "application/x-www-form-urlencoded", "udid": randomUUID().toUpperCase() },
        payload: encodeGameBody({
            app_secret: captured.app_secret, access_token: login.json().zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
        })
    })
    const { getAllPlayersSync } = await import("../src/data/wdfpData")
    const players = getAllPlayersSync()
    return { viewerId: decodeGameBody(signup.body).data_headers.viewer_id, playerId: players[players.length - 1].id }
}

async function gameRequest(route: string, body: Record<string, unknown>): Promise<number> {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody(body)
    })
    return response.statusCode
}

test("expod/stack_to_exp uses up the converted copies", async () => {
    const data = await import("../src/data/wdfpData")
    const { givePlayerCharacterSync } = await import("../src/lib/character")
    const { viewerId, playerId } = await signUp()
    const characterId = readCapturedRoute("expod_stack_to_exp").requestBody.character_id
    givePlayerCharacterSync(playerId, characterId)
    data.updatePlayerCharacterSync(playerId, characterId, { stack: 2 })

    const convert = (number: number) => gameRequest("expod/stack_to_exp", { viewer_id: viewerId, character_id: characterId, number, api_count: 1 })
    assert.equal(await convert(2), 200)
    assert.equal(data.getPlayerCharacterSync(playerId, characterId)!.stack, 0)
    assert.equal(await convert(1), 400, "nothing left to convert")
    assert.equal(await convert(-5), 400, "a negative count")
    assert.equal(data.getPlayerCharacterSync(playerId, characterId)!.stack, 0)
})

test("character/over_limit refuses a count below 1", async () => {
    const data = await import("../src/data/wdfpData")
    const { givePlayerCharacterSync } = await import("../src/lib/character")
    const { viewerId, playerId } = await signUp()
    const captured = readCapturedRoute("character_over_limit").requestBody
    givePlayerCharacterSync(playerId, captured.character_id)
    data.givePlayerItemSync(playerId, captured.item_id, 5)
    const before = { stack: data.getPlayerCharacterSync(playerId, captured.character_id)!.stack, items: data.getPlayerItemSync(playerId, captured.item_id) }

    for (const use_stack of [true, false]) {
        const status = await gameRequest("character/over_limit", { ...captured, viewer_id: viewerId, use_stack, over_limit_count: -100 })
        assert.equal(status, 400, `use_stack ${use_stack}`)
    }
    assert.deepEqual({ stack: data.getPlayerCharacterSync(playerId, captured.character_id)!.stack, items: data.getPlayerItemSync(playerId, captured.item_id) }, before)
})

test("single_battle_quest/finish pays the first-clear reward only for a clear", async () => {
    const data = await import("../src/data/wdfpData")
    const { viewerId, playerId } = await signUp()
    // main quest 1001002 pays 15 beads on its first clear
    const start = { ...readCapturedRoute("single_battle_quest_start").requestBody, viewer_id: viewerId, category: 1, quest_id: 1001002 }
    const finish = { ...readCapturedRoute("single_battle_quest_finish").requestBody, viewer_id: viewerId, elapsed_time_ms: 0, add_mana: 0 }
    const beads = () => data.getPlayerSync(playerId)!.freeVmoney

    const before = beads()
    for (let i = 0; i < 2; i++) {
        assert.equal(await gameRequest("single_battle_quest/start", start), 200)
        assert.equal(await gameRequest("single_battle_quest/finish", { ...finish, is_accomplished: false }), 200)
    }
    assert.equal(beads(), before, "a failed run pays nothing")

    assert.equal(await gameRequest("single_battle_quest/start", start), 200)
    assert.equal(await gameRequest("single_battle_quest/finish", { ...finish, is_accomplished: true }), 200)
    const cleared = beads()
    assert.ok(cleared > before, "the first clear pays")
    assert.equal(await gameRequest("single_battle_quest/start", start), 200)
    assert.equal(await gameRequest("single_battle_quest/finish", { ...finish, is_accomplished: true }), 200)
    assert.equal(beads(), cleared, "once")
})

test("option/update keeps a bounded number of options", async () => {
    const data = await import("../src/data/wdfpData")
    const { viewerId, playerId } = await signUp()
    const many = (prefix: string) => Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${prefix}${i}`, true]))

    assert.equal(await gameRequest("option/update", { viewer_id: viewerId, option_params: { ["k".repeat(65)]: true } }), 400, "key too long")
    assert.equal(await gameRequest("option/update", { viewer_id: viewerId, option_params: { ...many("a"), ...many("b") } }), 400, "too many keys at once")
    assert.equal(await gameRequest("option/update", { viewer_id: viewerId, option_params: many("a") }), 200)
    assert.equal(await gameRequest("option/update", { viewer_id: viewerId, option_params: many("b") }), 200)
    assert.equal(Object.keys(data.getPlayerOptionsSync(playerId)).length, data.MAX_PLAYER_OPTIONS)
    // known options still change
    assert.equal(await gameRequest("option/update", { viewer_id: viewerId, option_params: { a0: false } }), 200)
    assert.equal(data.getPlayerOptionsSync(playerId).a0, false)
})

test("a player's name and party names are bounded", async () => {
    const { viewerId } = await signUp()
    assert.equal(await gameRequest("tutorial/update_step", { viewer_id: viewerId, step: 2, name: "x".repeat(33) }), 400)
})
