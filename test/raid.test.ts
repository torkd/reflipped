// FT-12: raid events. One boss for the whole server: every clear adds its difficulty's kill weight, every full pool is
// a kill (the pool sized for a number of players, or the raid's participants); the kill tally rewards go to the
// players who fought, by mail, when they open the raid; each difficulty has its ranking by clears; the ranking band of
// the most-cleared difficulty pays once during the results announcement; the admin sets the pool on the Settings page.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import raidEvents from "../assets/raid_event.json";
import overallRewards from "../assets/raid_event_overall_reward.json";
import rankingRewards from "../assets/raid_event_ranking_reward.json";

const apiPrefix = "/latest/api/index.php"
const RAID = 23
// Sagas of Conquest 1: battles 2023-07-25 to 08-13, results announced 08-15 14:00 to 08-21 05:00 (Japan time)
const EVENT = 1
const HELL = 1004, NOVICE = 1001
const DURING = "2023-08-01T03:00:00Z"
const RESULTS = "2023-08-17T03:00:00Z"
const POOL = Math.round((raidEvents as Record<string, { bossHp: number }>)["1"].bossHp / 30_000)
const tiers = (overallRewards as Record<string, { tiers: { kills: number, reasonId: number, rewards: unknown[] }[] }>)["1"].tiers

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let raid: typeof import("../src/lib/raid")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    raid = await import("../src/lib/raid")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    const { default: getDatabase, Database } = await import("../src/data/index")
    getDatabase(Database.WDFP_DATA).prepare(`DELETE FROM players_raid_records`).run()
    getDatabase(Database.WDFP_DATA).prepare(`DELETE FROM players_raid_state`).run()
    raid.setRaidHpPolicy({ mode: "fixed", players: 1 })
})

after(async () => {
    await cleanup()
})

