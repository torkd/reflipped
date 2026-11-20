import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, readCapturedRoute, TestPlayer } from "./helpers";

// FT-51: the modes that arrived after the start of the archive (the Kaleidoscope's element dailies, the Necropolis,
// Solo Boss Challenges, Chrono Trials, Score Scramble, ...) start only inside their own row's period, as the client
// shows them (`assets/quest_mode_periods.json`). Dates are Japan time in the master: 14:00 there is 05:00 UTC.

const apiPrefix = "/latest/api/index.php"
const DAILY_WEEK = 6
const CHALLENGE_DUNGEON = 13
const DAILY_EXP_MANA = 14
const EXPERT_SINGLE = 21
const SOLO_TIME_ATTACK = 25
const SCORE_ATTACK = 27

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let periods: typeof import("../src/lib/questPeriods")

before(async () => {
    process.env.QUEST_PERIOD_CHECK = "enforce"
    ;({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    periods = await import("../src/lib/questPeriods")
})

after(async () => {
    process.env.QUEST_PERIOD_CHECK = "off"
    await cleanup()
})

const open = (category: number, questId: number, iso: string) => periods.isQuestOpen(category, questId, new Date(iso), true)

test("each mode's quests take their row's period", () => {
    assert.equal(periods.questEventPeriod(DAILY_WEEK, 13001)?.id, "daily_week_event/13")
    assert.equal(periods.questEventPeriod(CHALLENGE_DUNGEON, 1001)?.id, "challenge_dungeon_event/1")
    assert.equal(periods.questEventPeriod(CHALLENGE_DUNGEON, 2001)?.id, "challenge_dungeon_event/2")
    assert.equal(periods.questEventPeriod(EXPERT_SINGLE, 2001)?.id, "expert_single_event/2")
    assert.equal(periods.questEventPeriod(SOLO_TIME_ATTACK, 1001)?.id, "solo_time_attack_event/1")
    assert.equal(periods.questEventPeriod(SCORE_ATTACK, 1001)?.id, "score_attack_event/1")
    assert.equal(periods.questEventPeriod(DAILY_WEEK, 99001), null, "an unknown row has no period")
    assert.equal(periods.questEventPeriod(1, 1001002), null, "main quests have none")
    assert.equal(periods.questEventPeriod(20, 1001), null, "the Haunt keeps its own cycle check")
})

test("the element dailies open on 2021-09-11, change to Training Items on 2024-01-17, and the 2018 rows stay shut", () => {
    // all-element rows (13-18): 2021-09-11 14:00 to 2024-01-17 13:59:59
    assert.ok(!open(DAILY_WEEK, 13001, "2021-09-11T04:59:59Z"))
    assert.ok(open(DAILY_WEEK, 13001, "2021-09-11T05:00:00Z"))
    assert.ok(open(DAILY_WEEK, 18001, "2024-01-17T04:59:59Z"), "the last second counts")
    assert.ok(!open(DAILY_WEEK, 18001, "2024-01-17T05:00:00Z"))
    // Training Items (19): from 2024-01-17 14:00, open-ended
    assert.ok(!open(DAILY_WEEK, 19001, "2024-01-17T04:59:59Z"))
    assert.ok(open(DAILY_WEEK, 19001, "2024-01-17T05:00:00Z"))
    assert.ok(open(DAILY_WEEK, 19001, "2030-01-01T00:00:00Z"))
    // the weekday rows (1-12) closed in 2019, before the global game
    assert.ok(!open(DAILY_WEEK, 1001, "2021-10-01T00:00:00Z"))
    // EXP & Mana is always there
    assert.ok(open(DAILY_EXP_MANA, 1001, "2021-07-29T05:00:00Z"))
})

test("the later modes open on their release dates", () => {
    const releases: [number, number, string][] = [
        [CHALLENGE_DUNGEON, 1001, "2021-12-26T05:00:00Z"], // the Necropolis
        [CHALLENGE_DUNGEON, 2001, "2023-05-08T05:00:00Z"], // the Treasure Zone
        [EXPERT_SINGLE, 1001, "2022-05-08T05:00:00Z"], // Solo Boss Challenges
        [EXPERT_SINGLE, 2001, "2024-02-29T05:00:00Z"], // Nostalgia Trials
        [SOLO_TIME_ATTACK, 1001, "2023-11-09T05:00:00Z"], // Chrono Trials
        [SCORE_ATTACK, 1001, "2024-08-17T05:00:00Z"] // Score Scramble
    ]
    for (const [category, questId, release] of releases) {
        const opening = new Date(release).getTime()
        assert.ok(!open(category, questId, new Date(opening - 1000).toISOString()), `${category}/${questId} before ${release}`)
        assert.ok(open(category, questId, release), `${category}/${questId} at ${release}`)
        assert.ok(open(category, questId, "2025-01-03T12:00:00Z"), `${category}/${questId} on the default date`)
    }
})

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.json() }
}

test("a Necropolis start before its release is refused; on the player's later clock it starts", async () => {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    // the Necropolis opens after main quest 4-11-5
    data.insertPlayerQuestProgressSync(playerId, 1, { questId: 4011005, finished: true })
    const { setPlayerClockSync } = await import("../src/lib/playerClock")
    const start = () => post(player, "single_battle_quest/start", {
        ...readCapturedRoute("single_battle_quest_start").requestBody, category: CHALLENGE_DUNGEON, quest_id: 1001
    })

    setPlayerClockSync(playerId, new Date("2021-11-01T03:00:00Z"))
    const refused = await start()
    assert.equal(refused.status, 400)
    assert.match(refused.body.message, /event isn't open/)

    setPlayerClockSync(playerId, new Date("2022-01-10T03:00:00Z"))
    const started = await start()
    assert.equal(started.status, 200, started.body?.message)
})
