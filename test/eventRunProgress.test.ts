// FT-32: an accelerated run's progress (event shop currencies, event mission effort, Limited login entries) counts the
// run's speed, while every reward keeps its original amount.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";
import { QuestCategory } from "../src/lib/types";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let policy: typeof import("../src/lib/rewardPolicy")
let events: typeof import("../src/lib/eventPolicy")
let schedule: typeof import("../src/lib/eventSchedule")
let utils: typeof import("../src/utils")
let db: ReturnType<typeof import("../src/data").default>
const NOW = new Date("2025-01-03T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000
before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    policy = await import("../src/lib/rewardPolicy")
    events = await import("../src/lib/eventPolicy")
    schedule = await import("../src/lib/eventSchedule")
    utils = await import("../src/utils")
    db = (await import("../src/data")).default(0)
    utils.setServerTime(NOW)
    policy.setRewardPolicy({ management: "automatic" })
})
after(async () => { await cleanup?.() })

async function player() {
    const account = await createTestPlayer(fastify)
    const session = await data.getSession(String(account.viewerId))
    return (await data.getAccountPlayers(session!.accountId))[0]
}
function withScheduledContent<T>(fn: () => T): T {
    const clock = process.env.SERVER_CLOCK
    const scheduling = process.env.EVENT_SCHEDULING
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
    try { return fn() } finally {
        if (clock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = clock
        if (scheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = scheduling
    }
}
const run = (contentTime: number, rate?: number) => ({ occurrenceKey: `run-${rate ?? "old"}`, contentTime, profile: "accelerated" as const, rate })

test("rewards keep their original amounts in every profile, Automatic and Managed by default", () => {
    const prior = events.getEventPolicy()
    for (const acceleration of [2, 5, 10]) {
        events.setEventPolicy({ ...prior, mode: "accelerated", acceleration })
        assert.equal(policy.getRewardPolicy().multiplier, 1)
        assert.equal(policy.getRewardPolicy().profileMultiplier, 1)
    }
    events.setEventPolicy(prior)
})

test("the run's speed comes from the captured run, else the timeline, and is 1 with scheduling off", () => {
    const prior = events.getEventPolicy()
    assert.equal(schedule.currentRunSpeed(), 1, "scheduling off")
    withScheduledContent(() => {
        events.setEventPolicy({ ...prior, mode: "accelerated", acceleration: 3 })
        assert.equal(schedule.currentRunSpeed(), 3)
        assert.equal(schedule.captureEventContext().rate, 3)
        assert.equal(schedule.runOnCapturedEventContext(run(NOW.getTime(), 4), () => schedule.currentRunSpeed()), 4, "a battle keeps its start's speed")
        assert.equal(schedule.runOnCapturedEventContext(run(NOW.getTime()), () => schedule.currentRunSpeed()), 1, "a context from before FT-32")
        events.setEventPolicy({ ...prior, mode: "classic" })
        assert.equal(schedule.currentRunSpeed(), 1)
    })
    events.setEventPolicy(prior)
})

test("event shop currencies drop at the run's speed; other items and currencies do not", async () => {
    const id = await player()
    const { givePlayerScoreRewardsSync } = await import("../src/lib/quest")
    const currency = 50103
    assert.ok(policy.isRunCurrency(currency))
    assert.ok(!policy.isRunCurrency(100000), "Wrightpieces are not an event shop's currency")
    assert.ok(!policy.isRunCurrency(42), "Elements, though some event shops take them, are growth materials")
    assert.ok(policy.isRunCurrency(40210), "an advent event's Denarius (not the Boss Coin of the same boss)")
    const drop = (itemId: number) => [{ name: "", type: 0, reward_type: 0, id: itemId, count: 2, field5: 1000 } as any]
    const gain = (itemId: number, speed: number) => {
        const before = data.getPlayerItemSync(id, itemId) ?? 0
        givePlayerScoreRewardsSync(id, 1, drop(itemId), false, undefined, 1, 10, undefined, speed)
        return (data.getPlayerItemSync(id, itemId) ?? 0) - before
    }
    assert.equal(gain(currency, 1), 20)
    assert.equal(gain(currency, 3), 60)
    assert.equal(gain(100000, 3), 20)
})

test("event currencies in a rare pool drop at the run's speed too", async () => {
    const id = await player()
    const { givePlayerScoreRewardsSync, scoreRewardDrops } = await import("../src/lib/quest")
    // rare pool 3002 holds 20 Silver Ilco Opus Denarius (40210) with weight 1; a draw of 0 hits the slot and picks it
    const random = scoreRewardDrops.random
    scoreRewardDrops.random = () => 0
    try {
        const before = data.getPlayerItemSync(id, 40210) ?? 0
        givePlayerScoreRewardsSync(id, 1, [{ name: "", type: 1, id: 3002, rarity: 1 } as any], false, undefined, 1, 10, undefined, 2)
        assert.equal((data.getPlayerItemSync(id, 40210) ?? 0) - before, 40)
    } finally { scoreRewardDrops.random = random }
})

test("event missions count a run's effort at its speed; daily missions and item gains count once", async () => {
    const id = await player()
    const missions = await import("../src/lib/missions")
    data.setPlayerResetsSync(id, { day: "2025-01-03", month: "2025-01" })
    data.setPlayerMissionSync(id, 2, { missionId: 6, progress: 0, clearedStage: 0 })
    // event mission 2268: "clear 50 battles" of advent event 100006, open 2022-09-13 to 2022-09-27
    const contentTime = utils.masterDate("2022-09-15 12:00:00").getTime()
    // the player's own view (daily missions) at the real date; the battle's run (event missions) at 3x
    const own = { occurrenceKey: "own", contentTime: NOW.getTime(), profile: "classic" as const }
    withScheduledContent(() => schedule.runOnCapturedEventContext(own, () => missions.updateMissionsSync(id, NOW, [
        { pattern: 21, amount: 1, matches: mission => missions.missionMatchesQuest(mission, QuestCategory.ADVENT_EVENT_MULTI, 100006003) },
        { pattern: 12, amount: 1, matches: mission => missions.missionMatchesQuest(mission, 1, 1001002) }
    ], run(contentTime, 3))))
    assert.equal(data.getPlayerMissionsSync(id, 3).find(row => row.missionId === 2268)?.progress, 3)
    assert.equal(data.getPlayerMissionsSync(id, 2).find(row => row.missionId === 6)!.progress, 1)
    // a collect item event's item mission counts the items gained, which the drop already scaled
    withScheduledContent(() => missions.updateMissionsSync(id, NOW, [{ pattern: 35, amount: 50, matches: mission => mission.itemId === 80001 }],
        run(Date.parse("2021-10-20T12:00:00Z"), 3)))
    assert.equal(data.getPlayerMissionsSync(id, 4).find(row => row.missionId === 1500)!.progress, 50)
})

test("a Limited login ladder pays up to the run's speed in entries a day, never past the run's historical days", async () => {
    const id = await player()
    const { applyLoginBonuses } = await import("../src/lib/loginBonus")
    const { loginBonusGroups } = await import("../src/data/loginBonusData")
    const group = loginBonusGroups.find(group => group.id === "rcollab_event")!
    const start = utils.masterDate(group.startDate!).getTime()
    const entries = () => (db.prepare(`SELECT bonus_index FROM players_login_bonus_receipts WHERE player_id = ? AND group_id = ? ORDER BY id`)
        .all(id, group.id) as { bonus_index: number }[]).map(row => row.bonus_index)
    const login = (realDay: number, historicalDays: number, rate: number) => withScheduledContent(() =>
        schedule.runOnCapturedEventContext(run(start + historicalDays * DAY + 1000, rate), () => applyLoginBonuses(id, new Date(NOW.getTime() + realDay * DAY))))
    login(0, 0.5, 3)
    assert.deepEqual(entries(), [1], "the ladder's first day reaches one entry")
    login(0, 2.5, 3)
    assert.deepEqual(entries(), [1], "one login a real day")
    login(1, 3.5, 3)
    assert.deepEqual(entries(), [1, 2, 3, 4], "three a day at 3x, up to the four historical days reached")
    login(2, 6.5, 3)
    assert.deepEqual(entries(), [1, 2, 3, 4, 5, 6, 7])
    login(5, 13, 3)
    assert.deepEqual(entries(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "missed days stay lost")
    login(6, 14.2, 3)
    login(7, 14.9, 3)
    assert.equal(entries().length, group.days.length, "the ladder ends at its last entry")
    const mails = db.prepare(`SELECT COUNT(*) AS count FROM players_mail WHERE player_id = ? AND reason_id = ?`).get(id, group.reasonId) as { count: number }
    assert.ok(mails.count > 0)
})

test("at the original pace a Limited ladder pays one entry a day, as before", async () => {
    const id = await player()
    const { applyLoginBonuses } = await import("../src/lib/loginBonus")
    const { loginBonusGroups } = await import("../src/data/loginBonusData")
    const group = loginBonusGroups.find(group => group.id === "rcollab_event")!
    const start = utils.masterDate(group.startDate!).getTime()
    for (const day of [0, 1, 2]) withScheduledContent(() => schedule.runOnCapturedEventContext(
        { occurrenceKey: "classic-run", contentTime: start + (day * 5 + 0.5) * DAY, profile: "classic" },
        () => applyLoginBonuses(id, new Date(NOW.getTime() + day * DAY))))
    const count = db.prepare(`SELECT COUNT(*) AS count FROM players_login_bonus_receipts WHERE player_id = ? AND group_id = ?`).get(id, group.id) as { count: number }
    assert.equal(count.count, 3)
})
