import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, readCapturedRoute } from "./helpers";

// SEC-15: game routes that let a player cheat on their own account.

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

/** A new player: its viewer id and player id. */
async function signUp(): Promise<{ viewerId: number, playerId: number }> {
    const { viewerId } = await createTestPlayer(fastify)
    const { getAllPlayersSync } = await import("../src/data/wdfpData")
    const players = getAllPlayersSync()
    return { viewerId, playerId: players[players.length - 1].id }
}

/** A game request: its status and, for a 200, the decoded reply. */
async function gameRequest(route: string, body: Record<string, unknown>): Promise<{ status: number, body: any }> {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody(body)
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.body }
}

test("boost points are spent only when the player has one", async () => {
    const data = await import("../src/data/wdfpData")
    const { viewerId, playerId } = await signUp()
    data.updatePlayerSync({ id: playerId, boostPoint: 0, bossBoostPoint: 0 })
    const start = { ...readCapturedRoute("single_battle_quest_start").requestBody, viewer_id: viewerId, category: 1, quest_id: 1001002, use_boost_point: true, use_boss_boost_point: true }
    const finish = { ...readCapturedRoute("single_battle_quest_finish").requestBody, viewer_id: viewerId, elapsed_time_ms: 0, add_mana: 0, is_accomplished: true }

    for (let i = 0; i < 2; i++) {
        assert.equal((await gameRequest("single_battle_quest/start", start)).status, 200)
        assert.equal((await gameRequest("single_battle_quest/finish", finish)).status, 200)
    }
    const player = data.getPlayerSync(playerId)!
    assert.deepEqual([player.boostPoint, player.bossBoostPoint], [0, 0])

    data.updatePlayerSync({ id: playerId, boostPoint: 1 })
    assert.equal((await gameRequest("single_battle_quest/start", start)).status, 200)
    assert.equal((await gameRequest("single_battle_quest/finish", finish)).status, 200)
    assert.equal(data.getPlayerSync(playerId)!.boostPoint, 0)
})

test("tutorial/update_step makes the tutorial pull once", async () => {
    const data = await import("../src/data/wdfpData")
    const { getOpenGachaIdsSync } = await import("../src/lib/assets")
    const { getServerDate } = await import("../src/utils")
    const { viewerId, playerId } = await signUp()
    const gachaId = Number(getOpenGachaIdsSync(getServerDate())[0])
    for (let step = 1; step < 14; step++) {
        assert.equal((await gameRequest("tutorial/update_step", { viewer_id: viewerId, step, name: "Tester" })).status, 200)
    }
    const characters = () => Object.keys(data.getPlayerCharactersSync(playerId)).length
    const pull = () => gameRequest("tutorial/update_step", { viewer_id: viewerId, step: 14, gacha_id: gachaId })

    const first = await pull()
    assert.equal(first.status, 200)
    assert.equal(first.body.data.gacha.draw.length, 1)
    const owned = characters(), beads = data.getPlayerSync(playerId)!.freeVmoney
    assert.equal((await pull()).status, 400, "no second pull")
    assert.equal(characters(), owned)
    assert.equal(data.getPlayerSync(playerId)!.freeVmoney, beads)
    assert.ok(beads >= 0)
})

test("event/rush/summary answers only real events", async () => {
    const { viewerId } = await signUp()
    assert.equal((await gameRequest("event/rush/summary", { viewer_id: viewerId, event_id: 999999 })).status, 400)
    assert.equal((await gameRequest("event/rush/summary", { viewer_id: viewerId, event_id: 700001 })).status, 200)
})

