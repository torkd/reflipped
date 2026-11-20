// FT-54: the augment shop (shop type 10). A listing of one entry per armament at its current stage, and purchases of
// augmentation levels paid in items.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import playerRank from "../assets/player_rank.json";
import enhancement from "../assets/equipment_enhancement.json";

const apiPrefix = "/latest/api/index.php"
const AUGMENT = 10
// chain 21 of category 3: armament 5020042, stages 1 to 4 are the rows 2001 to 2004, all open from 2024-07-25 15:00 JST
const ARMAMENT = 5020042
const STAGE1 = 2001, STAGE2 = 2002, STAGE3 = 2003, STAGE4 = 2004
// open for every category 3 row
const CLOCK = "2024-08-01T00:00:00Z"
const RANK_90 = (playerRank as number[])[89]
const RANK_89 = (playerRank as number[])[88]
const shop = enhancement.shop as unknown as Record<string, { costs: { id: number, count: number }[], maxLevel: number, equipmentId: number, category: number }>

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

type Player = TestPlayer & { playerId: number }

/** A player of rank 90 on the clock where category 3 is on sale, owning `ARMAMENT` awakened to 5 at `level`. */
async function newPlayer(options: { rankPoint?: number, level?: number, awakening?: number, owns?: boolean } = {}): Promise<Player> {
    await setClock(CLOCK)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, rankPoint: options.rankPoint ?? RANK_90 })
    if (options.owns !== false) {
        data.insertPlayerEquipmentSync(playerId, ARMAMENT, { level: options.awakening ?? 5, enhancementLevel: options.level ?? 0, protection: false, stack: 1 })
    }
    return { ...player, playerId }
}

/** Gives the player enough of the items to pay `levels` levels of each of the rows (and a little more). */
function fund(playerId: number, rows: [row: number, levels: number][]) {
    for (const [row, levels] of rows) {
        for (const cost of shop[String(row)].costs) data.givePlayerItemSync(playerId, cost.id, cost.count * levels)
    }
}

async function salesList(player: TestPlayer, categories: number[] = [3]): Promise<any[]> {
    const response = await post(player, "shop/get_sales_list", {
        boss_coin_shop_category_ids: [], equipment_enhancement_shop_category_ids: categories, shop_types: [AUGMENT], event_list: [], browse_treasure_flag: false
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data.sales_list
}

function buy(player: TestPlayer, shopItemId: number, number: number) {
    return post(player, "shop/buy", { shop_type: AUGMENT, shop_item_id: shopItemId, number, api_count: 1 })
}

function entryOf(list: any[], equipmentRow: number): any {
    const row = shop[String(equipmentRow)]
    // an armament's entry is the row of its current stage: the same chain, so the same armament
    return list.find(entry => shop[String(entry.shop_item_id)].equipmentId === row.equipmentId)
}

test("below rank 90 the listing is empty and nothing can be bought", async () => {
    const player = await newPlayer({ rankPoint: RANK_89 })
    fund(player.playerId, [[STAGE1, 5]])
    assert.deepEqual(await salesList(player), [])
    const response = await buy(player, STAGE1, 1)
    assert.equal(response.statusCode, 400)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 0)

    // rank 90 is enough
    data.updatePlayerSync({ id: player.playerId, rankPoint: RANK_90 })
    assert.equal((await salesList(player)).length, 4)
    assert.equal((await buy(player, STAGE1, 1)).statusCode, 200)
})

test("the listing has one entry per armament of the category, at its current stage", async () => {
    const player = await newPlayer({ level: 5 })
    const list = await salesList(player)
    // category 3 has four armaments (chains 21 to 24)
    assert.equal(list.length, 4)
    assert.equal(new Set(list.map(entry => shop[String(entry.shop_item_id)].equipmentId)).size, 4)
    for (const entry of list) assert.equal(entry.shop_type, AUGMENT)

    const owned = entryOf(list, STAGE1)
    assert.equal(owned.shop_item_id, STAGE1)
    assert.equal(owned.stock_quantity, 69 - 5)
    assert.equal(owned.total_purchase_num, 5)
    assert.deepEqual(owned.group_info, { group_total_stock_quantity: 99 - 5, group_total_purchase_num: 5, multi_stage: true })

    // armaments the player doesn't own are listed at the first stage, nothing bought
    const other = list.find(entry => shop[String(entry.shop_item_id)].equipmentId !== ARMAMENT)
    assert.equal(shop[String(other.shop_item_id)].maxLevel, 69)
    assert.equal(other.stock_quantity, 69)
    assert.deepEqual(other.group_info, { group_total_stock_quantity: 99, group_total_purchase_num: 0, multi_stage: true })

    // another category isn't mixed in; a category of no armaments gives nothing
    assert.deepEqual(await salesList(player, [99]), [])
    assert.deepEqual(await salesList(player, []), [])
})

test("the stage moves on after the last level of a stage, and a fully augmented armament shows no stock", async () => {
    const player = await newPlayer({ level: 69 })
    let entry = entryOf(await salesList(player), STAGE1)
    assert.equal(entry.shop_item_id, STAGE2, "level 69 ends stage 1")
    assert.equal(entry.stock_quantity, 1)
    assert.equal(entry.group_info.group_total_stock_quantity, 30)

    data.updatePlayerEquipmentSync(player.playerId, ARMAMENT, { enhancementLevel: 70 })
    entry = entryOf(await salesList(player), STAGE1)
    assert.equal(entry.shop_item_id, STAGE3)
    assert.equal(entry.stock_quantity, 28)

    data.updatePlayerEquipmentSync(player.playerId, ARMAMENT, { enhancementLevel: 98 })
    entry = entryOf(await salesList(player), STAGE1)
    assert.equal(entry.shop_item_id, STAGE4)
    assert.equal(entry.stock_quantity, 1)

    data.updatePlayerEquipmentSync(player.playerId, ARMAMENT, { enhancementLevel: 99 })
    entry = entryOf(await salesList(player), STAGE1)
    assert.equal(entry.shop_item_id, STAGE4, "the last stage stays")
    assert.equal(entry.stock_quantity, 0)
    assert.deepEqual(entry.group_info, { group_total_stock_quantity: 0, group_total_purchase_num: 99, multi_stage: true })
})

test("rows outside their periods are left out", async () => {
    const player = await newPlayer()
    // 2024-07-25 15:00 in Japan is 06:00 UTC: category 3 is open since 2024-05-28, but chain 21 only from then
    await setClock("2024-07-25T05:59:59Z")
    let list = await salesList(player)
    assert.deepEqual(list.map(entry => shop[String(entry.shop_item_id)].equipmentId), [5010073], "only chain 22 (open since 2024-05-28)")
    assert.equal((await buy(player, STAGE1, 1)).statusCode, 400)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 0)

    await setClock("2024-07-25T06:00:00Z")
    list = await salesList(player)
    assert.equal(list.length, 4)

    // before the category and before the feature
    await setClock("2024-05-28T04:59:59Z")
    assert.deepEqual(await salesList(player), [])
    await setClock("2024-02-28T00:00:00Z")
    assert.deepEqual(await salesList(player, [1, 2, 3, 4]), [])

    // category 4 opens on 2024-08-17 14:00 in Japan
    await setClock("2024-08-17T04:59:59Z")
    assert.deepEqual(await salesList(player, [4]), [])
    await setClock("2024-08-17T05:00:00Z")
    assert.equal((await salesList(player, [4])).length, 3, "three armaments are open then (the others open on 2024-09-14)")
})

