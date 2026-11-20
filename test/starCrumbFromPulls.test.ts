// FT-61: portal pulls paid with beads give Star Slivers, 1 per 75 beads and 1 per 25 for the daily discounted pull
// (src/lib/beads.ts, starCrumbForPull). The reply's user_info.star_crumb carries the new balance; the client shows the
// difference to its last balance on the result screen. Ticket pulls give none, and the balance stops at 999,999.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const UNIT_PORTAL = 184 // 150 beads a pull, 1500 a 10-pull, 50 the daily discounted pull
const ARMAMENT_PORTAL = 5038 // 75 beads a pull, 750 a 10-pull; open on the test date (2025-01-03)
const TICKET_PORTAL = 2 // the 4 & 5-Star Exclusive Ticket's portal (item 20003)

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

type Player = TestPlayer & { playerId: number }

async function newPlayer(free: number, paid = 0, starCrumb = 0): Promise<Player> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, freeVmoney: free, vmoney: paid, starCrumb })
    return { ...player, playerId }
}

let apiCount = 1
async function exec(player: Player, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/gacha/exec`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ number_of_exec: 1, api_count: apiCount++, ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const slivers = (player: Player) => data.getPlayerSync(player.playerId)!.starCrumb

test("starCrumbForPull: 1 per 75 beads, 1 per 25 for the daily discounted pull", async () => {
    const { starCrumbForPull } = await import("../src/lib/beads")
    assert.equal(starCrumbForPull(150, false), 2)
    assert.equal(starCrumbForPull(1500, false), 20)
    assert.equal(starCrumbForPull(75, false), 1)
    assert.equal(starCrumbForPull(750, false), 10)
    assert.equal(starCrumbForPull(50, true), 2)
    assert.equal(starCrumbForPull(25, true), 1)
    assert.equal(starCrumbForPull(74, false), 0, "a part of 75 gives nothing")
    assert.equal(starCrumbForPull(0, false), 0)
    assert.equal(starCrumbForPull(-150, false), 0)
    assert.equal(starCrumbForPull(NaN, false), 0)
})

test("unit portal pulls give 2 a pull, 20 a 10-pull, and 2 for the daily discounted pull", async () => {
    const player = await newPlayer(5000)
    const single = await exec(player, { gacha_id: UNIT_PORTAL, type: 1, payment_type: 1 })
    assert.equal(single.status, 200, JSON.stringify(single.body))
    assert.equal(single.body.data.user_info.star_crumb, 2)
    assert.equal(slivers(player), 2)

    const multi = await exec(player, { gacha_id: UNIT_PORTAL, type: 2, payment_type: 2 })
    assert.equal(multi.status, 200, JSON.stringify(multi.body))
    assert.equal(multi.body.data.user_info.star_crumb, 22)

    const daily = await exec(player, { gacha_id: UNIT_PORTAL, type: 5, payment_type: 2 })
    assert.equal(daily.status, 200, JSON.stringify(daily.body))
    assert.equal(daily.body.data.user_info.star_crumb, 24)
    assert.equal(slivers(player), 24)
    assert.equal(data.getPlayerSync(player.playerId)!.freeVmoney, 5000 - 150 - 1500 - 50)
})

test("free and paid beads both count, free ones spent first", async () => {
    const player = await newPlayer(100, 100)
    const drawn = await exec(player, { gacha_id: UNIT_PORTAL, type: 1, payment_type: 1 })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.deepEqual(drawn.body.data.user_info, { free_vmoney: 0, vmoney: 50, star_crumb: 2 })
})

test("armament portal pulls count their own costs", async () => {
    const player = await newPlayer(1000)
    const single = await exec(player, { gacha_id: ARMAMENT_PORTAL, type: 1, payment_type: 1 })
    assert.equal(single.status, 200, JSON.stringify(single.body))
    assert.equal(single.body.data.user_info.star_crumb, 1)
    const multi = await exec(player, { gacha_id: ARMAMENT_PORTAL, type: 2, payment_type: 1 })
    assert.equal(multi.status, 200, JSON.stringify(multi.body))
    assert.equal(multi.body.data.user_info.star_crumb, 11)
})

test("ticket pulls give none and leave star_crumb out of the reply", async () => {
    const player = await newPlayer(0, 0, 7)
    data.givePlayerItemSync(player.playerId, 20003, 1)
    const drawn = await exec(player, { gacha_id: TICKET_PORTAL, type: 3, payment_type: 3 })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.equal(drawn.body.data.user_info.star_crumb, undefined)
    assert.equal(slivers(player), 7)
})

test("a refused pull gives none", async () => {
    const player = await newPlayer(100)
    assert.equal((await exec(player, { gacha_id: UNIT_PORTAL, type: 1, payment_type: 1 })).status, 400)
    assert.equal(slivers(player), 0)
})

test("the balance stops at 999,999, also from an imported balance above it", async () => {
    const near = await newPlayer(1500, 0, 999_990)
    const drawn = await exec(near, { gacha_id: UNIT_PORTAL, type: 2, payment_type: 1 })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.equal(drawn.body.data.user_info.star_crumb, 999_999)
    assert.equal(slivers(near), 999_999)

    const above = await newPlayer(150, 0, 5_000_000)
    const again = await exec(above, { gacha_id: UNIT_PORTAL, type: 1, payment_type: 1 })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.data.user_info.star_crumb, 999_999)
    assert.equal(slivers(above), 999_999)
})

test("a retried pull gets the first reply and gives the Slivers once", async () => {
    const player = await newPlayer(1000)
    const body = { gacha_id: UNIT_PORTAL, type: 1, payment_type: 1, api_count: 500 }
    const first = await exec(player, body)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const retry = await exec(player, { ...body, retry_count: 1 })
    assert.equal(retry.status, 200)
    assert.deepEqual(retry.body, first.body)
    assert.equal(slivers(player), 2)
    assert.equal(data.getPlayerSync(player.playerId)!.freeVmoney, 850)
})
