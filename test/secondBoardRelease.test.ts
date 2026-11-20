// FT-47: second mana boards come out on the shared timeline, on the dates of assets/board2_dates.json. Before its date
// a unit's second board is left out of the client's mana_node master (the schedule overlay), can't be opened, and a
// player's progress on it is hidden from /load (kept in the save); a player's own Time Travel doesn't change it, and
// with event scheduling off every board is out.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import board2Dates from "../assets/board2_dates.json";
import calendar from "../assets/event_calendar.json";
import { board2ReleaseTime, isBoard2Node, isBoard2Out, unitsWithHiddenBoard2, waveLandingTime } from "../src/lib/boardRelease";
import { balanceEpochAt, FINAL_BALANCE_EPOCH } from "../src/lib/balanceChanges";
import { buildOrderedMap, decodeOrderedMap } from "../src/lib/orderedmap";
import { buildScheduleOverlay } from "../src/lib/scheduleOverlay";
import { digestPath, masterAssetPath, readArchiveMember, readCentralDirectory } from "../src/lib/cdnIndex";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const DAY_MS = 24 * 60 * 60 * 1000
const UNIT = 111001 // Vagner: second board in Japan's first wave
const BOARD_1_NODE = 222002201
const BOARD_2_NODE = 222002401
const FIRST_EVENT = calendar.events.reduce((a, b) => a.start <= b.start ? a : b).id
const LAST_EVENT = calendar.events.reduce((a, b) => a.start >= b.start ? a : b).id
const masterTime = (text: string) => Date.parse(`${text.replace(" ", "T")}+09:00`)

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let schedule: typeof import("../src/lib/eventSchedule")
let events: typeof import("../src/lib/eventPolicy")
let balance: typeof import("../src/lib/balance")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    schedule = await import("../src/lib/eventSchedule")
    events = await import("../src/lib/eventPolicy")
    balance = await import("../src/lib/balance")
})

afterEach(() => {
    delete process.env.EVENT_SCHEDULING
    process.env.SERVER_CLOCK = "frozen"
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "classic" })
})

after(async () => {
    await cleanup()
})

/** Event scheduling on, the shared timeline on the first day of an event. */
function scheduledAt(eventId: string) {
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
    assert.equal(schedule.jumpToEventSync(eventId), "ok")
}

interface Player extends TestPlayer { playerId: number }

async function playerWithBoard2Progress(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    const playerId = data.getViewerPlayerIdSync(player.viewerId)!
    const { givePlayerCharacterSync } = await import("../src/lib/character")
    givePlayerCharacterSync(playerId, UNIT)
    data.updatePlayerCharacterSync(playerId, UNIT, { manaBoardIndex: 2 })
    data.updatePlayerCharacterBondTokenSync(playerId, UNIT, { manaBoardIndex: 1, status: 2 })
    data.updatePlayerCharacterBondTokenSync(playerId, UNIT, { manaBoardIndex: 2, status: 1 })
    data.insertPlayerCharacterManaNodesSync(playerId, UNIT, [BOARD_1_NODE, BOARD_2_NODE])
    return { ...player, playerId }
}

