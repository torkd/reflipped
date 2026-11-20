// FT-52: a portal draws only within the period the client shows it. Portal 184 runs 2024-12-31 14:00 to 2025-01-07
// 13:59:59, Japan time. The Launch Gala Portal (1) closed on 2021-08-12 13:59:59, but a player holding its own
// tickets (20001, 20002) still sees it, with only those tickets, until their expiry on 2022-08-13 13:59:59.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const UNIT_PORTAL = 184
const LAUNCH_GALA = 1
const STAR_HEROES = 800008
const OUT_OF_PERIOD = 1351

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

async function at(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function newPlayer(date: string): Promise<TestPlayer & { playerId: number }> {
    await at(date)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, freeVmoney: 30000 })
    return { ...player, playerId }
}

async function exec(player: TestPlayer, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/gacha/exec`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ number_of_exec: 1, api_count: 1, ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const resultCode = (drawn: { body: any }) => drawn.body?.data_headers?.result_code

test("a portal draws up to the last second of its period, then answers the client's out-of-period code", async () => {
    const player = await newPlayer("2025-01-07T04:59:59Z")
    const last = await exec(player, { gacha_id: UNIT_PORTAL, type: 1, payment_type: 1, api_count: 1 })
    assert.equal(last.status, 200, JSON.stringify(last.body))
    assert.equal(last.body.data.draw.length, 1)

    await at("2025-01-07T05:00:00Z")
    const beads = data.getPlayerSync(player.playerId)!.freeVmoney
    const closed = await exec(player, { gacha_id: UNIT_PORTAL, type: 1, payment_type: 1, api_count: 2 })
    assert.equal(closed.status, 200)
    assert.equal(resultCode(closed), OUT_OF_PERIOD)
    assert.deepEqual(closed.body.data, [])
    assert.equal(data.getPlayerSync(player.playerId)!.freeVmoney, beads, "nothing spent")
})

test("before its start a portal is closed too", async () => {
    const player = await newPlayer("2024-12-31T04:59:59Z")
    assert.equal(resultCode(await exec(player, { gacha_id: UNIT_PORTAL, type: 2, payment_type: 1 })), OUT_OF_PERIOD)
})

test("past its end, a portal takes only its own tickets until their expiry", async () => {
    const player = await newPlayer("2022-01-01T03:00:00Z")
    data.givePlayerItemSync(player.playerId, 20001, 2)
    data.givePlayerItemSync(player.playerId, 999003, 1)

    const own = await exec(player, { gacha_id: LAUNCH_GALA, type: 3, payment_type: 3, api_count: 1 })
    assert.equal(own.status, 200, JSON.stringify(own.body))
    assert.equal(own.body.data.draw.length, 1)
    assert.equal(data.getPlayerItemSync(player.playerId, 20001), 1)

    // beads and the Summoning Ticket (kind 10) aren't offered on an expired portal
    assert.equal(resultCode(await exec(player, { gacha_id: LAUNCH_GALA, type: 1, payment_type: 1, api_count: 2 })), OUT_OF_PERIOD)
    assert.equal(resultCode(await exec(player, { gacha_id: LAUNCH_GALA, type: 10, payment_type: 3, api_count: 3 })), OUT_OF_PERIOD)
    assert.equal(data.getPlayerItemSync(player.playerId, 999003), 1)

    // 2022-08-13 13:59:59 Japan time is the tickets' last second
    await at("2022-08-13T04:59:59Z")
    assert.equal((await exec(player, { gacha_id: LAUNCH_GALA, type: 3, payment_type: 3, api_count: 4 })).body.data.draw.length, 1)
    await at("2022-08-13T05:00:00Z")
    assert.equal(resultCode(await exec(player, { gacha_id: LAUNCH_GALA, type: 3, payment_type: 3, api_count: 5 })), OUT_OF_PERIOD)
    assert.equal(data.getPlayerItemSync(player.playerId, 20001), 0, "only the two in-period draws spent a ticket")
})

test("a Star Heroes portal outside its period is closed", async () => {
    // the FT-45 report: the client offered 800008 (2024-02-29 to 03-07) on 2024-01-27
    const player = await newPlayer("2024-01-27T05:00:00Z")
    assert.equal(resultCode(await exec(player, { gacha_id: STAR_HEROES, type: 7, payment_type: 2 })), OUT_OF_PERIOD)
})

test("the draw period follows the master columns", async () => {
    const { gachaDrawPeriodSync } = await import("../src/lib/gachaDraws")
    assert.equal(gachaDrawPeriodSync(LAUNCH_GALA, new Date("2021-08-12T04:59:59Z")), "open")
    assert.equal(gachaDrawPeriodSync(LAUNCH_GALA, new Date("2021-08-12T05:00:00Z")), "own-ticket")
    assert.equal(gachaDrawPeriodSync(LAUNCH_GALA, new Date("2022-08-13T05:00:00Z")), "closed")
    // a portal with no ticket of its own has no extension
    assert.equal(gachaDrawPeriodSync(UNIT_PORTAL, new Date("2025-02-01T00:00:00Z")), "closed")
    // the ticket-only portals run until 2199
    assert.equal(gachaDrawPeriodSync(2, new Date("2030-01-01T00:00:00Z")), "open")
    assert.equal(gachaDrawPeriodSync(123456, new Date("2025-01-03T00:00:00Z")), "closed")
})
