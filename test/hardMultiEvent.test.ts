// FT-23: the co-op boss events ("For The Reckoning ... Steambot", hard multi, category 19). Their quests start within
// their event's period; a won battle with a daily count left (the event's periodic reward point, 2 a day) spends one
// and drops the special reward (the event's augment gear), named in `drop_periodic_reward_ids`, with the new count in
// `user_periodic_reward_point_list`.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const HARD_MULTI = 26
// "For The Reckoning Inferno Steambot": event 1, 2024-05-28 14:00 to 2024-06-07 20:59:59 Japan time; its quest 1001
// drops periodic reward group 1 (9 Water-Cut Gears, item 40402) and spends periodic reward point 1
const QUEST = 1001
const POINT = 1
const GEAR = 40402
const DURING = "2024-05-30T12:00:00Z"
const BEFORE = "2024-05-27T12:00:00Z"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    process.env.QUEST_PERIOD_CHECK = "enforce"
    ;({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    process.env.QUEST_PERIOD_CHECK = "off"
    await cleanup()
})

async function setClock(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

async function newPlayer(date: string): Promise<TestPlayer & { playerId: number }> {
    await setClock(date)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.statusCode, 200, response.body)
    return { ...player, playerId }
}

/** Meets the event's unlock (`hard_multi_red`): player rank 120, the Necropolis' quest 1038 and the Descension's
 * Godly quest 200014004 cleared. */
function unlock(playerId: number) {
    data.updatePlayerSync({ id: playerId, rankPoint: 1774864 })
    data.insertPlayerQuestProgressSync(playerId, 13, { questId: 1038, finished: true, clearRank: 1 })
    data.insertPlayerQuestProgressSync(playerId, 8, { questId: 200014004, finished: true, clearRank: 1 })
}

