// FT-25: stamina. A battle start takes the quest's cost (lowered by an open stamina campaign), an abort gives it back,
// stamina refills one point per recovery period up to the rank's max, a rank-up adds a full bar, and beads and stamina
// items add to it up to the overflow cap (result code 2102 there).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const MAIN = 1
// chapter 1's second quest: 6 stamina, 3 rank points
const QUEST = 1001002
const COST = 6
// no stamina campaign covers main quests then
const DATE = "2023-03-01T03:00:00Z"
// "once" campaign 10000042 (2024-11-08 to 12-17, Japan time): every main quest at 25 %
const CAMPAIGN_DATE = "2024-11-20T03:00:00Z"
const STAMINADE_FLASK = 102

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let stamina: typeof import("../src/lib/stamina")

before(async () => {
    process.env.STAMINA = "on";
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    stamina = await import("../src/lib/stamina")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

async function setClock(date: string | Date) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { statusCode: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.body }
}

async function newPlayer(staminaValue: number): Promise<TestPlayer & { playerId: number }> {
    await setClock(DATE)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, stamina: staminaValue, staminaHealTime: new Date(DATE) })
    return { ...player, playerId }
}

const start = (player: TestPlayer) => post(player, "single_battle_quest/start", {
    quest_id: QUEST, category: MAIN, party_id: 1,
    use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
})

async function load(player: TestPlayer) {
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.statusCode, 200)
    return response.body.data.user_info as { stamina: number, stamina_heal_time: number }
}

test("the quest cost, the campaign rate and the quests without a refund", () => {
    assert.equal(stamina.questStaminaCost(MAIN, QUEST, COST, new Date(DATE)), COST)
    assert.equal(stamina.questStaminaCost(MAIN, QUEST, COST, new Date(CAMPAIGN_DATE)), 1, "25 % of 6, at least 1")
    assert.equal(stamina.questStaminaCost(MAIN, QUEST, 0, new Date(CAMPAIGN_DATE)), 0)
    assert.equal(stamina.refundsStamina(MAIN, QUEST), true)
    // battle_no_stamina_return: story event 200001's first quest
    assert.equal(stamina.refundsStamina(10 /* STORY_EVENT_SINGLE */, 200001001), false)
    assert.equal(stamina.staminaCostsEnabled("off"), false)
})

test("stamina refills a point per period up to the rank's max, and stays above it", () => {
    const healTime = new Date(DATE)
    const step = stamina.staminaRecoveryMs(1)
    assert.equal(step, 360_000)
    const later = (ms: number) => new Date(healTime.getTime() + ms)
    const partway = stamina.currentStamina({ stamina: 5, healTime }, 1, later(2 * step + 1000))
    assert.equal(partway.stamina, 7)
    assert.equal(partway.healTime.getTime(), later(2 * step).getTime(), "the point under way stays under way")
    assert.equal(stamina.currentStamina({ stamina: 5, healTime }, 1, later(100 * step)).stamina, stamina.maxStamina(1))
    assert.equal(stamina.currentStamina({ stamina: 50, healTime }, 1, later(100 * step)).stamina, 50)
    assert.equal(stamina.staminaRecoveryMs(100), Math.floor(360 * (1 - 0.22)) * 1000, "higher ranks refill faster")
})

test("a start takes the cost, an abort gives it back, too little stamina is refused", async () => {
    const player = await newPlayer(10)
    const started = await start(player)
    assert.equal(started.statusCode, 200, String(started.body))
    assert.equal(started.body.data.user_info.stamina, 10 - COST)

    const aborted = await post(player, "single_battle_quest/abort", { quest_id: QUEST, category: MAIN, api_count: 2, play_id: "test", finish_kind: 1 })
    assert.equal(aborted.statusCode, 200)
    assert.equal(aborted.body.data.user_info.stamina, 10)
    assert.equal((await load(player)).stamina, 10)

    data.updatePlayerSync({ id: player.playerId, stamina: COST - 1, staminaHealTime: new Date(DATE) })
    assert.equal((await start(player)).statusCode, 400)
    // a recovery period later the point is back
    await setClock(new Date(new Date(DATE).getTime() + 360_000))
    assert.equal((await load(player)).stamina, COST)
    assert.equal((await start(player)).statusCode, 200)
})

test("a stamina campaign lowers the cost", async () => {
    const player = await newPlayer(10)
    await setClock(CAMPAIGN_DATE)
    data.updatePlayerSync({ id: player.playerId, stamina: 10, staminaHealTime: new Date(CAMPAIGN_DATE) })
    const started = await start(player)
    assert.equal(started.statusCode, 200)
    assert.equal(started.body.data.user_info.stamina, 9)
})

