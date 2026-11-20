// FT-47 phase 2: global's 2.1.108 balance patch replayed on Japan's schedule. Before a change lands, the schedule
// overlay ships the tables it touches with the earlier values (single cells, or whole reworked entries), and the
// server's own party power uses the earlier stats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import balanceChanges from "../assets/balance_changes.json";
import { BALANCE_CHANGE_TABLES, BalanceChange, balanceChangeTime, balanceEpochAt, FINAL_BALANCE_EPOCH, pendingBalanceChanges, statusRowsAt } from "../src/lib/balanceChanges";
import { board2WaveTimes } from "../src/lib/boardRelease";
import { buildOrderedMap, decodeOrderedMap, OrderedMapNode } from "../src/lib/orderedmap";
import { buildScheduleOverlay } from "../src/lib/scheduleOverlay";
import { digestPath, masterAssetPath, readArchiveMember, readCentralDirectory } from "../src/lib/cdnIndex";

const changes = (balanceChanges as { changes: BalanceChange[] }).changes

test("the changes: Japan's adjustments from 2020-12 to 2023-06, each with values to write back and a landing time", () => {
    assert.deepEqual(changes.map(c => c.id), ["jp-2020-12-18", "jp-2021-04-24", "jp-2021-09-30", "jp-2022-05-31", "jp-2022-08-08", "jp-2022-09-07", "jp-2022-10-21",
        "jp-2022-12-31", "jp-2023-01-16", "jp-2023-02-21", "jp-2023-04-21", "jp-2023-06-23"])
    assert.deepEqual(changes.map(c => c.source), ["note 1242", "jp 817", "note 1241", "note 2610", "note 2610", "note 2610", "note 2610", "note 2610",
        "cdn 2.1.108", "cdn 2.1.108", "cdn 2.1.108", "cdn 2.1.108"])
    for (const change of changes) {
        assert.ok(change.cells.length + change.entries.length > 0, change.id)
        assert.ok(change.units.length + (change.armaments?.length ?? 0) > 0)
        assert.ok(Number.isFinite(balanceChangeTime(change.id)))
        for (const x of [...change.cells, ...change.entries]) assert.ok(BALANCE_CHANGE_TABLES.includes(x.table))
    }
    // in Japan's order
    const times = changes.map(c => balanceChangeTime(c.id)!)
    assert.deepEqual([...times].sort((a, b) => a - b), times)
    assert.deepEqual([...BALANCE_CHANGE_TABLES], ["ability/ability", "ability/ability_soul", "ability/leader_ability", "battle/multiball/multiball", "character/character", "character/character_status", "character/unique_condition", "mana_board/upskill", "skill/action_skill"])
})

test("pending changes: those not landed yet, latest first", () => {
    const second = balanceChangeTime("jp-2023-02-21")!
    assert.deepEqual(pendingBalanceChanges(0).map(c => c.id), [...changes.map(c => c.id)].reverse())
    assert.deepEqual(pendingBalanceChanges(second).map(c => c.id), ["jp-2023-06-23", "jp-2023-04-21"])
    assert.deepEqual(pendingBalanceChanges(Infinity), [])
})

test("balance epochs count board waves and balance changes", () => {
    const first = balanceChangeTime("jp-2021-09-30")!
    assert.ok(!board2WaveTimes.includes(first), "the first change lands on a day without a board wave")
    assert.equal(balanceEpochAt(first), balanceEpochAt(first - 1) + 1)
    assert.equal(balanceEpochAt(Infinity), FINAL_BALANCE_EPOCH)
    assert.equal(FINAL_BALANCE_EPOCH, new Set([...board2WaveTimes, ...changes.map(c => balanceChangeTime(c.id)!)]).size)
})

function readTable(archive: Buffer, table: string): OrderedMapNode | null {
    const folder = mkdtempSync(path.join(tmpdir(), "balance-"))
    const file = path.join(folder, "overlay.zip")
    writeFileSync(file, archive)
    const entry = readCentralDirectory(file).find(e => e.name === digestPath(masterAssetPath(table)))
    return entry ? decodeOrderedMap(readArchiveMember(file, entry)) : null
}

test("the overlay writes the earlier values back: cells, whole entries, and the earliest change wins", () => {
    const ability = buildOrderedMap([
        ["1000013", [["a", "90000", "180000"], ["b", "1", "2"]]],
        ["1000023", [["rework", "1", "1"], ["rework", "2", "2"], ["rework", "3", "3"]]]
    ]).encode()
    const dated = buildOrderedMap([["1", [["2024-01-01 09:00:00"]]]]).encode()
    const source = { readMaster: (table: string) => table === "ability/ability" ? ability : table === "fixture/date" ? dated : undefined }
    const later: BalanceChange = { id: "later", jpDate: "", jpNotices: [], source: "test", event: null, jpEventNotice: null, offsetDays: null, date: "2024-02-01", units: [],
        cells: [{ table: "ability/ability", key: ["1000013"], record: 0, column: 1, before: "60000" }], entries: [] }
    const earlier: BalanceChange = { id: "earlier", jpDate: "", jpNotices: [], source: "test", event: null, jpEventNotice: null, offsetDays: null, date: "2024-01-01", units: [],
        cells: [{ table: "ability/ability", key: ["1000013"], record: 0, column: 1, before: "40000" },
            { table: "ability/ability", key: ["1000013"], record: 1, column: 2, before: "3" }],
        entries: [{ table: "ability/ability", key: ["1000023"], records: [["old", "9", "9"]] }] }
    const projection = { sourceStart: 0, targetStart: 0, rate: 1 }
    const leaves = (node: OrderedMapNode | null) => node?.kind === "map"
        ? Object.fromEntries(node.entries.map(e => [e.key, e.value.kind === "leaf" ? e.value.records : null])) : null

    // both pending (latest first): the earliest change's values win
    const both = readTable(buildScheduleOverlay(source, projection, ["fixture/date"], { hiddenBoard2: new Set(), pending: [later, earlier] }).archive, "ability/ability")
    assert.deepEqual(leaves(both), {
        "1000013": [["a", "40000", "180000"], ["b", "1", "3"]],
        "1000023": [["old", "9", "9"]]
    })
    // only the later one pending
    const one = readTable(buildScheduleOverlay(source, projection, ["fixture/date"], { hiddenBoard2: new Set(), pending: [later] }).archive, "ability/ability")
    assert.deepEqual(leaves(one), {
        "1000013": [["a", "60000", "180000"], ["b", "1", "2"]],
        "1000023": [["rework", "1", "1"], ["rework", "2", "2"], ["rework", "3", "3"]]
    })
    // none pending: the final table as it is
    const none = readTable(buildScheduleOverlay(source, projection, ["fixture/date"], { hiddenBoard2: new Set(), pending: [] }).archive, "ability/ability")
    assert.deepEqual(leaves(none), leaves(decodeOrderedMap(ability)))
})