function start(player: TestPlayer) {
    return post(player, "single_battle_quest/start", {
        quest_id: QUEST, category: HARD_MULTI, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
}

async function battle(player: TestPlayer, won = true) {
    const started = await start(player)
    assert.equal(started.statusCode, 200, started.body)
    const response = await post(player, "single_battle_quest/finish", {
        quest_id: QUEST, category: HARD_MULTI, score: 1000, add_mana: 0, elapsed_time_ms: 300000,
        is_accomplished: won, is_restored: false, continue_count: 0, api_count: 2, play_id: "test",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

function count(playerId: number): number {
    return data.getPlayerPeriodicRewardPointsSync(playerId).find(entry => entry.id === POINT)?.point ?? 0
}

test("the quest starts only within its event's period", async () => {
    const early = await newPlayer(BEFORE)
    unlock(early.playerId)
    assert.equal((await start(early)).statusCode, 400)
    const player = await newPlayer(DURING)
    unlock(player.playerId)
    const ok = await start(player)
    assert.equal(ok.statusCode, 200, ok.body)
})

test("a won battle spends a daily count for the special reward, until none is left", async () => {
    const player = await newPlayer(DURING)
    unlock(player.playerId)
    // a new player starts with the captured counts (22 here); give them the 2 of one day
    data.setPlayerPeriodicRewardPointSync(player.playerId, POINT, 2)
    const gears = () => data.getPlayerItemSync(player.playerId, GEAR) ?? 0

    const first = await battle(player)
    assert.deepEqual(first.drop_periodic_reward_ids, [{ group_id: 1, index: 1, number: 9 }])
    assert.deepEqual(first.user_periodic_reward_point_list, [{ id: POINT, point: 1 }])
    assert.equal(gears(), 9)
    assert.equal(first.item_list[String(GEAR)], 9)
    assert.equal(count(player.playerId), 1)

    // a lost battle receives nothing and keeps the count
    const lost = await battle(player, false)
    assert.deepEqual(lost.drop_periodic_reward_ids, [])
    assert.equal(lost.user_periodic_reward_point_list, undefined)
    assert.equal(count(player.playerId), 1)

    await battle(player)
    assert.equal(gears(), 18)
    assert.equal(count(player.playerId), 0)

    const none = await battle(player)
    assert.deepEqual(none.drop_periodic_reward_ids, [])
    assert.equal(none.user_periodic_reward_point_list, undefined)
    assert.equal(gears(), 18)
})

test("developer mode clears the co-op boss quests", async () => {
    const player = await newPlayer(DURING)
    const { unlockEverything } = await import("../src/lib/developerMode")
    unlockEverything(player.playerId)
    assert.equal(data.getPlayerSingleQuestProgressSync(player.playerId, HARD_MULTI, QUEST)?.finished, true)
})

// the unlock (`hard_multi_red`): rank 120 (1774864 rank points), quest 1038 of the Necropolis cleared (category 13) and
// the Descension's Godly quest 200014004 cleared as an advent quest (category 7 or 8)
const RANK_120 = 1774864
const NECROPOLIS = 13
const ADVENT_QUEST = 200014004

function message(response: { body: string }): string {
    return JSON.parse(response.body).message
}

function giveRank(playerId: number) {
    data.updatePlayerSync({ id: playerId, rankPoint: RANK_120 })
}
function clearNecropolis(playerId: number) {
    data.insertPlayerQuestProgressSync(playerId, NECROPOLIS, { questId: 1038, finished: true, clearRank: 1 })
}
function clearAdvent(playerId: number, category: number) {
    data.insertPlayerQuestProgressSync(playerId, category, { questId: ADVENT_QUEST, finished: true, clearRank: 1 })
}

test("the unlock is checked at the start, condition by condition", async () => {
    const player = await newPlayer(DURING)
    const noRank = await start(player)
    assert.equal(noRank.statusCode, 400)
    assert.equal(message(noRank), "Needs rank 120.")

    giveRank(player.playerId)
    const noNecropolis = await start(player)
    assert.equal(noNecropolis.statusCode, 400)
    assert.match(message(noNecropolis), /^Needs quest 1038 cleared first\.$/)

    clearNecropolis(player.playerId)
    const noAdvent = await start(player)
    assert.equal(noAdvent.statusCode, 400)
    assert.match(message(noAdvent), /^Needs quest 200014004 cleared first\.$/)

    clearAdvent(player.playerId, 8)
    const ok = await start(player)
    assert.equal(ok.statusCode, 200, ok.body)
})

test("the quest clears do not stand in for the rank, and an unfinished advent quest does not count", async () => {
    const player = await newPlayer(DURING)
    clearNecropolis(player.playerId)
    clearAdvent(player.playerId, 8)
    assert.equal(message(await start(player)), "Needs rank 120.")

    const other = await newPlayer(DURING)
    giveRank(other.playerId)
    clearNecropolis(other.playerId)
    data.insertPlayerQuestProgressSync(other.playerId, 8, { questId: ADVENT_QUEST, finished: false, clearRank: 1 })
    assert.equal((await start(other)).statusCode, 400)
})

test("the advent boss quest counts when cleared alone (category 7) and when cleared in co-op (category 8)", async () => {
    for (const category of [7, 8]) {
        const player = await newPlayer(DURING)
        giveRank(player.playerId)
        clearNecropolis(player.playerId)
        assert.equal((await start(player)).statusCode, 400, `category ${category} not cleared yet`)
        clearAdvent(player.playerId, category)
        const ok = await start(player)
        assert.equal(ok.statusCode, 200, `advent category ${category}: ${ok.body}`)
    }
})

test("the advent boss quest cleared in another category does not count", async () => {
    const player = await newPlayer(DURING)
    giveRank(player.playerId)
    clearNecropolis(player.playerId)
    clearAdvent(player.playerId, 2)
    assert.equal((await start(player)).statusCode, 400)
})

function createRoom(player: TestPlayer) {
    return post(player, "multi_battle_quest/create_room", { quest_id: QUEST, party_id: 11, category: HARD_MULTI })
}

test("a locked host can't create a room for the event, an unlocked one can", async () => {
    const locked = await newPlayer(DURING)
    const refused = await createRoom(locked)
    assert.equal(refused.statusCode, 400)
    assert.equal(message(refused), "Needs rank 120.")

    const host = await newPlayer(DURING)
    unlock(host.playerId)
    const created = await createRoom(host)
    assert.equal(created.statusCode, 200, created.body)
    assert.ok(decodeGameBody(created.body).data.room_number)
})

test("a locked guest joins an unlocked host's room and starts the battle", async () => {
    const host = await newPlayer(DURING)
    unlock(host.playerId)
    const guest = await newPlayer(DURING)
    // alone the guest is refused
    assert.equal((await start(guest)).statusCode, 400)

    const roomNumber = decodeGameBody((await createRoom(host)).body).data.room_number
    const selected = await post(guest, "multi_battle_quest/select_room", {
        party_id: 1, room_number: roomNumber, quest_id: QUEST, accepted_type: 1, category: HARD_MULTI
    })
    assert.equal(selected.statusCode, 200, selected.body)
    const body = {
        room_number: roomNumber, quest_id: QUEST, category: HARD_MULTI, party_id: 1, play_id: "ROOM",
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, mate_player_ids: []
    }
    const started = await post(guest, "multi_battle_quest/start", body)
    assert.equal(started.statusCode, 200, started.body)
    // the exemption belongs to the room's start: the same guest still can't start alone afterwards
    assert.equal((await start(guest)).statusCode, 400)
})

// Event mission 600001 ("clear with an S+ rank", pattern 81): only a co-op S+ clear (clear time within 360000 ms) of the
// event's quest counts; its mission is in category 3
const MISSION = 600001
const EVENT_MISSIONS = 3

function missionProgress(playerId: number): number {
    return data.getPlayerMissionsSync(playerId, EVENT_MISSIONS).find(row => row.missionId === MISSION)?.progress ?? 0
}

/** A co-op battle of the event quest: the host creates the room, starts and finishes it in `elapsedMs`. */
async function coopBattle(host: TestPlayer & { playerId: number }, elapsedMs: number) {
    const created = await createRoom(host)
    assert.equal(created.statusCode, 200, created.body)
    const roomNumber = decodeGameBody(created.body).data.room_number
    const started = await post(host, "multi_battle_quest/start", {
        room_number: roomNumber, quest_id: QUEST, category: HARD_MULTI, party_id: 1, play_id: "COOP",
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, mate_player_ids: []
    })
    assert.equal(started.statusCode, 200, started.body)
    const finished = await post(host, "multi_battle_quest/finish", {
        ...readCapturedRoute("multi_battle_quest_finish").requestBody,
        quest_id: QUEST, category: HARD_MULTI, elapsed_time_ms: elapsedMs, is_accomplished: true, play_id: "COOP"
    })
    assert.equal(finished.statusCode, 200, finished.body)
    return decodeGameBody(finished.body).data
}

test("a co-op S+ clear of the event's quest advances its S+ mission, a lower rank does not", async () => {
    const host = await newPlayer(DURING)
    unlock(host.playerId)
    assert.equal(missionProgress(host.playerId), 0)

    // rank S (468000 ms or less) and A (603000 ms or less): not S+
    const rankS = await coopBattle(host, 400000)
    assert.equal(rankS.clear_rank, 4)
    assert.equal(missionProgress(host.playerId), 0)
    const rankA = await coopBattle(host, 500000)
    assert.equal(rankA.clear_rank, 3)
    assert.equal(missionProgress(host.playerId), 0)

    const fast = await coopBattle(host, 300000)
    assert.equal(fast.clear_rank, 5)
    assert.equal(missionProgress(host.playerId), 1)
})

test("a solo S+ clear does not count for the co-op-only S+ mission", async () => {
    const player = await newPlayer(DURING)
    unlock(player.playerId)
    const result = await battle(player)
    assert.equal(result.clear_rank, 5)
    assert.equal(missionProgress(player.playerId), 0)
})
