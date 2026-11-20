import { after, afterEach, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

// FT-5: the event calendar. The server clock runs 1:1 inside a window of whole game days and carries on at the next
// window's start at its end (src/lib/calendar.ts, src/lib/serverClock.ts). These tests let the clock run (no
// SERVER_CLOCK=frozen) and move the machine's time with mock timers.

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    // These fixtures explicitly cover the retained legacy clock, not projected event schedules.
    process.env.EVENT_SCHEDULING = "off";
    process.env.SERVER_CLOCK = "running"
    ;({ admin, cleanup } = await createTestServer())
})

afterEach(async () => {
    mock.timers.reset()
    delete process.env.SERVER_TIME
    process.env.SERVER_CLOCK = "running"
    const clock = await import("../src/lib/serverClock")
    clock.setCalendarWindows(null)
    clock.setServerTime(null)
})

after(async () => {
    await cleanup()
})

/** Machine time stands still at `iso` until `tick()`. */
function freezeMachineTime(iso = "2026-10-30T10:00:00Z") {
    mock.timers.enable({ apis: ["Date"], now: Date.parse(iso) })
}

const tick = (ms: number) => mock.timers.tick(ms)

async function clock() {
    return await import("../src/lib/serverClock")
}

async function calendar() {
    return await import("../src/lib/calendar")
}

/** An admin form post (the pages send urlencoded forms); returns where it redirects. */
async function post(url: string, form: Record<string, string>): Promise<string> {
    const response = await admin.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(form).toString()
    })
    assert.equal(response.statusCode, 302, response.body)
    return String(response.headers.location)
}

// ---- game days and windows ----

test("a game day runs from 20:00 UTC (05:00 in Japan) to 20:00 UTC", async () => {
    const { gameDayOf, gameDayStart, timeIntoGameDay } = await calendar()
    assert.equal(gameDayOf(Date.parse("2025-01-02T19:59:59.999Z")), "2025-01-02")
    assert.equal(gameDayOf(Date.parse("2025-01-02T20:00:00Z")), "2025-01-03")
    assert.equal(new Date(gameDayStart("2025-01-03")).toISOString(), "2025-01-02T20:00:00.000Z")
    assert.equal(timeIntoGameDay(Date.parse("2025-01-03T12:00:00Z")), 16 * HOUR)
    for (const bad of ["2025-02-30", "2025-1-3", "", "2025-01-03T00:00"]) assert.ok(isNaN(gameDayStart(bad)), bad)
})

test("windows are at least one whole game day and are checked", async () => {
    const { checkCalendarWindow, windowBounds } = await calendar()
    const single = checkCalendarWindow("2025-01-05", "2025-01-05", "")
    assert.deepEqual(single, { from: "2025-01-05", to: "2025-01-05", label: "2025-01-05" })
    const bounds = windowBounds(single as any)
    assert.equal(bounds.end - bounds.start, DAY)
    assert.equal(checkCalendarWindow("2025-01-06", "2025-01-05", ""), "window_reversed")
    assert.equal(checkCalendarWindow("2025-02-30", "2025-03-01", ""), "invalid_from")
    assert.equal(checkCalendarWindow("2025-01-01", 7, ""), "invalid_to")
    // only days in the years the server clock can be set in (2000 to 2100)
    assert.equal(checkCalendarWindow("1999-12-31", "2000-01-02", ""), "invalid_from")
    assert.equal(checkCalendarWindow("2100-12-30", "2101-01-01", ""), "invalid_to")
    assert.equal(typeof checkCalendarWindow("2000-01-01", "2100-12-31", ""), "object")
    assert.equal(checkCalendarWindow("2025-01-01", "2025-01-02", "x".repeat(101)), "invalid_label")
    assert.equal(checkCalendarWindow("2025-01-01", "2025-01-02", "line\nbreak"), "invalid_label")
    assert.deepEqual(checkCalendarWindow("2025-01-01", "2025-01-02", "  New year  "), { from: "2025-01-01", to: "2025-01-02", label: "New year" })
})

test("past a window's end the clock carries on at the next window's start, at the same time of day", async () => {
    const { advanceCalendar, windowBounds } = await calendar()
    const bounds = [windowBounds({ from: "2024-06-01", to: "2024-06-03", label: "" }), windowBounds({ from: "2024-12-10", to: "2024-12-11", label: "" })]
    const start = { index: 0, time: Date.parse("2024-06-03T12:00:00Z"), era: 0 }

    // inside the window: 1:1
    assert.deepEqual(advanceCalendar(bounds, start, 7 * HOUR), { index: 0, time: Date.parse("2024-06-03T19:00:00Z"), era: 0 })
    // 20:00 UTC on the last day is the switch, to the next window's first day (which starts at 20:00 UTC the day before)
    assert.deepEqual(advanceCalendar(bounds, start, 8 * HOUR), { index: 1, time: Date.parse("2024-12-09T20:00:00Z"), era: 0 })
    assert.deepEqual(advanceCalendar(bounds, start, 9 * HOUR), { index: 1, time: Date.parse("2024-12-09T21:00:00Z"), era: 0 })
    // after the last window: back to the first, a new era
    assert.deepEqual(advanceCalendar(bounds, start, 8 * HOUR + 2 * DAY), { index: 0, time: Date.parse("2024-05-31T20:00:00Z"), era: 1 })
})

