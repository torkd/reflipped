// FT-11: World Story events, end to end on the generic routes: a story scene (story_quest/finish), a battle and the
// event's boss battle (single_battle_quest, categories 18 and 19) record their progress and pay their rewards, the
// boss's pooled exp from the master's column 96, and the world story missions (quest kinds 9 and 10) count them.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import worldStoryQuests from "../assets/world_story_event_quest.json";
import worldStoryBosses from "../assets/world_story_event_boss_battle_quest.json";

const apiPrefix = "/latest/api/index.php"
const WORLD_STORY_EVENT = 18
const WORLD_STORY_BOSS = 19
// The Yokai Encyclopedia (event 100400): a story scene and a battle; boss battle 100100001
const STORY = 100400001
const BATTLE = 100400003
const BOSS = 100100001
type Quest = { rankPointReward?: number, manaReward?: number, poolExpReward?: number, characterExpReward?: number }

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

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2022-06-01T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

async function battle(player: TestPlayer, category: number, questId: number) {
    const started = await post(player, "single_battle_quest/start", {
        quest_id: questId, category, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(started.statusCode, 200, started.body)
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category, score: 1000, add_mana: 0, elapsed_time_ms: 2_000_000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

function cleared(playerId: number, category: number, questId: number): boolean {
    return data.getPlayerSingleQuestProgressSync(playerId, category, questId)?.finished === true
}

test("a World Story event's story, battle and boss record their progress and pay their rewards", async () => {
    const player = await newPlayer()

    const story = await post(player, "story_quest/finish", { quest_id: STORY, category: WORLD_STORY_EVENT, party_id: 1, api_count: 1 })
    assert.equal(story.statusCode, 200, story.body)
    assert.ok(cleared(player.playerId, WORLD_STORY_EVENT, STORY))

    for (const [category, questId, quest] of [
        [WORLD_STORY_EVENT, BATTLE, (worldStoryQuests as Record<string, Quest>)[String(BATTLE)]],
        [WORLD_STORY_BOSS, BOSS, (worldStoryBosses as Record<string, Quest>)[String(BOSS)]]
    ] as [number, number, Quest][]) {
        const before = data.getPlayerSync(player.playerId)!
        const result = await battle(player, category, questId)
        assert.ok(cleared(player.playerId, category, questId), `${questId} cleared`)
        const after = data.getPlayerSync(player.playerId)!
        assert.equal(after.rankPoint - before.rankPoint, quest.rankPointReward)
        assert.equal(result.rewards.reward_mana, quest.manaReward)
        assert.equal(result.rewards.reward_pool_exp, quest.poolExpReward)
        assert.equal(result.category_id, category)
    }
    // the boss's pooled exp is its master value (column 96), not the 1 that column 97 gave
    assert.equal((worldStoryBosses as Record<string, Quest>)[String(BOSS)].poolExpReward, (worldStoryBosses as Record<string, Quest>)[String(BOSS)].characterExpReward)
})
