// FT-11: the time attack clear-phase missions (patterns 46-49, "clear phase N" of a ranking event battle, quest kind 8)
// count a cleared battle by its `statistics.clear_phase`, the number of phases it cleared: phase N counts when at
// least N were cleared.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const RANKING_EVENT_SINGLE = 11
// Trial by Light (ranking event 2, 2022-06-28 to 07-07): quest 2001; its daily missions 200831-200834 are phases 1-4
const QUEST = 2001
const PHASE_MISSIONS = [200831, 200832, 200833, 200834]

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

test("a ranking battle counts the clear-phase missions up to the phases it cleared", async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2022-07-01T03:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]

    const started = await post(player, "single_battle_quest/start", {
        quest_id: QUEST, category: RANKING_EVENT_SINGLE, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(started.statusCode, 200, started.body)
    const finished = await post(player, "single_battle_quest/finish", {
        quest_id: QUEST, category: RANKING_EVENT_SINGLE, score: 1000, add_mana: 0, elapsed_time_ms: 100_000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 2,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(finished.statusCode, 200, finished.body)

    const daily = new Map(data.getPlayerMissionsSync(playerId, 2).map(mission => [mission.missionId, mission]))
    const done = (missionId: number) => (daily.get(missionId)?.progress ?? 0) > 0 || (daily.get(missionId)?.clearedStage ?? 0) > 0
    assert.deepEqual(PHASE_MISSIONS.map(done), [true, true, false, false])
})
