import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

// SEC-18 phase 1: the finish rules (src/lib/anticheatRules.ts) one by one, against the captured finishes, then through
// the finish route: log records flags, enforce keeps the rewards and leaves the record off the board, and restricted
// players are off the shared boards unless anti-cheat is off.

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let anticheat: typeof import("../src/lib/anticheat")
let flags: typeof import("../src/data/anticheatData")
let rules: typeof import("../src/lib/anticheatRules")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    anticheat = await import("../src/lib/anticheat")
    flags = await import("../src/data/anticheatData")
    rules = await import("../src/lib/anticheatRules")
})
afterEach(async () => {
    anticheat.setAnticheatMode(null)
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})
after(async () => {
    await cleanup()
})

// ---- the rules, pure ----

const NOW = 1_800_000_000_000
const solo = () => structuredClone(readCapturedRoute("single_battle_quest_finish").requestBody)
const coop = () => structuredClone(readCapturedRoute("multi_battle_quest_finish").requestBody)
// the captured solo finish: a Treasure Zone quest (13), 20995 ms in one zone of 1235 frames, party 121153, 121087, 321011
const SOLO_PARTY = [121153, 121087, 321011]
const COOP_PARTY = [151165, 151129, 251035]

type Judgement = Parameters<typeof import("../src/lib/anticheatRules").judgeFinish>[0]
function judge(body: unknown, overrides: { wallMs?: number, start?: Partial<Judgement["start"]>, quest?: Partial<Judgement["quest"]> } = {}) {
    return rules.judgeFinish({
        start: { startedAtMs: NOW - (overrides.wallMs ?? 60_000), startParty: { characterIds: SOLO_PARTY }, continues: 0, coop: false, ...overrides.start },
        body,
        quest: { category: 13, timeLimitMs: 1_800_000, ...overrides.quest },
        nowMs: NOW,
        wallClockSlackMs: 10_000
    })
}
const names = (list: { rule: string, severity: string, details: Record<string, unknown> }[]) =>
    list.map(flag => flag.details.check === undefined ? `${flag.rule}:${flag.severity}` : `${flag.rule}/${flag.details.check}:${flag.severity}`).sort()