test("buying raises the armament's level and takes the costs for every level", async () => {
    const player = await newPlayer({ level: 10 })
    data.givePlayerItemSync(player.playerId, 40401, 100)
    const response = await buy(player, STAGE1, 3)
    assert.equal(response.statusCode, 200, response.body)
    const reply = decodeGameBody(response.body).data
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 13)
    assert.equal(data.getPlayerItemSync(player.playerId, 40401), 97)
    assert.equal(reply.equipment_list.length, 1)
    const equipment = reply.equipment_list[0]
    assert.equal(equipment.equipment_id, ARMAMENT)
    assert.equal(equipment.enhancement_level, 13)
    assert.equal(equipment.level, 5)
    assert.equal(equipment.protection, false)
    assert.equal(equipment.stack, 1)
    assert.deepEqual(reply.item_list, { "40401": 97 })

    // the listing follows
    const entry = entryOf(await salesList(player), STAGE1)
    assert.equal(entry.stock_quantity, 69 - 13)
    assert.equal(entry.group_info.group_total_purchase_num, 13)
})

test("a stage with several costs takes each of them, times the number of levels", async () => {
    const player = await newPlayer({ level: 69 })
    // row 2002 is one level, 10 x 40401 + 1 x 40407 + 10 x 14040
    data.givePlayerItemSync(player.playerId, 40401, 12)
    data.givePlayerItemSync(player.playerId, 40407, 3)
    data.givePlayerItemSync(player.playerId, 14040, 10)
    const response = await buy(player, STAGE2, 1)
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(decodeGameBody(response.body).data.item_list, { "40401": 2, "40407": 2, "14040": 0 })
    assert.equal(data.getPlayerItemSync(player.playerId, 40401), 2)
    assert.equal(data.getPlayerItemSync(player.playerId, 40407), 2)
    assert.equal(data.getPlayerItemSync(player.playerId, 14040), 0)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 70)
})