async function post(player: Player, route: string, body: Record<string, unknown> = {}) {
    // a device on the current asset view: an older one is sent back to the title (result 214) before any route runs
    const { availableAssetVersion } = await import("../src/lib/assetLayers")
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/${route}`, headers: { ...gameHeaders(player.udid), res_ver: availableAssetVersion() },
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null, raw: response.body }
}

async function load(player: Player) {
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.status, 200, response.raw)
    return response.body.data
}

test("every unit with a dated second board names a wave of the list", () => {
    const { waves, units } = board2Dates as { waves: unknown[], units: Record<string, number> }
    assert.ok(Object.keys(units).length >= 400)
    for (const wave of Object.values(units)) assert.ok(wave >= 0 && wave < waves.length)
    assert.ok(board2ReleaseTime(UNIT) !== undefined)
})

test("a wave lands its offset into its event, kept inside it, at the start of that game day (05:00 Japan time)", () => {
    const event = calendar.events.find(e => e.id === "advent_event/9")!
    const start = masterTime(event.start)
    const landing = waveLandingTime({ event: event.id, offsetDays: 3, date: "2000-01-01" })
    assert.equal(new Date(landing).toISOString().slice(11, 19), "20:00:00", "05:00 JST is 20:00 UTC")
    assert.ok(landing <= start + 3 * DAY_MS && start + 3 * DAY_MS - landing < DAY_MS)
    // before its event: the event's first day; long after it: its last day
    assert.ok(waveLandingTime({ event: event.id, offsetDays: -5, date: "2000-01-01" }) <= start)
    assert.ok(waveLandingTime({ event: event.id, offsetDays: 400, date: "2000-01-01" }) < masterTime(event.end))
    // an event the calendar doesn't have: the wave's own date
    assert.equal(waveLandingTime({ event: "story_event/0", offsetDays: 3, date: "2024-03-01" }), Date.parse("2024-02-29T20:00:00Z"))
})

test("a second board is out from its date on; units the list doesn't name are never held back", () => {
    const release = board2ReleaseTime(UNIT)!
    assert.equal(isBoard2Out(UNIT, release - 1), false)
    assert.equal(isBoard2Out(UNIT, release), true)
    assert.equal(isBoard2Out(UNIT, Infinity), true)
    assert.equal(isBoard2Out(999999, 0), true)
    assert.ok(unitsWithHiddenBoard2(release - 1).has(String(UNIT)))
    assert.equal(unitsWithHiddenBoard2(Infinity).size, 0)
    assert.equal(isBoard2Node(UNIT, BOARD_2_NODE), true)
    assert.equal(isBoard2Node(UNIT, BOARD_1_NODE), false)
})

test("balance epochs count the waves landed, and only change when one lands", () => {
    const release = board2ReleaseTime(UNIT)!
    assert.equal(balanceEpochAt(0), 0)
    assert.ok(balanceEpochAt(release) > balanceEpochAt(release - 1))
    assert.equal(balanceEpochAt(release), balanceEpochAt(release + 60 * 60 * 1000))
    assert.equal(balanceEpochAt(Infinity), FINAL_BALANCE_EPOCH)
})

test("the overlay ships mana_node without the hidden units' second boards", () => {
    const manaNode = buildOrderedMap([
        [String(UNIT), buildOrderedMap([["1", [["node", "1"]]], ["2", [["node", "2"]]]])],
        ["111002", buildOrderedMap([["1", [["node", "1"]]], ["2", [["node", "2"]]]])]
    ]).encode()
    const dated = buildOrderedMap([["1", [["2024-01-01 09:00:00"]]]]).encode()
    const source = { readMaster: (table: string) => table === "mana_board/mana_node" ? manaNode : dated }
    const folder = mkdtempSync(path.join(tmpdir(), "board2-"))
    const member = digestPath(masterAssetPath("mana_board/mana_node"))
    const boardsOf = (archive: Buffer) => {
        const file = path.join(folder, `${Math.random()}.zip`)
        writeFileSync(file, archive)
        const entry = readCentralDirectory(file).find(e => e.name === member)
        if (!entry) return null
        const node = decodeOrderedMap(readArchiveMember(file, entry))
        assert.equal(node.kind, "map")
        return Object.fromEntries((node.kind === "map" ? node.entries : []).map(e => [e.key, e.value.kind === "map" ? e.value.entries.map(b => b.key) : []]))
    }
    const projection = { sourceStart: 0, targetStart: 0, rate: 1 }
    const hidden = buildScheduleOverlay(source, projection, ["fixture/date"], { hiddenBoard2: new Set([String(UNIT)]) })
    assert.deepEqual(boardsOf(hidden.archive), { [String(UNIT)]: ["1"], "111002": ["1", "2"] })
    // none hidden (scheduling turned off again): the full table, so a device that saw a hidden board gets it back
    assert.deepEqual(boardsOf(buildScheduleOverlay(source, null, ["fixture/date"], { hiddenBoard2: new Set() }).archive),
        { [String(UNIT)]: ["1", "2"], "111002": ["1", "2"] })
    // no balance: the date overlay alone
    assert.equal(boardsOf(buildScheduleOverlay(source, projection, ["fixture/date"]).archive), null)
    // a CDN without the table builds the date overlay alone
    assert.equal(boardsOf(buildScheduleOverlay({ readMaster: (table: string) => table === "fixture/date" ? dated : undefined },
        projection, ["fixture/date"], { hiddenBoard2: new Set() }).archive), null)
})

test("before its date, /load shows the unit on its first board without the second board's nodes; the save keeps them", async () => {
    const player = await playerWithBoard2Progress()
    scheduledAt(FIRST_EVENT)
    assert.equal(balance.board2Available(UNIT), false)
    const before = await load(player)
    assert.equal(before.user_character_list[String(UNIT)].mana_board_index, 1)
    assert.deepEqual(before.user_character_list[String(UNIT)].bond_token_list, [{ mana_board_index: 1, status: 2 }, { mana_board_index: 2, status: 0 }])
    assert.deepEqual(before.user_character_mana_node_list[String(UNIT)], [BOARD_1_NODE])
    // stored as it was
    assert.equal(data.getPlayerCharacterSync(player.playerId, UNIT)!.manaBoardIndex, 2)
    assert.deepEqual(data.getPlayerCharacterManaNodesSync(player.playerId, UNIT).sort(), [BOARD_1_NODE, BOARD_2_NODE])

    scheduledAt(LAST_EVENT)
    assert.equal(balance.board2Available(UNIT), true)
    const afterwards = await load(player)
    assert.equal(afterwards.user_character_list[String(UNIT)].mana_board_index, 2)
    assert.deepEqual([...afterwards.user_character_mana_node_list[String(UNIT)]].sort(), [BOARD_1_NODE, BOARD_2_NODE])
})

test("before its date, the second board can't be opened nor its bond token taken", async () => {
    const player = await playerWithBoard2Progress()
    scheduledAt(FIRST_EVENT)
    for (const route of ["character/open_mana_board", "character/receive_bond_token"]) {
        const refused = await post(player, route, { character_id: UNIT, mana_board_index: 2 })
        assert.equal(refused.status, 400)
        assert.match(refused.raw, /isn't out yet/)
    }
    scheduledAt(LAST_EVENT)
    const taken = await post(player, "character/receive_bond_token", { character_id: UNIT, mana_board_index: 2 })
    assert.equal(taken.status, 200, taken.raw)
})

test("balance follows the shared timeline: a player's own Time Travel doesn't change it", () => {
    scheduledAt(FIRST_EVENT)
    const now = Date.now()
    const shared = balance.sharedBalanceTime(now)
    const travelled = schedule.runOnEventView(3 * 365, () => balance.sharedBalanceTime(now))
    assert.equal(travelled, shared)
    assert.equal(schedule.runOnEventView(3 * 365, () => balance.board2Available(UNIT)), false)
})

test("with event scheduling off every second board is out", async () => {
    const player = await playerWithBoard2Progress()
    assert.equal(balance.sharedBalanceTime(), Infinity)
    assert.equal(balance.board2Available(UNIT), true)
    const loaded = await load(player)
    assert.equal(loaded.user_character_list[String(UNIT)].mana_board_index, 2)
})

test("a co-op room from another balance epoch is not found", async () => {
    const player = await playerWithBoard2Progress()
    const { createRoom, deleteRoom } = await import("../src/lib/coop/rooms")
    const room = createRoom(999999001, 1, 1)
    try {
        room.balanceEpoch = balance.currentBalanceEpoch()
        const found = await post(player, "multi_battle_quest/search_room", { room_number: room.roomNumber })
        assert.equal(found.status, 200, found.raw)
        assert.equal(found.body.data.room_exists, true)
        room.balanceEpoch = balance.currentBalanceEpoch() + 1
        const stale = await post(player, "multi_battle_quest/search_room", { room_number: room.roomNumber })
        assert.equal(stale.body.data.room_exists, false)
    } finally {
        deleteRoom(room.roomNumber)
    }
})
