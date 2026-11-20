import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, readCapturedRoute } from "./helpers";

// SEC-13: a battle finish's claims are bounded: field mana, score, clear time and the party that earns exp; a lost
// final rush round doesn't complete its folder.

const apiPrefix = "/latest/api/index.php"
// main quest 1001002
const MAIN = 1
const QUEST_ID = 1001002

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let questResult: typeof import("../src/lib/questResult")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    questResult = await import("../src/lib/questResult")
})

after(async () => {
    await cleanup()
})

async function signUp(): Promise<{ viewerId: number, playerId: number }> {
    const deviceId = randomUUID()
    const login = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey: randomUUID(), accessToken: "" }
    })
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tool/signup`,
        headers: { "content-type": "application/x-www-form-urlencoded", "udid": randomUUID().toUpperCase() },
        payload: encodeGameBody({
            app_secret: captured.app_secret, access_token: login.json().zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
        })
    })
    const players = data.getAllPlayersSync()
    return { viewerId: decodeGameBody(signup.body).data_headers.viewer_id, playerId: players[players.length - 1].id }
}

async function gameRequest(route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody(body)
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

const capturedFinish = () => readCapturedRoute("single_battle_quest_finish").requestBody

/** Starts and finishes a quest (main 1001002 unless named); `finish` overrides fields of the captured finish body. */
async function play(viewerId: number, finish: Record<string, unknown>, quest: { category: number, quest_id: number } = { category: MAIN, quest_id: QUEST_ID }) {
    await gameRequest("single_battle_quest/start", { ...readCapturedRoute("single_battle_quest_start").requestBody, viewer_id: viewerId, ...quest })
    return await gameRequest("single_battle_quest/finish", { ...capturedFinish(), viewer_id: viewerId, is_accomplished: true, ...finish })
}

const party = (characters: (number | null)[], unisons: (number | null)[] = [null, null, null]) => ({
    ...capturedFinish().statistics,
    party: {
        characters: characters.map(id => (id === null ? null : { id })),
        unison_characters: unisons.map(id => (id === null ? null : { id })),
        equipments: [null, null, null],
        ability_soul_ids: [null, null, null]
    }
})

test("the bounds", () => {
    const body = (fields: Record<string, unknown>) => ({ add_mana: 0, score: 0, elapsed_time_ms: 1000, statistics: party([null, null, null]), ...fields }) as never
    assert.equal(questResult.checkFinishClaims(body({ add_mana: 250 })).fieldMana, 250)
    assert.equal(questResult.checkFinishClaims(body({ add_mana: 2 ** 31 - 1 })).fieldMana, questResult.FIELD_MANA_MAX)
    assert.equal(questResult.checkFinishClaims(body({ add_mana: -5000 })).fieldMana, 0)
    assert.equal(questResult.checkFinishClaims(body({ score: 8083396649.0 })).score, 8083396649, "the co-op capture's score passes")
    assert.equal(questResult.checkFinishClaims(body({ score: 12.7 })).score, 12)
    assert.equal(questResult.checkFinishClaims(body({ score: -1 })).score, 0)
    assert.equal(questResult.checkFinishClaims(body({ elapsed_time_ms: -1 })).clearTimeMs, 2 ** 31 - 1)
    const checked = questResult.checkFinishClaims(body({ statistics: party([7, 7, 8, 9], [7, 10, null]) }))
    assert.deepEqual(checked.partyCharacterIds, [7, 8, 10], "each unit once, three slots of each kind")
    assert.deepEqual(checked.clamped, ["statistics.party"])
    assert.deepEqual(questResult.checkFinishClaims(body({ statistics: party([7, 8, null], [9, null, null]) })).clamped, [], "a normal finish is left alone")
})

test("field mana is credited within its bound, and never taken", async () => {
    const { getQuestFromCategorySync } = await import("../src/lib/assets")
    const manaReward = (getQuestFromCategorySync(MAIN, QUEST_ID) as { manaReward: number }).manaReward
    const { viewerId, playerId } = await signUp()
    const mana = () => data.getPlayerSync(playerId)!.freeMana

    let before = mana()
    const huge = await play(viewerId, { add_mana: 2 ** 31 - 1 })
    assert.equal(huge.rewards.field_mana, questResult.FIELD_MANA_MAX)
    assert.ok(mana() <= before + manaReward + questResult.FIELD_MANA_MAX + 100000, "no more than the quest's mana, its score drops and the bound")
    assert.ok(mana() >= before + manaReward + questResult.FIELD_MANA_MAX)

    before = mana()
    const negative = await play(viewerId, { add_mana: -1_000_000 })
    assert.equal(negative.rewards.field_mana, 0)
    assert.ok(mana() >= before + manaReward, "a negative claim takes nothing away")
})

test("a negative clear time doesn't rank S+, and the score is stored whole and non-negative", async () => {
    const { viewerId, playerId } = await signUp()
    const reply = await play(viewerId, { elapsed_time_ms: -100, score: -50 })
    assert.equal(reply.clear_rank, 1)
    const progress = data.getPlayerSingleQuestProgressSync(playerId, MAIN, QUEST_ID)!
    assert.equal(progress.clearRank, 1)
    assert.ok(!progress.highScore, "no score above 0 (a score of 0 is stored as none)")

    await play(viewerId, { elapsed_time_ms: 5000, score: 1234.9 })
    assert.equal(data.getPlayerSingleQuestProgressSync(playerId, MAIN, QUEST_ID)!.highScore, 1234)
})

test("a unit listed twice earns its exp once", async () => {
    const { givePlayerCharacterSync } = await import("../src/lib/character")
    const { viewerId, playerId } = await signUp()
    const characterId = readCapturedRoute("expod_stack_to_exp").requestBody.character_id
    givePlayerCharacterSync(playerId, characterId)
    const exp = () => data.getPlayerCharacterSync(playerId, characterId)!.exp

    const single = exp()
    await play(viewerId, { statistics: party([characterId, null, null]) })
    const once = exp() - single

    const before = exp()
    const reply = await play(viewerId, { statistics: party([characterId, characterId, characterId, characterId], [characterId, null, null]) })
    assert.equal(exp() - before, once)
    assert.equal(reply.add_exp_list.length, 1)
})

test("a lost final rush round neither completes the folder nor pays its rewards", async () => {
    const { QuestCategory } = await import("../src/lib/types")
    // rush event 700001, folder 1 (two rounds): round 2 is quest 700001002, the folder pays 50 of item 70001
    const quest = { category: QuestCategory.RUSH_EVENT, quest_id: 700001002 }
    const { viewerId, playerId } = await signUp()
    const items = () => data.getPlayerItemSync(playerId, 70001) ?? 0

    const lost = await play(viewerId, { is_accomplished: false }, quest)
    assert.deepEqual(lost.rush_event.rush_battle_reward_list, [])
    assert.equal(items(), 0)

    const won = await play(viewerId, { is_accomplished: true }, quest)
    assert.ok(won.rush_event.rush_battle_reward_list.some((reward: { kind_id: number, number: number }) => reward.kind_id === 70001 && reward.number === 50))
    assert.equal(items(), 50)
})
