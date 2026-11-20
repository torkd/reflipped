// FT-65: the Welcome Back Boost (src/lib/comebackBoost.ts). A player back after 60+ days starts the returning login and
// each new game day of the next 7 days with 15 Boss Boosts instead of 3, and /load sends the boost's end
// (`comeback_campaign_boss_boost.period_end_time`) meanwhile, for the client's "5x the Boss Boosts" dialog. The game
// day changes at 20:00 UTC.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const DAY_S = 24 * 60 * 60

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    utils = await import("../src/utils")
})

after(async () => {
    utils.setServerTime(null)
    await cleanup?.()
})

interface Player extends TestPlayer { id: number }

async function newPlayer(time: string): Promise<Player> {
    utils.setServerTime(new Date(time))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return { ...player, id: (await data.getAccountPlayers(session!.accountId))[0] }
}

/** /load at `time`, the player's previous login at `previous`: the boss boosts it shows and the boost it sends. */
async function load(player: Player, time: string, previous?: string) {
    if (previous !== undefined) data.updatePlayerSync({ id: player.id, lastLoginTime: new Date(previous) })
    utils.setServerTime(new Date(time))
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/load`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, access_token: player.zat })
    })
    assert.equal(response.statusCode, 200)
    const body = decodeGameBody(response.body).data
    return { bossBoost: body.user_info.boss_boost_point as number, boost: body.comeback_campaign_boss_boost as { period_end_time: number } | undefined }
}

const use = (player: Player, left: number) => data.updatePlayerSync({ id: player.id, bossBoostPoint: left })

test("welcome back boost: 15 Boss Boosts on the returning login and each new game day of the next 7 days", async () => {
    const player = await newPlayer("2025-01-01T12:00:00Z")
    const returned = Date.parse("2025-03-05T12:00:00Z") / 1000

    const first = await load(player, "2025-03-05T12:00:00Z", "2025-01-01T12:00:00Z")
    assert.equal(first.bossBoost, 15)
    assert.deepEqual(first.boost, { period_end_time: returned + 7 * DAY_S })

    // a relaunch the same game day refills nothing
    use(player, 2)
    const relaunch = await load(player, "2025-03-05T15:00:00Z")
    assert.equal(relaunch.bossBoost, 2)
    assert.notEqual(relaunch.boost, undefined)

    // the next game day (after 20:00 UTC) starts at 15 again
    assert.equal((await load(player, "2025-03-05T21:00:00Z")).bossBoost, 15)

    // still on the 7th day (it ends 2025-03-12 12:00 UTC)
    use(player, 0)
    assert.equal((await load(player, "2025-03-11T21:00:00Z")).bossBoost, 15)

    // after the 7 days: no boost sent, and a new day starts at the usual 3
    use(player, 0)
    const later = await load(player, "2025-03-12T21:00:00Z")
    assert.equal(later.bossBoost, 3)
    assert.equal(later.boost, undefined)
})

test("welcome back boost: a player who stayed gets the usual 3 and no boost", async () => {
    const player = await newPlayer("2025-01-01T12:00:00Z")
    use(player, 0)
    const stayed = await load(player, "2025-02-20T12:00:00Z", "2025-01-01T12:00:00Z")
    assert.equal(stayed.bossBoost, 3)
    assert.equal(stayed.boost, undefined)
})
