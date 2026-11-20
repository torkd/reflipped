import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

// SEC-16: the game ends a lost battle with single_battle_quest/abort, so a lost finish is refused, except for a lose
// battle (main quest 7014002, which the player is meant to lose: it counts as cleared) and the event modes whose lost
// battles finish with their result.

const apiPrefix = "/latest/api/index.php"
const MAIN = 1
const LOSE_BATTLE = 7014002
const NORMAL_BATTLE = 1001002

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

after(async () => {
    await cleanup()
})

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, data: response.statusCode === 200 ? decodeGameBody(response.body).data : response.json() }
}

async function play(player: TestPlayer, category: number, questId: number, accomplished: boolean) {
    const started = await post(player, "single_battle_quest/start", { ...readCapturedRoute("single_battle_quest_start").requestBody, category, quest_id: questId })
    assert.equal(started.status, 200, JSON.stringify(started.data))
    return post(player, "single_battle_quest/finish", {
        ...readCapturedRoute("single_battle_quest_finish").requestBody,
        category, quest_id: questId, is_accomplished: accomplished, ...(accomplished ? {} : { is_lose: true })
    })
}

async function newPlayer() {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return { player, playerId: (await data.getAccountPlayers(session!.accountId))[0] }
}

test("the lose battle is cleared when lost, with its first-clear reward", async () => {
    const { getQuestFromCategorySync } = await import("../src/lib/assets")
    assert.equal((getQuestFromCategorySync(MAIN, LOSE_BATTLE) as { loseBattle?: boolean }).loseBattle, true)
    assert.equal((getQuestFromCategorySync(MAIN, NORMAL_BATTLE) as { loseBattle?: boolean }).loseBattle, undefined)

    const { player, playerId } = await newPlayer()
    const beads = () => data.getPlayerSync(playerId)!.freeVmoney
    const before = beads()
    const lost = await play(player, MAIN, LOSE_BATTLE, false)
    assert.equal(lost.status, 200, JSON.stringify(lost.data))
    assert.equal(data.getPlayerSingleQuestProgressSync(playerId, MAIN, LOSE_BATTLE)?.finished, true)
    assert.ok(beads() > before, "the first-clear reward")

    const again = beads()
    assert.equal((await play(player, MAIN, LOSE_BATTLE, false)).status, 200)
    assert.equal(beads(), again, "once")
})

test("a lost finish of another quest is refused, pays nothing, and the battle can still end", async () => {
    const { player, playerId } = await newPlayer()
    const before = data.getPlayerSync(playerId)!
    const lost = await play(player, MAIN, NORMAL_BATTLE, false)
    assert.equal(lost.status, 400)
    assert.match(lost.data.message, /ends with abort/)
    const after = data.getPlayerSync(playerId)!
    assert.deepEqual([after.rankPoint, after.freeMana, after.expPool, after.freeVmoney], [before.rankPoint, before.freeMana, before.expPool, before.freeVmoney])
    assert.equal(data.getPlayerSingleQuestProgressSync(playerId, MAIN, NORMAL_BATTLE), null)

    // the active quest is kept: the game's abort (or a won finish) still ends it
    const won = await post(player, "single_battle_quest/finish", { ...readCapturedRoute("single_battle_quest_finish").requestBody, category: MAIN, quest_id: NORMAL_BATTLE, is_accomplished: true })
    assert.equal(won.status, 200, JSON.stringify(won.data))
    assert.ok(data.getPlayerSync(playerId)!.rankPoint > before.rankPoint)
})

test("event modes that finish their lost battles still do", async () => {
    const { QuestCategory } = await import("../src/lib/types")
    const { player } = await newPlayer()
    // score attack 1001: a run that ends without the win still sends its score
    assert.equal((await play(player, QuestCategory.SCORE_ATTACK_EVENT, 1001, false)).status, 200)
})

test("abort answers in msgpack like every game reply, and ends the battle", async () => {
    const { player } = await newPlayer()
    await post(player, "single_battle_quest/start", { ...readCapturedRoute("single_battle_quest_start").requestBody, category: MAIN, quest_id: NORMAL_BATTLE })
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/single_battle_quest/abort`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ api_count: 3, finish_kind: 1, statistics: {}, quest_id: NORMAL_BATTLE, play_id: "test", category: MAIN, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200)
    assert.match(String(response.headers["content-type"]), /application\/x-msgpack/)
    assert.equal(decodeGameBody(response.body).data.category_id, MAIN)
    const finish = await post(player, "single_battle_quest/finish", { ...readCapturedRoute("single_battle_quest_finish").requestBody, category: MAIN, quest_id: NORMAL_BATTLE, is_accomplished: true })
    assert.equal(finish.status, 400, "no battle left to finish")
})
