import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, readCapturedRoute, TestPlayer } from "./helpers";

// SEC-16: an event quest starts only within its event's period (the event calendar's master dates), on the player's
// own clock; a co-op room's quest is checked when its host creates it, and its guests are let in.

const apiPrefix = "/latest/api/index.php"
const MAIN = 1
const STORY_EVENT_SINGLE = 10
// story event 100002 ("New Year, New Flipper"): 2021-08-28 00:00 to 2021-09-11 13:59:59 Japan time
const EVENT_QUEST = 100002007
const DURING_EVENT = new Date("2021-09-01T03:00:00Z")

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    process.env.QUEST_PERIOD_CHECK = "enforce"
    ;({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

after(async () => {
    process.env.QUEST_PERIOD_CHECK = "off"
    await cleanup()
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

const start = (player: TestPlayer, category: number, questId: number) =>
    post(player, "single_battle_quest/start", { ...readCapturedRoute("single_battle_quest_start").requestBody, category, quest_id: questId })

async function playerIdOf(player: TestPlayer): Promise<number> {
    const session = await data.getSession(String(player.viewerId))
    return (await data.getAccountPlayers(session!.accountId))[0]
}

test("a quest's event period comes from the calendar; quests of other kinds have none", async () => {
    const { isQuestOpen, questEventPeriod, questPeriodCheckFromEnv } = await import("../src/lib/questPeriods")
    assert.equal(questEventPeriod(STORY_EVENT_SINGLE, EVENT_QUEST)?.id, "story_event/100002")
    const { QuestCategory } = await import("../src/lib/types")
    assert.equal(questEventPeriod(MAIN, 1001002), null)
    assert.equal(questEventPeriod(QuestCategory.WORLD_STORY_EVENT, 400001003), null, "a world story the calendar doesn't have")
    assert.equal(questEventPeriod(QuestCategory.WORLD_STORY_EVENT, 100100001)?.id, "world_story_event/100100")
    assert.ok(isQuestOpen(STORY_EVENT_SINGLE, EVENT_QUEST, DURING_EVENT, true))
    assert.ok(!isQuestOpen(STORY_EVENT_SINGLE, EVENT_QUEST, new Date("2025-01-03T12:00:00Z"), true))
    // the last second of the period still counts, the next doesn't (Japan time)
    assert.ok(isQuestOpen(STORY_EVENT_SINGLE, EVENT_QUEST, new Date("2021-09-11T04:59:59.500Z"), true))
    assert.ok(!isQuestOpen(STORY_EVENT_SINGLE, EVENT_QUEST, new Date("2021-09-11T05:00:00Z"), true))
    assert.ok(isQuestOpen(STORY_EVENT_SINGLE, EVENT_QUEST, new Date("2025-01-03T12:00:00Z"), false), "the check off")
    assert.equal(questPeriodCheckFromEnv(undefined), true)
    assert.equal(questPeriodCheckFromEnv("OFF"), false)
    assert.equal(questPeriodCheckFromEnv("of"), true, "a typo doesn't turn it off")
})

test("a solo start outside the event's period is refused; the player's own clock in it is let in", async () => {
    const player = await createTestPlayer(fastify)
    const refused = await start(player, STORY_EVENT_SINGLE, EVENT_QUEST)
    assert.equal(refused.status, 400)
    assert.match(refused.body.message, /event isn't open/)
    assert.equal((await start(player, MAIN, 1001002)).status, 200, "a main quest has no period")

    const { setPlayerClockSync } = await import("../src/lib/playerClock")
    setPlayerClockSync(await playerIdOf(player), DURING_EVENT)
    assert.equal((await start(player, STORY_EVENT_SINGLE, EVENT_QUEST)).status, 200)
})

test("a co-op room's quest is checked for its host; a guest of the room is let in on any clock", async () => {
    const host = await createTestPlayer(fastify)
    const createRoom = () => post(host, "multi_battle_quest/create_room", { quest_id: EVENT_QUEST, party_id: 11, category: STORY_EVENT_SINGLE })
    assert.equal((await createRoom()).status, 400)

    const { setPlayerClockSync } = await import("../src/lib/playerClock")
    setPlayerClockSync(await playerIdOf(host), DURING_EVENT)
    const created = await createRoom()
    assert.equal(created.status, 200)

    const guest = await createTestPlayer(fastify)
    assert.equal((await start(guest, STORY_EVENT_SINGLE, EVENT_QUEST)).status, 400, "not in the room yet")
    const { admit, getRoom } = await import("../src/lib/coop/rooms")
    admit(getRoom(created.body.data.room_number)!, guest.viewerId)
    assert.equal((await start(guest, STORY_EVENT_SINGLE, EVENT_QUEST)).status, 400, "room history cannot bypass a solo period")
    assert.equal((await post(guest, "multi_battle_quest/start", { ...readCapturedRoute("single_battle_quest_start").requestBody,
        category: STORY_EVENT_SINGLE, quest_id: EVENT_QUEST, room_number: created.body.data.room_number,
        play_id: "PERIOD", mate_player_ids: [] })).status, 200)
})
