// A content view change during a battle: the co-op invitation poll the client sends every 15 s in battle must not get
// the resource-version error (214), which throws the battle back to title before it can settle. Outside a battle the
// poll still gets it, so a player on the home screen reloads the new view.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
before(async () => { ({ fastify, cleanup } = await createTestServer()) })
after(async () => { await cleanup?.() })

test("attention polls pass a stale view during a battle and get 214 outside one", async () => {
    const data = await import("../src/data/wdfpData")
    const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
    const { availableAssetVersion } = await import("../src/lib/assetLayers")
    const { hasActiveBattleQuest } = await import("../src/routes/api/singleBattleQuest")
    const oldClock = process.env.SERVER_CLOCK
    const oldScheduling = process.env.EVENT_SCHEDULING
    const oldPolicy = getEventPolicy()
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const request = (route: string, body: object, version?: string) => {
        const headers = { ...gameHeaders(player.udid) }
        delete headers.res_ver
        if (version !== undefined) headers.res_ver = version
        return fastify.inject({ method: "POST", url: `/latest/api/index.php/${route}`, headers,
            payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 1, ...body }) })
    }
    const poll = (version: string) => request("attention/check", { holding_number: 0, retry_count: 0, request_number: 3 }, version)
    const log = (version: string) => request("attention/logger", { client_logs: [] }, version)
    const resultCode = (response: Awaited<ReturnType<typeof poll>>) => decodeGameBody(response.body).data_headers.result_code
    try {
        process.env.SERVER_CLOCK = "running"
        process.env.EVENT_SCHEDULING = "on"
        setEventPolicy({ ...oldPolicy, mode: "accelerated", acceleration: 3 })
        const start = await request("single_battle_quest/start", { category: 1, quest_id: 1001002, party_id: 1,
            use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false }, availableAssetVersion())
        assert.equal(start.statusCode, 200, start.body)
        assert.equal(hasActiveBattleQuest(playerId, false), true)
        const oldVersion = availableAssetVersion()
        setEventPolicy({ ...getEventPolicy(), acceleration: 2 })
        assert.notEqual(availableAssetVersion(), oldVersion, "the speed change is a new view")

        for (const response of [await poll(oldVersion), await log(oldVersion)]) {
            assert.equal(response.statusCode, 200, response.body)
            assert.equal(resultCode(response), 1, "a battle in progress keeps polling")
        }
        assert.equal(hasActiveBattleQuest(playerId, false), true)
        const finish = await request("single_battle_quest/finish", { category: 1, quest_id: 1001002, party_id: 1, score: 0, elapsed_time_ms: 10000, add_mana: 0,
            is_accomplished: true, statistics: { party: { characters: [{ id: 1 }], unison_characters: [] } } }, oldVersion)
        assert.equal(finish.statusCode, 200, finish.body)
        assert.equal(decodeGameBody(finish.body).data_headers.asset_update, true)

        assert.equal(resultCode(await poll(oldVersion)), 214, "outside a battle the poll still returns the player to title")
    } finally {
        setEventPolicy(oldPolicy)
        if (oldClock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = oldClock
        if (oldScheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = oldScheduling
    }
})
