// FT-14: portal and box gacha edge cases. Box gacha 11 (2023-03-13 to 03-31, Japan time): its last box (5) resets once
// empty, the others never. Portal draws spend the ticket their draw kind names (the client's GachaDrawKind), the 4 &
// 5-Star Portal Ticket pulls at least 4 stars, and a free campaign pull gives the campaign's own size.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import characters from "../assets/character.json";
import gachaCampaigns from "../assets/gacha_campaign.json";

const apiPrefix = "/latest/api/index.php"
const BOX_GACHA = 11
const LAST_BOX = 5
const UNIT_PORTAL = 184
const ARMAMENT_PORTAL = 5038

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
    return { ...player, playerId }
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

test("the last box resets once it is empty, and only it", async () => {
    const player = await newPlayer("2023-03-20T03:00:00Z")
    const reset = (boxId: number) => post(player, "box_gacha/reset", { box_gacha_id: BOX_GACHA, box_id: boxId })

    // the last box, drawn empty: one drawn reward left in the table, nothing remaining
    data.insertPlayerBoxGachaSync(player.playerId, BOX_GACHA, { boxId: LAST_BOX, isClosed: true, remainingNumber: 0, resetTimes: 0 })
    data.insertPlayerBoxGachaDrawnRewardSync(player.playerId, BOX_GACHA, LAST_BOX, { id: 1, number: 3 })
    assert.equal((await reset(1)).status, 400, "the first box never resets")

    const done = await reset(LAST_BOX)
    assert.equal(done.status, 200, JSON.stringify(done.body))
    const box = done.body.data.all_box_info.find((entry: any) => entry.box_id === LAST_BOX)
    assert.equal(box.reset_times, 1)
    assert.equal(box.is_closed, false)
    assert.deepEqual([...box.all_drawn_reward_list], [])
    assert.deepEqual(data.getPlayerBoxGachaDrawnRewardsSync(player.playerId, BOX_GACHA, LAST_BOX), [])
    assert.ok(data.getPlayerBoxGachaSync(player.playerId, BOX_GACHA, LAST_BOX)!.remainingNumber > 0)

    assert.equal((await reset(LAST_BOX)).status, 400, "not empty any more")

    await at("2023-05-01T03:00:00Z")
    assert.equal((await reset(LAST_BOX)).body.data_headers.result_code, 4608, "outside the box's period")
})

test("each ticket draw kind names its own ticket", async () => {
    const { ticketDraw, campaignPulls } = await import("../src/lib/gachaDraws")
    const { GachaType } = await import("../src/lib/types")
    assert.deepEqual(ticketDraw(UNIT_PORTAL, GachaType.CHARACTER, 9), { itemId: 999001, pulls: 10, guaranteed: false })
    assert.deepEqual(ticketDraw(UNIT_PORTAL, GachaType.CHARACTER, 10), { itemId: 999003, pulls: 1, guaranteed: false })
    assert.deepEqual(ticketDraw(UNIT_PORTAL, GachaType.CHARACTER, 20), { itemId: 999008, pulls: 1, guaranteed: true })
    assert.deepEqual(ticketDraw(ARMAMENT_PORTAL, GachaType.WEAPON, 12), { itemId: 999005, pulls: 1, guaranteed: false })
    assert.deepEqual(ticketDraw(ARMAMENT_PORTAL, GachaType.WEAPON, 13), { itemId: 999004, pulls: 10, guaranteed: false })
    assert.equal(ticketDraw(UNIT_PORTAL, GachaType.CHARACTER, 12), null, "an armament ticket on a unit portal")
    // the Launch Gala Portal's own tickets
    assert.deepEqual(ticketDraw(1, GachaType.CHARACTER, 3), { itemId: 20001, pulls: 1, guaranteed: false })
    assert.deepEqual(ticketDraw(1, GachaType.CHARACTER, 4), { itemId: 20002, pulls: 10, guaranteed: false })
    assert.equal(ticketDraw(UNIT_PORTAL, GachaType.CHARACTER, 3), null, "a portal without its own ticket")

    // campaign 1 ("Free 10-Pulls Daily") covers portals 28-30; campaign 2 a free pull a day
    assert.equal((gachaCampaigns as Record<string, number>)["28"], 1)
    assert.equal(campaignPulls(1), 10)
    assert.equal(campaignPulls(2), 1)
})

test("an armament single ticket spends the Armament Ticket, not a Summoning Ticket", async () => {
    const player = await newPlayer("2025-01-03T12:00:00Z")
    data.givePlayerItemSync(player.playerId, 999005, 2)
    data.givePlayerItemSync(player.playerId, 999003, 2)
    const drawn = await post(player, "gacha/exec", { gacha_id: ARMAMENT_PORTAL, type: 12, payment_type: 3, number_of_exec: 1, api_count: 1 })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.equal(data.getPlayerItemSync(player.playerId, 999005), 1)
    assert.equal(data.getPlayerItemSync(player.playerId, 999003), 2)
})

test("the 4 & 5-Star Portal Ticket pulls at least 4 stars", async () => {
    const player = await newPlayer("2025-01-03T12:00:00Z")
    data.givePlayerItemSync(player.playerId, 999008, 20)
    const rarity = (id: number) => (characters as Record<string, { rarity: number }>)[String(id)]?.rarity
    for (let draw = 0; draw < 20; draw++) {
        const drawn = await post(player, "gacha/exec", { gacha_id: UNIT_PORTAL, type: 20, payment_type: 3, number_of_exec: 1, api_count: draw + 1 })
        assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
        assert.equal(drawn.body.data.draw.length, 1)
        const id = drawn.body.data.draw[0].character_id
        assert.ok(rarity(id) >= 4, `pulled ${id} (${rarity(id)} stars)`)
    }
    assert.equal(data.getPlayerItemSync(player.playerId, 999008), 0)
})

test("a device without its language's CDN gets the English data", async () => {
    const { servedLanguage } = await import("../src/routes/api/asset")
    assert.equal(servedLanguage("ko"), "en")
    assert.equal(servedLanguage("th"), "en")
    assert.equal(servedLanguage("en"), "en")
    assert.equal(servedLanguage(undefined), "en")
})
