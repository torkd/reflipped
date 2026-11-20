// Ticket portals (assets/ticket_gacha.json): the portals drawn only with their own ticket, such as the 4 & 5-Star
// Exclusive Portal (gacha 2, ticket 20003). A draw finds them like any portal, spends one ticket and pulls by the
// portal's star rates; the lists of open portals don't count them.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import characters from "../assets/character.json";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

after(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    await cleanup()
})

async function newPlayer(date: string): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

async function exec(player: TestPlayer, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/gacha/exec`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ payment_type: 3, number_of_exec: 1, ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const rarity = (id: number) => (characters as Record<string, { rarity: number }>)[String(id)]?.rarity

test("the 4 & 5-Star Exclusive Ticket pulls a 4- or 5-star unit and is spent", async () => {
    const player = await newPlayer("2023-03-20T03:00:00Z")
    data.givePlayerItemSync(player.playerId, 20003, 15)
    for (let draw = 0; draw < 15; draw++) {
        const drawn = await exec(player, { gacha_id: 2, type: 3, api_count: draw + 1 })
        assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
        assert.equal(drawn.body.data.draw.length, 1)
        const id = drawn.body.data.draw[0].character_id
        assert.ok(rarity(id) >= 4, `pulled ${id} (${rarity(id)} stars)`)
    }
    assert.equal(data.getPlayerItemSync(player.playerId, 20003), 0)
    assert.equal((await exec(player, { gacha_id: 2, type: 3, api_count: 16 })).status, 400, "no ticket left")
})

test("the 5-Star Exclusive Ticket pulls a 5-star unit", async () => {
    const player = await newPlayer("2023-03-20T03:00:00Z")
    data.givePlayerItemSync(player.playerId, 20004, 5)
    for (let draw = 0; draw < 5; draw++) {
        const drawn = await exec(player, { gacha_id: 4, type: 3, api_count: draw + 1 })
        assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
        const id = drawn.body.data.draw[0].character_id
        assert.equal(rarity(id), 5, `pulled ${id}`)
    }
})

test("a 10-pull ticket portal pulls 10 units for one ticket", async () => {
    const player = await newPlayer("2023-03-20T03:00:00Z")
    data.givePlayerItemSync(player.playerId, 20015, 1)
    const drawn = await exec(player, { gacha_id: 9, type: 4, api_count: 1 })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.equal(drawn.body.data.draw.length, 10)
    assert.equal(data.getPlayerItemSync(player.playerId, 20015), 0)
})

test("another portal's ticket and beads are refused on a ticket portal", async () => {
    const player = await newPlayer("2023-03-20T03:00:00Z")
    data.givePlayerItemSync(player.playerId, 20004, 1)
    data.givePlayerItemSync(player.playerId, 999008, 1)
    // the client offers the wildcard tickets only on portals whose master row allows them, and no ticket portal does
    assert.equal((await exec(player, { gacha_id: 2, type: 20, api_count: 1 })).status, 400, "no 4 & 5-Star Portal Ticket")
    assert.equal(data.getPlayerItemSync(player.playerId, 999008), 1, "not spent")
    assert.equal((await exec(player, { gacha_id: 9, type: 3, api_count: 2 })).status, 400, "the Grab Bag has no single ticket")
    assert.equal(data.getPlayerItemSync(player.playerId, 20004), 1, "not spent")
    assert.equal((await exec(player, { gacha_id: 2, type: 1, payment_type: 1, api_count: 3 })).status, 400, "no bead pull")
})

test("the open-portal lists still hold only bead portals", async () => {
    const { getOpenGachaIdsSync, getGachaSync } = await import("../src/lib/assets")
    const open = getOpenGachaIdsSync(new Date("2023-03-20T03:00:00Z"))
    for (const id of ["2", "4", "9", "900000"]) assert.equal(open.includes(id), false, `portal ${id}`)
    assert.equal(getGachaSync(2)?.paymentType, 3)
})
