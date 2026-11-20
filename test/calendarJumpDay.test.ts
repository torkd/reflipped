// The Calendar page's "Go to" with a day (POST /api/server/calendar/jump, `day`): the timeline lands that many days after
// the event's opening; a later day of the event already open carries on its run, any other jump starts a new one; a
// day outside the event is refused. With event scheduling off, the server clock moves to that day instead.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

const EVENT = "advent_event/200056"
const OTHER_EVENT = "advent_event/200053"
const DAY_MS = 24 * 60 * 60 * 1000

let admin: FastifyInstance
let cleanup: () => Promise<void>
let schedule: typeof import("../src/lib/eventSchedule")
let events: typeof import("../src/lib/eventPolicy")

before(async () => {
    ({ admin, cleanup } = await createTestServer())
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

async function jump(form: Record<string, string>): Promise<string> {
    const response = await admin.inject({
        method: "POST", url: "/api/server/calendar/jump",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(form).toString()
    })
    assert.equal(response.statusCode, 302, response.body)
    return String(response.headers.location)
}

const find = (id: string) => schedule.eventCatalog.find(entry => entry.id === id)!

function assertContentNear(expected: number, label: string) {
    const view = schedule.getEventScheduleView()
    assert.ok(view.contentTime >= expected && view.contentTime < expected + 60_000,
        `${label}: ${new Date(view.contentTime).toISOString()}, expected ${new Date(expected).toISOString()}`)
}

test("the events used here last long enough for a later day", () => {
    assert.ok(schedule.eventDayCount(find(EVENT)) >= 5, `${EVENT}: ${schedule.eventDayCount(find(EVENT))} days`)
    assert.ok(schedule.eventDayCount(find(OTHER_EVENT)) >= 3)
})

test("Classic and Accelerated: a later day of an event not running starts a new run there", async () => {
    scheduling()
    for (const mode of ["classic", "accelerated"] as const) {
        events.setEventPolicy({ ...events.getEventPolicy(), mode, acceleration: 3 })
        assert.equal(await jump({ event: OTHER_EVENT }), "/calendar?message=event_jump")
        const before = events.getEventPolicy().rotationId
        assert.equal(await jump({ event: EVENT, day: "3" }), "/calendar?message=event_day_jump")
        assertContentNear(find(EVENT).startTime + 2 * DAY_MS, `${mode}, day 3`)
        assert.notEqual(events.getEventPolicy().rotationId, before, `${mode}: a new run`)
    }
})

test("a later day of the event already running carries on its run", async () => {
    scheduling()
    assert.equal(await jump({ event: EVENT }), "/calendar?message=event_jump")
    const run = events.getEventPolicy().rotationId
    assert.equal(await jump({ event: EVENT, day: "5" }), "/calendar?message=event_day_jump")
    assertContentNear(find(EVENT).startTime + 4 * DAY_MS, "day 5")
    assert.equal(events.getEventPolicy().rotationId, run, "the same run")
    // and back to an earlier day of it, still the same run
    assert.equal(await jump({ event: EVENT, day: "2" }), "/calendar?message=event_day_jump")
    assertContentNear(find(EVENT).startTime + DAY_MS, "day 2")
    assert.equal(events.getEventPolicy().rotationId, run)
    // day 1 (or no day) is the opening, as a new run
    assert.equal(await jump({ event: EVENT, day: "1" }), "/calendar?message=event_jump")
    assertContentNear(find(EVENT).startTime, "day 1")
    assert.notEqual(events.getEventPolicy().rotationId, run, "a new run")
})

test("a day outside the event changes nothing", async () => {
    scheduling()
    assert.equal(await jump({ event: EVENT }), "/calendar?message=event_jump")
    const policy = events.getEventPolicy()
    const days = schedule.eventDayCount(find(EVENT))
    for (const day of ["0", "-1", String(days + 1), "2.5", "x"]) {
        assert.equal(await jump({ event: EVENT, day }), "/calendar?error=invalid_day", `day ${day}`)
    }
    assert.deepEqual(events.getEventPolicy(), policy)
    assert.equal(await jump({ event: EVENT, day: String(days) }), "/calendar?message=event_day_jump", "the last day")
    assert.equal(await jump({ event: "advent_event/0", day: "2" }), "/calendar?error=unknown_event")
})

test("Manual: a later day of a playlist event, and none of an event outside it", async () => {
    scheduling()
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "manual" })
    const event = find(EVENT)
    const from = new Date(event.startTime).toISOString().slice(0, 10)
    const to = new Date(event.endTime - 1000).toISOString().slice(0, 10)
    schedule.setManualWindows([{ from, to, label: event.name, eventId: EVENT }])
    assert.equal(await jump({ event: EVENT, day: "4" }), "/calendar?message=event_day_jump")
    assertContentNear(event.startTime + 3 * DAY_MS, "manual, day 4")
    assert.equal(await jump({ event: OTHER_EVENT, day: "2" }), "/calendar?error=event_not_in_playlist")
})

test("scheduling off: the server clock moves to that day of the event", async () => {
    const { getServerDate } = await import("../src/lib/serverClock")
    const { listEvents } = await import("../src/lib/eventCalendar")
    const event = listEvents().find(entry => entry.id === EVENT)!
    assert.equal(await jump({ event: EVENT, day: "3" }), "/calendar?message=event_day_jump")
    const now = getServerDate().getTime()
    const expected = event.start.getTime() + 2 * DAY_MS
    assert.ok(now >= expected && now < expected + 60_000, new Date(now).toISOString())
    assert.equal(await jump({ event: EVENT, day: "99" }), "/calendar?error=invalid_day")
})

test("the Calendar page offers a day beside Go to", async () => {
    scheduling()
    const response = await admin.inject({ method: "GET", url: `/calendar?q=${encodeURIComponent(find(EVENT).name)}` })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, new RegExp(`name="day" type="number" min="1" max="${schedule.eventDayCount(find(EVENT))}"`))
    const notice = await admin.inject({ method: "GET", url: "/calendar?message=event_day_jump" })
    assert.match(notice.body, /carries on with the progress made so far/)
})