test("a single window wraps onto itself, and every move back in time starts a new era", async () => {
    const { advanceCalendar, windowBounds } = await calendar()
    const one = [windowBounds({ from: "2025-01-03", to: "2025-01-30", label: "" })]
    const moved = advanceCalendar(one, { index: 0, time: Date.parse("2025-01-30T19:00:00Z"), era: 0 }, 2 * HOUR)
    assert.deepEqual(moved, { index: 0, time: Date.parse("2025-01-02T21:00:00Z"), era: 1 })

    // unsorted and overlapping windows: 2 → 1 goes back, 1 → 3 forward, 3 → 2 back (the wrap)
    const unsorted = [
        windowBounds({ from: "2024-03-10", to: "2024-03-12", label: "" }),
        windowBounds({ from: "2024-03-01", to: "2024-03-11", label: "" }),
        windowBounds({ from: "2024-05-01", to: "2024-05-01", label: "" })
    ]
    let position = { index: 0, time: unsorted[0].start, era: 0 }
    position = advanceCalendar(unsorted, position, 3 * DAY)
    assert.deepEqual([position.index, position.era], [1, 1])
    position = advanceCalendar(unsorted, position, 11 * DAY)
    assert.deepEqual([position.index, position.era], [2, 1])
    position = advanceCalendar(unsorted, position, DAY)
    assert.deepEqual([position.index, position.era], [0, 2])
})

test("a long downtime skips whole rounds and lands where walking day by day would", async () => {
    const { advanceCalendar, windowBounds } = await calendar()
    const bounds = [
        windowBounds({ from: "2023-01-01", to: "2023-01-02", label: "" }),
        windowBounds({ from: "2022-06-01", to: "2022-06-01", label: "" }),
        windowBounds({ from: "2024-02-27", to: "2024-03-02", label: "" })
    ]
    const start = { index: 0, time: bounds[0].start + 5 * HOUR, era: 3 }
    let stepped = start
    for (let i = 0; i < 1000; i++) stepped = advanceCalendar(bounds, stepped, DAY)
    assert.deepEqual(advanceCalendar(bounds, start, 1000 * DAY), stepped)
})

test("entering a calendar keeps a date inside a window, otherwise starts at the first window's first day", async () => {
    const { enterCalendar, windowBounds } = await calendar()
    const bounds = [windowBounds({ from: "2024-06-01", to: "2024-06-10", label: "" }), windowBounds({ from: "2024-06-05", to: "2024-06-20", label: "" })]
    const inBoth = Date.parse("2024-06-07T12:00:00Z")
    assert.deepEqual(enterCalendar(bounds, inBoth), { index: 0, time: inBoth })
    assert.deepEqual(enterCalendar(bounds, inBoth, 1), { index: 1, time: inBoth }, "the current window wins when it still holds the date")
    assert.deepEqual(enterCalendar(bounds, Date.parse("2025-03-01T12:00:00Z")), { index: 0, time: Date.parse("2024-06-01T12:00:00Z") })
})

// ---- the content the calendar works with ----

test("the default window is the default start's day to the last day a portal is open all day", async () => {
    const { DEFAULT_CALENDAR, DEFAULT_SERVER_TIME } = await clock()
    const { gameDayOf, windowBounds, GAME_DAY_MS } = await calendar()
    const { contentGapIn, contentRange } = await import("../src/lib/eventCalendar")
    const bounds = windowBounds(DEFAULT_CALENDAR[0])
    assert.equal(DEFAULT_CALENDAR[0].from, gameDayOf(Date.parse(`${DEFAULT_SERVER_TIME}Z`)))
    assert.equal(contentGapIn(bounds.start, bounds.end), null)
    assert.notEqual(contentGapIn(bounds.end, bounds.end + GAME_DAY_MS), null, "the next day closes the last portal")
    assert.equal(new Date(contentRange().end).toISOString(), "2025-01-31T05:00:00.000Z")
})