test("gacha exchanges only buy what the gacha's pool holds", async () => {
    const data = await import("../src/data/wdfpData")
    const { getGachaSync } = await import("../src/lib/assets")
    const { viewerId, playerId } = await signUp()
    const exchange = (route: string, gachaId: number, field: string, id: number) => gameRequest(`gacha/${route}`, { viewer_id: viewerId, gacha_id: gachaId, [field]: id, api_count: 1 })
    for (const [gachaId, route, field] of [[184, "exchange_character", "character_id"], [5038, "exchange_equipment", "equipment_id"]] as const) {
        data.insertPlayerGachaInfoSync(playerId, { gachaId, isDailyFirst: false, isAccountFirst: false, gachaExchangePoint: 250 })
        const inPool = Object.values(getGachaSync(gachaId)!.pool)[0][0].id
        assert.equal((await exchange(route, gachaId, field, 999999)).status, 400, `${route}: not in the pool`)
        assert.equal(data.getPlayerGachaInfoSync(playerId, gachaId)!.gachaExchangePoint, 250, "points kept")
        assert.equal((await exchange(route, gachaId, field, inPool)).status, 200, `${route}: in the pool`)
    }
    data.insertPlayerGachaInfoSync(playerId, { gachaId: 185, isDailyFirst: false, isAccountFirst: false, gachaExchangePoint: 250 })
    const equipmentId = Object.values(getGachaSync(5038)!.pool)[0][0].id
    assert.equal((await exchange("exchange_character", 185, "character_id", equipmentId)).status, 400, "an armament from a unit gacha")
})

test("equipment/upgrade without a duplicate takes the ingot for the armament's rarity", async () => {
    const data = await import("../src/data/wdfpData")
    const { givePlayerEquipmentSync } = await import("../src/lib/equipment")
    const { viewerId, playerId } = await signUp()
    const fiveStar = 5030037, fourStar = 4080003
    for (const id of [fiveStar, fourStar]) givePlayerEquipmentSync(playerId, id, 1)
    for (const item of [100000, 12001, 12002, 10001]) data.givePlayerItemSync(playerId, item, 100)
    const upgrade = (equipmentId: number, itemId: number) => gameRequest("equipment/upgrade", { viewer_id: viewerId, equipment_id: equipmentId, upgrade_count: 1, use_stack: false, item_id: itemId, api_count: 1 })

    assert.equal((await upgrade(fiveStar, 10001)).status, 400, "an unrelated item")
    assert.equal((await upgrade(fiveStar, 12001)).status, 400, "the 4★ ingot on a 5★")
    assert.equal((await upgrade(fourStar, 12002)).status, 400, "the 5★ ingot on a 4★")
    assert.equal(data.getPlayerItemSync(playerId, 10001), 100)
    assert.equal((await upgrade(fiveStar, 12002)).status, 200)
    assert.equal((await upgrade(fourStar, 12001)).status, 200)
    assert.equal(data.getPlayerItemSync(playerId, 12002), 99)
})

test("box_gacha/exec draws from the current box only, and charges the draws made", async () => {
    const data = await import("../src/data/wdfpData")
    const { getBoxGachaSync } = await import("../src/lib/assets")
    const { viewerId, playerId } = await signUp()
    const boxGachaId = 1011
    const boxGacha = getBoxGachaSync(boxGachaId)!
    data.givePlayerItemSync(playerId, boxGacha.redeemItemId, boxGacha.redeemItemCount * 10_000)
    const exec = (boxId: number, number: number) => gameRequest("box_gacha/exec", { viewer_id: viewerId, box_gacha_id: boxGachaId, box_id: boxId, number, stop_on_featured_rewards: false, api_count: 1 })
    const currency = () => data.getPlayerItemSync(playerId, boxGacha.redeemItemId)!

    assert.equal((await exec(2, 1)).status, 400, "box 2 before box 1")
    assert.equal((await exec(1, 0)).status, 400)
    assert.equal((await exec(1, -5)).status, 400)
    const before = currency()
    const box1Size = boxGacha.availableCounts[1]
    assert.equal((await exec(1, box1Size + 100)).status, 200, "more than the box holds")
    assert.equal(before - currency(), box1Size * boxGacha.redeemItemCount, "only the draws made are paid")
    assert.equal((await exec(1, 1)).status, 400, "box 1 is closed")
    assert.equal((await exec(2, 1)).status, 200, "box 2 is next")
})