describe("the rules", () => {
    test("the captured finishes raise nothing", () => {
        assert.deepEqual(judge(solo()), [])
        assert.deepEqual(judge(coop(), { start: { coop: true, startParty: { characterIds: COOP_PARTY } }, quest: { category: 19, timeLimitMs: 900_000 } }), [])
    })

    test("R4: an isolated co-op finish below its zones' time is not flagged (emulator QA: 8 s after a stall)", () => {
        const body = coop()
        body.elapsed_time_ms = body.statistics.zones[0].playthrough_ms - 8_400
        const coopJudge = (b: unknown) => judge(b, { start: { coop: true, startParty: { characterIds: COOP_PARTY } }, quest: { category: 19, timeLimitMs: 900_000 } })
        assert.ok(names(coopJudge(body)).includes("consistency/elapsed-below-zones:soft"), "a connected player: soft")
        body.isolated = true
        assert.ok(!names(coopJudge(body)).some(name => name.includes("elapsed-below-zones")), "an isolated one: nothing")
    })

    test("R1: a clear time beyond real time at the top speed, restored or not", () => {
        const body = solo()
        body.elapsed_time_ms = 60_000
        body.statistics.zones[0].playthrough_ms = 60_000
        // 15 s real: 15000 × 3 × 1.05 + 1020 + 10000 = 58270 < 60000
        assert.ok(names(judge(body, { wallMs: 15_000 })).includes("wall-clock:hard"))
        assert.ok(!names(judge(body, { wallMs: 16_000 })).includes("wall-clock:hard"), "within the ceiling at 16 s")
        // Reflipped offers no resume, so a restored claim is judged like any finish, and noted (emulator QA 2026-11-14)
        body.is_restored = true
        assert.ok(names(judge(body, { wallMs: 15_000 })).includes("wall-clock:hard"), "a restored claim is no way around R1")
        assert.ok(names(judge(body, { wallMs: 16_000 })).includes("consistency/restored-claim:soft"))
    })

    test("R2: more frames than 180 a real second", () => {
        const body = solo()
        // 6 s real: 180 × 6 × 1.05 + 60 = 1194 frames at most; the capture has 1235
        assert.deepEqual(names(judge(body, { wallMs: 6_000 })), ["speed:hard"])
        assert.deepEqual(names(judge(body, { wallMs: 7_000 })), [])
        body.is_restored = true
        assert.deepEqual(names(judge(body, { wallMs: 6_000 })), ["consistency/restored-claim:soft", "speed:hard"], "nor around R2")
    })

    test("R3: a clear within seconds of the start", () => {
        const body = solo()
        body.elapsed_time_ms = 1000
        body.statistics.zones[0].playthrough_ms = 1020
        body.statistics.zones[0].playthrough_frame = 60
        assert.deepEqual(names(judge(body, { wallMs: 2_000 })), ["instant-finish:soft"])
        assert.deepEqual(names(judge(body, { wallMs: 6_000 })), [])
        // soft only: it acts on nothing in enforce mode (src/lib/anticheat.ts excludes on hard flags)
        assert.ok(judge(body, { wallMs: 2_000 }).every(flag => flag.severity === "soft"))
        body.is_accomplished = false
        assert.deepEqual(names(judge(body, { wallMs: 2_000 })), [], "only a claimed clear")
    })

    test("R4: the statistics agree with each other", () => {
        const frames = solo()
        frames.statistics.zones[0].playthrough_frame = 1236 // 17 × 1236 > 20995
        assert.deepEqual(names(judge(frames)), ["consistency/zone-frames:hard"])

        const damage = solo()
        damage.statistics.zones[0].damage_deal_max = 50_000
        damage.statistics.zones[0].boss_damage_deal_total = 50_000
        assert.deepEqual(names(judge(damage)), ["consistency/boss-damage:hard", "consistency/damage-max:hard"])

        const above = solo()
        above.elapsed_time_ms = 22_000
        assert.deepEqual(names(judge(above)), ["consistency/elapsed-above-zones:hard"])
        const below = solo()
        below.elapsed_time_ms = 19_000
        assert.deepEqual(names(judge(below)), ["consistency/elapsed-below-zones:hard"])
        assert.deepEqual(names(judge(below, { start: { coop: true } })), ["consistency/elapsed-below-zones:soft"], "co-op: the teammates' time may be lower")
        below.is_restored = true
        assert.ok(names(judge(below)).some(name => name.startsWith("consistency/elapsed-below-zones")), "nor around R4")

        const noZones = solo()
        delete noZones.statistics.zones
        assert.deepEqual(names(judge(noZones)), ["consistency/no-zones:soft"])

        // the capture has no boss damage: fine for its Treasure Zone quest, soft on a boss quest
        assert.deepEqual(names(judge(solo(), { quest: { category: 2 } })), ["consistency/no-boss-damage:soft"])
        assert.deepEqual(names(judge(solo(), { quest: { category: 2 }, start: { coop: true } })), [])
    })

    test("R5: the quest's time limit, one more per continue", () => {
        const body = solo()
        assert.deepEqual(names(judge(body, { quest: { timeLimitMs: 15_000 } })), ["time-limit:hard"])
        assert.deepEqual(names(judge(body, { quest: { timeLimitMs: 16_000 } })), [], "within the 5 s tolerance")
        assert.deepEqual(names(judge(body, { quest: { timeLimitMs: 15_000 }, start: { continues: 1 } })), [])
        assert.deepEqual(names(judge(body, { quest: { timeLimitMs: undefined } })), [])
    })

    test("R6: the units at the finish are the units the battle started with", () => {
        assert.deepEqual(names(judge(solo(), { start: { startParty: { characterIds: [121153, 121087, 999999] } } })), ["party-changed:hard"])
        assert.deepEqual(names(judge(solo(), { start: { startParty: { characterIds: [321011, 121153, 121087] } } })), [], "order isn't compared")
        assert.deepEqual(names(judge(solo(), { start: { startParty: null } })), [], "a fixed party isn't compared")
        const [flag] = judge(solo(), { start: { startParty: { characterIds: [121153, null, null] } } })
        assert.deepEqual(flag.details, { startCharacterIds: [121153], finishCharacterIds: [121087, 121153, 321011] })
    })

    test("an honest three-zone finish: each zone's figures are its own (0.0.81 bytecode), so nothing is flagged", () => {
        // per zone: frames counted from the zone's start, 17 ms each plus some real stalls; damage stats fresh per zone
        const zones = [
            { zone: 0, playthrough_frame: 1800, stallMs: 400, damage_deal_total: 80_000, damage_deal_max: 9_000, boss_damage_deal_total: 0 },
            { zone: 1, playthrough_frame: 2400, stallMs: 0, damage_deal_total: 120_000, damage_deal_max: 15_000, boss_damage_deal_total: 0 },
            { zone: 2, playthrough_frame: 3000, stallMs: 900, damage_deal_total: 400_000, damage_deal_max: 30_000, boss_damage_deal_total: 350_000 }
        ].map(({ stallMs, ...zone }) => ({ ...zone, playthrough_ms: zone.playthrough_frame * 17 + stallMs }))
        const elapsedMs = zones.reduce((total, zone) => total + zone.playthrough_ms, 0) // 123,700 ms
        const body = { ...solo(), elapsed_time_ms: elapsedMs, score: 3_000_000, statistics: { ...solo().statistics, zones } }
        // two and a half minutes of real time (the frames need 40 s at the top speed); a boss quest, 10 min limit
        assert.deepEqual(judge(body, { wallMs: 150_000, quest: { category: 2, timeLimitMs: 600_000 } }), [])
        // the clear time a little off the zones' sum (the zone changes) is within a second a zone
        assert.deepEqual(judge({ ...body, elapsed_time_ms: elapsedMs + 2_500 }, { wallMs: 150_000, quest: { category: 2, timeLimitMs: 600_000 } }), [])
    })

    test("a body of the wrong shape is judged without throwing", () => {
        assert.doesNotThrow(() => judge(null))
        assert.doesNotThrow(() => judge({ elapsed_time_ms: "fast", statistics: { zones: [null, 3, {}], party: { characters: "x" } } }))
    })
})

