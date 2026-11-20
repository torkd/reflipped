// FT-47: the admin Calendar page (event scheduling on) lists the balance changes of the shared timeline: how many have
// landed, the next ones with a "Go to" set to their landing day, and all of them.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import calendar from "../assets/event_calendar.json";
import { createTestServer } from "./helpers";

const FIRST_EVENT = calendar.events.reduce((a, b) => a.start <= b.start ? a : b).id
const LAST_EVENT = calendar.events.reduce((a, b) => a.start >= b.start ? a : b).id

let admin: FastifyInstance
let cleanup: () => Promise<void>
let schedule: typeof import("../src/lib/eventSchedule")
let events: typeof import("../src/lib/eventPolicy")
let landings: typeof import("../src/lib/balanceChanges").balanceLandings

before(async () => {
    ({ admin, cleanup } = await createTestServer())
    schedule = await import("../src/lib/eventSchedule")
    events = await import("../src/lib/eventPolicy")
    landings = (await import("../src/lib/balanceChanges")).balanceLandings
})

afterEach(() => {
    delete process.env.EVENT_SCHEDULING
    process.env.SERVER_CLOCK = "frozen"
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "classic" })
})

after(async () => {
    await cleanup()
})

async function calendarPageAt(eventId: string): Promise<string> {
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
    assert.equal(schedule.jumpToEventSync(eventId), "ok")
    const response = await admin.inject({ method: "GET", url: "/calendar" })
    assert.equal(response.statusCode, 200)
    return response.body
}

test("the balance landings: board waves and changes in order", () => {
    const all = landings()
    assert.ok(all.length > 30)
    assert.deepEqual(all.map(l => l.time), [...all.map(l => l.time)].sort((a, b) => a - b))
    assert.equal(all[0].kind, "board2")
    assert.ok(all.some(l => l.kind === "change" && l.label.startsWith("Armament buffs")))
    assert.ok(all.some(l => l.kind === "change" && l.label.startsWith("Unit buffs (200 units)")))
})

test("at the archive's start nothing has landed; the next ones are listed with Go to on their landing day", async () => {
    const page = await calendarPageAt(FIRST_EVENT)
    const total = landings().length
    assert.match(page, /<h2 class="card-title">Balance changes<\/h2>/)
    assert.match(page, new RegExp(`0 of ${total} have landed`))
    // the first board wave (58 units and two story copies) lands on Not Today, Romero's first day (Japan's wave came
    // five days before its event)
    assert.match(page, /Second mana boards for 60 units<\/span><p class="card-text">Lands on the archive's 2022-05-13 · Not Today, Romero, day 1/)
    // the second at the start of The Descension's last game day: its Go to selects the first day at or after it
    assert.match(page, /Lands on the archive's 2022-06-19 · The Descension: A Requiem for You, day 8/)
    assert.match(page, /value="advent_event\/9" \/><div class="unit-input">.*?value="8"/)
})

test("at the archive's end every change has landed", async () => {
    const page = await calendarPageAt(LAST_EVENT)
    const total = landings().length
    assert.match(page, new RegExp(`${total} of ${total} have landed`))
    assert.match(page, /Every balance change has landed\./)
})