test("events come from the master data with their game days, and gaps without portals are found", async () => {
    const { contentGapIn, contentRange, eventWindow, getEvent, portalsIn } = await import("../src/lib/eventCalendar")
    const event = getEvent("advent_event/200056")
    assert.ok(event)
    // master dates are Japan time: 2024-12-17 14:00 is 05:00 UTC
    assert.equal(event.start.toISOString(), "2024-12-17T05:00:00.000Z")
    assert.deepEqual(eventWindow(event), { from: "2024-12-17", to: "2024-12-31", label: event.name })
    assert.equal(getEvent("advent_event/nope"), null)

    const { start, end } = contentRange()
    assert.equal(contentGapIn(start - HOUR, start + HOUR), start - HOUR, "before the first portal")
    assert.equal(contentGapIn(end - HOUR, end + HOUR), end, "after the last one")
    assert.equal(contentGapIn(start, end), null, "no gap in between")
    assert.deepEqual(portalsIn(Date.parse("2025-01-03T12:00:00Z"), Date.parse("2025-01-03T12:00:01Z")).map(portal => portal.id).sort(), ["184", "185", "5038"])
})

// ---- the server clock on the calendar ----

test("the default clock runs on the default calendar and wraps at the end of 30 January", async () => {
    freezeMachineTime()
    const { getClockStatus, getServerDate, setServerTime } = await clock()
    setServerTime(null)
    let status = getClockStatus()
    const eraBefore = status.era
    assert.equal(status.mode, "calendar")
    assert.equal(status.date.toISOString(), "2025-01-03T12:00:00.000Z")

    tick(10 * DAY)
    assert.equal(getServerDate().toISOString(), "2025-01-13T12:00:00.000Z", "1:1 inside the window")

    // 2025-01-30 20:00 UTC (05:00 on the 31st in Japan) is the switch: back to 2025-01-02 20:00 UTC, the start of game day 3 January
    tick(Date.parse("2025-01-30T19:59:59Z") - Date.parse("2025-01-13T12:00:00Z"))
    assert.equal(getServerDate().toISOString(), "2025-01-30T19:59:59.000Z")
    tick(1000)
    assert.equal(getServerDate().toISOString(), "2025-01-02T20:00:00.000Z")
    status = getClockStatus()
    assert.equal(status.era, eraBefore + 1)
    assert.equal(status.window?.index, 0)
})

test("after a wrap the repeated dates are new game days and months", async () => {
    freezeMachineTime()
    const { setServerTime, getClockEra } = await clock()
    const { gameDay } = await import("../src/lib/resets")
    assert.deepEqual(gameDay(new Date("2025-01-10T12:00:00Z"), 0), { day: "2025-01-10", month: "2025-01" })
    setServerTime(null)
    const eraBefore = getClockEra()
    const before = gameDay(new Date("2025-01-10T12:00:00Z"))
    tick(28 * DAY)
    assert.equal(getClockEra(), eraBefore + 1)
    const afterWrap = gameDay(new Date("2025-01-10T12:00:00Z"))
    assert.notEqual(afterWrap.day, before.day)
    assert.notEqual(afterWrap.month, before.month)
    assert.deepEqual(afterWrap, { day: `2025-01-10~${eraBefore + 1}`, month: `2025-01~${eraBefore + 1}` })
    // the month's digits stay where the shop's month check reads them
    assert.equal(afterWrap.month.slice(5, 7), "01")
})

test("every move back to an earlier game day starts an era, not only a wrap", async () => {
    freezeMachineTime()
    const { getClockEra, getServerDate, reloadServerClock, setCalendarWindows, setServerTime, startCalendar, stopCalendar } = await clock()
    const { gameDay } = await import("../src/lib/resets")
    const era = () => getClockEra()

    // an upgraded install ran freely past the content; "Run on the event calendar" takes it back to 3 January
    setServerTime(new Date("2025-01-10T12:00:00Z"))
    const bought = gameDay(getServerDate())
    let before = era()
    setServerTime(new Date("2025-02-10T12:00:00Z"))
    assert.equal(era(), before, "forward: the same era")
    assert.equal(startCalendar(), true)
    assert.equal(getServerDate().toISOString(), "2025-01-03T12:00:00.000Z")
    assert.equal(era(), before + 1)
    assert.notEqual(gameDay(new Date("2025-01-10T12:00:00Z")).month, bought.month, "the month bought under is a new one")

    // a date set by hand, and Reset
    before = era()
    setServerTime(new Date("2025-01-03T08:00:00Z"))
    assert.equal(era(), before, "earlier on the same game day: no new era")
    setServerTime(new Date("2025-01-02T12:00:00Z"))
    assert.equal(era(), before + 1)
    setServerTime(new Date("2025-01-20T12:00:00Z"))
    setServerTime(null)
    assert.equal(era(), before + 2, "Reset to 3 January")

    // removing the current window falls back to the first window's start
    setCalendarWindows([{ from: "2025-01-03", to: "2025-01-05", label: "A" }, { from: "2025-01-20", to: "2025-01-25", label: "B" }])
    setServerTime(new Date("2025-01-21T12:00:00Z"))
    assert.equal(startCalendar(), true)
    before = era()
    setCalendarWindows([{ from: "2025-01-03", to: "2025-01-05", label: "A" }])
    assert.equal(getServerDate().toISOString(), "2025-01-03T12:00:00.000Z")
    assert.equal(era(), before + 1)
    // "Restore default" from a window later in January, the same
    setCalendarWindows([{ from: "2025-01-20", to: "2025-01-25", label: "B" }])
    before = era()
    setCalendarWindows(null)
    assert.equal(era(), before, "B's 20 January lies in the default window: the clock stays")
    stopCalendar()
    setServerTime(new Date("2025-01-29T12:00:00Z"))
    assert.equal(startCalendar(), true)
    setCalendarWindows([{ from: "2025-01-03", to: "2025-01-10", label: "Early" }])
    assert.equal(era(), before + 1)

    // the era is stored: a restart keeps it
    const stored = era()
    reloadServerClock()
    assert.equal(era(), stored)

    // a changed SERVER_TIME starts the clock again there; earlier than the stored clock, in a new era
    process.env.SERVER_TIME = "2025-01-02T12:00:00"
    reloadServerClock()
    assert.equal(getServerDate().toISOString(), "2025-01-02T12:00:00.000Z")
    assert.equal(era(), stored + 1)
})

