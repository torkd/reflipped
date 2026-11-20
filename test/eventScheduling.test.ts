import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

let fastify: FastifyInstance, admin: FastifyInstance, cleanup: () => Promise<void>
before(async () => { ({ fastify, admin, cleanup } = await createTestServer()); delete process.env.SERVER_CLOCK })
after(async () => { await cleanup() })

test("timeline boundaries, offline cycles and acceleration are deterministic", async () => {
    const { resolveTimeline } = await import("../src/lib/eventSchedule")
    const windows = [{ start: 100, end: 200 }, { start: 500, end: 550 }]
    assert.equal(resolveTimeline(windows, 1000, 1000, 1).contentTime, 100)
    assert.equal(resolveTimeline(windows, 1000, 1100, 1).contentTime, 500)
    assert.equal(resolveTimeline(windows, 1000, 1150, 1).cycle, 1)
    assert.equal(resolveTimeline(windows, 1000, 1075, 2).cycle, 1)
    assert.equal(resolveTimeline(windows, 1000, 1000 + 150 * 1000000 + 25, 1).contentTime, 125)
    assert.equal(resolveTimeline(windows, 1000, 900, 1).contentTime, 100)
    assert.throws(() => resolveTimeline([], 1000, 1000, 1))
    assert.throws(() => resolveTimeline([{ start: 2, end: 1 }], 1000, 1000, 1))
    assert.throws(() => resolveTimeline(windows, 1000, Infinity, 1))
})

test("real progression time works beyond closure while source availability remains historical", async () => {
    const { getServerDate, getClockEra, runOnClock } = await import("../src/lib/serverClock")
    const { contentDate, runOnEventView } = await import("../src/lib/eventSchedule")
    const { getOpenGachaIdsSync } = await import("../src/lib/assets")
    const { BASELINE_CHARACTER_GACHA_ID } = await import("../src/lib/scheduleGacha")
    const now = getServerDate()
    assert.ok(Math.abs(now.getTime() - Date.now()) < 2000)
    assert.equal(getClockEra(), 0)
    runOnEventView(100, () => runOnClock({ offsetMs: 86400000 * 100, era: 42 }, () => {
        assert.ok(Math.abs(getServerDate().getTime() - Date.now()) < 2000)
        // The event view is the travel mechanism; direct legacy contexts cannot shift progression.
        const { getEventScheduleView } = require("../src/lib/eventSchedule")
        assert.equal(contentDate(now).getTime(), getEventScheduleView(now.getTime()).contentTime)
        assert.equal(getClockEra(), 0)
    }))
    assert.ok(getOpenGachaIdsSync(new Date("2090-01-01T00:00:00Z")).length > 0)
})

test("saved anchor and occurrence identity survive reads and personal travel", async () => {
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { getEventScheduleView } = await import("../src/lib/eventSchedule")
    const p = getEventPolicy()
    const now = Date.now()
    const a = getEventScheduleView(now, 0)
    setEventPolicy({ ...p })
    assert.deepEqual(getEventScheduleView(now, 0), a)
    const b = getEventScheduleView(now, 60)
    assert.equal(a.occurrenceKey, b.occurrenceKey, "travel cannot manufacture another reward occurrence")
    assert.notEqual(a.key, b.key, "client caches must distinguish personal views")
    assert.equal(b.contentTime - a.contentTime, 86400000 * 60)
})

test("pace changes preserve current timeline position and reward run identity", async () => {
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { getEventScheduleView } = await import("../src/lib/eventSchedule")
    const { saveEventSettings } = await import("../src/lib/eventSettings")
    const p = getEventPolicy(), now = Date.now()
    setEventPolicy({ ...p, mode: "classic", anchor: now - 100000 })
    const before = getEventScheduleView(now, 0)
    saveEventSettings({ mode: "accelerated", acceleration: 2, management: "managed" }, now)
    const after = getEventScheduleView(now, 0)
    assert.equal(after.contentTime, before.contentTime)
    assert.equal(after.occurrenceKey, before.occurrenceKey)
    assert.equal(after.rate, 2)
    setEventPolicy(p)
})

test("invalid combined settings roll back both event and reward policy", async () => {
    const { getEventPolicy } = await import("../src/lib/eventPolicy")
    const { getRewardPolicy } = await import("../src/lib/rewardPolicy")
    const before = getEventPolicy(), rewardBefore = getRewardPolicy()
    const response = await admin.inject({ method: "POST", url: "/api/server/events", payload: {
        mode: "manual", acceleration: 2, management: "managed", multiplierOverride: 100000
    } })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(getEventPolicy(), before)
    assert.deepEqual(getRewardPolicy(), rewardBefore)
})

