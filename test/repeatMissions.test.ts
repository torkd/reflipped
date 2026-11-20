// FT-2: repeatable missions (`is_repeat`, "Repeatable"): each time the progress reaches the target again the reward is
// paid again; the mission list shows the round under way, and the mission stays complete for "clear the other
// missions".
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

// event mission 1402 (2021-08-27 to 09-28): "Clear a beginner boss battle as backup", 10 of item 49000, repeatable
const MISSION = 1402
const EVENT = 3
const DURING = new Date("2021-09-01T03:00:00Z")
const BACKUP_CLEAR = 18

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

test("a repeatable mission pays every time and starts a new round", async () => {
    const missions = await import("../src/lib/missions")
    const data = await import("../src/data/wdfpData")
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const backupClear = (amount: number) => missions.updateMissionsSync(playerId, DURING, [{ pattern: BACKUP_CLEAR, amount, matches: mission => mission.questKind === 2 && mission.questRankId === 1 }])
    const paid = (result: ReturnType<typeof backupClear>) => result.missionInfo.filter(info => info.mission_id === MISSION).length

    assert.equal(paid(backupClear(1)), 1)
    assert.equal(paid(backupClear(1)), 1, "paid again")
    assert.equal(paid(backupClear(2)), 2, "two clears at once: two rounds")
    const rewardMail = data.getPlayerAllMailSync(playerId).filter(mail => mail.typeId === 49000)
    assert.equal(rewardMail.length, 4)

    const { list } = missions.getMissionProgressListSync(playerId, [{ category: EVENT }], DURING)
    assert.deepEqual(list.find(entry => entry.mission_id === MISSION), { mission_category: EVENT, mission_id: MISSION, progress_value: 0, stage: 1 })
    // still complete for the missions that count it
    assert.equal(data.getPlayerMissionsSync(playerId, EVENT).find(entry => entry.missionId === MISSION)?.clearedStage, 4)
})
