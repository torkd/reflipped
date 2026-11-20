// FT-71: during a select item campaign, shop/get_sales_list lists only the chosen lineup's items, since shop/buy
// refuses the others and the client turns that refusal into H400. Boss Coin shop category 33, campaign 10000004
// (exchange until 2024-05-27, Japan time): lineups 9 (10011000-1), 10 (10011002-3), 11 (10011004-5), 12 (10011006-7).
// Event shop (event type 4, event 1), campaign 10 (Beast of the Abyss, until 2022-10-22): lineups 1010 (100010-14)
// and 1020 (100020-24).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const BOSS_COIN = 7
const EVENT_SHOP = 4
const bossLineups: Record<number, number[]> = { 9: [10011000, 10011001], 10: [10011002, 10011003], 11: [10011004, 10011005], 12: [10011006, 10011007] }
const eventLineups: Record<number, number[]> = { 1010: [100010, 100011, 100012, 100013, 100014], 1020: [100020, 100021, 100022, 100023, 100024] }

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

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body)
}

async function at(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

/** The shop item IDs of one shop type the player's sales list holds. */
async function listed(player: TestPlayer, shopType: number): Promise<Set<number>> {
    const body = await post(player, "shop/get_sales_list", {
        shop_types: [], boss_coin_shop_category_ids: shopType === BOSS_COIN ? [33] : [],
        event_list: shopType === EVENT_SHOP ? [{ event_type: 4, event_ids: [1] }] : [],
        equipment_enhancement_shop_category_ids: [], browse_treasure_flag: false
    })
    const rows = body.data.sales_list as { shop_item_id: number, shop_type: number }[]
    return new Set(rows.filter(row => row.shop_type === shopType).map(row => row.shop_item_id))
}

function assertLineups(items: Set<number>, lineups: Record<number, number[]>, shown: number | null, label: string) {
    for (const [lineupId, itemIds] of Object.entries(lineups))
        for (const itemId of itemIds)
            assert.equal(items.has(itemId), Number(lineupId) === shown, `${label}: item ${itemId} of lineup ${lineupId}`)
}

test("the Boss Coin shop lists no lineup before a choice, then only the chosen one", async () => {
    await at("2024-05-10T03:00:00Z")
    const player = await createTestPlayer(fastify)
    const before = await listed(player, BOSS_COIN)
    assert.ok(before.size > 0, "the shop's other items are still listed")
    assertLineups(before, bossLineups, null, "nothing chosen")

    await post(player, "shop/set_campaign_lineup_id", { shop_type: BOSS_COIN, campaign_id: 10000004, lineup_id: 10 })
    const after = await listed(player, BOSS_COIN)
    assertLineups(after, bossLineups, 10, "lineup 10 chosen")
    assert.equal(after.size, before.size + bossLineups[10].length, "only the lineup's items were added")
})

test("the Beast of the Abyss shop lists only the chosen lineup", async () => {
    await at("2022-10-10T03:00:00Z")
    const player = await createTestPlayer(fastify)
    assertLineups(await listed(player, EVENT_SHOP), eventLineups, null, "nothing chosen")
    await post(player, "shop/set_campaign_lineup_id", { shop_type: EVENT_SHOP, campaign_id: 10, lineup_id: 1020 })
    assertLineups(await listed(player, EVENT_SHOP), eventLineups, 1020, "lineup 1020 chosen")
})

test("the list and shop/buy agree on every lineup item", async () => {
    const { hiddenLineupItemsSync, lineupPurchaseRefusal } = await import("../src/lib/lineupChoice")
    await at("2024-05-10T03:00:00Z")
    const player = await createTestPlayer(fastify)
    await post(player, "shop/set_campaign_lineup_id", { shop_type: BOSS_COIN, campaign_id: 10000004, lineup_id: 11 })
    const data = await import("../src/data/wdfpData")
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const now = new Date("2024-05-10T03:00:00Z")
    const hidden = hiddenLineupItemsSync(playerId, BOSS_COIN, now)
    for (const itemId of Object.values(bossLineups).flat())
        assert.equal(hidden.has(itemId), lineupPurchaseRefusal(playerId, BOSS_COIN, itemId, now) !== null, `item ${itemId}`)
})