test("player and admin travel switches independently suspend saved selections", async () => {
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { effectiveContentOffset, requestClockOf } = await import("../src/lib/playerClock")
    const p = getEventPolicy()
    setEventPolicy({ ...p, mode: "classic", adminTimeTravel: false })
    assert.equal(effectiveContentOffset({ offsetDays: 30, era: 10, source: "player" }), 0)
    assert.equal(effectiveContentOffset({ offsetDays: 30, era: 10, source: "admin" }), 0)
    setEventPolicy({ ...p, mode: "time-travel", adminTimeTravel: false })
    assert.equal(effectiveContentOffset({ offsetDays: 30, era: 10, source: "player" }), 30)
    assert.equal(effectiveContentOffset({ offsetDays: 30, era: 10, source: "admin" }), 0)
    setEventPolicy({ ...p, mode: "classic", adminTimeTravel: true })
    assert.equal(effectiveContentOffset({ offsetDays: 30, era: 10, source: "player" }), 0)
    assert.equal(effectiveContentOffset({ offsetDays: 30, era: 10, source: "admin" }), 30)
    assert.deepEqual(requestClockOf({ offsetDays: -1000, era: 50 }), { offsetMs: 0, era: 0 })
    setEventPolicy(p)
})

test("disabled admin travel is enforced by direct POST; calendar and settings render", async () => {
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const p = getEventPolicy()
    setEventPolicy({ ...p, adminTimeTravel: false })
    const result = await admin.inject({ method: "POST", url: "/api/player/clock?id=1", payload: { date: "2024-01-01" } })
    assert.equal(result.statusCode, 403)
    const calendar = await admin.inject({ method: "GET", url: "/calendar?q=%3Cscript%3E" })
    assert.equal(calendar.statusCode, 200)
    assert.ok(calendar.body.includes("&lt;script&gt;"))
    assert.ok(!calendar.body.includes('value="<script>"'))
    const settings = await admin.inject({ method: "GET", url: "/settings" })
    assert.equal(settings.statusCode, 200)
    assert.ok(settings.body.includes("Rewards follow the server&#39;s rules"))
    assert.ok(settings.body.includes('name="management" value="automatic"'))
    // Automatic, the default, is the first card; the three tabs are links that work without the script
    assert.ok(settings.body.indexOf('name="management" value="automatic"') < settings.body.indexOf('name="management" value="managed"'))
    for (const tab of ["events", "rewards", "performance"]) assert.ok(settings.body.includes(`data-tab="${tab}" aria-selected=`), tab)
    assert.ok(settings.body.includes('<script src="/public/js/settings-tabs.js" defer></script>'))
    assert.ok(settings.body.includes("Time Travel"))
    // the row only Accelerated uses is rendered locked while another mode is selected
    assert.match(settings.body, /setting-row setting-row-locked" data-locked-unless="mode=accelerated"/)
    setEventPolicy(p)
})

test("captured room availability cannot move a guest's progression day", async () => {
    const { runOnEventView, runOnCapturedEventContext, contentDate, currentEventOccurrenceKey } = await import("../src/lib/eventSchedule")
    const { getServerDate } = await import("../src/lib/serverClock")
    const captured = { occurrenceKey: "room-run", contentTime: Date.parse("2024-06-01T00:00:00Z"), profile: "classic" as const }
    runOnEventView(500, () => {
        const real = getServerDate().getTime()
        runOnCapturedEventContext(captured, () => {
            assert.equal(contentDate(getServerDate()).getTime(), captured.contentTime)
            assert.equal(currentEventOccurrenceKey(), "room-run")
            assert.equal(getServerDate().getTime(), real)
        })
    })
})

test("personal travel cooldown persists through clearing the selection", async () => {
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { setPlayerDaySync } = await import("../src/lib/playerClockChange")
    const { setPlayerClockSync } = await import("../src/lib/playerClock")
    const { getSession, getAccountPlayers } = await import("../src/data/wdfpData")
    const prior = getEventPolicy()
    setEventPolicy({ ...prior, mode: "time-travel" })
    const player = await createTestPlayer(fastify)
    const session = await getSession(String(player.viewerId))
    const id = (await getAccountPlayers(session!.accountId))[0]
    assert.equal(setPlayerDaySync(id, "2024-06-01"), "clock-set")
    assert.equal(setPlayerDaySync(id, "2023-06-01"), "clock-cooldown")
    setPlayerClockSync(id, null)
    assert.equal(setPlayerDaySync(id, "2023-06-01"), "clock-cooldown")
    assert.equal(setPlayerDaySync(id, "2023-06-01", false, true), "clock-set", "admin assignments are separately controlled at their endpoint")
    setEventPolicy(prior)
})

test("projected availability agrees with whole-second client boundaries", async () => {
    const { getEventScheduleView, isContentPeriodOpen, scheduledMasterTime } = await import("../src/lib/eventSchedule")
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const prior = getEventPolicy(), now = Date.now()
    setEventPolicy({ ...prior, mode: "accelerated", anchor: now - 12345 })
    const view = getEventScheduleView(now, 0)
    const start = view.contentTime + 11000
    const end = start + 20000
    const projectedStart = scheduledMasterTime(start, view)
    const projectedEnd = scheduledMasterTime(end, view)
    assert.equal(isContentPeriodOpen(start, end, new Date(projectedStart - 1)), false)
    assert.equal(isContentPeriodOpen(start, end, new Date(projectedStart)), true)
    assert.equal(isContentPeriodOpen(start, end, new Date(projectedEnd + 999)), true)
    assert.equal(isContentPeriodOpen(start, end, new Date(projectedEnd + 1000)), false)
    setEventPolicy(prior)
})


test("month-restricted shop stock follows real progression months", async () => {
    const { isOnSale } = await import("../src/lib/shopLimits")
    const date = new Date()
    const month = Number((await import("../src/lib/resets")).gameDay(date).month.slice(5, 7))
    assert.equal(isOnSale({ availableFrom: "1900-01-01 00:00:00", availableUntil: null, specifiedMonths: [month] } as any, date), true)
    assert.equal(isOnSale({ availableFrom: "1900-01-01 00:00:00", availableUntil: null, specifiedMonths: [month % 12 + 1] } as any, date), false)
})

test("manual event entries start at their actual opening instant", async () => {
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { eventCatalog, setManualWindows, getManualWindows, getEventScheduleView } = await import("../src/lib/eventSchedule")
    const { gameDayOf } = await import("../src/lib/calendar")
    const prior = getEventPolicy(), windows = getManualWindows(), event = eventCatalog[0], now = Date.now()
    setManualWindows([{ from: gameDayOf(event.startTime), to: gameDayOf(event.endTime - 1), label: event.name, eventId: event.id }])
    setEventPolicy({ ...prior, mode: "manual", anchor: now })
    const view = getEventScheduleView(now, 0)
    assert.equal(view.contentTime, event.startTime)
    assert.equal(view.sourceEnd, event.endTime)
    assert.equal(getEventScheduleView(now + event.endTime - event.startTime, 0).cycle, 1)
    assert.throws(() => setManualWindows([{ from: "2024-01-01", to: "2024-01-02", label: "invalid", eventId: "unknown/1" }]))
    setManualWindows(windows)
    setEventPolicy(prior)
})

test("compatibility and frozen environment switches normalize whitespace and case", async () => {
    const { scheduledContentEnabled } = await import("../src/lib/eventSchedule")
    const oldScheduling = process.env.EVENT_SCHEDULING, oldClock = process.env.SERVER_CLOCK
    try {
        process.env.EVENT_SCHEDULING = " OFF "
        assert.equal(scheduledContentEnabled(), false)
        delete process.env.EVENT_SCHEDULING
        process.env.SERVER_CLOCK = " FROZEN "
        assert.equal(scheduledContentEnabled(), false)
    } finally {
        if (oldScheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = oldScheduling
        if (oldClock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = oldClock
    }
})

test("accelerated periods opening later in the real day receive attempts once", async () => {
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { HISTORICAL_START } = await import("../src/lib/eventSchedule")
    const { gameDayOf, gameDayStart } = await import("../src/lib/calendar")
    const { getDailyChallengePoint, getPlayerDailyChallengePointSync, refillRewardPointsSync } = await import("../src/lib/rewardPoints")
    const { getSession, getAccountPlayers, setPlayerDailyChallengePointSync } = await import("../src/data/wdfpData")
    const { masterDate } = await import("../src/utils")
    const prior = getEventPolicy(), reset = gameDayStart(gameDayOf(Date.now())), point = getDailyChallengePoint(2)!
    setEventPolicy({ ...prior, mode: "accelerated", acceleration: 2,
        anchor: reset + 15 * 3600000 - (masterDate(point.start).getTime() - HISTORICAL_START) / 2 })
    const player = await createTestPlayer(fastify), session = await getSession(String(player.viewerId))
    const id = (await getAccountPlayers(session!.accountId))[0]
    refillRewardPointsSync(id, new Date(reset))
    assert.equal(getPlayerDailyChallengePointSync(id, 2)?.point, point.daily)
    setPlayerDailyChallengePointSync(id, 2, 0)
    refillRewardPointsSync(id, new Date(reset + 16 * 3600000))
    assert.equal(getPlayerDailyChallengePointSync(id, 2)?.point, 0, "later loads or revisits cannot refill a spent daily entitlement")
    setEventPolicy(prior)
})


test("the extended final banner cannot expose future units during early content", async () => {
    const { getOpenGachaIdsSync } = await import("../src/lib/assets")
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { HISTORICAL_START } = await import("../src/lib/eventSchedule")
    const prior = getEventPolicy(), now = Date.now()
    setEventPolicy({ ...prior, mode: "classic", anchor: now })
    assert.ok(!getOpenGachaIdsSync(new Date(now)).includes("185"))
    const sourceAfterClosure = Date.parse("2025-05-01T00:00:00Z")
    setEventPolicy({ ...prior, mode: "classic", anchor: now - (sourceAfterClosure - HISTORICAL_START) })
    assert.ok(getOpenGachaIdsSync(new Date(now)).includes("185"))
    setEventPolicy(prior)
})


test("modern timestamp serialization preserves explicit dates", async () => {
    const { getServerTime } = await import("../src/lib/serverClock")
    const recorded = new Date("2024-01-02T03:04:05Z")
    assert.equal(getServerTime(recorded), Math.floor(recorded.getTime() / 1000))
    assert.ok(Math.abs(getServerTime() * 1000 - Date.now()) < 2000)
})