// ---- through the finish route ----

const apiPrefix = "/latest/api/index.php"
const RANKING = 11
const RANKING_EVENT = 2
const RANKING_QUEST = 2001
const DURING = "2022-07-01T03:00:00Z"

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return fastify.inject({ method: "POST", url: `${apiPrefix}/${route}`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId }) })
}

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(DURING))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

/** A start, then a finish whose zone agrees with its clear time. `honest` backdates the start by a minute. */
async function battle(player: TestPlayer & { playerId: number }, questId: number, category: number, elapsedMs: number, honest: boolean) {
    const started = await post(player, "single_battle_quest/start", { quest_id: questId, category, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "SEC18" })
    assert.equal(started.statusCode, 200, started.body)
    const { getActiveQuest } = await import("../src/routes/api/singleBattleQuest")
    const active = getActiveQuest(player.playerId) as { startedAtMs?: number, startParty?: unknown }
    if (honest) active.startedAtMs = Date.now() - 60_000
    const characters = (active.startParty as { characterIds: (number | null)[] } | null)?.characterIds ?? [null, null, null]
    const frames = Math.floor(elapsedMs / 17)
    const finished = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category, score: 1000, add_mana: 0, elapsed_time_ms: elapsedMs, is_accomplished: true,
        is_restored: false, continue_count: 0, api_count: 2, play_id: "SEC18",
        statistics: {
            clear_phase: 0,
            party: { characters: characters.map(id => id === null ? null : { id }), unison_characters: [null, null, null],
                equipments: [null, null, null], ability_soul_ids: [null, null, null] },
            zones: [{ zone: 0, playthrough_ms: elapsedMs, playthrough_frame: frames, damage_deal_total: 100, damage_deal_max: 10, boss_damage_deal_total: 0 }]
        }
    })
    assert.equal(finished.statusCode, 200, finished.body)
    return decodeGameBody(finished.body).data
}

async function rankingRecord(player: TestPlayer) {
    const response = await post(player, "ranking_event/get_summary", { ranking_event_id: RANKING_EVENT, quest_kind: 8 })
    assert.equal(response.statusCode, 200, response.body)
    return JSON.parse(JSON.stringify(decodeGameBody(response.body).data))
}

const ruleNames = (playerId: number) => flags.getPlayerAnticheatFlagsSync(playerId).map(flag => flag.rule).sort()

