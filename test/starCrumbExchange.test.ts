// FT-58: the Star Sliver Exchange (exchange/star_crumb). At 2025-01-03 (Japan time) exchange 22 (5-star unit 111002,
// 600 Slivers) and 1091 (4-star armament 4010010, 200) are open, as is 9000001 (4-star Astral Gem item 10002, 300);
// exchange 1 (armament 4010010) closed in July 2024 and 475 is tied to a Welcome Back Portal.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const NOW = "2025-01-03T03:00:00Z"

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

async function newPlayer(starCrumb: number): Promise<Player> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(NOW))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, starCrumb })
    return { ...player, playerId }
}

async function exchange(player: TestPlayer, exchangeId: number) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/exchange/star_crumb`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ exchange_id: exchangeId, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const starCrumbOf = (player: Player) => data.getPlayerSync(player.playerId)!.starCrumb

test("a unit costs 600 Star Slivers at 5 stars, joins the roster and can't be taken twice", async () => {
    const player = await newPlayer(1000)
    assert.equal(data.getPlayerCharacterSync(player.playerId, 111002), null, "the test needs a unit the player lacks")

    const reply = await exchange(player, 22)
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.equal(reply.body.data.user_info.star_crumb, 400)
    assert.equal(starCrumbOf(player), 400)
    assert.ok(reply.body.data.character_list.some((character: any) => character.character_id === 111002))
    assert.notEqual(data.getPlayerCharacterSync(player.playerId, 111002), null)

    const again = await exchange(player, 22)
    assert.equal(again.status, 400)
    assert.equal(starCrumbOf(player), 400, "a refused exchange takes nothing")
})

test("an armament costs 200 at 4 stars, once", async () => {
    const player = await newPlayer(250)
    const reply = await exchange(player, 1091)
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.equal(reply.body.data.user_info.star_crumb, 50)
    assert.ok(reply.body.data.equipment_list.some((equipment: any) => equipment.equipment_id === 4010010))
    assert.equal((await exchange(player, 1091)).status, 400)
})

test("an item costs 300 at 4 stars and can be taken again", async () => {
    const player = await newPlayer(700)
    const before = data.getPlayerItemSync(player.playerId, 10002) ?? 0
    for (const left of [400, 100]) {
        const reply = await exchange(player, 9000001)
        assert.equal(reply.status, 200, JSON.stringify(reply.body))
        assert.equal(reply.body.data.user_info.star_crumb, left)
    }
    assert.equal(data.getPlayerItemSync(player.playerId, 10002), before + 2)
    assert.equal((await exchange(player, 9000001)).status, 400, "not enough Slivers left")
})

test("closed exchanges answer ExchangePeriodError and take nothing", async () => {
    const player = await newPlayer(1000)
    for (const exchangeId of [1, 475]) {
        const reply = await exchange(player, exchangeId)
        assert.equal(reply.status, 200)
        assert.equal(reply.body.data_headers.result_code, 3006, `exchange ${exchangeId}`)
    }
    assert.equal(starCrumbOf(player), 1000)
})

test("an unknown exchange or too few Slivers is refused", async () => {
    const player = await newPlayer(100)
    assert.equal((await exchange(player, 123456789)).status, 400)
    assert.equal((await exchange(player, 22)).status, 400)
    assert.equal(starCrumbOf(player), 100)
})

async function exchangeWith(player: TestPlayer, exchangeId: number, extra: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/exchange/star_crumb`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ exchange_id: exchangeId, viewer_id: player.viewerId, ...extra })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

test("a retried exchange gets the first reply and is charged once", async () => {
    const player = await newPlayer(1000)
    const first = await exchangeWith(player, 9000001, { api_count: 40 })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const retry = await exchangeWith(player, 9000001, { api_count: 40, retry_count: 1 })
    assert.deepEqual(retry.body, first.body)
    assert.equal(starCrumbOf(player), 700, "charged once")
    assert.equal(data.getPlayerItemSync(player.playerId, 10002), first.body.data.item_list["10002"])
})

test("the period's last second is open and the next one closed (exchange 1091 ends 2025-01-31 13:59:59 Japan time)", async () => {
    const { setServerTime } = await import("../src/utils")
    const player = await newPlayer(1000)
    setServerTime(new Date("2025-01-31T04:59:59Z"))
    const open = await exchange(player, 1091)
    assert.equal(open.status, 200, JSON.stringify(open.body))
    assert.equal(open.body.data_headers.result_code, 1)

    const later = await newPlayer(1000)
    setServerTime(new Date("2025-01-31T05:00:00Z"))
    assert.equal((await exchange(later, 1091)).body.data_headers.result_code, 3006)
    assert.equal(starCrumbOf(later), 1000)
})

test("exactly the price is enough, and an item at its limit is refused", async () => {
    const player = await newPlayer(300)
    const reply = await exchange(player, 9000001)
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.equal(reply.body.data.user_info.star_crumb, 0)

    const full = await newPlayer(1000)
    data.givePlayerItemSync(full.playerId, 10002, 9999 - (data.getPlayerItemSync(full.playerId, 10002) ?? 0))
    assert.equal((await exchange(full, 9000001)).status, 400)
    assert.equal(starCrumbOf(full), 1000)
})

test("a balance past the client's limit spends from the limit /load showed, so the reply stays in the client's range", async () => {
    const player = await newPlayer(5_000_000)
    const reply = await exchange(player, 9000001)
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.equal(reply.body.data.user_info.star_crumb, 999_699)
    assert.equal(starCrumbOf(player), 999_699)
})