test("a changed SERVER_TIME at a restart compares with where the clock stands now, not with its anchor", async () => {
    freezeMachineTime()
    const { getClockEra, getServerDate, reloadServerClock, setServerTime } = await clock()
    setServerTime(null)
    const before = getClockEra()
    // 17 days of uptime inside the default window: the anchor is still 3 January, the clock shows the 20th
    tick(17 * DAY)
    assert.equal(getServerDate().toISOString(), "2025-01-20T12:00:00.000Z")
    // a restart on an earlier start than the clock shows, though later than its anchor: a move back
    process.env.SERVER_TIME = "2025-01-10T12:00:00"
    reloadServerClock()
    assert.equal(getServerDate().toISOString(), "2025-01-10T12:00:00.000Z")
    assert.equal(getClockEra(), before + 1)
    // and a calendar wrap during the downtime counts too: on the default calendar again, off for 25 days
    delete process.env.SERVER_TIME
    reloadServerClock()
    const wrapped = getClockEra()
    tick(28 * DAY) // the stored clock (3 January) would have wrapped back to the 3rd by now
    process.env.SERVER_TIME = "2025-01-29T12:00:00"
    reloadServerClock()
    assert.equal(getClockEra(), wrapped + 1, "the wrap it missed")
})

test("leaving SERVER_TIME=real for an earlier date at a restart starts an era", async () => {
    freezeMachineTime("2026-10-30T10:00:00Z")
    const { getClockEra, getServerDate, reloadServerClock, setServerTime } = await clock()
    setServerTime(null)
    const before = getClockEra()
    process.env.SERVER_TIME = "real"
    reloadServerClock()
    assert.equal(getServerDate().toISOString(), "2026-10-30T10:00:00.000Z")
    assert.equal(getClockEra(), before, "forward to the machine's date")
    tick(HOUR)
    delete process.env.SERVER_TIME
    reloadServerClock()
    assert.equal(getServerDate().toISOString(), "2025-01-03T12:00:00.000Z")
    assert.equal(getClockEra(), before + 1, "back from 2026 to 2025")
})

test("the machine's clock going back never takes the server clock back with it", async () => {
    freezeMachineTime("2026-10-30T10:00:00Z")
    const { getClockEra, getClockStatus, getServerDate, reloadServerClock, setCalendarWindows, setServerTime, startCalendar } = await clock()
    setServerTime(new Date("2025-01-03T21:00:00Z")) // one hour into game day 2025-01-04
    setCalendarWindows([{ from: "2025-01-04", to: "2025-01-30", label: "A" }])
    assert.equal(startCalendar(), true)
    tick(2 * HOUR)
    assert.equal(getServerDate().toISOString(), "2025-01-03T23:00:00.000Z")
    const era = getClockEra()
    // a VM restored, an NTP fix: the machine goes back three hours, before the window's start
    mock.timers.setTime(Date.parse("2026-10-30T09:00:00Z"))
    assert.equal(getServerDate().toISOString(), "2025-01-03T23:00:00.000Z", "it carries on from where it stood")
    tick(HOUR)
    assert.equal(getServerDate().toISOString(), "2025-01-04T00:00:00.000Z")
    assert.deepEqual([getClockStatus().mode, getClockStatus().window?.index, getClockEra()], ["calendar", 0, era])
    // across a restart only the stored anchor is known: the clock carries on from it, never before it
    mock.timers.setTime(Date.parse("2026-10-30T08:00:00Z"))
    reloadServerClock()
    assert.equal(getServerDate().toISOString(), "2025-01-03T23:00:00.000Z")
    assert.equal(getClockEra(), era)
})

