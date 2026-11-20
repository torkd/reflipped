// Leftovers of the event scheduling work: a reward never scales to nothing, a new rotation starts at the daily reset,
// and a co-op battle keeps the player's own mission run instead of swapping to the room's.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestServer, createTestPlayer } from "./helpers";

let cleanup: () => Promise<void>
let policy: typeof import("../src/lib/rewardPolicy")

before(async () => {
    ({ cleanup } = await createTestServer())
    policy = await import("../src/lib/rewardPolicy")
})
after(async () => { await cleanup() })

test("a reward that pays something never scales below 1, and nothing stays nothing", () => {
    assert.equal(policy.scaleEarnedAmount(1, "mana", undefined, 0.5), 1)
    assert.equal(policy.scaleEarnedAmount(1, "exp", undefined, 0.1), 1)
    assert.equal(policy.scaleEarnedAmount(3, "mana", undefined, 0.5), 1, "rounded down from 1.5")
    assert.equal(policy.scaleEarnedAmount(10, "mana", undefined, 0.5), 5)
    assert.equal(policy.scaleEarnedAmount(0, "mana", undefined, 0.5), 0)
    assert.equal(policy.scaleEarnedAmount(1, "mana", undefined, 3), 3)
    assert.equal((policy.scaleEarnedReward({ type: 3, count: 1 } as any, 0.1) as unknown as { count: number }).count, 1)
})

test("a rotation that was never saved starts at the beginning of a game day", async () => {
    const { setStoredTexts } = await import("../src/data/serverSettings")
    const { getEventPolicy } = await import("../src/lib/eventPolicy")
    const { gameDayStart, gameDayOf } = await import("../src/lib/calendar")
    setStoredTexts([["events.policy", null]])
    const before = Date.now()
    const anchor = getEventPolicy().anchor
    assert.equal(anchor, gameDayStart(gameDayOf(anchor)), "on a game day boundary")
    assert.ok(anchor <= before && before - anchor < 24 * 3600 * 1000, "the current game day")
    // 05:00 Japan time is 20:00 UTC
    assert.equal(new Date(anchor).getUTCHours(), 20)
    assert.equal(new Date(anchor).getUTCMinutes(), 0)
    assert.equal(getEventPolicy().anchor, anchor, "kept after the first read")
})

test("a co-op battle in another period leaves the player's mission run alone", async () => {
    const data = await import("../src/data/wdfpData")
    const { setCurrentMissionRunSync, currentMissionRunSync } = await import("../src/data/rewardSnapshots")
    const { updateMissionsSync } = await import("../src/lib/missions")
    const process_ = process.env
    const clock = process_.SERVER_CLOCK, scheduling = process_.EVENT_SCHEDULING
    process_.SERVER_CLOCK = "running"; process_.EVENT_SCHEDULING = "on"
    try {
        const { fastify } = await createTestServer()
        const account = await createTestPlayer(fastify)
        const session = await data.getSession(String(account.viewerId))
        const playerId = (await data.getAccountPlayers(session!.accountId))[0]
        const { currentEventOccurrenceKey } = await import("../src/lib/eventSchedule")
        const ownRun = currentEventOccurrenceKey()   // the run of the player's own view
        setCurrentMissionRunSync(playerId, ownRun)
        const room = { occurrenceKey: "hosts-run", contentTime: Date.parse("2021-08-25T12:00:00Z"), profile: "classic" as const, rewardMultiplier: 1 }
        updateMissionsSync(playerId, new Date(), [], room, true)
        assert.equal(currentMissionRunSync(playerId), ownRun, "co-op keeps the player's run")
        updateMissionsSync(playerId, new Date(), [], room, false)
        assert.equal(currentMissionRunSync(playerId), "hosts-run", "a solo battle pinned to a run still switches to it")
    } finally {
        if (clock === undefined) delete process_.SERVER_CLOCK; else process_.SERVER_CLOCK = clock
        if (scheduling === undefined) delete process_.EVENT_SCHEDULING; else process_.EVENT_SCHEDULING = scheduling
    }
})
