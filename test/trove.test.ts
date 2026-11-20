// FT-9: the Trove. Each player gets 8 products a game day, drawn by the master weights, some discounted; the sales
// list shows that lineup with each product's stock left, and only those products can be bought, at their price of the
// day.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import treasureShop from "../assets/treasure_shop.json";

const apiPrefix = "/latest/api/index.php"
const TREASURE = 2
const DAY = 24 * 60 * 60 * 1000
const CLOCK = "2025-01-03T12:00:00Z"
const shop = treasureShop as unknown as Record<string, { availableUntil: string | null, dailyStock: number, buyMaxCount: number, lineupWeight: number, userCost: { amount: number } }>

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let trove: typeof import("../src/lib/trove")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    trove = await import("../src/lib/trove")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

async function setClock(date: Date | string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    await setClock(CLOCK)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, freeMana: 10_000_000 })
    return { ...player, playerId }
}

async function salesList(player: TestPlayer): Promise<any[]> {
    const response = await post(player, "shop/get_sales_list", {
        boss_coin_shop_category_ids: [], equipment_enhancement_shop_category_ids: [], shop_types: [TREASURE], event_list: [], browse_treasure_flag: true
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data.sales_list
}

function buy(player: TestPlayer, shopItemId: number, number: number) {
    return post(player, "shop/buy", { shop_type: TREASURE, shop_item_id: shopItemId, number, api_count: 1 })
}

test("a player's lineup: 8 products on sale, the same all day, new the next day", () => {
    const date = new Date(CLOCK)
    const lineup = trove.troveLineup(1, date)
    assert.equal(lineup.length, trove.TROVE_LINEUP_SIZE)
    const ids = lineup.map(product => product.shopItemId)
    assert.equal(new Set(ids).size, ids.length, "no product twice")
    for (const id of ids) assert.equal(shop[String(id)].availableUntil, null, `${id} is a product still sold in 2025`)

    // 23:00 in Japan, same game day; then 05:00 the next day
    assert.deepEqual(trove.troveLineup(1, new Date("2025-01-03T14:00:00Z")), lineup)
    const days = Array.from({ length: 10 }, (_, day) => JSON.stringify(trove.troveLineup(1, new Date(date.getTime() + day * DAY))))
    assert.ok(new Set(days).size > 1, "the lineup changes from day to day")
    assert.notDeepEqual(trove.troveLineup(2, date), lineup, "each player has their own")
})

test("the draw follows the master weights and discount rates", () => {
    const shown = new Map<number, number>()
    const rates = new Map<number, number>()
    let discounted = 0, total = 0
    for (let playerId = 1; playerId <= 400; playerId++) {
        for (const product of trove.troveLineup(playerId, new Date(CLOCK))) {
            total++
            shown.set(product.shopItemId, (shown.get(product.shopItemId) ?? 0) + 1)
            if (product.discount !== null) {
                discounted++
                rates.set(product.discount.rate, (rates.get(product.discount.rate) ?? 0) + 1)
                assert.equal(product.discount.price, Math.round(shop[String(product.shopItemId)].userCost.amount * (1 - product.discount.rate)))
            }
        }
    }
    // a medium element (weight 10) shows more often than its largest (weight 1); 10% off is the most common discount
    assert.ok((shown.get(200031) ?? 0) > 3 * (shown.get(200033) ?? 0))
    assert.ok(discounted > 0 && discounted < total / 2)
    assert.equal([...rates.entries()].sort((a, b) => b[1] - a[1])[0][0], 0.1)
})

test("the sales list shows the lineup with stock and discounts, and only it can be bought, at its price", async () => {
    const player = await newPlayer()
    // a day whose lineup has a discount
    let date = new Date(CLOCK)
    while (!trove.troveLineup(player.playerId, date).some(product => product.discount !== null)) date = new Date(date.getTime() + DAY)
    await setClock(date)
    const lineup = trove.troveLineup(player.playerId, date)

    const list = await salesList(player)
    assert.deepEqual(list.map(entry => entry.shop_item_id), lineup.map(product => product.shopItemId))
    for (const [index, entry] of list.entries()) {
        const product = lineup[index]
        assert.equal(entry.shop_type, TREASURE)
        assert.equal(entry.stock_quantity, shop[String(product.shopItemId)].dailyStock)
        assert.equal(entry.discount_id, product.discount?.discountId)
        assert.equal(entry.discount_rate, product.discount?.rate)
        assert.equal(entry.discounted_price, product.discount?.price)
    }

    // a discounted product costs its price of the day
    const discounted = lineup.find(product => product.discount !== null)!
    const mana = data.getPlayerSync(player.playerId)!.freeMana
    assert.equal((await buy(player, discounted.shopItemId, 2)).statusCode, 200)
    assert.equal(data.getPlayerSync(player.playerId)!.freeMana, mana - 2 * discounted.discount!.price)
    const entry = (await salesList(player)).find(entry => entry.shop_item_id === discounted.shopItemId)
    assert.equal(entry.stock_quantity, shop[String(discounted.shopItemId)].dailyStock - 2)

    // a product on sale but not in today's lineup
    const missing = Object.keys(shop).map(Number).find(id => shop[String(id)].availableUntil === null && !lineup.some(product => product.shopItemId === id))!
    assert.equal((await buy(player, missing, 1)).statusCode, 400)
})