test("a change naming an entry the table doesn't have fails the build instead of shipping a half view", () => {
    const ability = buildOrderedMap([["1000013", [["a", "1"]]]]).encode()
    const change: BalanceChange = { id: "missing", jpDate: "", jpNotices: [], source: "test", event: null, jpEventNotice: null, offsetDays: null, date: "2024-01-01", units: [],
        cells: [{ table: "ability/ability", key: ["9999999"], record: 0, column: 1, before: "0" }], entries: [] }
    assert.throws(() => buildScheduleOverlay({ readMaster: (t: string) => t === "ability/ability" ? ability : buildOrderedMap([["1", [["2024-01-01 09:00:00"]]]]).encode() },
        { sourceStart: 0, targetStart: 0, rate: 1 }, ["fixture/date"], { hiddenBoard2: new Set(), pending: [change] }), /no ability\/ability entry 9999999/)
})

test("party power uses a unit's stats before a change not landed yet", () => {
    const unitStatusRows = statusRowsAt
    const final: [number, number, number][] = [[1, 47, 14], [10, 470, 132], [80, 2820, 792], [100, 3102, 872]]
    // Adjudicus (161027): HP and ATK raised in Japan's 2023-01-16 adjustment
    const first = balanceChangeTime("jp-2023-01-16")!
    assert.deepEqual(unitStatusRows(161027, final, first - 1), [[1, 47, 13], [10, 466, 121], [80, 2796, 726], [100, 3076, 799]])
    assert.deepEqual(unitStatusRows(161027, final, first), final)
    assert.deepEqual(unitStatusRows(161027, final, Infinity), final)
    assert.deepEqual(unitStatusRows(111001, [[1, 53, 11]], 0), [[1, 53, 11]], "units without a change keep their rows")
})

test("the notes' changes: Vagner's leader and second ability before Japan's 2021-09 round", () => {
    const round = changes.find(c => c.id === "jp-2021-09-30")!
    assert.equal(round.date, "2023-05-28", "the round lands with Crown of the Beast King, the event running in Japan")
    const vagner = (table: string, key: string) => round.cells.filter(c => c.table === table && c.key[0] === key)
        .map(c => [c.record, c.column, c.before])
    // "+40 % to attack / +40 % to Power Flip damage" (after: +100 % / +70 %); the lower values by the table's convention
    assert.deepEqual(vagner("ability/leader_ability", "111001").sort(), [[0, 47, "30000"], [0, 48, "40000"], [1, 47, "30000"], [1, 48, "40000"]])
    // "every 5 time(s) a unit Power Flips → +10 % to attack for this unit (Max +60 %)" (after: +15 %, Max +90 %): 6 stacks either way
    assert.deepEqual(vagner("ability/ability", "1110012").sort(), [[0, 49, "5000"], [0, 50, "10000"]])
})

test("a cell changed twice shows the earliest value until the first change lands", () => {
    // Remnith's ability (1210063): raised in Japan's 2021-09 round and again in 2023-02
    const first = balanceChangeTime("jp-2021-09-30")!, second = balanceChangeTime("jp-2023-02-21")!
    const value = (time: number) => {
        let v: string | undefined
        for (const change of pendingBalanceChanges(time))
            for (const cell of change.cells)
                if (cell.table === "ability/ability" && cell.key[0] === "1210063" && cell.record === 0 && cell.column === 109) v = cell.before
        return v
    }
    const earliest = value(first - 1), between = value(first)
    assert.ok(earliest !== undefined && between !== undefined && earliest !== between)
    assert.ok(Number(earliest) < Number(between))
    assert.equal(value(second), undefined)
})

test("armaments: Japan's 2020-12-18 update, the effects added at awakening dropped until it lands", () => {
    const update = changes.find(c => c.id === "jp-2020-12-18")!
    assert.equal(update.date, "2022-08-15", "4 days into Violent Night, Holy Night, the Christmas advent running in Japan")
    assert.deepEqual(update.units, [])
    assert.ok(update.armaments!.length >= 55)
    // Kaleido Drop Pendant (5090001): two records now (main effect, and one unlocked at awakening 5); one before, with
    // +10 % / +20 % at level 1 / max awakening instead of +15 % / +30 %
    const pendant = update.entries.find(e => e.table === "ability/ability_soul" && e.key[0] === "5090001")!
    assert.equal(pendant.records.length, 1)
    assert.equal(pendant.records[0][1], "1")
    assert.deepEqual([pendant.records[0][48], pendant.records[0][49]], ["10000", "20000"])
    for (const entry of update.entries) assert.ok(entry.records.every(r => r.length === 117), "the final layout")
})
