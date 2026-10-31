// FT-2: missions. The server counts progress (battle clears, story reads, login days, the patterns the client
// reports), clears stages, mails their rewards (reason 60) and lists progress for the mission screen.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";
import mainQuests from "../assets/main_quest.json";

const apiPrefix = "/latest/api/index.php"
// the default clock's day: daily missions 6-11 are open
const DEFAULT_CLOCK = "2025-01-03T12:00:00Z"
const MAIN = 1
const STORY_EVENT_SINGLE = 10
const REGULAR = 1
const DAILY = 2
const MISSION_REWARD_REASON = 60

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let missions: typeof import("../src/lib/missions")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
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

async function setClock(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

/** A new player (signed up and loaded once, so the day's resets ran) and its player id. */
async function newPlayer(date = DEFAULT_CLOCK): Promise<TestPlayer & { playerId: number }> {
    await setClock(date)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const result = { ...player, playerId }
    await post(result, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    return result
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

const emptyParty = { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }

/** Plays a story event quest through start and finish (cleared, slower than every rank time). */
async function clearBattle(player: TestPlayer, zone: Record<string, number> = {}) {
    const questId = 100002007
    await post(player, "single_battle_quest/start", {
        quest_id: questId, category: STORY_EVENT_SINGLE, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    return await post(player, "single_battle_quest/finish", {
        quest_id: questId, category: STORY_EVENT_SINGLE, score: 1000, add_mana: 0, elapsed_time_ms: 700000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: { clear_phase: 0, party: emptyParty, max_combo_count: 5, zones: [zone] }
    })
}

async function missionProgress(player: TestPlayer, categories: number[]) {
    const reply = await post(player, "mission/get_mission_progress", { api_count: 1, category_list: categories.map(category => ({ category })) })
    return reply.mission_progress_list as { mission_category: number, mission_id: number, progress_value: number, stage: number }[]
}

async function mails(player: TestPlayer) {
    const reply = await post(player, "mail/index", { api_count: 1, current_page: 1 })
    return reply.mail as { type: number, type_id: number | null, number: number, reason_id: number }[]
}

test("the mission screen lists the open daily and regular missions with their progress", async () => {
    const player = await newPlayer()
    const list = await missionProgress(player, [2, 1, 3])

    const daily = list.filter(entry => entry.mission_category === DAILY).map(entry => entry.mission_id)
    assert.deepEqual(daily.sort((a, b) => a - b), [6, 7, 8, 9, 10, 11])
    assert.ok(list.some(entry => entry.mission_category === REGULAR && entry.mission_id === 6))
    // no event mission is open on the default clock
    assert.ok(!list.some(entry => entry.mission_category === 3))
    assert.deepEqual(list.find(entry => entry.mission_category === DAILY && entry.mission_id === 6), { mission_category: DAILY, mission_id: 6, progress_value: 0, stage: 1 })
    // the first load counted a login day ("Log in for a total of ::x_count:: days": stage 1 needs 2)
    const loginDays = list.find(entry => entry.mission_category === REGULAR && entry.mission_id === 24)!
    assert.equal(loginDays.progress_value, 1)
    assert.equal(loginDays.stage, 1)
})

test("solo battle clears count, clear the stage and mail its reward", async () => {
    const player = await newPlayer()
    // daily 6: "Clear 3 solo battles" (15 beads); daily 9: "Dash 10 times" (1500 mana)
    const first = await clearBattle(player, { use_dash_count: 4 })
    assert.ok(!first.mission_info.some((info: { mission_category_id: number }) => info.mission_category_id === DAILY))
    await clearBattle(player, { use_dash_count: 4 })
    const third = await clearBattle(player, { use_dash_count: 4 })

    const dailyCleared = third.mission_info.filter((info: { mission_category_id: number }) => info.mission_category_id === DAILY)
    assert.deepEqual(dailyCleared, [
        { mission_category_id: DAILY, mission_id: 6, mission_reward_id: 6001 },
        { mission_category_id: DAILY, mission_id: 9, mission_reward_id: 9001 }
    ])
    assert.equal(third.mail_arrived, true)

    const rewardMails = (await mails(player)).filter(mail => mail.reason_id === MISSION_REWARD_REASON)
    assert.ok(rewardMails.some(mail => mail.type === 4 && mail.number === 15), "15 free beads")
    assert.ok(rewardMails.some(mail => mail.type === 8 && mail.number === 1500), "1500 mana")

    const daily = (await missionProgress(player, [DAILY])).filter(entry => [6, 9].includes(entry.mission_id))
    assert.deepEqual(daily.map(entry => [entry.mission_id, entry.progress_value, entry.stage]), [[6, 3, 1], [9, 12, 1]])
    // a cleared stage isn't paid twice
    const fourth = await clearBattle(player, { use_dash_count: 4 })
    assert.ok(!fourth.mission_info.some((info: { mission_category_id: number }) => info.mission_category_id === DAILY))
})

test("a failed battle counts nothing", async () => {
    const player = await newPlayer()
    const questId = 100002007
    await post(player, "single_battle_quest/start", {
        quest_id: questId, category: STORY_EVENT_SINGLE, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    const result = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category: STORY_EVENT_SINGLE, score: 1000, add_mana: 0, elapsed_time_ms: 700000,
        is_accomplished: false, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: { clear_phase: 0, party: emptyParty, zones: [{ use_dash_count: 50 }] }
    })
    assert.deepEqual(result.mission_info, [])
    assert.deepEqual(data.getPlayerMissionsSync(player.playerId, DAILY), [])
})

test("daily missions start over on a new game day", async () => {
    const player = await newPlayer()
    await clearBattle(player)
    assert.equal((await missionProgress(player, [DAILY])).find(entry => entry.mission_id === 6)!.progress_value, 1)

    // 20:00 UTC is 05:00 in Japan: the next /load resets them
    await setClock("2025-01-03T20:00:00Z")
    await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal((await missionProgress(player, [DAILY])).find(entry => entry.mission_id === 6)!.progress_value, 0)
    // and the new day is a second login day, which clears the login days' first stage
    const loginDays = (await missionProgress(player, [REGULAR])).find(entry => entry.mission_id === 24)!
    assert.deepEqual([loginDays.progress_value, loginDays.stage], [2, 2])
    assert.equal(data.getPlayerClearedRegularMissionListSync(player.playerId)["24"], 1)
})

test("\"clear all daily missions\" follows the missions it lists", async () => {
    const player = await newPlayer()
    const now = new Date(DEFAULT_CLOCK)
    // daily 10 needs 6, 7, 8 and 9; complete them directly
    for (const missionId of [6, 7, 8]) {
        const mission = missions.getMission(missions.MissionCategory.DAILY, missionId)!
        data.setPlayerMissionSync(player.playerId, DAILY, { missionId, progress: mission.stages[0].target, clearedStage: 1 })
    }
    const cleared = missions.updateMissionsSync(player.playerId, now, [{ pattern: missions.MissionPattern.BATTLE_ZONE_STATISTICS_COUNT, amount: 10, matches: mission => mission.statistics === 2 }]).missionInfo
    assert.ok(cleared.some(info => info.mission_id === 9))
    assert.ok(cleared.some(info => info.mission_id === 10 && info.mission_reward_id === 10001))
})

test("the client reports only the patterns it counts itself", async () => {
    // regular 107 ("twitter_check", 300 beads) was open for a day in 2016
    const player = await newPlayer("2016-10-26T12:00:00Z")
    const ignored = await post(player, "mission/update_mission_progress", { api_count: 1, mission_param_list: [{ mission_pattern: "single_battle_clear_count", progress_value: 99 }] })
    assert.deepEqual(ignored.mission_info, [])

    const reported = await post(player, "mission/update_mission_progress", { api_count: 1, mission_param_list: [{ mission_pattern: "twitter_check", progress_value: 1 }] })
    assert.deepEqual(reported.mission_info, [{ mission_category_id: REGULAR, mission_id: 107, mission_reward_id: 107001 }])
    assert.deepEqual(reported.degree_list, [])
    assert.equal(data.getPlayerClearedRegularMissionListSync(player.playerId)["107"], 1)
})

test("reading the last quest of a chapter clears the chapter mission", async () => {
    const player = await newPlayer()
    // regular 10: "Clear Chapter 1"; mark every chapter 1 quest but the first story quest as cleared
    const chapterQuestIds = Object.keys(mainQuests).map(Number).filter(id => Math.floor(id / 1000000) === 1)
    for (const questId of chapterQuestIds.filter(id => id !== 1001001)) data.insertPlayerQuestProgressSync(player.playerId, MAIN, { questId, finished: true })

    const result = await post(player, "story_quest/finish", { quest_id: 1001001, category: MAIN, party_id: 1, api_count: 1 })
    assert.ok(result.mission_info.some((info: { mission_id: number, mission_category_id: number }) => info.mission_category_id === REGULAR && info.mission_id === 10))

    const loaded = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(loaded.cleared_regular_mission_list["10"], 1)
})

test("quest filters match by chapter, stage and quest, or by event and quest", async () => {
    const { QuestCategory } = await import("../src/lib/types")
    // regular 42: chapter 1, stage 4, quest 2 (1004002)
    const boss = missions.getMission(missions.MissionCategory.REGULAR, 42)!
    assert.equal(missions.missionMatchesQuest(boss, QuestCategory.MAIN, 1004002), true)
    assert.equal(missions.missionMatchesQuest(boss, QuestCategory.MAIN, 1004001), false)
    assert.equal(missions.missionMatchesQuest(boss, QuestCategory.EX, 1004002), false)
    // daily 11: any quest of score attack event 1
    const scoreAttack = missions.getMission(missions.MissionCategory.DAILY, 11)!
    assert.equal(missions.missionMatchesQuest(scoreAttack, QuestCategory.SCORE_ATTACK_EVENT, 1003), true)
    assert.equal(missions.missionMatchesQuest(scoreAttack, QuestCategory.SCORE_ATTACK_EVENT, 2001), false)
    // daily 7: any daily content (Kaleidoscope)
    const kaleido = missions.getMission(missions.MissionCategory.DAILY, 7)!
    assert.equal(missions.missionMatchesQuest(kaleido, QuestCategory.DAILY_WEEK_EVENT, 1001), true)
    assert.equal(missions.missionMatchesQuest(kaleido, QuestCategory.MAIN, 1001002), false)
})

test("a stage whose rewards don't fit in the gift box waits until there is room", async () => {
    const player = await newPlayer()
    const { mailLimits } = await import("../src/lib/limits")
    const { MailType } = await import("../src/data/types")
    const now = new Date(DEFAULT_CLOCK)
    const fill = mailLimits.pendingMails - data.getPlayerReceivableMailCountSync(player.playerId, now)
    const fillerIds: number[] = []
    for (let i = 0; i < fill; i++) {
        fillerIds.push(data.insertPlayerMailSync(player.playerId, { type: MailType.FREE_MANA, typeId: null, number: 1, reasonId: 0, subject: "x", description: "x", createTime: now, receiveTime: null, rewardLimitTime: null }))
    }

    await clearBattle(player)
    await clearBattle(player)
    const third = await clearBattle(player)
    assert.ok(!third.mission_info.some((info: { mission_id: number, mission_category_id: number }) => info.mission_category_id === DAILY && info.mission_id === 6))
    assert.equal((await missionProgress(player, [DAILY])).find(entry => entry.mission_id === 6)!.stage, 1)

    // one mail received: the mission list clears the waiting stage
    data.setPlayerMailReceivedSync(player.playerId, fillerIds[0], now)
    const reply = await post(player, "mission/get_mission_progress", { api_count: 1, category_list: [{ category: DAILY }] })
    assert.equal(reply.mail_arrived, true)
    assert.deepEqual(data.getPlayerMissionsSync(player.playerId, DAILY).find(mission => mission.missionId === 6), { missionId: 6, progress: 3, clearedStage: 1 })
})

// Step Up Missions (active missions): cleared stages wait in all_active_mission_list until active_mission/receive

type ActiveMissionEntry = { mission_id: number, progress_value: number, stages: { stage: number, received: boolean }[] }

function activeEntry(reply: { active_mission_list?: ActiveMissionEntry[] }, missionId: number) {
    return reply.active_mission_list?.find(entry => entry.mission_id === missionId)
}

test("Step Up stages clear unreceived and active_mission/receive grants their rewards", async () => {
    const player = await newPlayer()
    data.updatePlayerSync({ id: player.playerId, expPool: 20000 })
    // 11090: "Give a unit experience" (1000 pooled exp); 12030: "Raise a unit to level 40" (3000 pooled exp)
    const injected = await post(player, "expod/inject_exp", { character_id: 1, exp: 12000, api_count: 1 })
    assert.deepEqual(activeEntry(injected, 11090), { mission_id: 11090, progress_value: 1, stages: [{ stage: 1, received: false }] })
    assert.equal(activeEntry(injected, 12030)!.progress_value, 40)
    assert.deepEqual(activeEntry(injected, 12030)!.stages, [{ stage: 1, received: false }])

    const loaded = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.deepEqual(loaded.all_active_mission_list["11090"], { progress: 1, stages: { "1": false } })

    const expPool = data.getPlayerSync(player.playerId)!.expPool
    const received = await post(player, "active_mission/receive", { api_count: 2, active_mission_list: [{ mission_id: 11090, stages: [1] }, { mission_id: 12030, stages: [1] }] })
    assert.deepEqual(received.active_mission_list.map((entry: ActiveMissionEntry) => [entry.mission_id, entry.stages]), [
        [11090, [{ stage: 1, received: true }]],
        [12030, [{ stage: 1, received: true }]]
    ])
    assert.equal(received.user_info.exp_pool, expPool + 4000)
    assert.equal(data.getPlayerSync(player.playerId)!.expPool, expPool + 4000)
    assert.deepEqual(data.getPlayerActiveMissionsSync(player.playerId)["11090"], { progress: 1, stages: { "1": true } })

    // a stage is received once, and a stage that isn't cleared can't be
    const again = await post(player, "active_mission/receive", { api_count: 3, active_mission_list: [{ mission_id: 11090, stages: [1] }, { mission_id: 11010, stages: [1] }] })
    assert.deepEqual(again.active_mission_list, [])
    assert.equal(data.getPlayerSync(player.playerId)!.expPool, expPool + 4000)
})

test("\"Clear all Rookie missions\" counts cleared missions, claimed or not", async () => {
    const player = await newPlayer()
    for (const missionId of [11010, 11020, 11030, 11040, 11050, 11060, 11070, 11080, 11100]) {
        data.setPlayerActiveMissionProgressSync(player.playerId, missionId, 1)
        data.setPlayerActiveMissionStageSync(player.playerId, missionId, 1, missionId % 20 === 0)
    }
    const result = missions.updateMissionsSync(player.playerId, new Date(DEFAULT_CLOCK), [{ pattern: missions.MissionPattern.INJECTED_EXP_FIRST_TIME, value: 1 }])
    assert.deepEqual(result.activeMissions.find(entry => entry.mission_id === 11110), { mission_id: 11110, progress_value: 10, stages: [{ stage: 1, received: false }] })

    const freeVmoney = data.getPlayerSync(player.playerId)!.freeVmoney
    const received = await post(player, "active_mission/receive", { api_count: 1, active_mission_list: [{ mission_id: 11110, stages: [1] }] })
    assert.equal(received.user_info.free_vmoney, freeVmoney + 300)

    // 11010 pays 5 of item 101
    const owned = data.getPlayerItemSync(player.playerId, 101) ?? 0
    const items = await post(player, "active_mission/receive", { api_count: 2, active_mission_list: [{ mission_id: 11010, stages: [1] }] })
    assert.deepEqual(items.item_list, { "101": owned + 5 })
    assert.equal(data.getPlayerItemSync(player.playerId, 101), owned + 5)
})

test("Step Up counts story reads, party edits and the units the player owns", async () => {
    const player = await newPlayer()
    // 11050: "Clear World 1 of the main quest" is chapter 1's last story quest
    const story = await post(player, "story_quest/finish", { quest_id: 1008004, category: MAIN, party_id: 1, api_count: 1 })
    assert.deepEqual(activeEntry(story, 11050)?.stages, [{ stage: 1, received: false }])

    // 11020: "Equip an armament"; 11040: "Set a unit as a Second"
    const { givePlayerEquipmentSync } = await import("../src/lib/equipment")
    givePlayerEquipmentSync(player.playerId, 2010002, 1)
    const body = readCapturedRoute("party_edit").requestBody as { party_info_list: Record<string, unknown>[] }
    const party = { ...body.party_info_list[0], character_ids: [1, null, null], unison_character_ids: [1, null, null], equipment_ids: [2010002, null, null] }
    const edited = await post(player, "party/edit", { ...body, party_info_list: [party] })
    assert.ok(activeEntry(edited, 11020), "armament equipped")
    assert.ok(activeEntry(edited, 11040), "Second set")
    // the same party again sets nothing new
    const again = await post(player, "party/edit", { ...body, party_info_list: [party] })
    assert.equal(again.active_mission_list, undefined)

    // 14080: "Have Murakumo join your team"
    const { givePlayerCharacterSync } = await import("../src/lib/character")
    givePlayerCharacterSync(player.playerId, 141003)
    const result = missions.updateMissionsSync(player.playerId, new Date(DEFAULT_CLOCK), missions.collectionUpdatesSync(player.playerId))
    assert.deepEqual(result.activeMissions.find(entry => entry.mission_id === 14080)?.stages, [{ stage: 1, received: false }])
})

test("unit levels come from the level table", () => {
    assert.equal(missions.characterLevel(0), 1)
    assert.equal(missions.characterLevel(11415), 39)
    assert.equal(missions.characterLevel(11416), 40)
    assert.equal(missions.characterLevel(10_000_000), 100)
})

test("a \"complete\" chapter mission needs every battle up to its last chapter at S+", async () => {
    const player = await newPlayer()
    const { QuestCategory } = await import("../src/lib/types")
    const now = new Date(DEFAULT_CLOCK)
    // 13090: main chapters 1-6, battles at S+ (rank 5) and stories read
    const quests = mainQuests as Record<string, { sPlusRankTime?: number }>
    const questIds = Object.keys(quests).map(Number).filter(id => Math.floor(id / 1000000) <= 6)
    const battleIds = questIds.filter(id => quests[id].sPlusRankTime !== undefined)
    for (const questId of questIds) {
        data.insertPlayerQuestProgressSync(player.playerId, MAIN, { questId, finished: true, ...(quests[questId].sPlusRankTime !== undefined ? { clearRank: questId === battleIds[0] ? 4 : 5 } : {}) })
    }
    const notYet = missions.updateMissionsSync(player.playerId, now, missions.chapterClearUpdates(player.playerId, QuestCategory.MAIN, battleIds[1]))
    assert.equal(notYet.activeMissions.find(entry => entry.mission_id === 13090), undefined)

    data.updatePlayerQuestProgressSync(player.playerId, MAIN, { questId: battleIds[0], clearRank: 5 })
    const complete = missions.updateMissionsSync(player.playerId, now, missions.chapterClearUpdates(player.playerId, QuestCategory.MAIN, battleIds[0]))
    assert.deepEqual(complete.activeMissions.find(entry => entry.mission_id === 13090)?.stages, [{ stage: 1, received: false }])
})