const finish = (player: TestPlayer) => post(player, "single_battle_quest/finish", {
    quest_id: QUEST, category: MAIN, score: 1000, add_mana: 0, elapsed_time_ms: 100_000,
    is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
    statistics: { party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] } }
})

test("a finish counts the stamina used, and a rank-up refills it", async () => {
    const player = await newPlayer(COST)
    data.updatePlayerSync({ id: player.playerId, rankPoint: 9 })
    assert.equal((await start(player)).statusCode, 200)
    const finished = await finish(player)
    assert.equal(finished.statusCode, 200, String(finished.body))
    assert.equal(finished.body.data.user_info.stamina, stamina.maxStamina(2), "rank 2's max")

    // "Use up N stamina" (pattern 36): the regular title missions 52000-52020
    const degree = data.getPlayerMissionsSync(player.playerId, 5).find(mission => mission.missionId === 52000)
    assert.equal(degree?.progress, COST)
})

test("a rank-up adds the new rank's max to what is left, up to the overflow cap", async () => {
    // 10 left after the start: rank 1 to 2 (9 + 3 rank points) adds rank 2's 20
    const player = await newPlayer(COST + 10)
    data.updatePlayerSync({ id: player.playerId, rankPoint: 9 })
    assert.equal((await start(player)).statusCode, 200)
    const finished = await finish(player)
    assert.equal(finished.statusCode, 200, String(finished.body))
    assert.equal(finished.body.data.user_info.stamina, 10 + stamina.maxStamina(2))
    assert.equal(data.getPlayerSync(player.playerId)?.stamina, 10 + stamina.maxStamina(2))

    // near the cap: 990 + 20 stops at 999
    const full = await newPlayer(990 + COST)
    data.updatePlayerSync({ id: full.playerId, rankPoint: 9 })
    assert.equal((await start(full)).statusCode, 200)
    assert.equal((await finish(full)).body.data.user_info.stamina, 999)

    // no rank-up: nothing added
    const same = await newPlayer(COST + 10)
    assert.equal((await start(same)).statusCode, 200)
    assert.equal((await finish(same)).body.data.user_info.stamina, 10)
})

test("a rank-up over several ranks adds one bar of the rank reached, and regeneration restarts", async () => {
    const player = await newPlayer(5)
    const now = new Date(Date.parse(DATE) + 60 * 60_000)
    // an hour at rank 1 brings back 10 points (one per 360 s) before the bar is added
    const next = stamina.refillStaminaOnRankUpSync(player.playerId, 1, 5, now)
    assert.deepEqual(next, { stamina: 5 + 10 + stamina.maxStamina(5), healTime: now })
    assert.equal(data.getPlayerSync(player.playerId)?.stamina, 5 + 10 + stamina.maxStamina(5))
    assert.equal(stamina.refillStaminaOnRankUpSync(player.playerId, 5, 5, now), null, "same rank")
    assert.equal(stamina.refillStaminaOnRankUpSync(player.playerId, 6, 5, now), null, "lower rank")
})

test("beads refill 100 stamina for 50, refused at the overflow cap", async () => {
    const player = await newPlayer(10)
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 30, vmoney: 100 })
    const refilled = await post(player, "shop/recover_stamina", {})
    assert.equal(refilled.statusCode, 200)
    assert.deepEqual(
        [refilled.body.data.user_info.stamina, refilled.body.data.user_info.free_vmoney, refilled.body.data.user_info.vmoney],
        [110, 0, 80], "free beads first"
    )

    data.updatePlayerSync({ id: player.playerId, stamina: 999 })
    const capped = await post(player, "shop/recover_stamina", {})
    assert.equal(capped.body.data_headers.result_code, stamina.ALREADY_STAMINA_MAX)
    assert.equal(data.getPlayerSync(player.playerId)?.vmoney, 80, "nothing spent")
})

test("stamina items add their stamina and are used up", async () => {
    const player = await newPlayer(10)
    data.givePlayerItemSync(player.playerId, STAMINADE_FLASK, 3)
    const used = await post(player, "item/use_item", { items: [{ id: STAMINADE_FLASK, number: 2 }] })
    assert.equal(used.statusCode, 200)
    assert.equal(used.body.data.user_info.stamina, 110)
    assert.deepEqual(used.body.data.item_list, { [STAMINADE_FLASK]: 1 })

    assert.equal((await post(player, "item/use_item", { items: [{ id: STAMINADE_FLASK, number: 2 }] })).statusCode, 400, "only one left")
    assert.equal((await post(player, "item/use_item", { items: [{ id: 1, number: 1 }] })).statusCode, 400, "not a stamina item")
})
