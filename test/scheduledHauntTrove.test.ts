// FT-48: with modern event scheduling the Haunt and the Trove follow the event timeline's date, as the client's
// projected masters do, not the real clock: the open Haunt cycle is the timeline's, a new run of the timeline starts a
// cycle over, and the Trove draws its lineup from the products on sale on the timeline.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";
import treasureShop from "../assets/treasure_shop.json";

const apiPrefix = "/latest/api/index.php"
const TOWER = 20
const TREASURE = 2
// cycle 1221 runs from 2024-03-06 05:00 Japan time; the real clock is years past it, in the last cycle (1471)
const IN_1221 = Date.parse("2024-03-10T12:00:00Z")
const shop = treasureShop as unknown as Record<string, { availableFrom: string, availableUntil: string | null }>

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let schedule: typeof import("../src/lib/eventSchedule")
let policy: typeof import("../src/lib/eventPolicy")
const saved = { clock: process.env.SERVER_CLOCK, scheduling: process.env.EVENT_SCHEDULING }

before(async () => {
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
    ;({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    schedule = await import("../src/lib/eventSchedule")
    policy = await import("../src/lib/eventPolicy")
})

beforeEach(() => timelineAt(IN_1221))

after(async () => {
    await cleanup()
    if (saved.clock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = saved.clock
    if (saved.scheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = saved.scheduling
})

let runs = 0

/** Puts the shared timeline (Classic) on a moment of the archive now; a new run unless `sameRun`. */
function timelineAt(sourceTime: number, sameRun = false) {
    const current = policy.getEventPolicy()
    const anchor = schedule.anchorForContentTime(sourceTime, Date.now(), { ...current, mode: "classic" })
    assert.notEqual(anchor, null)
    policy.setEventPolicy({ ...current, mode: "classic", anchor: anchor!, rotationId: sameRun ? current.rotationId : Date.now() + ++runs })
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    // a client that has the timeline's masters (an older resource version is sent back to the title)
    const { availableAssetVersion } = await import("../src/lib/assetLayers")
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: { ...gameHeaders(player.udid), res_ver: availableAssetVersion() },
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

async function load(player: TestPlayer) {
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    await load(player)
    return { ...player, playerId }
}

function startHaunt(player: TestPlayer, questId: number) {
    return post(player, "single_battle_quest/start", {
        quest_id: questId, category: TOWER, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
}

function cleared(playerId: number, questId: number): boolean {
    return data.getPlayerSingleQuestProgressSync(playerId, TOWER, questId)?.finished === true
}

test("the open Haunt cycle is the timeline's, not the real clock's", async () => {
    const { openTowerCycle, towerCycleAt } = await import("../src/lib/towerDungeon")
    assert.equal(towerCycleAt(new Date())?.id, 1471, "the real clock is in the last cycle")
    assert.equal(openTowerCycle(new Date())?.id, 1221)

    const player = await newPlayer()
    assert.equal(data.getPlayerTowerDungeonSync(player.playerId, 1)?.cycle?.split("~")[0], "1221")
    assert.equal((await startHaunt(player, 1471)).statusCode, 400, "the real clock's cycle")
    const started = await startHaunt(player, 1221)
    assert.equal(started.statusCode, 200, started.body)
})

test("a new run of the timeline starts the same cycle over; the same run keeps it", async () => {
    const player = await newPlayer()
    data.insertPlayerQuestProgressSync(player.playerId, TOWER, { questId: 1221, finished: true, clearRank: 1 })

    timelineAt(IN_1221 + 60_000, true)
    await load(player)
    assert.ok(cleared(player.playerId, 1221), "same run: progress kept")

    timelineAt(IN_1221)
    const reply = await load(player)
    assert.ok(!cleared(player.playerId, 1221), "new run: the cycle starts over")
    assert.deepEqual(reply.tower_dungeon_list, [{ event_id: 1, reset_month: 3, reset_status: 2 }])
})

test("a cycle stored before runs were keeps its progress", async () => {
    const player = await newPlayer()
    data.insertPlayerQuestProgressSync(player.playerId, TOWER, { questId: 1221, finished: true, clearRank: 1 })
    data.setPlayerTowerDungeonSync(player.playerId, 1, { cycle: "1221~0", noticeMonth: null, noticeStatus: null })

    const reply = await load(player)
    assert.ok(cleared(player.playerId, 1221))
    assert.deepEqual(reply.tower_dungeon_list ?? [], [])
    const stored = data.getPlayerTowerDungeonSync(player.playerId, 1)!.cycle!
    assert.match(stored, /^1221~0~v1:/, "the run is added to the key")
})

test("the Trove draws from the products on sale on the timeline", async () => {
    const { troveLineup } = await import("../src/lib/trove")
    const player = await newPlayer()
    const until = (id: number) => shop[String(id)].availableUntil

    // before the product switch of 2021-11-12: only the first set, which the real clock has long passed
    timelineAt(Date.parse("2021-09-01T12:00:00Z"))
    const early = troveLineup(player.playerId, new Date())
    assert.equal(early.length, 8)
    assert.ok(early.every(product => until(product.shopItemId) === "2021-11-12 04:59:58"), JSON.stringify(early))
    const listed = (await post(player, "shop/get_sales_list", {
        boss_coin_shop_category_ids: [], equipment_enhancement_shop_category_ids: [], shop_types: [TREASURE], event_list: [], browse_treasure_flag: true
    }))
    const sales = decodeGameBody(listed.body).data.sales_list
    assert.deepEqual(sales.map((entry: { shop_item_id: number }) => entry.shop_item_id), early.map(product => product.shopItemId))

    // during the one-week set of April 2024, it joins the products without an end
    timelineAt(Date.parse("2024-04-07T12:00:00Z"))
    const april = troveLineup(player.playerId, new Date())
    assert.equal(april.length, 8)
    assert.ok(april.every(product => until(product.shopItemId) !== "2021-11-12 04:59:58"))
    const aprilSet = Object.keys(shop).filter(id => shop[id].availableFrom === "2024-04-05 04:59:59").map(Number)
    const players = Array.from({ length: 30 }, (_, index) => index + 1)
    assert.ok(players.some(id => troveLineup(id, new Date()).some(product => aprilSet.includes(product.shopItemId))), "some lineup has the April set")
})