test("shop/buy keeps to the product's amount per purchase, stock and period", async () => {
    const data = await import("../src/data/wdfpData")
    const { getServerDate, setServerTime } = await import("../src/utils")
    const { ShopType } = await import("../src/lib/types")
    const { viewerId, playerId } = await signUp()
    data.updatePlayerSync({ id: playerId, freeMana: 1_000_000 })
    const buy = (shopType: number, shopItemId: number, number: number) => gameRequest("shop/buy", { viewer_id: viewerId, shop_type: shopType, shop_item_id: shopItemId, number, api_count: 1 })
    const salesEntry = async (shopItemId: number) => (await gameRequest("shop/get_sales_list", { viewer_id: viewerId, shop_types: [ShopType.TREASURE], boss_coin_shop_category_ids: [], event_list: [] }))
        .body.data.sales_list.find((entry: any) => entry.shop_item_id === shopItemId)

    // treasure 200032: at most 10 at once and 10 a day (the captured sales list shows the same daily stock)
    const start = getServerDate()
    try {
        assert.equal((await buy(ShopType.TREASURE, 200032, 11)).status, 400, "more than one purchase allows")
        assert.equal((await buy(ShopType.TREASURE, 200032, 0)).status, 400)
        assert.equal((await buy(ShopType.TREASURE, 200032, 10)).status, 200)
        assert.equal((await buy(ShopType.TREASURE, 200032, 1)).status, 400, "the day's stock is gone")
        assert.deepEqual([(await salesEntry(200032)).today_purchase_num, (await salesEntry(200032)).total_purchase_num], [10, 10])

        setServerTime(new Date(start.getTime() + 24 * 60 * 60 * 1000))
        assert.equal((await buy(ShopType.TREASURE, 200032, 1)).status, 200, "a new day")
        assert.deepEqual([(await salesEntry(200032)).today_purchase_num, (await salesEntry(200032)).total_purchase_num], [1, 11])
    } finally {
        setServerTime(start)
    }

    // general 220032 costs nothing and is given once a month
    assert.equal((await buy(ShopType.GENERAL, 220032, 1)).status, 200)
    assert.equal((await buy(ShopType.GENERAL, 220032, 1)).status, 400, "once a month")
    // treasure 200001 left the shop in 2021
    assert.equal((await buy(ShopType.TREASURE, 200001, 1)).status, 400, "not on sale")
})

test("shop limits: rank, months and the game day", async () => {
    const { gameDay, purchaseRefusal } = await import("../src/lib/shopLimits")
    const item = { costs: [], rewards: [], availableFrom: "2020-01-01 05:00:00", availableUntil: null, buyMaxCount: 5 }
    const none = { total: 0, day: "", dayCount: 0, month: "", monthCount: 0 }
    const date = new Date("2025-01-03T12:00:00Z")
    assert.equal(purchaseRefusal(item, 1, 0, none, date), null)
    assert.match(purchaseRefusal({ ...item, releaseRank: 100 }, 1, 632297, none, date)!, /rank/, "rank 99")
    assert.equal(purchaseRefusal({ ...item, releaseRank: 100 }, 1, 666297, none, date), null, "rank 100")
    assert.match(purchaseRefusal({ ...item, specifiedMonths: [2, 3] }, 1, 0, none, date)!, /sale/)
    assert.equal(purchaseRefusal({ ...item, specifiedMonths: [1] }, 1, 0, none, date), null)
    // a game day runs from 05:00 Japan time (20:00 UTC)
    assert.equal(gameDay(new Date("2025-01-03T19:59:59Z")).day, "2025-01-03")
    assert.equal(gameDay(new Date("2025-01-03T20:00:00Z")).day, "2025-01-04")
    assert.equal(gameDay(new Date("2025-01-31T20:00:00Z")).month, "2025-02")
})

