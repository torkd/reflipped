import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

// FT-69: cores and Wrightpieces past their cap (9,999 a core, 99,999 Wrightpieces) turn into mana at the item's sale
// price, when an armament is awakened (equipment/upgrade, bulk_upgrade) or melted (sell_stack, sell_equipment,
// bulk_sell_stack). The client's confirmations: "Convert these Ability Cores to ::mana:: mana instead?" and the same
// for Wrightpieces.

const apiPrefix = "/latest/api/index.php"
const WRIGHTPIECE = 100000
const WRIGHTPIECE_PRICE = 5
const CORE_MAX = 9999
const WRIGHTPIECE_MAX = 99999
const MANA_MAX = 999_999_999
const ARMAMENT_1 = 1010001 // 1*: core sells for 10, melt 1 Wrightpiece, awakening 5
const ARMAMENT_2 = 2010002 // 2*: core sells for 50, melt 2 Wrightpieces, awakening 10
const CORE_1_PRICE = 10
const CORE_2_PRICE = 50

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

after(async () => {
    await cleanup()
})

interface Player extends TestPlayer { playerId: number }

async function signUp(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    return { ...player, playerId: data.getViewerPlayerIdSync(player.viewerId)! }
}

async function post(player: Player, route: string, body: Record<string, unknown> = {}) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, ...body })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body) as { data: Record<string, any> }
}

function setItem(playerId: number, itemId: number, amount: number) {
    if (data.getPlayerItemSync(playerId, itemId) === null) data.givePlayerItemSync(playerId, itemId, amount)
    else data.updatePlayerItemSync(playerId, itemId, amount)
}

function setEquipment(playerId: number, id: number, level: number, stack: number) {
    if (data.getPlayerEquipmentSync(playerId, id) === null) data.insertPlayerEquipmentSync(playerId, id, { level, enhancementLevel: 0, protection: false, stack })
    else data.updatePlayerEquipmentSync(playerId, id, { level, stack, protection: false })
}

function setMana(playerId: number, mana: number) {
    data.updatePlayerSync({ id: playerId, freeMana: mana })
}

const mana = (playerId: number) => data.getPlayerSync(playerId)!.freeMana

test("melting duplicates: cores and Wrightpieces past the cap become mana", async () => {
    const player = await signUp()
    setMana(player.playerId, 1000)
    setEquipment(player.playerId, ARMAMENT_1, 1, 3)
    setItem(player.playerId, ARMAMENT_1, CORE_MAX - 1)
    setItem(player.playerId, WRIGHTPIECE, WRIGHTPIECE_MAX - 1)

    const reply = await post(player, "equipment/sell_stack", { equipment_list: [{ equipment_id: ARMAMENT_1, number: 3 }] })
    // 3 cores, 1 fits; 3 Wrightpieces, 1 fits
    const expected = 1000 + 2 * CORE_1_PRICE + 2 * WRIGHTPIECE_PRICE
    assert.equal(reply.data.item_list[String(ARMAMENT_1)], CORE_MAX)
    assert.equal(reply.data.item_list[String(WRIGHTPIECE)], WRIGHTPIECE_MAX)
    assert.deepEqual(reply.data.user_info, { free_mana: expected })
    assert.equal(mana(player.playerId), expected)
})

test("melting an armament itself converts the same way", async () => {
    const player = await signUp()
    setMana(player.playerId, 0)
    setEquipment(player.playerId, ARMAMENT_2, 1, 1)
    setItem(player.playerId, ARMAMENT_2, CORE_MAX)

    const reply = await post(player, "equipment/sell_equipment", { equipment_list: [{ equipment_id: ARMAMENT_2 }] })
    assert.equal(reply.data.item_list[String(ARMAMENT_2)], CORE_MAX)
    assert.deepEqual(reply.data.user_info, { free_mana: 2 * CORE_2_PRICE })
})

test("Melt Down All adds up the mana of every armament", async () => {
    const player = await signUp()
    setMana(player.playerId, 0)
    setEquipment(player.playerId, ARMAMENT_1, 1, 4)
    setEquipment(player.playerId, ARMAMENT_2, 1, 2)
    setItem(player.playerId, ARMAMENT_1, CORE_MAX)
    setItem(player.playerId, ARMAMENT_2, CORE_MAX - 1)
    setItem(player.playerId, WRIGHTPIECE, 0)

    const reply = await post(player, "equipment/bulk_sell_stack", { equipment_ids: [ARMAMENT_1, ARMAMENT_2] })
    assert.equal(reply.data.item_list[String(WRIGHTPIECE)], 4 * 1 + 2 * 2, "Wrightpieces under the cap stay Wrightpieces")
    assert.deepEqual(reply.data.user_info, { free_mana: 4 * CORE_1_PRICE + 1 * CORE_2_PRICE })
})

test("awakening: cores past the cap become mana (equipment/upgrade and Awaken All)", async () => {
    const player = await signUp()
    setMana(player.playerId, 0)
    setItem(player.playerId, WRIGHTPIECE, 1000)
    setEquipment(player.playerId, ARMAMENT_1, 1, 2)
    setItem(player.playerId, ARMAMENT_1, CORE_MAX)

    const single = await post(player, "equipment/upgrade", { equipment_id: ARMAMENT_1, upgrade_count: 2, use_stack: true })
    assert.equal(single.data.item_list[String(ARMAMENT_1)], CORE_MAX, "the core count stays at the cap")
    assert.deepEqual(single.data.user_info, { free_mana: 2 * CORE_1_PRICE })

    setEquipment(player.playerId, ARMAMENT_2, 1, 3)
    setItem(player.playerId, ARMAMENT_2, CORE_MAX - 1)
    const bulk = await post(player, "equipment/bulk_upgrade", { equipment_ids: [ARMAMENT_2] })
    assert.equal(bulk.data.item_list[String(ARMAMENT_2)], CORE_MAX)
    assert.deepEqual(bulk.data.user_info, { free_mana: 2 * CORE_1_PRICE + 2 * CORE_2_PRICE })
})

test("nothing past the cap: no mana and no user_info", async () => {
    const player = await signUp()
    setMana(player.playerId, 500)
    setEquipment(player.playerId, ARMAMENT_1, 1, 2)
    setItem(player.playerId, ARMAMENT_1, 0)
    setItem(player.playerId, WRIGHTPIECE, 0)

    const reply = await post(player, "equipment/sell_stack", { equipment_list: [{ equipment_id: ARMAMENT_1, number: 2 }] })
    assert.equal(reply.data.item_list[String(ARMAMENT_1)], 2)
    assert.equal(reply.data.user_info, undefined)
    assert.equal(mana(player.playerId), 500)
})

test("the mana itself stops at the mana cap", async () => {
    const player = await signUp()
    setMana(player.playerId, MANA_MAX - 5)
    setEquipment(player.playerId, ARMAMENT_2, 1, 1)
    setItem(player.playerId, ARMAMENT_2, CORE_MAX)

    const reply = await post(player, "equipment/sell_stack", { equipment_list: [{ equipment_id: ARMAMENT_2, number: 1 }] })
    assert.deepEqual(reply.data.user_info, { free_mana: MANA_MAX })
})