describe("the finish route", () => {
    test("an honest finish raises nothing", async () => {
        const player = await newPlayer()
        await battle(player, 1001002, 1, 30_000, true)
        assert.deepEqual(ruleNames(player.playerId), [])
    })

    test("log: an impossible ranking clear is flagged and still on the board", async () => {
        const player = await newPlayer()
        // a clear sent straight after the start, longer than real time allows and the quest's three minutes
        await battle(player, RANKING_QUEST, RANKING, 200_000, false)
        assert.deepEqual(ruleNames(player.playerId), ["instant-finish", "speed", "time-limit", "wall-clock"])
        const stored = flags.getPlayerAnticheatFlagsSync(player.playerId)
        assert.ok(stored.every(flag => flag.severity === (flag.rule === "instant-finish" ? "soft" : "hard")
            && flag.details.excluded === undefined && flag.route === "single_battle_quest/finish"))
        assert.deepEqual((await rankingRecord(player)).best_record, { elapsed_time_ms: 200_000, is_accomplished: true, score: 1000 })
    })

    test("enforce: the finish keeps its rewards, its record stays off the board, the flags say excluded", async () => {
        anticheat.setAnticheatMode("enforce")
        const ranked = await newPlayer()
        await battle(ranked, RANKING_QUEST, RANKING, 200_000, false)
        assert.deepEqual((await rankingRecord(ranked)).best_record, { elapsed_time_ms: 0, is_accomplished: false, score: 0 }, "no record")
        assert.ok(flags.getPlayerAnticheatFlagsSync(ranked.playerId).every(flag => flag.details.excluded === (flag.severity === "hard" ? true : undefined)))

        const rewarded = await newPlayer()
        const before = data.getPlayerSync(rewarded.playerId)!.rankPoint
        const reply = await battle(rewarded, 1001002, 1, 30_000, false)
        assert.ok(ruleNames(rewarded.playerId).includes("wall-clock"))
        assert.ok(reply.user_info.rank_point > before, "the quest's rank points are paid")
        assert.equal(data.getPlayerSync(rewarded.playerId)!.rankPoint, reply.user_info.rank_point)

        // an honest finish in enforce mode is on the board as usual
        const honest = await newPlayer()
        await battle(honest, RANKING_QUEST, RANKING, 100_000, true)
        assert.deepEqual(ruleNames(honest.playerId), [])
        assert.deepEqual((await rankingRecord(honest)).best_record, { elapsed_time_ms: 100_000, is_accomplished: true, score: 1000 })
    })

    test("enforce: an impossible raid clear is the player's own kill but stays out of the tally and the raid ranking", async () => {
        const raid = await import("../src/lib/raid")
        const RAID_DURING = "2023-08-01T03:00:00Z", RAID_EVENT = 1, NOVICE = 1001
        async function raidClear(player: TestPlayer) {
            const { setServerTime } = await import("../src/utils")
            setServerTime(new Date(RAID_DURING))
            const parties = await post(player, "event/raid/party", {})
            const groupId = decodeGameBody(parties.body).data.user_party_group_list[0].party_group_id
            const started = await post(player, "event/raid/battle/start", { quest_id: NOVICE, party_group_id: groupId, play_id: "SEC18",
                use_auto_start_point: false, is_auto_start_mode: false })
            assert.equal(started.statusCode, 200, started.body)
            const finished = await post(player, "single_battle_quest/finish", { quest_id: NOVICE, category: 23, score: 500, add_mana: 0,
                elapsed_time_ms: 60_000, is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "SEC18",
                statistics: { clear_phase: 0, party: { characters: [null, null, null], unison_characters: [null, null, null] } } })
            assert.equal(finished.statusCode, 200, finished.body)
            return decodeGameBody(finished.body).data
        }
        const kills = (playerId: number) => data.getPlayerRaidRecordsSync(playerId, RAID_EVENT).reduce((sum, record) => sum + record.killCount, 0)
        const tallied = (playerId: number) => data.getRaidEventKillsSync(RAID_EVENT).filter(kill => kill.playerId === playerId)
            .reduce((sum, kill) => sum + kill.killCount, 0)

        raid.setRaidHpPolicy({ mode: "fixed", players: 1 })
        try {
            const logged = await newPlayer()
            await raidClear(logged)
            assert.equal(kills(logged.playerId), 1, "log: the kill counts")
            assert.equal(tallied(logged.playerId), 1)
            // the server's kills: enough Novice clears for three, so the tally rewards' first tiers are reached
            const pool = raid.raidPoolSize(RAID_EVENT, 1)
            data.setPlayerRaidRecordSync(logged.playerId, RAID_EVENT, { questId: NOVICE, killCount: 3 * pool, highScore: 500, party: [] })

            anticheat.setAnticheatMode("enforce")
            const excluded = await newPlayer()
            const bossBefore = raid.raidBossSync(RAID_EVENT)
            const reply = await raidClear(excluded)
            assert.ok(flags.getPlayerAnticheatFlagsSync(excluded.playerId).some(flag => flag.severity === "hard" && flag.details.excluded === true))
            assert.equal(reply.raid_event.quest_boss.kill_count, 1, "the finish reply counts the player's own kill")
            assert.equal(kills(excluded.playerId), 1, "enforce: the player's own record keeps the kill")
            assert.equal(tallied(excluded.playerId), 0, "but not the shared tally")
            assert.deepEqual(raid.raidBossSync(RAID_EVENT), bossBefore)
            assert.ok(!raid.raidQuestRankingSync(RAID_EVENT, NOVICE).some(record => record.playerId === excluded.playerId), "nor the raid ranking")

            // they fought: the summary mails them the tally rewards the server's kills reached, and lists their clear
            const summary = decodeGameBody((await post(excluded, "event/raid/summary", { event_id: RAID_EVENT })).body).data
            assert.equal(summary.raid_boss.total_kill_count, 3)
            assert.equal(summary.kill_count_reward_data.received_up_to, 3)
            assert.ok(summary.kill_count_reward_data.reward_list.length > 0)
            assert.equal(summary.quest_list[String(NOVICE)].kill_count, 1)
            // the ranking band follows the board: none for an excluded clear
            assert.equal(raid.receiveRaidRankingRewardSync(excluded.playerId, RAID_EVENT).status, 3)
            assert.equal(raid.receiveRaidRankingRewardSync(logged.playerId, RAID_EVENT).status, 1)
        } finally {
            raid.setRaidHpPolicy({ mode: "automatic", players: 1 })
        }
    })

    test("a version 15 database's raid records get the excluded kill count", async () => {
        const { default: SqliteDatabase } = await import("../src/data/sqlite")
        const { updateBeforeInit, updateAfterInit } = await import("../src/data/updaters/wdfpData")
        const { default: init } = await import("../src/data/initializers/wdfpData")
        const database = new SqliteDatabase(":memory:")
        // the table as version 15 made it
        database.prepare(`CREATE TABLE players_raid_records (player_id INTEGER NOT NULL, event_id INTEGER NOT NULL, quest_id INTEGER NOT NULL,
            kill_count INTEGER NOT NULL, high_score INTEGER NOT NULL, party TEXT NOT NULL, run TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (player_id, event_id, quest_id, run))`).run()
        database.prepare(`INSERT INTO players_raid_records (player_id, event_id, quest_id, kill_count, high_score, party) VALUES (1, 1, 1001, 4, 9, '[]')`).run()
        updateBeforeInit(database, 15)
        init(database, true)
        updateAfterInit(database, 15)
        assert.deepEqual(database.prepare(`SELECT kill_count, excluded_kill_count FROM players_raid_records`).all(), [{ kill_count: 4, excluded_kill_count: 0 }])
        database.close()
    })

    test("off: nothing is judged or recorded", async () => {
        anticheat.setAnticheatMode("off")
        const player = await newPlayer()
        await battle(player, RANKING_QUEST, RANKING, 200_000, false)
        assert.deepEqual(ruleNames(player.playerId), [])
        assert.equal((await rankingRecord(player)).best_record.elapsed_time_ms, 200_000)
    })

    test("continues are counted for the time limit", async () => {
        const player = await newPlayer()
        await data.updatePlayerSync({ id: player.playerId, freeVmoney: 1000 })
        const started = await post(player, "single_battle_quest/start", { quest_id: RANKING_QUEST, category: RANKING, party_id: 1,
            use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "SEC18" })
        assert.equal(started.statusCode, 200, started.body)
        const continued = await post(player, "single_battle_quest/play_continue", { quest_id: RANKING_QUEST, category: RANKING, payment_type: 1, api_count: 2, play_id: "SEC18" })
        assert.equal(continued.statusCode, 200, continued.body)
        const { getActiveQuest } = await import("../src/routes/api/singleBattleQuest")
        assert.equal(getActiveQuest(player.playerId)!.continues, 1)
    })

    test("R6 reads a Carnival battle's party from the Carnival party set", async () => {
        const CARNIVAL = 22, GODLY = 1003
        const player = await newPlayer()
        const { setServerTime } = await import("../src/utils")
        setServerTime(new Date("2025-01-03T12:00:00Z"))
        assert.equal((await post(player, "carnival_event/index", { event_id: 1 })).statusCode, 200, "the set is copied from the normal parties")
        const normal = data.getPlayerPartyBySlotSync(player.playerId, 1)!.characterIds.filter((id): id is number => id !== null)
        const carnivalUnit = normal.includes(111001) ? 111002 : 111001
        const { givePlayerCharacterSync } = await import("../src/lib/character")
        givePlayerCharacterSync(player.playerId, carnivalUnit)
        // the Carnival party 1 now differs from the normal party 1
        const edited = await post(player, "party/edit", { main_party_id: 1, api_count: 1, party_info_list: [{
            party_category: 2, party_name: "Carnival", party_id: 1, character_ids: [carnivalUnit, null, null],
            unison_character_ids: [null, null, null], equipment_ids: [null, null, null], ability_soul_ids: [null, null, null],
            options: { allow_other_players_to_heal_me: true } }] })
        assert.equal(edited.statusCode, 200, edited.body)

        async function carnivalClear(units: number[]) {
            const started = await post(player, "single_battle_quest/start", { quest_id: GODLY, category: CARNIVAL, party_id: 1,
                use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "SEC18" })
            assert.equal(started.statusCode, 200, started.body)
            const { getActiveQuest } = await import("../src/routes/api/singleBattleQuest")
            ;(getActiveQuest(player.playerId) as { startedAtMs?: number }).startedAtMs = Date.now() - 120_000
            const finished = await post(player, "single_battle_quest/finish", { quest_id: GODLY, category: CARNIVAL, score: 1000, add_mana: 0,
                elapsed_time_ms: 90_000, is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "SEC18",
                statistics: { clear_phase: 0, party: { characters: units.map(id => ({ id })), unison_characters: [null, null, null],
                    equipments: [null, null, null], ability_soul_ids: [null, null, null] },
                    zones: [{ zone: 0, playthrough_ms: 90_000, playthrough_frame: Math.floor(90_000 / 17), damage_deal_total: 100, damage_deal_max: 10, boss_damage_deal_total: 50 }] } })
            assert.equal(finished.statusCode, 200, finished.body)
        }
        await carnivalClear([carnivalUnit])
        assert.deepEqual(ruleNames(player.playerId), [], "the Carnival party the battle started with")
        await carnivalClear(normal)
        assert.deepEqual(ruleNames(player.playerId), ["party-changed"], "a real swap is still caught")
    })
})

