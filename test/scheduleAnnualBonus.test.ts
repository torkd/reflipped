import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import bonuses from "../assets/login_bonus.json";
import { annualBonusOccurrence, annualBonusViewIdentity } from "../src/lib/scheduleAnnualBonus";
import { ScheduleAssetUnavailableError } from "../src/lib/scheduleArchiveCache";
import { buildScheduleOverlay } from "../src/lib/scheduleOverlay";
import { buildOrderedMap, decodeOrderedMap, walkLeaves } from "../src/lib/orderedmap";

const rawTime = (text: string) => Date.parse(`${text.replace(" ", "T")}+09:00`)
function archiveRow(zip: Buffer): string[] {
    const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28)
    const body = zip.subarray(start, start + zip.readUInt32LE(18))
    return [...walkLeaves(decodeOrderedMap(zip.readUInt16LE(8) === 8 ? inflateRawSync(body) : body))][0].leaf.records[0]
}

test("annual bonus client masters contain a release-clipped full projected period", () => {
    const row = Array(47).fill("(None)") as string[]
    row[0] = "1"
    row[1] = "Translated seasonal bonus"
    row[40] = "2025-05-02 09:00:00"
    row[42] = "05-01 09:00:00"
    row[43] = "05-04 09:00:00"
    const bytes = buildOrderedMap([["synthetic", buildOrderedMap([["1", [row]]])]]).encode()
    const result = buildScheduleOverlay({ readMaster: () => bytes }, {
        sourceStart: Date.parse("2025-05-01T00:00:00Z"), targetStart: Date.parse("2026-11-01T00:00:00Z"),
        rate: 2, contentTime: rawTime("2025-05-03 12:00:00")
    }, ["bonus/login_bonus"])
    const client = archiveRow(result.archive)
    assert.equal(client[1], "Translated seasonal bonus")
    assert.equal(client[40], "2026-11-01 21:00:00")
    assert.equal(client[41], "2026-11-02 21:00:00")
    assert.equal(client[42], "(None)")
    assert.equal(client[43], "(None)")
    // Removing scheduling restores both original full release and annual MM-DD fields.
    assert.deepEqual(archiveRow(buildScheduleOverlay({ readMaster: () => bytes }, null, ["bonus/login_bonus"]).archive), row)
})

test("all enabled source annual groups have a valid first season after their late-year launch", () => {
    const annual = bonuses.filter(group => (group.groupType === "Normal" || group.groupType === "Limited")
        && group.annualStart !== null && group.annualEnd !== null)
    assert.equal(annual.length, 3)
    for (const group of annual) {
        const occurrence = annualBonusOccurrence(group.annualStart!, group.annualEnd!,
            group.startDate === null ? undefined : rawTime(group.startDate),
            group.endDate === null ? undefined : rawTime(group.endDate), rawTime("2024-12-20 12:00:00"))
        assert.equal(occurrence.startYear, 2025)
        assert.ok(occurrence.end >= occurrence.start)
        assert.ok(group.startDate === null || occurrence.start >= rawTime(group.startDate))
    }
})

test("cross-year annual seasons select the previous start year in January", () => {
    const january = annualBonusOccurrence("12-20 12:00:00", "01-10 04:59:59", undefined, undefined,
        rawTime("2025-01-05 12:00:00"))
    assert.equal(january.startYear, 2024)
    assert.equal(january.start, rawTime("2024-12-20 12:00:00"))
    assert.equal(january.end, rawTime("2025-01-10 04:59:59"))
    const february = annualBonusOccurrence("12-20 12:00:00", "01-10 04:59:59", undefined, undefined,
        rawTime("2025-02-01 12:00:00"))
    assert.equal(february.startYear, 2025)
    assert.equal(february.end, rawTime("2026-01-10 04:59:59"))
})

test("annual leap-day boundaries use the same Date normalization as the server", () => {
    const leap = annualBonusOccurrence("02-29 00:00:00", "03-02 23:59:59", undefined, undefined,
        rawTime("2024-02-29 12:00:00"))
    assert.equal(leap.start, rawTime("2024-02-29 00:00:00"))
    const ordinary = annualBonusOccurrence("02-29 00:00:00", "03-02 23:59:59", undefined, undefined,
        rawTime("2025-03-01 12:00:00"))
    assert.equal(ordinary.start, rawTime("2025-03-01 00:00:00"))
})

test("finite campaigns without any annual intersection fail explicitly instead of installing C2044", () => {
    assert.throws(() => annualBonusOccurrence("04-01 00:00:00", "05-01 00:00:00",
        rawTime("2025-10-01 00:00:00"), rawTime("2025-12-01 00:00:00"), rawTime("2025-11-01 00:00:00")),
        (error: unknown) => error instanceof ScheduleAssetUnavailableError && error.statusCode === 503
            && /no occurrence/.test(error.message))
    assert.throws(() => annualBonusOccurrence("02-31 00:00:00", "05-01 00:00:00", undefined, undefined,
        rawTime("2025-01-01 00:00:00")), /Invalid annual/)
})

test("annual view identity changes by content year and remains stable within that year", () => {
    const january = annualBonusViewIdentity(rawTime("2025-01-01 00:00:00"))
    assert.equal(january, annualBonusViewIdentity(rawTime("2025-06-01 00:00:00")))
    assert.notEqual(january, annualBonusViewIdentity(rawTime("2026-01-01 00:00:00")))
})
