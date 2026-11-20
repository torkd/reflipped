// FT-2: pattern 82 (battle_client_check). A battle start names the checks of the open missions its quest can count for;
// the finish's statistics.client_checks lists those met, and each moves its missions.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestPlayer, createTestServer } from "./helpers";
import type { FastifyInstance } from "fastify";

const HARD_MULTI_EVENT = 26
// mission 600003 (2024-10-01 to 10-15): a co-op clear of hard multi event 3 meeting `hard_multi_steam_robot_water`
const MISSION = 600003
const CHECK = "hard_multi_steam_robot_water"
const QUEST = 3001
const DURING = new Date("2024-10-05T03:00:00Z")

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

test("the start names the open missions' checks for the quest", async () => {
    const missions = await import("../src/lib/missions")
    assert.deepEqual(missions.battleClientChecks(HARD_MULTI_EVENT, QUEST, true, DURING), [CHECK])
    assert.deepEqual(missions.battleClientChecks(HARD_MULTI_EVENT, QUEST, false, DURING), [], "a co-op mission")
    assert.deepEqual(missions.battleClientChecks(HARD_MULTI_EVENT, 1001, true, DURING), [], "another event's quest")
    assert.deepEqual(missions.battleClientChecks(HARD_MULTI_EVENT, QUEST, true, new Date("2024-11-05T03:00:00Z")), [], "after the mission")
})

test("a met check moves its missions", async () => {
    const missions = await import("../src/lib/missions")
    const data = await import("../src/data/wdfpData")
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]

    missions.updateMissionsSync(playerId, DURING, missions.clientCheckUpdates(HARD_MULTI_EVENT, QUEST, true, ["other_check"]))
    assert.equal(data.getPlayerMissionsSync(playerId, 3).find(entry => entry.missionId === MISSION), undefined)

    const result = missions.updateMissionsSync(playerId, DURING, missions.clientCheckUpdates(HARD_MULTI_EVENT, QUEST, true, [CHECK]))
    assert.ok(result.missionInfo.some(info => info.mission_id === MISSION), "mission 600003 cleared")
})