describe("restricted players", () => {
    test("leave the shared boards unless anti-cheat is off; developer-mode players leave them always", async () => {
        const fast = await newPlayer(), slow = await newPlayer()
        const { default: getDatabase, Database } = await import("../src/data/index")
        getDatabase(Database.WDFP_DATA).prepare(`DELETE FROM players_ranking_records`).run()
        await battle(fast, RANKING_QUEST, RANKING, 100_000, true)
        await battle(slow, RANKING_QUEST, RANKING, 150_000, true)
        assert.equal(Math.round((await rankingRecord(slow)).rank_percentage), 50, "behind the faster player")

        flags.setPlayerRestrictedSync(fast.playerId, true, null)
        assert.ok(anticheat.boardHiddenPlayers().has(fast.playerId))
        assert.equal((await rankingRecord(slow)).rank_percentage, 0.01, "the restricted record is off the board")

        anticheat.setAnticheatMode("off")
        assert.ok(!anticheat.boardHiddenPlayers().has(fast.playerId), "off suspends restrictions")
        assert.equal(Math.round((await rankingRecord(slow)).rank_percentage), 50)
        anticheat.setAnticheatMode(null)

        flags.setPlayerRestrictedSync(fast.playerId, false, null)
        assert.ok(!anticheat.boardHiddenPlayers().has(fast.playerId), "the cache follows the change")
        assert.equal(Math.round((await rankingRecord(slow)).rank_percentage), 50)

        const { setDeveloperMode } = await import("../src/lib/developerModePlayers")
        setDeveloperMode(fast.playerId, true)
        try {
            anticheat.setAnticheatMode("off")
            assert.ok(anticheat.boardHiddenPlayers().has(fast.playerId), "developer mode in every mode")
        } finally {
            setDeveloperMode(fast.playerId, false)
        }
    })
})
