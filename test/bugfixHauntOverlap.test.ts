// FT-77: the client's Haunt screen (`TowerDungeonQuestSelectScene.prepareScene`) throws client error 3092 unless
// exactly ten battle quests are within their period at the scene's time. The master's periods overlap where the global
// and Japanese schedules meet (August to October 2024), and the cycles from February 2025 on have no end but a yearly
// window, so the projected master must carry the back-to-back periods the server opens (`towerCycleAt`).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import towerQuests from "../assets/tower_dungeon_event_quest.json";
import { buildOrderedMap, decodeOrderedMap, walkLeaves } from "../src/lib/orderedmap";
import type { ScheduleProjection } from "../src/lib/scheduleOverlay";
import { createTestServer } from "./helpers";

const TABLE = "quest/event/tower_dungeon_event_quest"
const jst = (text: string) => Date.parse(`${text.replace(" ", "T")}+09:00`)
const quests = towerQuests as Record<string, { start: string, end: string | null }>

let cleanup: () => Promise<void>
let overlay: typeof import("../src/lib/scheduleOverlay")
let tower: typeof import("../src/lib/towerDungeon")
let schedule: typeof import("../src/lib/eventSchedule")
let policy: typeof import("../src/lib/eventPolicy")
const saved = { clock: process.env.SERVER_CLOCK, scheduling: process.env.EVENT_SCHEDULING }

before(async () => {
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
    ;({ cleanup } = await createTestServer())
    overlay = await import("../src/lib/scheduleOverlay")
    tower = await import("../src/lib/towerDungeon")
    schedule = await import("../src/lib/eventSchedule")
    policy = await import("../src/lib/eventPolicy")
})