async function setClock(date: string) {
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
    await setClock(DURING)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

async function battle(player: TestPlayer, questId: number, score: number, options: { accomplished?: boolean, auto?: boolean } = {}) {
    await setClock(DURING)
    const parties = await post(player, "event/raid/party", {})
    assert.equal(parties.statusCode, 200, parties.body)
    const groupId = decodeGameBody(parties.body).data.user_party_group_list[0].party_group_id
    const started = await post(player, "event/raid/battle/start", {
        quest_id: questId, party_group_id: groupId, play_id: "test", use_auto_start_point: options.auto === true, is_auto_start_mode: options.auto === true
    })
    if (started.statusCode !== 200) return { started }
    const finished = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category: RAID, score, add_mana: 0, elapsed_time_ms: 60_000,
        is_accomplished: options.accomplished ?? true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(finished.statusCode, 200, finished.body)
    return { started, finished: decodeGameBody(finished.body).data }
}

/** Adds kills straight to a record (many clears at once). */
function addKills(playerId: number, questId: number, kills: number, highScore = 0) {
    const current = data.getPlayerRaidRecordsSync(playerId, EVENT).find(record => record.questId === questId)
    data.setPlayerRaidRecordSync(playerId, EVENT, { questId, killCount: (current?.killCount ?? 0) + kills, highScore: Math.max(highScore, current?.highScore ?? 0), party: current?.party ?? [] })
}

test("a raid battle is a kill of the server's boss, sent back in raid_event", async () => {
    const player = await newPlayer()
    const { finished } = await battle(player, HELL, 5000)
    assert.equal(finished.raid_event.quest_boss.kill_count, 1)
    assert.equal(finished.raid_event.is_out_of_period, false)
    assert.equal(finished.raid_event.raid_boss.total_kill_count, 0)
    assert.equal(finished.raid_event.raid_boss.hp_percentage, Math.round(10000 * (1 - 230 / POOL)) / 100)
    assert.equal(finished.raid_event.auto_start_point, 10)

    // a lost battle keeps its score but is no kill
    const lost = await battle(player, HELL, 9000, { accomplished: false })
    assert.equal(lost.finished.raid_event.quest_boss.kill_count, 1)
    assert.equal(data.getPlayerRaidRecordsSync(player.playerId, EVENT)[0].highScore, 9000)

    // auto-battles: ten a day
    for (let count = 0; count < 10; count++) assert.equal((await battle(player, NOVICE, 1, { auto: true })).started.statusCode, 200)
    assert.equal((await battle(player, NOVICE, 1, { auto: true })).started.statusCode, 400)

    // after the battles: no start
    await setClock("2023-08-14T03:00:00Z")
    const late = await post(player, "event/raid/battle/start", { quest_id: HELL, party_group_id: 1, play_id: "test", use_auto_start_point: false, is_auto_start_mode: false })
    assert.equal(late.statusCode, 400)
})

test("the tally rewards go to the players who fought, as the server's kills reach them", async () => {
    const fighter = await newPlayer(), other = await newPlayer(), idle = await newPlayer()
    // enough clears between the two fighters for 3 kills
    const clears = Math.ceil(3 * POOL / 230)
    addKills(fighter.playerId, HELL, clears - 1)
    addKills(other.playerId, HELL, 1)

    await setClock(DURING)
    const summary = decodeGameBody((await post(fighter, "event/raid/summary", { event_id: EVENT })).body).data
    assert.equal(summary.raid_boss.total_kill_count, 3)
    assert.equal(summary.kill_count_reward_data.received_up_to, 3)
    const reached = tiers.filter(tier => tier.kills <= 3)
    assert.equal(plain(summary.kill_count_reward_data.reward_list).length, reached.reduce((sum, tier) => sum + tier.rewards.length, 0))
    // the client's reward dialog reads kind as a mail type: tier 1's item (GeneralRewardKind 0) is 1, its beads (2) are 4
    assert.deepEqual(plain(summary.kill_count_reward_data.reward_list).slice(0, 2).map((reward: { kind: number }) => reward.kind), [1, 4])
    const reasons = (playerId: number) => data.getPlayerAllMailSync(playerId).filter(mail => reached.some(tier => tier.reasonId === mail.reasonId)).length
    assert.equal(reasons(fighter.playerId), reached.reduce((sum, tier) => sum + tier.rewards.length, 0))
    assert.equal(plain(summary.quest_list)[String(HELL)].kill_count, clears - 1)

    // again: nothing new
    const again = decodeGameBody((await post(fighter, "event/raid/summary", { event_id: EVENT })).body).data
    assert.deepEqual(plain(again.kill_count_reward_data.reward_list), [])

    // a player who never fought gets none
    const idleSummary = decodeGameBody((await post(idle, "event/raid/summary", { event_id: EVENT })).body).data
    assert.equal(idleSummary.kill_count_reward_data.received_up_to, 0)
    assert.equal(reasons(idle.playerId), 0)
})

test("the pool: fixed for a number of players, or the raid's participants", async () => {
    raid.setRaidHpPolicy({ mode: "fixed", players: 4 })
    assert.equal(raid.raidPoolSize(EVENT, 1), 4 * POOL)
    raid.setRaidHpPolicy({ mode: "automatic", players: 4 })
    assert.equal(raid.raidPoolSize(EVENT, 0), POOL)
    assert.equal(raid.raidPoolSize(EVENT, 3), 3 * POOL)

    // the admin's settings
    const saved = await admin.inject({ method: "POST", url: "/api/server/raids", payload: { raidHpMode: "fixed", raidHpPlayers: 12 } })
    assert.equal(saved.statusCode, 302, saved.body)
    assert.deepEqual(raid.getRaidHpPolicy(), { mode: "fixed", players: 12 })
    const page = await admin.inject({ method: "GET", url: "/settings" })
    assert.match(page.body, /Raid boss HP sized for/)
    assert.match(page.body, /players active this week/)
    const invalid = await admin.inject({ method: "POST", url: "/api/server/raids", payload: { raidHpMode: "fixed", raidHpPlayers: 0 } })
    assert.equal(invalid.statusCode, 400)
    assert.deepEqual(raid.getRaidHpPolicy(), { mode: "fixed", players: 12 })
})

test("each difficulty's ranking by clears, its parties, and the ranking reward of the most-cleared difficulty", async () => {
    const first = await newPlayer(), second = await newPlayer(), absent = await newPlayer()
    await battle(first, HELL, 100)
    addKills(first.playerId, HELL, 4)
    addKills(second.playerId, HELL, 2, 999_999)
    addKills(second.playerId, NOVICE, 1)

    await setClock(DURING)
    const ranking = decodeGameBody((await post(first, "event/raid/ranking", { event_id: EVENT })).body).data
    const hell = plain(ranking.quest_list)[String(HELL)]
    assert.deepEqual(hell.ranking_list.map((entry: { kill_count: number, rank_number: number }) => [entry.kill_count, entry.rank_number]), [[5, 1], [2, 2]], "clears, not score")
    assert.equal(hell.my_data.rank_number, 1)
    assert.equal(plain(ranking.quest_list)[String(NOVICE)].my_data, null)

    // the party group of rank 1 on Hell: the group the best score was set with
    const party = decodeGameBody((await post(second, "event/raid/ranking/party", { quest_id: HELL, rank_number: 1, aggregated_time: "" })).body).data
    assert.ok(party.raid_ranking_party.length > 0)

    // before the announcement: out of the receivable period
    const early = await post(first, "event/raid/ranking_reward", { event_id: EVENT })
    assert.equal(decodeGameBody(early.body).data_headers.result_code, 5003)

    await setClock(RESULTS)
    const band = (rankingRewards as Record<string, Record<string, { from: number, to: number, reasonId: number, rewards: unknown[] }[]>>)["1"][String(HELL)][0]
    const received = decodeGameBody((await post(first, "event/raid/ranking_reward", { event_id: EVENT })).body).data
    assert.equal(received.status, 1)
    assert.equal(received.reward_list.length, band.rewards.length)
    assert.equal(plain(received.reward_list)[0].kind, 13, "a title band is sent as mail type 13, not GeneralRewardKind 6")
    assert.equal(data.getPlayerAllMailSync(first.playerId).filter(mail => mail.reasonId === band.reasonId).length, band.rewards.length)
    assert.equal(decodeGameBody((await post(first, "event/raid/ranking_reward", { event_id: EVENT })).body).data.status, 2)
    assert.equal(decodeGameBody((await post(absent, "event/raid/ranking_reward", { event_id: EVENT })).body).data.status, 3)
})

test("setting up a raid set's parties counts the Main and Sub missions", async () => {
    const player = await newPlayer()
    // raid 4's missions (2025-05-12 to 05-18): 400054-400056 are Main, Sub 1, Sub 2
    await setClock("2025-05-14T03:00:00Z")
    const edit = (partyId: number) => post(player, "party/edit", {
        main_party_id: 1, api_count: 1,
        party_info_list: [{
            party_category: 3, party_name: "Raid", party_id: partyId,
            unison_character_ids: [null, null, null], equipment_ids: [null, null, null], character_ids: [111001, null, null],
            ability_soul_ids: [null, null, null], options: { allow_other_players_to_heal_me: true }
        }]
    })
    assert.equal((await edit(1)).statusCode, 200)
    assert.equal((await edit(5)).statusCode, 200)
    const missions = new Map(data.getPlayerMissionsSync(player.playerId, 3).map(mission => [mission.missionId, mission]))
    const done = (missionId: number) => (missions.get(missionId)?.progress ?? 0) > 0 || (missions.get(missionId)?.clearedStage ?? 0) > 0
    assert.deepEqual([400054, 400055, 400056].map(done), [true, true, false])
})