test("a wrap read inside a transaction that rolls back keeps its era once the clock is stored again", async () => {
    freezeMachineTime()
    const { getClockEra, getServerDate, reloadServerClock, setServerTime, stopCalendar } = await clock()
    const { runInTransactionSync } = await import("../src/data/wdfpData")
    setServerTime(null)
    const before = getClockEra()
    tick(28 * DAY)
    // a request in an atomicHandler reads the clock past the wrap, then answers 4xx: its writes are rolled back
    runInTransactionSync(() => getServerDate(), () => true)
    assert.equal(getClockEra(), before + 1)
    // a later change stores the clock again; a restart must find the era with it
    stopCalendar()
    reloadServerClock()
    assert.equal(getClockEra(), before + 1)
    // and a restart straight after the rolled-back walk walks to the same era again
    setServerTime(null)
    const second = getClockEra()
    tick(28 * DAY)
    runInTransactionSync(() => getServerDate(), () => true)
    reloadServerClock()
    assert.equal(getClockEra(), second + 1)
    assert.equal(getServerDate().toISOString(), "2025-01-03T12:00:00.000Z")
})

test("the calendar's position, rotation and era survive a restart", async () => {
    freezeMachineTime()
    const { getClockStatus, getServerDate, reloadServerClock, setCalendarWindows, setServerTime } = await clock()
    setCalendarWindows([{ from: "2024-06-01", to: "2024-06-02", label: "A" }, { from: "2024-03-01", to: "2024-03-01", label: "B" }])
    setServerTime(new Date("2024-06-02T10:00:00Z"))
    const { startCalendar } = await clock()
    assert.equal(startCalendar(), true)
    tick(12 * HOUR) // past 20:00 on 2 June: on to B, back in time
    assert.equal(getServerDate().toISOString(), "2024-02-29T22:00:00.000Z")
    const eraBefore = getClockStatus().era

    reloadServerClock()
    tick(HOUR)
    assert.equal(getServerDate().toISOString(), "2024-02-29T23:00:00.000Z", "carries on after the restart")
    const status = getClockStatus()
    assert.deepEqual([status.mode, status.window?.index, status.window?.window.label, status.era], ["calendar", 1, "B", eraBefore])

    // a restart after the server was off for two days walks the windows it missed: 21 h left in B, then 27 h into A
    reloadServerClock()
    tick(2 * DAY)
    assert.equal(getServerDate().toISOString(), "2024-06-01T23:00:00.000Z")
})

test("setting a time stops the calendar, and Reset starts the default clock on it again", async () => {
    freezeMachineTime()
    const { getClockStatus, setServerTime, startCalendar, stopCalendar } = await clock()
    setServerTime(new Date("2025-01-20T08:00:00Z"))
    assert.equal(getClockStatus().mode, "free")
    tick(20 * DAY)
    assert.equal(getClockStatus().date.toISOString(), "2025-02-09T08:00:00.000Z", "runs on freely, past the content")

    // turning the calendar on outside its windows starts at the first window's first day, same time of day
    assert.equal(startCalendar(), true)
    assert.equal(getClockStatus().date.toISOString(), "2025-01-03T08:00:00.000Z")
    stopCalendar()
    tick(HOUR)
    assert.deepEqual([getClockStatus().mode, getClockStatus().date.toISOString()], ["free", "2025-01-03T09:00:00.000Z"])

    setServerTime(null)
    assert.deepEqual([getClockStatus().mode, getClockStatus().date.toISOString()], ["calendar", "2025-01-03T12:00:00.000Z"])
})

test("changing the rotation while it runs keeps the current window when it can; an empty one stops the calendar", async () => {
    freezeMachineTime()
    const { getClockStatus, setCalendarWindows, setServerTime, startCalendar } = await clock()
    setServerTime(null)
    // a new first window that doesn't hold the date: the clock stays in the default one, now second
    setCalendarWindows([{ from: "2024-06-01", to: "2024-06-05", label: "June" }, { from: "2025-01-03", to: "2025-01-30", label: "January" }])
    assert.deepEqual([getClockStatus().window?.index, getClockStatus().date.toISOString()], [1, "2025-01-03T12:00:00.000Z"])
    // the window holding the date is removed: on to the first window's first day
    setCalendarWindows([{ from: "2024-06-01", to: "2024-06-05", label: "June" }])
    assert.deepEqual([getClockStatus().window?.index, getClockStatus().date.toISOString()], [0, "2024-06-01T12:00:00.000Z"])
    // empty: the clock runs on freely from where it is, and can't be put back on the calendar
    setCalendarWindows([])
    assert.deepEqual([getClockStatus().mode, getClockStatus().date.toISOString()], ["free", "2024-06-01T12:00:00.000Z"])
    assert.equal(startCalendar(), false)
    // and Reset then runs freely too: the default time lies in no window
    setServerTime(null)
    assert.equal(getClockStatus().mode, "free")
})