test("a co-op lobby mate is rebuilt from the player's save", async () => {
    const data = await import("../src/data/wdfpData")
    const { givePlayerCharacterSync } = await import("../src/lib/character")
    const { givePlayerEquipmentSync } = await import("../src/lib/equipment")
    const { checkMateAgainstSave } = await import("../src/lib/coop/mateCheck")
    const { playerId } = await signUp()
    data.updatePlayerSync({ id: playerId, name: "Saved", rankPoint: 666297 })
    givePlayerCharacterSync(playerId, 151165)
    givePlayerEquipmentSync(playerId, 5030037, 1)
    // its ability soul is an item (what selling the armament gives), held once
    data.givePlayerItemSync(playerId, 5030037, 1)
    const owned = data.getPlayerCharacterSync(playerId, 151165)!

    const forged = {
        name: "Forged", rank: 999, degreeId: 42, autoStart: true, connectionId: "",
        party: {
            characters: [
                [0, { id: 151165, evolution_level: 9, exp: 99_999_999, over_limit_step: 99, mana_node_ids: [1, 2, 3], ex_boost: [1], illustration_settings: [1] }],
                [0, { id: 111001, evolution_level: 1, exp: 0, over_limit_step: 0, mana_node_ids: [], ex_boost: [1], illustration_settings: [1] }],
                [1]
            ],
            unison_characters: [[1], [1], [1]],
            equipments: [[0, { equipmentId: 5030037, level: 99, enhancementLevel: 99 }], [0, { equipmentId: 5020010, level: 1, enhancementLevel: 0 }], [1]],
            abilitySoulIds: [[0, 5030037], [0, 5020010], [1]],
            options: null
        }
    }
    const checked = checkMateAgainstSave(playerId, forged)
    assert.equal(checked.name, "Saved")
    assert.equal(checked.rank, 100)
    assert.equal(checked.autoStart, true, "the player's own settings stay")
    assert.deepEqual(checked.party.characters[0][1].id, 151165)
    assert.equal(checked.party.characters[0][1].exp, owned.exp)
    assert.equal(checked.party.characters[0][1].over_limit_step, owned.overLimitStep)
    assert.equal(checked.party.characters[0][1].evolution_level, owned.evolutionLevel)
    assert.deepEqual(checked.party.characters[0][1].mana_node_ids, [])
    assert.deepEqual(checked.party.characters[1], [1], "a unit the player doesn't own")
    assert.deepEqual(checked.party.characters[2], [1])
    assert.deepEqual(checked.party.equipments[0], [0, { equipmentId: 5030037, level: 1, enhancementLevel: 0 }])
    assert.deepEqual(checked.party.equipments[1], [1], "an armament the player doesn't own")
    assert.deepEqual(checked.party.abilitySoulIds, [[0, 5030037], [1], [1]])
    assert.equal(checkMateAgainstSave(999_999_999, forged), null, "no such player")
})

test("the co-op lobby relays the saved mate, with the player from the room's admission", async (t) => {
    const net = await import("net")
    const data = await import("../src/data/wdfpData")
    const { CoopSocketServer, setCoopSocketServer } = await import("../src/lib/coop/socketServer")
    const { checkMateAgainstSave } = await import("../src/lib/coop/mateCheck")
    const server = new CoopSocketServer({ log: () => {}, keepAliveMs: 0, abandonedRoomMs: 0, checkMate: checkMateAgainstSave })
    const port = await server.listen(0, "127.0.0.1")
    setCoopSocketServer(server)
    const { viewerId, playerId } = await signUp()
    data.updatePlayerSync({ id: playerId, name: "Saved" })
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: 1001001, party_id: 11, category: 2 })).body.data.room_number

    const socket = net.connect(port, "127.0.0.1")
    t.after(async () => { socket.destroy(); setCoopSocketServer(null); await server.close() })
    let buffer = ""
    const messages: any[] = []
    socket.on("data", chunk => {
        buffer += chunk.toString("utf8")
        let end: number
        while ((end = buffer.indexOf("\0")) !== -1) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1) }
    })
    const next = async () => { for (let i = 0; i < 100 && messages.length === 0; i++) await new Promise(r => setTimeout(r, 20)); return messages.shift() }
    await new Promise(resolve => socket.once("connect", resolve))
    socket.write(JSON.stringify({ reconnected: 0, socklet: "cooperation_room", viewerId, roomNumber, questCategory: 2, questId: 1001001 }) + "\0")
    assert.equal((await next())[0], 0, "Accept")
    socket.write(JSON.stringify([0, [0, { name: "Forged", rank: 999, party: { characters: [[0, { id: 111001 }]], unison_characters: [], equipments: [], abilitySoulIds: [] } }, 1]]) + "\0")
    const welcome = await next()
    const mate = welcome[1][2][0]
    assert.equal(mate.name, "Saved")
    assert.deepEqual(mate.party.characters, [[1]])
})
