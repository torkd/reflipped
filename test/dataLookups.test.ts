import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import encyclopedia from "../assets/encyclopedia.json";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

// FT-16: character/add_character_from_town (Shroombo in the town), how_to_get/get_list ("How to obtain") and sns/get.

const apiPrefix = "/latest/api/index.php"
const SHROOMBO = 512001
const SHROOMBO_QUEST = 1008004 // main quest after which Shroombo waits in the town
const MAIN = 1 // QuestCategory.MAIN

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let setServerTime: typeof import("../src/utils").setServerTime

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    setServerTime = (await import("../src/utils")).setServerTime
})

after(async () => {
    setServerTime(null)
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
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null }
}

describe("character/add_character_from_town", () => {
    test("Shroombo joins once his story quest is read, as in the capture", async () => {
        const player = await signUp()
        data.insertPlayerQuestProgressSync(player.playerId, MAIN, { questId: SHROOMBO_QUEST, finished: true })

        const { status, body } = await post(player, "character/add_character_from_town", { character_id: SHROOMBO, api_count: 33 })
        assert.equal(status, 200)
        const captured = readCapturedRoute("character_add_character_from_town").responseBody.data
        const [unit] = body.data.character_list
        assert.equal(body.data.character_list.length, 1)
        assert.deepEqual(Object.keys(unit).sort(), Object.keys(captured.character_list[0]).sort())
        assert.equal(unit.character_id, SHROOMBO)
        assert.equal(unit.viewer_id, player.viewerId)
        assert.deepEqual(body.data.encyclopedia_info, captured.encyclopedia_info)
        assert.equal(typeof body.data.mail_arrived, "boolean")
        assert.notEqual(data.getPlayerCharacterSync(player.playerId, SHROOMBO), null)

        // asking again changes nothing: no duplicate
        const again = await post(player, "character/add_character_from_town", { character_id: SHROOMBO })
        assert.equal(again.status, 200)
        assert.deepEqual(again.body.data.character_list, [])
        assert.equal(data.getPlayerCharacterSync(player.playerId, SHROOMBO)!.stack, 0)
    })

    test("refused before the story quest, and for units that don't join through the story", async () => {
        const player = await signUp()
        assert.equal((await post(player, "character/add_character_from_town", { character_id: SHROOMBO })).status, 400)
        assert.equal(data.getPlayerCharacterSync(player.playerId, SHROOMBO), null)
        // 111001 is a portal unit
        assert.equal((await post(player, "character/add_character_from_town", { character_id: 111001 })).status, 400)
        assert.equal((await post(player, "character/add_character_from_town", { character_id: 10 })).status, 400)
    })

    test("a quest unit the save missed can be taken in the town, where the client shows it", async () => {
        const player = await signUp()
        data.insertPlayerQuestProgressSync(player.playerId, MAIN, { questId: 2009007, finished: true })
        const { status, body } = await post(player, "character/add_character_from_town", { character_id: 10 })
        assert.equal(status, 200)
        assert.deepEqual(body.data.character_list.map((unit: { character_id: number }) => unit.character_id), [10])
        assert.deepEqual(body.data.encyclopedia_info, { "100001001": { "read": false } })
    })
})

describe("story_quest/finish brings a story unit", () => {
    const QUEST_UNIT = 10 // joins with main quest 2009007 (story_join_character, "quest")

    test("the unit joins on the first read and is named in story_join_character_id_list", async () => {
        const player = await signUp()
        const { status, body } = await post(player, "story_quest/finish", { quest_id: 2009007, category: MAIN })
        assert.equal(status, 200)
        assert.deepEqual(body.data.story_join_character_id_list, [QUEST_UNIT])
        assert.deepEqual(body.data.character_list.map((unit: { character_id: number }) => unit.character_id), [QUEST_UNIT])
        assert.equal(body.data.character_list[0].viewer_id, player.viewerId)
        // the unit id is padded to six digits; "11001" isn't in the master and stopped the client with C8601
        assert.deepEqual(body.data.encyclopedia_info, { "100001001": { "read": false } })
        assert.ok("100001001" in encyclopedia)
        assert.notEqual(data.getPlayerCharacterSync(player.playerId, QUEST_UNIT), null)

        // reading it again gives nothing more
        const again = await post(player, "story_quest/finish", { quest_id: 2009007, category: MAIN })
        assert.equal(again.status, 200)
        assert.equal(data.getPlayerCharacterSync(player.playerId, QUEST_UNIT)!.stack, 0)
    })

    test("other stories bring no unit, and the town unit's story doesn't give it", async () => {
        const player = await signUp()
        const { body } = await post(player, "story_quest/finish", { quest_id: SHROOMBO_QUEST, category: MAIN })
        assert.equal(body.data.story_join_character_id_list, undefined)
        assert.equal(data.getPlayerCharacterSync(player.playerId, SHROOMBO), null)
    })

    test("a save that read the quest before the unit was given gets it at /load, once", async () => {
        const player = await signUp()
        data.insertPlayerQuestProgressSync(player.playerId, MAIN, { questId: 2009007, finished: true })
        data.insertPlayerQuestProgressSync(player.playerId, MAIN, { questId: SHROOMBO_QUEST, finished: true })
        const load = await post(player, "load", { access_token: player.zat })
        assert.equal(load.status, 200)
        assert.notEqual(data.getPlayerCharacterSync(player.playerId, QUEST_UNIT), null)
        assert.ok(String(QUEST_UNIT) in load.body.data.user_character_list)
        // the town unit still waits to be tapped, and 10-15-3 isn't read
        assert.equal(data.getPlayerCharacterSync(player.playerId, SHROOMBO), null)
        assert.equal(data.getPlayerCharacterSync(player.playerId, 213013), null)

        assert.equal((await post(player, "load", { access_token: player.zat })).status, 200)
        assert.equal(data.getPlayerCharacterSync(player.playerId, QUEST_UNIT)!.stack, 0)
    })

    test("a unit the player already has isn't given again", async () => {
        const player = await signUp()
        assert.equal((await post(player, "story_quest/finish", { quest_id: 2009007, category: MAIN })).status, 200)
        data.updatePlayerQuestProgressSync(player.playerId, MAIN, { questId: 2009007, finished: false })
        const { body } = await post(player, "story_quest/finish", { quest_id: 2009007, category: MAIN })
        assert.equal(body.data.story_join_character_id_list, undefined)
        assert.equal(data.getPlayerCharacterSync(player.playerId, QUEST_UNIT)!.stack, 0)
    })
})