test("an anchor stored before the calendar existed keeps running freely, and broken stored windows are dropped", async () => {
    freezeMachineTime()
    const { getClockStatus, reloadServerClock } = await clock()
    const { setStoredText } = await import("../src/data/serverSettings")
    setStoredText("clock.anchor", JSON.stringify({ date: "2025-01-25T00:00:00.000Z", setAt: Date.now(), start: "2025-01-03T12:00:00.000Z" }))
    setStoredText("clock.calendar", JSON.stringify({ windows: [{ from: "2024-06-01", to: "2024-06-02" }, { from: "2024-06-09", to: "2024-06-01" }, "junk", null] }))
    reloadServerClock()
    const status = getClockStatus()
    assert.deepEqual([status.mode, status.date.toISOString()], ["free", "2025-01-25T00:00:00.000Z"])
    const { getCalendarWindows } = await clock()
    assert.deepEqual(getCalendarWindows(), [{ from: "2024-06-01", to: "2024-06-02", label: "2024-06-01 to 2024-06-02" }])

    setStoredText("clock.calendar", "{not json")
    reloadServerClock()
    assert.deepEqual(getCalendarWindows(), [])
})

test("SERVER_CLOCK=frozen stops the calendar too, and SERVER_TIME=real follows the machine", async () => {
    freezeMachineTime()
    const { getClockStatus, reloadServerClock, setServerTime, startCalendar } = await clock()
    process.env.SERVER_CLOCK = "frozen"
    reloadServerClock()
    assert.deepEqual([getClockStatus().mode, getClockStatus().frozen], ["calendar", true])
    tick(40 * DAY)
    assert.equal(getClockStatus().date.toISOString(), "2025-01-03T12:00:00.000Z")

    process.env.SERVER_CLOCK = "running"
    process.env.SERVER_TIME = "real"
    reloadServerClock()
    assert.deepEqual([getClockStatus().mode, getClockStatus().date.toISOString()], ["real", new Date().toISOString()])
    // the calendar can still run until a restart; it starts in its first window (the real date is past the content)
    assert.equal(startCalendar(), true)
    assert.equal(getClockStatus().mode, "calendar")
    reloadServerClock()
    assert.equal(getClockStatus().mode, "real")
    delete process.env.SERVER_TIME
    reloadServerClock()
    setServerTime(null)
})

test("a warning tells when a clock leaves the content, following the calendar's switches", async () => {
    freezeMachineTime()
    const { setServerTime, startCalendar } = await clock()
    const { contentWarning } = await import("../src/lib/eventCalendar")
    setServerTime(new Date("2025-01-27T05:00:00Z"))
    const leaving = contentWarning()
    assert.equal(leaving?.kind, "leaving")
    assert.equal(leaving?.clockDate.toISOString(), "2025-01-31T05:00:00.000Z")
    assert.equal(leaving?.inMs, 4 * DAY)

    setServerTime(new Date("2025-02-03T00:00:00Z"))
    assert.equal(contentWarning()?.kind, "outside")
    assert.equal(contentWarning()?.inMs, 0)

    // on the calendar the clock wraps at 20:00 UTC on 30 January, nine hours before the last portal closes
    setServerTime(new Date("2025-01-28T12:00:00Z"))
    startCalendar()
    assert.equal(contentWarning(), null)
    // a player a day ahead gets there before the wrap
    const ahead = contentWarning(1)
    assert.deepEqual([ahead?.kind, ahead?.clockDate.toISOString(), ahead?.inMs], ["leaving", "2025-01-31T05:00:00.000Z", DAY + 17 * HOUR])
    // a player before the first portal is outside
    assert.equal(contentWarning(-3000)?.kind, "outside")
})

// ---- the admin site ----

test("the Calendar page lists the rotation and the events", async () => {
    const page = await admin.inject({ method: "GET", url: "/calendar" })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Default: 3 to 30 January 2025/)
    assert.match(page.body, /badge-on">now/)
    assert.match(page.body, /value="advent_event\/200056"/)
    assert.match(page.body, /href="\/calendar" class="nav-link nav-link-active"/)

    // the events that can be added come first; a disabled Add keeps its name and points at the chip that says why
    const events = page.body.slice(page.body.indexOf("<h2 class=\"card-title\">Events</h2>"))
    const firstDisabled = events.indexOf("disabled")
    assert.ok(firstDisabled > 0)
    assert.equal(events.indexOf('value="event"', firstDisabled), -1, "no addable event after the first disabled one")
    for (const [, label, gapId] of events.matchAll(/<button type="button" class="btn-outline" disabled aria-label="([^"]+)" aria-describedby="([^"]+)">Add<\/button>/g)) {
        assert.match(label, /^Add to the rotation: /)
        assert.match(events, new RegExp(`<span class="chip-warning" id="${gapId}">no portal from`))
    }
})

