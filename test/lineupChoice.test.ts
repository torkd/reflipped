// FT-38: lineup choices. During a select item campaign the player picks one lineup, once, and the shop then sells only
// that lineup's items. Boss Coin shop campaign 10000004 (choosing 2024-05-07 to 05-19, exchange until 05-27, Japan
// time): lineup 10 is armament 5010054 (shop items 10011002-10011003), lineup 11 armament 5010037 (10011004-10011005).
// Event shop campaign 10 (Beast of the Abyss, 2022-10-07 to 10-22): lineups 1010 (items 100010-) and 1020 (100020-).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const BOSS_COIN = 7
const EVENT_SHOP = 4

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

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

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

const lineupOf = async (player: TestPlayer, shopType: number, campaignId: number) =>
    (await post(player, "shop/get_campaign_lineup_id", { shop_type: shopType, campaign_id: campaignId })).body

test("a lineup is chosen once, during the choosing period, and read back until the exchange ends", async () => {
    const player = await newPlayer("2024-05-10T03:00:00Z")
    const before = await lineupOf(player, BOSS_COIN, 10000004)
    assert.equal(before.data_headers.result_code, 1)
    assert.equal(before.data.lineup_id, null, "nothing chosen yet")

    const chosen = await post(player, "shop/set_campaign_lineup_id", { shop_type: BOSS_COIN, campaign_id: 10000004, lineup_id: 10 })
    assert.equal(chosen.status, 200)
    assert.equal(chosen.body.data_headers.result_code, 1)
    assert.equal((await lineupOf(player, BOSS_COIN, 10000004)).data.lineup_id, 10)

    assert.equal((await post(player, "shop/set_campaign_lineup_id", { shop_type: BOSS_COIN, campaign_id: 10000004, lineup_id: 11 })).status, 400, "only once")
    assert.equal((await post(player, "shop/set_campaign_lineup_id", { shop_type: BOSS_COIN, campaign_id: 10000004, lineup_id: 7 })).status, 400, "another campaign's lineup")

    // after the choosing period: the choice still reads until the exchange ends, but can't be made any more
    await at("2024-05-22T03:00:00Z")
    assert.equal((await lineupOf(player, BOSS_COIN, 10000004)).data.lineup_id, 10)
    const late = await newPlayer("2024-05-22T03:00:00Z")
    const refused = await post(late, "shop/set_campaign_lineup_id", { shop_type: BOSS_COIN, campaign_id: 10000004, lineup_id: 10 })
    assert.equal(refused.body.data_headers.result_code, 1652)
    await at("2024-06-01T03:00:00Z")
    assert.equal((await lineupOf(player, BOSS_COIN, 10000004)).data_headers.result_code, 1652, "after the exchange")
})

test("the shop sells only the chosen lineup's items", async () => {
    const player = await newPlayer("2024-05-10T03:00:00Z")
    data.givePlayerItemSync(player.playerId, 40307, 1000)
    const buy = (shopItemId: number) => post(player, "shop/buy", { shop_type: BOSS_COIN, shop_item_id: shopItemId, number: 1, api_count: 1 })

    assert.equal((await buy(10011002)).status, 400, "nothing chosen yet")
    await post(player, "shop/set_campaign_lineup_id", { shop_type: BOSS_COIN, campaign_id: 10000004, lineup_id: 10 })
    assert.equal((await buy(10011004)).status, 400, "another lineup's armament")
    assert.equal((await buy(10011002)).status, 200, "the chosen lineup's armament")
})

test("the event shop's Beast of the Abyss lineups work the same way", async () => {
    const player = await newPlayer("2022-10-10T03:00:00Z")
    data.givePlayerItemSync(player.playerId, 30005, 100)
    await post(player, "shop/set_campaign_lineup_id", { shop_type: EVENT_SHOP, campaign_id: 10, lineup_id: 1010 })
    assert.equal((await lineupOf(player, EVENT_SHOP, 10)).data.lineup_id, 1010)
    const buy = (shopItemId: number) => post(player, "shop/buy", { shop_type: EVENT_SHOP, shop_item_id: shopItemId, number: 1, api_count: 1 })
    assert.equal((await buy(100020)).status, 400)
    assert.equal((await buy(100010)).status, 200)
})