describe("how_to_get/get_list", () => {
    test("lists the original's shops and box for item 2 on the capture's date", async () => {
        const player = await signUp()
        setServerTime(new Date("2024-06-21T21:45:05Z"))
        try {
            const captured = readCapturedRoute("how_to_get_get_list")
            const { status, body } = await post(player, "how_to_get/get_list", { item_id: 2 })
            assert.equal(status, 200)
            assert.deepEqual(body.data.box_gacha_id_list, captured.responseBody.data.box_gacha_id_list)
            assert.deepEqual(body.data.unselected_lineup_shop_sales_list, [])
            // every product of the capture but the paid pack (shop_type 3), which isn't in the data
            const ids = (list: { shop_item_id: number, shop_type: number }[]) => list.map(entry => `${entry.shop_type}:${entry.shop_item_id}`).sort()
            const expected = captured.responseBody.data.shop_sales_list.filter((entry: { shop_type: number }) => entry.shop_type !== 3)
            assert.deepEqual(ids(body.data.shop_sales_list), ids(expected))
            const entry = body.data.shop_sales_list.find((entry: { shop_item_id: number }) => entry.shop_item_id === 600071)
            assert.deepEqual(Object.keys(entry).sort(), Object.keys(expected.find((entry: { shop_item_id: number }) => entry.shop_item_id === 600071)).sort())
        } finally {
            setServerTime(null)
        }
    })

    test("finds armaments by equipment_id and counts the player's purchases", async () => {
        const player = await signUp()
        setServerTime(new Date("2024-06-21T21:45:05Z"))
        try {
            // a Boss Coin shop armament: 200109 and 200110 sell 4010014 then; 200101 did until May 2024
            const { body } = await post(player, "how_to_get/get_list", { equipment_id: 4010014 })
            const sold = body.data.shop_sales_list.map((entry: { shop_item_id: number, shop_type: number }) => `${entry.shop_type}:${entry.shop_item_id}`)
            assert.ok(sold.includes("7:200109") && sold.includes("7:200110"))
            assert.ok(!sold.includes("7:200101"))

            data.setPlayerShopPurchasesSync(player.playerId, 7, 200509, { total: 4, day: "", dayCount: 0, month: "", monthCount: 0 })
            const { body: item } = await post(player, "how_to_get/get_list", { item_id: 2 })
            const bought = item.data.shop_sales_list.find((entry: { shop_item_id: number }) => entry.shop_item_id === 200509)
            assert.equal(bought.total_purchase_num, 4)
        } finally {
            setServerTime(null)
        }
    })

    test("a lineup the player can't buy goes to the unselected list", async () => {
        const player = await signUp()
        // Boss Coin campaign 4 (November 2023): lineup 7 holds 301795 (armament 5010054), lineup 8 holds 301797
        setServerTime(new Date("2023-11-15T03:00:00Z"))
        try {
            const lookup = async () => (await post(player, "how_to_get/get_list", { equipment_id: 5010054 })).body.data
            const ids = (list: { shop_item_id: number }[]) => list.map(entry => entry.shop_item_id)
            // no lineup chosen yet
            assert.ok(ids((await lookup()).unselected_lineup_shop_sales_list).includes(301795))
            assert.ok(!ids((await lookup()).shop_sales_list).includes(301795))
            data.setPlayerLineupChoiceSync(player.playerId, 7, 4, 7)
            assert.ok(ids((await lookup()).shop_sales_list).includes(301795))
            assert.ok(!ids((await lookup()).unselected_lineup_shop_sales_list).includes(301795))
        } finally {
            setServerTime(null)
        }
    })

    test("needs an item or an armament", async () => {
        const player = await signUp()
        assert.equal((await post(player, "how_to_get/get_list")).status, 400)
    })
})

describe("sns/get", () => {
    test("no linked account, as the original answered", async () => {
        const player = await signUp()
        const { status, body } = await post(player, "sns/get", { sns_type: 1 })
        assert.equal(status, 200)
        assert.deepEqual(body.data, readCapturedRoute("sns_get").responseBody.data)
    })
})