test("every notice code the calendar routes send renders a notice on the page they return to", async () => {
    const { readFileSync } = await import("fs")
    // the codes in the sources, so a new one can't miss its text
    const rotation = readFileSync("src/lib/eventCalendar.ts", "utf-8") + readFileSync("src/lib/calendar.ts", "utf-8")
    const errors = new Set([...rotation.matchAll(/ok: false, code: "(\w+)"|return "(invalid_\w+|window_\w+)"|null \? "(\w+)"/g)].map(match => match[1] ?? match[2] ?? match[3]))
    const messages = new Set([...rotation.matchAll(/ok: true, code: "(\w+)"/g)].map(match => match[1]))
    const modeRoute = readFileSync("src/routes/web_api/server.ts", "utf-8")
    const mode = [...modeRoute.matchAll(/\$\{page\}\?(error|message)=(\w+)/g)].map(match => [match[1], match[2]] as const)
    assert.ok(errors.size >= 9 && messages.size >= 4 && mode.length === 3, `${[...errors]} ${[...messages]} ${mode}`)

    const notice = async (url: string) => (await admin.inject({ method: "GET", url })).body.match(/<div class="notice-(error|info)">([^<]+)<\/div>/)
    const table: [string, "error" | "info"][] = [
        ...[...errors].map(code => [`/calendar?error=${code}`, "error"] as [string, "error"]),
        ...[...messages].map(code => [`/calendar?message=${code}`, "info"] as [string, "info"]),
        ...mode.flatMap(([kind, code]) => ["/calendar", "/"].map(page => [`${page}?${kind}=${code}`, kind === "error" ? "error" : "info"] as [string, "error" | "info"]))
    ]
    for (const [url, kind] of table) {
        const found = await notice(url)
        assert.equal(found?.[1], kind, url)
        assert.ok(found![2].length > 10, url)
    }
    // an unknown code shows nothing
    assert.equal(await notice("/calendar?error=nope&message=nope"), null)
})

test("a frozen clock's warning doesn't count down", async () => {
    process.env.SERVER_CLOCK = "frozen"
    const { reloadServerClock, setServerTime } = await clock()
    reloadServerClock()
    try {
        setServerTime(new Date("2025-01-29T12:00:00Z"))
        const dashboard = (await admin.inject({ method: "GET", url: "/" })).body
        assert.match(dashboard, /The server clock is frozen 1 day 17 h before a date with no summoning portal open/)
        assert.doesNotMatch(dashboard, /reaches a date with no summoning portal open in/)
        assert.match((await admin.inject({ method: "GET", url: "/calendar" })).body, /is frozen 1 day 17 h before/)
    } finally {
        process.env.SERVER_CLOCK = "running"
        reloadServerClock()
    }
})

test("windows are added from events or as ranges of days, moved and removed", async () => {
    const { getCalendarWindows } = await clock()
    assert.equal(await post("/api/server/calendar/windows", { action: "event", event: "advent_event/200056" }), "/calendar?message=window_added")
    assert.equal(await post("/api/server/calendar/windows", { action: "add", from: "2024-07-01", to: "2024-07-03", label: "July" }), "/calendar?message=window_added")
    const { eventWindow, getEvent } = await import("../src/lib/eventCalendar")
    assert.deepEqual(getCalendarWindows(), [
        { from: "2025-01-03", to: "2025-01-30", label: "Default: 3 to 30 January 2025" },
        eventWindow(getEvent("advent_event/200056")!),
        { from: "2024-07-01", to: "2024-07-03", label: "July" }
    ])

    assert.equal(await post("/api/server/calendar/windows", { action: "up", index: "2" }), "/calendar?message=window_moved")
    assert.equal(getCalendarWindows()[1].label, "July")
    assert.equal(await post("/api/server/calendar/windows", { action: "down", index: "2" }), "/calendar?error=window_at_end", "the last can't go further down: nothing moves")
    assert.equal(await post("/api/server/calendar/windows", { action: "remove", index: "0" }), "/calendar?message=window_removed")
    assert.equal(getCalendarWindows()[0].label, "July")
    assert.equal(await post("/api/server/calendar/windows", { action: "remove", index: "5" }), "/calendar?error=unknown_window")
    assert.equal(await post("/api/server/calendar/windows", { action: "default" }), "/calendar?message=calendar_default")
    assert.equal(getCalendarWindows().length, 1)
})

