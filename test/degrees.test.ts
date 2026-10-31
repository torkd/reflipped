// FT-2 degree missions and FT-4 title mail: titles (degrees) come from degree missions (category 5) at once, or from
// mail type 13; profile/get_degree_list lists them and profile/update_degree sets one.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const DEGREE = 5

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let missions: typeof import("../src/lib/missions")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    // the data layer opens the test database, so import it only after createTestServer()
    data = await import("../src/data/wdfpData")
    missions = await import("../src/lib/missions")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const result = { ...player, playerId }
    await post(result, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    return result
}

async function request(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await request(player, route, body)
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function degreeIds(player: TestPlayer): Promise<number[]> {
    return (await post(player, "profile/get_degree_list", { api_count: 1 })).degree_ids
}

test("a new player owns the default title only", async () => {
    const player = await newPlayer()
    assert.deepEqual(await degreeIds(player), [1])
})

test("a degree mission gives its title at once, without mail", async () => {
    const player = await newPlayer()
    // degree 49000: "Tap a unit 5 times on the Town page" (the captured update_mission_progress cleared it)
    const reply = await post(player, "mission/update_mission_progress", { api_count: 1, mission_param_list: [{ mission_pattern: "home_tap_town_character_count", progress_value: 5 }] })
    assert.ok(reply.mission_info.some((info: { mission_category_id: number, mission_id: number, mission_reward_id: number }) =>
        info.mission_category_id === DEGREE && info.mission_id === 49000 && info.mission_reward_id === 49000001))
    assert.deepEqual(reply.degree_list, [{ viewer_id: player.viewerId, degree_id: 49000 }])
    assert.ok((await degreeIds(player)).includes(49000))
    assert.equal(data.getPlayerReceivableMailCountSync(player.playerId, new Date()), 0)

    // the title screen's progress
    const progress = await post(player, "mission/get_mission_progress", { api_count: 2, category_list: [{ category: DEGREE }] })
    const entry = progress.mission_progress_list.find((item: { mission_id: number }) => item.mission_id === 49000)
    assert.deepEqual(entry, { mission_category: DEGREE, mission_id: 49000, progress_value: 5, stage: 1 })
})

test("profile/update_degree sets an owned title only", async () => {
    const player = await newPlayer()
    data.insertPlayerDegreeSync(player.playerId, 49000)
    const reply = await post(player, "profile/update_degree", { api_count: 1, degree_id: 49000 })
    assert.equal(reply.user_info.degree_id, 49000)
    const loaded = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(loaded.user_info.degree_id, 49000)

    const refused = await request(player, "profile/update_degree", { api_count: 2, degree_id: 1000 })
    assert.equal(refused.statusCode, 400)
    assert.equal(data.getPlayerSync(player.playerId)!.degreeId, 49000)
})

test("a title mail (type 13) gives the title when received", async () => {
    const player = await newPlayer()
    const send = (mail: Record<string, unknown>) => admin.inject({ method: "POST", url: `/api/player/mail?id=${player.playerId}`, payload: { subject: "Title", description: "A title", ...mail } })
    assert.equal((await send({ type: "DEGREE", typeId: 999999999, number: 1 })).statusCode, 400, "unknown title")
    assert.equal((await send({ type: "DEGREE", typeId: 1000, number: 2 })).statusCode, 400, "a title is sent once")
    const sent = await send({ type: "DEGREE", typeId: 1000, number: 1 })
    assert.equal(sent.statusCode, 200, sent.body)

    const index = await post(player, "mail/index", { api_count: 1, current_page: 1 })
    const mail = index.mail.find((entry: { id: number }) => entry.id === sent.json().id)
    assert.deepEqual([mail.type, mail.type_id, mail.number], [13, 1000, 1])

    const received = await post(player, "mail/receive", { api_count: 2, mail_id: mail.id })
    assert.equal(received.total_count, 0)
    assert.ok((await degreeIds(player)).includes(1000))
})

test("\"Level a unit to 100 and obtain their Amity Scroll\" needs both", async () => {
    const player = await newPlayer()
    const { givePlayerCharacterSync } = await import("../src/lib/character")
    const now = new Date("2025-01-03T12:00:00Z")
    // degree 111001: Vagner (111001), target 2
    givePlayerCharacterSync(player.playerId, 111001)
    data.updatePlayerCharacterSync(player.playerId, 111001, { exp: 400000 })
    const levelOnly = missions.updateMissionsSync(player.playerId, now, missions.collectionUpdatesSync(player.playerId))
    assert.ok(!missions.grantedDegreeIds(levelOnly).includes(111001))
    assert.equal(data.getPlayerMissionsSync(player.playerId, DEGREE).find(mission => mission.missionId === 111001)?.progress, 1)

    data.updatePlayerCharacterBondTokenSync(player.playerId, 111001, { manaBoardIndex: 1, status: 2 })
    const both = missions.updateMissionsSync(player.playerId, now, missions.collectionUpdatesSync(player.playerId))
    assert.deepEqual(missions.grantedDegreeIds(both), [111001])
    assert.ok((await degreeIds(player)).includes(111001))
})

test("\"Clear a solo battle in under N seconds\" checks the stage's time limit", async () => {
    const player = await newPlayer()
    const { QuestCategory } = await import("../src/lib/types")
    const now = new Date("2025-01-03T12:00:00Z")
    const clear = { category: QuestCategory.MAIN, questId: 1001002, multi: null, clearRank: 5, clearTimeMs: 8000, score: 0, fieldMana: 0, statistics: {} }
    // degrees 15000, 15010 and 15020: under 60, 10 and 5 seconds
    const result = missions.updateMissionsSync(player.playerId, now, missions.battleClearUpdates(player.playerId, clear, 1))
    const titles = missions.grantedDegreeIds(result)
    assert.ok(titles.includes(15000) && titles.includes(15010))
    assert.ok(!titles.includes(15020))
    // co-op clears don't count
    const coop = missions.updateMissionsSync(player.playerId, now, missions.battleClearUpdates(player.playerId, { ...clear, clearTimeMs: 1000, multi: { host: true } }, 1))
    assert.ok(!missions.grantedDegreeIds(coop).includes(15020))
})
