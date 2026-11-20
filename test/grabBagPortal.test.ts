// The New Year's Grab Bag (gacha 57, the client's GachaPageKind.TicketOnly, assets/ticket_gacha.json): drawn with its
// own tickets only, the 2021 Grab Bag 1-Pull Ticket (20065) and 10-Pull Ticket (20064). It answered "Gacha doesn't
// exist" before (FT-45).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import characters from "../assets/character.json";
import ticketGachas from "../assets/ticket_gacha.json";

const apiPrefix = "/latest/api/index.php"
const GRAB_BAG = 57
const SINGLE_TICKET = 20065
const TEN_TICKET = 20064

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

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
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
        payload: encodeGameBody({ gacha_id: GRAB_BAG, payment_type: 3, number_of_exec: 1, ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const pool = new Set(Object.values((ticketGachas as unknown as Record<string, { pool: Record<string, { id: number }[]> }>)[String(GRAB_BAG)].pool)
    .flat().map(entry => entry.id))
const rarity = (id: number) => (characters as Record<string, { rarity: number }>)[String(id)]?.rarity

test("the 1-pull ticket draws one unit from the Grab Bag's pool and is spent", async () => {
    const player = await newPlayer()
    data.givePlayerItemSync(player.playerId, SINGLE_TICKET, 2)
    const drawn = await exec(player, { type: 3, api_count: 1 })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.equal(drawn.body.data.draw.length, 1)
    assert.ok(pool.has(drawn.body.data.draw[0].character_id))
    assert.equal(data.getPlayerItemSync(player.playerId, SINGLE_TICKET), 1)
    assert.equal(drawn.body.data.item_list[SINGLE_TICKET], 1, "the ticket count left, for the client")
})

test("the 10-pull ticket draws ten units, one of them at least 4 stars", async () => {
    for (let run = 0; run < 5; run++) {
        const player = await newPlayer()
        data.givePlayerItemSync(player.playerId, TEN_TICKET, 1)
        const drawn = await exec(player, { type: 4, api_count: 1 })
        assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
        const ids: number[] = drawn.body.data.draw.map((entry: { character_id: number }) => entry.character_id)
        assert.equal(ids.length, 10)
        assert.ok(ids.every(id => pool.has(id)))
        assert.ok(ids.some(id => rarity(id) >= 4), `stars ${ids.map(rarity)}`)
        assert.equal(data.getPlayerItemSync(player.playerId, TEN_TICKET), 0)
        assert.equal((await exec(player, { type: 4, api_count: 2 })).status, 400, "no ticket left")
    }
})

test("beads, a free pull and another portal's ticket are refused, and nothing is spent", async () => {
    const player = await newPlayer()
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 3000 })
    data.givePlayerItemSync(player.playerId, 20003, 1)
    assert.equal((await exec(player, { type: 1, payment_type: 1, api_count: 1 })).status, 400, "single bead pull")
    assert.equal((await exec(player, { type: 2, payment_type: 1, api_count: 2 })).status, 400, "bead 10-pull")
    assert.equal((await exec(player, { type: 8, payment_type: 4, api_count: 3 })).status, 400, "free pull")
    assert.equal((await exec(player, { type: 3, api_count: 4 })).status, 400, "no Grab Bag ticket")
    assert.equal(data.getPlayerSync(player.playerId)!.freeVmoney, 3000)
    assert.equal(data.getPlayerItemSync(player.playerId, 20003), 1)
})

test("every 10-pull holds its guaranteed 4-star or better", async () => {
    // the reply merges the pulls by unit, so the guaranteed (last) pull can't be picked out there: draw directly. Without
    // the guarantee a 10-pull still holds a 4-star about 97% of the time, so 300 of them all passing needs it.
    const { drawGachaSync } = await import("../src/lib/gacha")
    const { getGachaSync } = await import("../src/lib/assets")
    const gacha = getGachaSync(GRAB_BAG)!
    for (let run = 0; run < 300; run++) {
        const ids = [...drawGachaSync(gacha, 10).keys()]
        assert.ok(ids.some(id => rarity(id) >= 4), `run ${run}: stars ${ids.map(rarity)}`)
    }
})

test("the ticket-only check refuses beads on every ticket-only kind, and bead portals still take them", async () => {
    const { getGachaSync, getOpenGachaIdsSync } = await import("../src/lib/assets")
    const player = await newPlayer()
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 3000 })
    // kind 3 (a single-pull ticket only: 2) and kind 4 (a 10-pull ticket only: 9), next to the Grab Bag's kind 2
    for (const [gachaId, kind] of [[2, 3], [9, 4]]) {
        assert.equal(getGachaSync(gachaId)?.paymentType, kind)
        assert.equal((await exec(player, { gacha_id: gachaId, type: 1, payment_type: 1, api_count: gachaId })).status, 400, `bead pull on ${gachaId}`)
    }
    assert.equal(data.getPlayerSync(player.playerId)!.freeVmoney, 3000)

    const beadPortal = getOpenGachaIdsSync(new Date("2025-01-03T12:00:00Z"))
        .map(Number).find(id => getGachaSync(id)?.type === 0 && (getGachaSync(id)?.singleCost ?? 0) > 0)!
    assert.equal(getGachaSync(beadPortal)?.paymentType, 0)
    const drawn = await exec(player, { gacha_id: beadPortal, type: 1, payment_type: 1, api_count: 10 })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.equal(drawn.body.data.draw.length, 1)
})

test("the Grab Bag isn't listed among the open bead portals", async () => {
    const { getOpenGachaIdsSync, getGachaSync } = await import("../src/lib/assets")
    assert.equal(getOpenGachaIdsSync(new Date("2025-01-03T12:00:00Z")).includes(String(GRAB_BAG)), false)
    assert.equal(getGachaSync(GRAB_BAG)?.paymentType, 2)
})