test("buying up to the stage's last level works, one more is refused, and then the next stage's row works", async () => {
    const player = await newPlayer({ level: 60 })
    fund(player.playerId, [[STAGE1, 10], [STAGE2, 1], [STAGE3, 28], [STAGE4, 1]])
    const items = () => [40401, 40407, 14040, 14033, 14041].map(id => data.getPlayerItemSync(player.playerId, id))
    const before = items()

    // 10 levels would pass 69
    assert.equal((await buy(player, STAGE1, 10)).statusCode, 400)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 60)
    assert.deepEqual(items(), before, "a refusal takes nothing")

    // exactly up to 69
    assert.equal((await buy(player, STAGE1, 9)).statusCode, 200)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 69)
    // one more of stage 1 is refused
    assert.equal((await buy(player, STAGE1, 1)).statusCode, 400)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 69)

    // stage 2 is one level (70), then stage 3 up to 98, stage 4 to 99
    assert.equal((await buy(player, STAGE2, 2)).statusCode, 400, "stage 2 holds one level")
    assert.equal((await buy(player, STAGE2, 1)).statusCode, 200)
    assert.equal((await buy(player, STAGE3, 28)).statusCode, 200)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 98)
    const last = await buy(player, STAGE4, 1)
    assert.equal(last.statusCode, 200, last.body)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 99)
    assert.equal((await buy(player, STAGE4, 1)).statusCode, 400, "nothing is left")
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 99)
})

test("a row of another stage than the armament's level is refused", async () => {
    const player = await newPlayer({ level: 10 })
    fund(player.playerId, [[STAGE2, 1], [STAGE3, 5], [STAGE4, 1]])
    for (const row of [STAGE2, STAGE3, STAGE4]) {
        assert.equal((await buy(player, row, 1)).statusCode, 400, `row ${row} while at level 10`)
    }
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 10)

    // a lower stage once the armament is past it
    data.updatePlayerEquipmentSync(player.playerId, ARMAMENT, { enhancementLevel: 70 })
    fund(player.playerId, [[STAGE1, 1]])
    assert.equal((await buy(player, STAGE1, 1)).statusCode, 400)
    assert.equal((await buy(player, STAGE2, 1)).statusCode, 400)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel, 70)
})

test("buying is refused for an unknown row, a bad number, an armament not owned, a lower awakening and missing items", async () => {
    const player = await newPlayer({ level: 0 })
    const level = () => data.getPlayerEquipmentSync(player.playerId, ARMAMENT)!.enhancementLevel

    // not enough items: none, then one short
    assert.equal((await buy(player, STAGE1, 1)).statusCode, 400)
    data.givePlayerItemSync(player.playerId, 40401, 4)
    assert.equal((await buy(player, STAGE1, 5)).statusCode, 400)
    assert.equal(level(), 0)
    assert.equal(data.getPlayerItemSync(player.playerId, 40401), 4, "nothing was taken")
    assert.equal((await buy(player, STAGE1, 4)).statusCode, 200)
    assert.equal(data.getPlayerItemSync(player.playerId, 40401), 0)

    data.givePlayerItemSync(player.playerId, 40401, 10)
    assert.equal((await buy(player, 999999, 1)).statusCode, 400, "unknown row")
    assert.equal((await buy(player, STAGE1, 0)).statusCode, 400, "zero levels")
    assert.equal((await buy(player, STAGE1, -1)).statusCode, 400, "negative levels")
    assert.equal(level(), 4)
    assert.equal(data.getPlayerItemSync(player.playerId, 40401), 10)

    // awakening 4 is below the 5 the row needs
    data.updatePlayerEquipmentSync(player.playerId, ARMAMENT, { level: 4 })
    assert.equal((await buy(player, STAGE1, 1)).statusCode, 400)
    assert.equal(level(), 4)
    data.updatePlayerEquipmentSync(player.playerId, ARMAMENT, { level: 5 })
    assert.equal((await buy(player, STAGE1, 1)).statusCode, 200)
    assert.equal(level(), 5)

    // an armament that isn't owned: the sibling chain's row (5010073, chain 22)
    const unowned = Object.entries(shop).find(([, row]) => row.category === 3 && row.equipmentId === 5010073 && row.maxLevel === 69)![0]
    fund(player.playerId, [[Number(unowned), 1]])
    assert.equal(data.getPlayerEquipmentSync(player.playerId, 5010073), null)
    assert.equal((await buy(player, Number(unowned), 1)).statusCode, 400)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, 5010073), null, "buying doesn't create the armament")
})

test("a single-stage armament (category 2, awakening 1) is listed without multi_stage and keeps its other fields when bought", async () => {
    // category 2 is a single stage (row of armament 5010070, awakening 1, up to level 99)
    const row = Object.entries(shop).find(([, entry]) => entry.category === 2)!
    const rowId = Number(row[0])
    const player = await newPlayer()
    await setClock("2024-05-01T00:00:00Z")
    data.insertPlayerEquipmentSync(player.playerId, row[1].equipmentId, { level: 1, enhancementLevel: 0, protection: true, stack: 2 })
    fund(player.playerId, [[rowId, 3]])
    const list = await salesList(player, [2])
    assert.equal(list.length, 1)
    assert.equal(list[0].shop_item_id, rowId)
    assert.equal(list[0].group_info.multi_stage, false)
    assert.equal(list[0].stock_quantity, 99)

    const response = await buy(player, rowId, 3)
    assert.equal(response.statusCode, 200, response.body)
    const equipment = decodeGameBody(response.body).data.equipment_list[0]
    assert.equal(equipment.enhancement_level, 3)
    assert.equal(equipment.protection, true, "the armament's other fields stay")
    assert.equal(equipment.stack, 2)
})
