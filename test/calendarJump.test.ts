// The Calendar page's "Go to" (POST /api/server/calendar/jump): with event scheduling on, the shared content timeline
// moves to the event's opening as a new run (in Manual mode only to a playlist event); with it off, the server clock does.
// Event records (raid, ranking, carnival, score attack, rush) are kept per run, so a new run starts the event fresh.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

const EVENT = "advent_event/200056"

let admin: FastifyInstance
let cleanup: () => Promise<void>
let schedule: typeof import("../src/lib/eventSchedule")
let events: typeof import("../src/lib/eventPolicy")
let data: typeof import("../src/data/wdfpData")
let fastify: FastifyInstance

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    schedule = await import("../src/lib/eventSchedule")
    events = await import("../src/lib/eventPolicy")
})

afterEach(async () => {
    delete process.env.EVENT_SCHEDULING
    process.env.SERVER_CLOCK = "frozen"
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "classic" })
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

function scheduling() {
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
}

async function post(url: string, form: Record<string, string>): Promise<string> {
    const response = await admin.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(form).toString()
    })
    assert.equal(response.statusCode, 302, response.body)
    return String(response.headers.location)
}

const event = () => schedule.eventCatalog.find(entry => entry.id === EVENT)!

async function newPlayerId(): Promise<number> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return (await data.getAccountPlayers(session!.accountId))[0]
}

const RANKING_EVENT = 5
const record = (score: number) => ({ accomplished: true, elapsedTimeMs: 1000, score, leaderCharacterId: 100001, rewarded: score > 50 })

// first in the file: the adoption of records from before runs happens once, at the first run asked for
test("records from before runs join the current run, and a new run starts with none", async () => {
    const playerId = await newPlayerId()
    data.setPlayerRankingRecordSync(playerId, RANKING_EVENT, record(77))   // scheduling off: run ""
    data.setPlayerRaidRecordSync(playerId, 3, { questId: 31, killCount: 4, highScore: 9, party: [] })
    data.insertPlayerRushEventClearedFolderSync(playerId, 2, 20)

    scheduling()
    const firstRun = data.currentEventRun()
    assert.notEqual(firstRun, "")
    assert.equal(data.getPlayerRankingRecordSync(playerId, RANKING_EVENT)?.score, 77, "adopted by the current run")
    assert.equal(data.getRaidEventKillsSync(3).find(kill => kill.playerId === playerId)?.killCount, 4)
    assert.deepEqual(data.getPlayerRushEventClearedFoldersSync(playerId, 2), [20])

    assert.equal(await post("/api/server/calendar/jump", { event: EVENT }), "/calendar?message=event_jump")
    assert.notEqual(data.currentEventRun(), firstRun, "a new run")
    assert.equal(data.getPlayerRankingRecordSync(playerId, RANKING_EVENT), null, "no score in the new run")
    assert.equal(data.getRankingRecordsSync(RANKING_EVENT).some(entry => entry.playerId === playerId), false, "nor on its leaderboard")
    assert.equal(data.getRaidEventKillsSync(3).some(kill => kill.playerId === playerId), false, "no raid kills")
    assert.deepEqual(data.getPlayerRushEventClearedFoldersSync(playerId, 2), [])

    data.setPlayerRankingRecordSync(playerId, RANKING_EVENT, record(12))
    assert.deepEqual(data.getPlayerRankingRecordSync(playerId, RANKING_EVENT), record(12), "the new run's own record, not rewarded")
})

test("a save import keeps the rush records of other runs", async () => {
    scheduling()
    const playerId = await newPlayerId()
    data.insertPlayerRushEventClearedFolderSync(playerId, 2, 21)
    const { getClientSerializedData, deserializePlayerData } = await import("../src/data/utils")
    assert.equal(await post("/api/server/calendar/jump", { event: EVENT }), "/calendar?message=event_jump")
    data.insertPlayerRushEventClearedFolderSync(playerId, 2, 22)
    const save = getClientSerializedData(playerId, { serializeRushEventData: true, serializeSaveData: true })!
    data.replacePlayerDataSync(deserializePlayerData(playerId, save))
    assert.deepEqual(data.getPlayerRushEventClearedFoldersSync(playerId, 2), [22], "the save's run")
    const { default: getDatabase, Database } = await import("../src/data")
    const runs = getDatabase(Database.WDFP_DATA).prepare(`SELECT folder_id FROM players_rush_events_cleared_folders WHERE player_id = ? ORDER BY folder_id`).all(playerId)
    assert.deepEqual(runs, [{ folder_id: 21 }, { folder_id: 22 }], "the earlier run's record kept")
})

test("Classic and Accelerated: the timeline lands on the event's opening, as a new run", async () => {
    scheduling()
    for (const mode of ["classic", "accelerated"] as const) {
        events.setEventPolicy({ ...events.getEventPolicy(), mode, acceleration: 3 })
        const before = events.getEventPolicy().rotationId
        assert.equal(await post("/api/server/calendar/jump", { event: EVENT }), "/calendar?message=event_jump")
        const view = schedule.getEventScheduleView()
        assert.ok(view.contentTime >= event().startTime && view.contentTime < event().startTime + 60_000, `${mode}: ${new Date(view.contentTime).toISOString()}`)
        assert.ok(schedule.isContentPeriodOpen(event().startTime, event().endTime - 1000, new Date()), `${mode}: the event is open`)
        assert.notEqual(events.getEventPolicy().rotationId, before, "a new run")
    }
    assert.equal(await post("/api/server/calendar/jump", { event: "advent_event/0" }), "/calendar?error=unknown_event")
})

test("Manual: only an event of the playlist can be reached", async () => {
    scheduling()
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "manual" })
    schedule.setManualWindows([...schedule.DEFAULT_MANUAL_WINDOWS])
    assert.equal(await post("/api/server/calendar/jump", { event: EVENT }), "/calendar?error=event_not_in_playlist")
    assert.equal(await post("/api/server/calendar/windows", { action: "event", event: EVENT }), "/calendar?message=playlist_saved")
    assert.equal(await post("/api/server/calendar/jump", { event: EVENT }), "/calendar?message=event_jump")
    const view = schedule.getEventScheduleView()
    assert.equal(view.index, 1, "the playlist's second entry")
    assert.ok(view.contentTime >= event().startTime && view.contentTime < event().startTime + 60_000)

    const page = await admin.inject({ method: "GET", url: "/calendar?message=event_jump" })
    assert.match(page.body, /The event timeline is at the event&#39;s opening|The event timeline is at the event's opening/)
    assert.match(page.body, /action="\/api\/server\/calendar\/jump"/)
})

test("event scheduling off: the server clock goes to the event's opening and the calendar stops", async () => {
    const { getEvent } = await import("../src/lib/eventCalendar")
    const { getServerDate } = await import("../src/utils")
    const { getClockStatus } = await import("../src/lib/serverClock")
    assert.equal(await post("/api/server/calendar/jump", { event: EVENT }), "/calendar?message=event_jump")
    assert.equal(getServerDate().getTime(), getEvent(EVENT)!.start.getTime())
    assert.notEqual(getClockStatus().mode, "calendar")
    const page = await admin.inject({ method: "GET", url: "/calendar" })
    assert.match(page.body, /aria-label="Go to: /)
})