after(async () => {
    await cleanup()
    if (saved.clock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = saved.clock
    if (saved.scheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = saved.scheduling
})

/**
 * The CDN master as the client 0.0.81 ships it, for the columns that matter: 0 the quest id, 5 and 6 the period, 7 and
 * 8 the yearly window. The cycles without an end carry one (1361: 08-20 to 09-20, then a month later each).
 */
function cdnMaster(): Buffer {
    const leaves: [string, string[][]][] = Object.keys(quests).map(Number).sort((a, b) => a - b).map(id => {
        const row = Array(116).fill("(None)") as string[]
        const quest = quests[String(id)]
        row[0] = String(id)
        row[2] = "The Haunt"
        row[5] = quest.start
        row[6] = quest.end ?? "(None)"
        if (quest.end === null) {
            const month = (7 + Math.floor((id - 1361) / 10)) % 12
            const pad = (value: number) => String(value).padStart(2, "0")
            row[7] = `${pad(month + 1)}-20 05:00:00`
            row[8] = `${pad((month + 1) % 12 + 1)}-20 04:59:59`
        }
        return [String(id - 1000), [row]]
    })
    return buildOrderedMap([["1", buildOrderedMap(leaves)]]).encode()
}

interface ClientQuest { id: number, start: number, end: number | null, annual: [string, string] | null }

function decodeMaster(bytes: Buffer): ClientQuest[] {
    return [...walkLeaves(decodeOrderedMap(bytes))].map(({ leaf }) => {
        const row = leaf.records[0]
        return {
            id: Number(row[0]),
            start: overlay.parseScheduleMasterDate(row[5])!,
            end: row[6] === "(None)" ? null : overlay.parseScheduleMasterDate(row[6])!,
            annual: row[7] === "(None)" ? null : [row[7], row[8]]
        }
    })
}

/** The projected master as the client reads it. */
function clientQuests(projection: ScheduleProjection | null): ClientQuest[] {
    const raw = cdnMaster()
    const result = overlay.buildScheduleOverlay({ readMaster: table => table === TABLE ? raw : undefined }, projection, [TABLE])
    assert.equal(result.files, 1)
    const archive = result.archive
    const size = archive.readUInt32LE(18)
    const offset = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28)
    const member = archive.subarray(offset, offset + size)
    return decodeMaster(archive.readUInt16LE(8) === 8 ? inflateRawSync(member) : member)
}

/** The quests the client's Haunt screen counts at a client time: within the period (end second included) and the yearly window. */
function openAt(master: ClientQuest[], time: number): number[] {
    const monthDay = new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(5, 19).replace("T", " ")
    return master.filter(quest => quest.start <= time && (quest.end === null || time < quest.end + 1000)
        && (quest.annual === null || (quest.annual[0] <= quest.annual[1]
            ? quest.annual[0] <= monthDay && monthDay <= quest.annual[1]
            : quest.annual[0] <= monthDay || monthDay <= quest.annual[1])))
        .map(quest => quest.id)
}

/** The source (master) time a client time stands for in a projection. */
const sourceOf = (projection: ScheduleProjection | null, time: number) =>
    projection === null ? time : projection.sourceStart + (time - projection.targetStart) * projection.rate

test("the CDN master has two cycles open in the overlap, and none in a gap of the yearly windows", () => {
    const master = decodeMaster(cdnMaster())
    // the dates of the device test: 1271 and 1301 on 1 September, 1281 and 1311 on 1 October
    assert.equal(openAt(master, jst("2024-09-01 12:00:00")).length, 20)
    assert.equal(openAt(master, jst("2024-10-01 12:00:00")).length, 20)
    // 1361 to 1421 have started, none of their windows holds 1 April (1431's, 03-20 to 04-20, starts in September)
    assert.deepEqual(openAt(master, jst("2025-04-01 12:00:00")), [])
})

test("the server opens one cycle at a time, back to back, the later-starting one in an overlap", () => {
    assert.equal(tower.towerCycleAt(new Date(jst("2024-09-01 12:00:00")))?.id, 1301)
    assert.equal(tower.towerCycleAt(new Date(jst("2024-10-01 12:00:00")))?.id, 1311)
    assert.equal(tower.towerCycleAt(new Date(jst("2024-10-10 12:00:00")))?.id, 1291)
    // 1291's own end (10-17) is before 1321's start: it runs on to it, no gap and no going back to 1311
    assert.equal(tower.towerCycleAt(new Date(jst("2024-10-19 12:00:00")))?.id, 1291)
    assert.equal(tower.towerCycleAt(new Date(jst("2024-10-21 05:00:00")))?.id, 1321)
    const cycles = tower.getTowerCycles()
    cycles.forEach((cycle, index) => {
        const next = cycles[index + 1]
        if (next) assert.equal(cycle.end?.getTime(), next.start.getTime(), `cycle ${cycle.id} ends when ${next.id} starts`)
        else assert.equal(cycle.end, null)
    })
})

test("at a date inside the overlap the projected master has exactly the server's cycle open", () => {
    for (const date of ["2024-09-01 12:00:00", "2024-10-01 12:00:00"]) {
        const source = jst(date)
        const projection: ScheduleProjection = { sourceStart: source, targetStart: Date.parse("2026-11-15T03:00:00Z"), rate: 1 }
        const open = openAt(clientQuests(projection), projection.targetStart)
        const cycle = tower.towerCycleAt(new Date(source))
        assert.notEqual(cycle, null)
        assert.deepEqual(open, cycle!.questIds, date)
    }
})

test("the projected master and the server agree at every date, at every speed and when restored", () => {
    const first = jst("2022-05-06 14:00:00")
    const last = jst("2026-03-01 00:00:00")
    const target = Date.parse("2026-11-15T03:00:00Z")
    const projections: (ScheduleProjection | null)[] = [
        // Classic: the archive from its first Haunt on, at the real speed
        { sourceStart: first, targetStart: target, rate: 1 },
        // Accelerated
        { sourceStart: first, targetStart: target, rate: 7 },
        // a window starting inside the overlap (Manual, or Time Travel's shifted view)
        { sourceStart: jst("2024-08-30 05:00:00"), targetStart: target - 3 * 86_400_000, rate: 1 },
        // scheduling off again: the restored master, on the master's own dates
        null
    ]
    for (const projection of projections) {
        const master = clientQuests(projection)
        // every 5 hours and 17 minutes, 29 seconds off the minute (never on a cycle boundary), across the whole archive
        for (let source = first + 3_629_000; source < last; source += 19_020_000) {
            const time = projection === null ? source
                : Math.ceil(projection.targetStart + (source - projection.sourceStart) / projection.rate)
            const cycle = tower.towerCycleAt(new Date(sourceOf(projection, time)))
            const open = openAt(master, time)
            assert.equal(open.length, 10, `${new Date(source).toISOString()} (rate ${projection?.rate ?? "restore"}): ${open.length} quests open`)
            assert.deepEqual(open, cycle?.questIds, new Date(source).toISOString())
        }
    }
})

test("in every event mode the overlay of the live view opens the cycle openTowerCycle has", () => {
    const now = Date.now()
    const original = policy.getEventPolicy()
    const check = (label: string, offsetDays = 0) => {
        const view = schedule.getEventScheduleView(now, offsetDays)
        const master = clientQuests({ sourceStart: view.sourceStart, targetStart: view.targetStart, rate: view.rate, contentTime: view.contentTime })
        const cycle = schedule.runOnEventView(offsetDays, () => tower.openTowerCycle(new Date(now)))
        assert.notEqual(cycle, null, label)
        assert.deepEqual(openAt(master, now), cycle!.questIds, label)
        return cycle!.id
    }
    try {
        for (const [date, expected] of [["2024-09-01 12:00:00", 1301], ["2024-10-01 12:00:00", 1311]] as const) {
            for (const mode of ["classic", "accelerated", "time-travel"] as const) {
                const draft = { ...original, mode, acceleration: 4 }
                const anchor = schedule.anchorForContentTime(jst(date), now, draft)
                assert.notEqual(anchor, null)
                policy.setEventPolicy({ ...draft, anchor: anchor!, rotationId: now })
                assert.equal(check(`${mode} at ${date}`), expected)
            }
        }
        // Time Travel: a player's own view ahead of the shared timeline at 25 August
        const travel = { ...original, mode: "time-travel" as const, adminTimeTravel: true }
        policy.setEventPolicy({ ...travel, anchor: schedule.anchorForContentTime(jst("2024-08-25 12:00:00"), now, travel)!, rotationId: now + 1 })
        assert.equal(check("time travel, shared timeline"), 1301)
        assert.equal(check("time travel, seven days ahead", 7), 1301)
        assert.equal(check("time travel, twelve days ahead", 12), 1281)
        // Manual: a playlist window over the overlap (from the game day of 30 August), its start played now
        schedule.setManualWindows([{ from: "2024-08-30", to: "2024-10-10", label: "Haunt overlap" }])
        policy.setEventPolicy({ ...original, mode: "manual", anchor: now, rotationId: now + 2 })
        assert.equal(check("manual"), 1301)
        policy.setEventPolicy({ ...original, mode: "manual", anchor: now - 10 * 86_400_000, rotationId: now + 3 })
        assert.equal(check("manual, ten days in"), 1281)
        policy.setEventPolicy({ ...original, mode: "manual", anchor: now - 38 * 86_400_000, rotationId: now + 4 })
        assert.equal(check("manual, 38 days in"), 1291)
    } finally {
        schedule.setManualWindows([...schedule.DEFAULT_MANUAL_WINDOWS])
        policy.setEventPolicy(original)
    }
})

test("with scheduling off the server's cycle is the restored master's", () => {
    process.env.EVENT_SCHEDULING = "off"
    try {
        const master = clientQuests(null)
        for (const date of ["2024-09-01 12:00:00", "2024-10-01 12:00:00", "2025-04-01 12:00:00"]) {
            const time = jst(date)
            const cycle = tower.openTowerCycle(new Date(time))
            assert.deepEqual(openAt(master, time), cycle?.questIds, date)
        }
    } finally {
        process.env.EVENT_SCHEDULING = "on"
    }
})