test("removing or moving a window needs a real index: an empty one doesn't mean the first", async () => {
    const { getCalendarWindows } = await clock()
    const { changeRotation } = await import("../src/lib/eventCalendar")
    assert.equal(await post("/api/server/calendar/windows", { action: "add", from: "2024-07-01", to: "2024-07-03", label: "July" }), "/calendar?message=window_added")
    const windows = getCalendarWindows()
    for (const index of ["", " ", "0x1", "1.5", "-1", "1e1", "abc", "1000"]) {
        const response = await admin.inject({
            method: "POST", url: "/api/server/calendar/windows",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: new URLSearchParams({ action: "remove", index }).toString()
        })
        assert.equal(response.statusCode, 400, JSON.stringify(index))
        assert.deepEqual(changeRotation({ action: "remove", index }), { ok: false, code: "unknown_window" }, JSON.stringify(index))
    }
    assert.deepEqual(changeRotation({ action: "remove" }), { ok: false, code: "unknown_window" }, "no index")
    assert.equal(await post("/api/server/calendar/windows", { action: "remove", index: "99" }), "/calendar?error=unknown_window", "digits past the rotation")
    assert.deepEqual(getCalendarWindows(), windows)
    assert.equal(await post("/api/server/calendar/windows", { action: "remove", index: "1" }), "/calendar?message=window_removed")
    assert.equal(getCalendarWindows().length, 1)
})

test("a stored window outside the rotation (negative or past its end) runs freely instead of failing", async () => {
    freezeMachineTime()
    const { getClockStatus, reloadServerClock } = await clock()
    const { setStoredText } = await import("../src/data/serverSettings")
    for (const window of [-1, 1, 1.5, "0"]) {
        setStoredText("clock.anchor", JSON.stringify({ date: "2025-01-10T00:00:00.000Z", setAt: Date.now(), start: "2025-01-03T12:00:00.000Z", window }))
        reloadServerClock()
        assert.deepEqual([getClockStatus().mode, getClockStatus().date.toISOString()], ["free", "2025-01-10T00:00:00.000Z"], String(window))
        for (const url of ["/", "/calendar"]) assert.equal((await admin.inject({ method: "GET", url })).statusCode, 200, `${url} with window ${window}`)
    }
})

test("windows without portals, reversed or invalid days and unknown events change nothing", async () => {
    const { getCalendarWindows } = await clock()
    const cases: [Record<string, string>, string][] = [
        [{ action: "add", from: "2025-02-01", to: "2025-02-10" }, "no_portal"],
        [{ action: "add", from: "2018-09-01", to: "2018-10-10" }, "no_portal"],
        [{ action: "event", event: "raid_event/5" }, "no_portal"],
        [{ action: "add", from: "2024-07-03", to: "2024-07-01" }, "window_reversed"],
        [{ action: "add", from: "2024-02-30", to: "2024-03-01" }, "invalid_from"],
        [{ action: "add", from: "2024-03-01" }, "invalid_to"],
        [{ action: "event", event: "story_event/0" }, "unknown_event"]
    ]
    for (const [form, code] of cases) assert.equal(await post("/api/server/calendar/windows", form), `/calendar?error=${code}`, JSON.stringify(form))
    assert.equal(getCalendarWindows().length, 1)
    // the API can insist, as for the server clock
    assert.equal(await post("/api/server/calendar/windows", { action: "add", from: "2025-02-01", to: "2025-02-10", force: "1" }), "/calendar?message=window_added")
    const unknownAction = await admin.inject({ method: "POST", url: "/api/server/calendar/windows", payload: { action: "explode" } })
    assert.equal(unknownAction.statusCode, 400)
})

test("the calendar is turned on and off from its page and from the dashboard warning", async () => {
    freezeMachineTime()
    const { getClockStatus, setServerTime } = await clock()
    setServerTime(new Date("2025-01-29T12:00:00Z"))
    const dashboard = await admin.inject({ method: "GET", url: "/" })
    assert.match(dashboard.body, /reaches a date with no summoning portal open in 1 day 17 h/)
    assert.match(dashboard.body, /action="\/api\/server\/calendar\/mode"/)

    assert.equal(await post("/api/server/calendar/mode", { mode: "on", back: "dashboard" }), "/?message=calendar_on")
    assert.equal(getClockStatus().mode, "calendar")
    assert.doesNotMatch((await admin.inject({ method: "GET", url: "/" })).body, /no summoning portal/)
    assert.equal(await post("/api/server/calendar/mode", { mode: "off" }), "/calendar?message=calendar_off")
    assert.equal(getClockStatus().mode, "free")

    const json = (await admin.inject({ method: "GET", url: "/api/server/clock" })).json()
    assert.equal(json.mode, "free")
    assert.equal(json.warning.kind, "leaving")
    assert.equal(json.windows.length, 1)
})

test("another site can't change the calendar", async () => {
    const { getCalendarWindows } = await clock()
    const response = await admin.inject({
        method: "POST", url: "/api/server/calendar/windows",
        headers: { "content-type": "application/x-www-form-urlencoded", "origin": "https://evil.example", "sec-fetch-site": "cross-site" },
        payload: "action=remove&index=0"
    })
    assert.equal(response.statusCode, 403)
    assert.equal(getCalendarWindows().length, 1)
})
