import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

// FT-1: daily and monthly resets, applied at /load on the server clock's game day (05:00 Japan time, 20:00 UTC).

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

/** A new player, its player id, and the server clock set to `date`. */
async function signUpAt(date: string): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
    const player = await createTestPlayer(fastify)
    const { getAllPlayersSync } = await import("../src/data/wdfpData")
    const players = getAllPlayersSync()
    return { ...player, playerId: players[players.length - 1].id }
}

async function loadAt(player: TestPlayer, date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/load`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

test("a new game day refills boost points and reopens daily portal pulls", async () => {
    const data = await import("../src/data/wdfpData")
    const player = await signUpAt("2025-01-03T12:00:00Z")
    await loadAt(player, "2025-01-03T12:00:00Z")

    // the day's boosts and pulls are spent
    data.updatePlayerSync({ id: player.playerId, boostPoint: 0, bossBoostPoint: 1 })
    data.insertPlayerGachaInfoSync(player.playerId, { gachaId: 184, isDailyFirst: false, isAccountFirst: false })
    data.insertPlayerGachaCampaignSync(player.playerId, { gachaId: 184, campaignId: 28, count: 0 })

    // same game day, up to 19:59:59 UTC: nothing comes back
    let loaded = await loadAt(player, "2025-01-03T19:59:59Z")
    assert.deepEqual([loaded.user_info.boost_point, loaded.user_info.boss_boost_point], [0, 1])
    assert.equal(data.getPlayerGachaInfoSync(player.playerId, 184)?.isDailyFirst, false)

    // 20:00 UTC is 05:00 in Japan: a new game day
    loaded = await loadAt(player, "2025-01-03T20:00:00Z")
    assert.deepEqual([loaded.user_info.boost_point, loaded.user_info.boss_boost_point], [3, 3])
    assert.equal(data.getPlayerGachaInfoSync(player.playerId, 184)?.isDailyFirst, true)
    assert.equal(data.getPlayerGachaCampaignSync(player.playerId, 184, 28)?.count, 1)

    // only once a day
    data.updatePlayerSync({ id: player.playerId, boostPoint: 2 })
    loaded = await loadAt(player, "2025-01-04T10:00:00Z")
    assert.equal(loaded.user_info.boost_point, 2)
})

test("boost points above the daily amount are kept", async () => {
    const data = await import("../src/data/wdfpData")
    const player = await signUpAt("2025-01-03T12:00:00Z")
    await loadAt(player, "2025-01-03T12:00:00Z")
    data.updatePlayerSync({ id: player.playerId, boostPoint: 15, bossBoostPoint: 20 })

    const loaded = await loadAt(player, "2025-01-04T21:00:00Z")
    assert.deepEqual([loaded.user_info.boost_point, loaded.user_info.boss_boost_point], [15, 20])
})

test("resets follow the server clock, also when it is moved back", async () => {
    const data = await import("../src/data/wdfpData")
    const player = await signUpAt("2025-01-10T12:00:00Z")
    await loadAt(player, "2025-01-10T12:00:00Z")
    data.updatePlayerSync({ id: player.playerId, boostPoint: 0 })

    const loaded = await loadAt(player, "2025-01-05T12:00:00Z")
    assert.equal(loaded.user_info.boost_point, 3)
    assert.equal(data.getPlayerSync(player.playerId)?.lastLoginTime.toISOString(), "2025-01-05T12:00:00.000Z")
})

test("a game month starts on the 1st at 05:00 Japan time", async () => {
    const { applyResets } = await import("../src/lib/resets")
    const player = await signUpAt("2025-01-03T12:00:00Z")

    // a player with no reset stored gets both
    assert.deepEqual(applyResets(player.playerId, new Date("2025-01-30T12:00:00Z")), { daily: true, monthly: true })
    assert.deepEqual(applyResets(player.playerId, new Date("2025-01-31T12:00:00Z")), { daily: true, monthly: false })
    assert.deepEqual(applyResets(player.playerId, new Date("2025-01-31T19:59:59Z")), { daily: false, monthly: false })
    assert.deepEqual(applyResets(player.playerId, new Date("2025-01-31T20:00:00Z")), { daily: true, monthly: true })
})
