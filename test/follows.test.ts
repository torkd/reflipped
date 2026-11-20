// FT-15: follows. Players find each other by viewer ID (follow/search_kakao_pid), follow and unfollow, see the follow
// states the client's tabs use (1 mutual, 2 following, 3 follower), open each other's profiles (profile/get_profile,
// counts hidden by the target's settings sent as null), keep their follows through a save import, and in co-op see
// the host's follow state; a guest in a mutual follow's room starts without paying stamina.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    // stamina costs are off in tests unless asked for (test/helpers.ts); the co-op test checks who pays
    process.env.STAMINA = "on";
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

type Player = TestPlayer & { playerId: number }

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.body }
}

async function ok(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await post(player, route, body)
    assert.equal(response.status, 200, String(response.body))
    return response.body as any
}

async function newPlayer(): Promise<Player> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

async function stateOf(player: Player, other: Player): Promise<number | undefined> {
    const { data: lists } = await ok(player, "follow/lists", {})
    return lists.follow_info.find((entry: any) => entry.viewer_id === other.viewerId)?.follow_state
}

test("the search finds a player by viewer ID, and not yourself or an unknown ID", async () => {
    const a = await newPlayer(), b = await newPlayer()
    const found = await ok(a, "follow/search_kakao_pid", { search_kakao_pid: String(b.viewerId) })
    assert.equal(found.data_headers.result_code, 1)
    assert.equal(found.data.search_result.viewer_id, b.viewerId)
    assert.equal(found.data.search_result.follow_state, 0)
    assert.equal(found.data.search_result.name, data.getPlayerSync(b.playerId)!.name)
    assert.equal(typeof found.data.search_result.last_login_time, "number")
    assert.equal(found.data.search_result.follow_time, null)

    for (const id of [String(a.viewerId), "123", "not a number"]) {
        const missing = await ok(a, "follow/search_kakao_pid", { search_kakao_pid: id })
        assert.equal(missing.data_headers.result_code, 1455, id)
    }
})

test("following both ways makes a mutual follow, and unfollowing undoes it", async () => {
    const a = await newPlayer(), b = await newPlayer()
    assert.equal((await ok(a, "follow/add", { follow_id: b.viewerId })).data_headers.result_code, 1)
    assert.equal(await stateOf(a, b), 2, "a follows b")
    assert.equal(await stateOf(b, a), 3, "b is followed by a")
    assert.equal((await ok(b, "follow/lists", {})).data.followed_count, 1)

    await ok(b, "follow/add", { follow_id: a.viewerId })
    assert.equal(await stateOf(a, b), 1)
    assert.equal(await stateOf(b, a), 1)
    const entry = (await ok(a, "follow/lists", {})).data.follow_info[0]
    assert.equal(typeof entry.follow_time, "number")
    assert.equal(typeof entry.followed_time, "number")

    await ok(a, "follow/delete", { follow_id: b.viewerId })
    assert.equal(await stateOf(a, b), 3)
    assert.equal((await post(a, "follow/add", { follow_id: a.viewerId })).status, 400, "not yourself")
})

test("bulk_edit unfollows and follows in one go", async () => {
    const a = await newPlayer(), b = await newPlayer(), c = await newPlayer()
    await ok(a, "follow/add", { follow_id: b.viewerId })
    const edited = await ok(a, "follow/bulk_edit", { add_follow_id_list: [c.viewerId], delete_follow_id_list: [b.viewerId] })
    assert.deepEqual([...edited.data.max_follower_user_viewer_id_list], [])
    assert.equal(await stateOf(a, b), undefined)
    assert.equal(await stateOf(a, c), 2)
})

test("get_profile shows another player's profile, without the counts they hide", async () => {
    const a = await newPlayer(), b = await newPlayer()
    await ok(a, "follow/add", { follow_id: b.viewerId })
    const shown = (await ok(a, "profile/get_profile", { target_viewer_id: b.viewerId })).data
    assert.equal(shown.target_user_info.viewer_id, b.viewerId)
    assert.equal(shown.target_user_info.follow_state, 2)
    assert.equal(shown.target_user_info.max_owned_character_count, 454)
    assert.equal(shown.favorite_character.character_ids.length, 3)
    assert.equal(shown.favorite_character.character_ex_boost.length, 3)

    await ok(b, "profile/update_profile_settings", { profile_settings: {
        show_owned_character_count: false, show_opened_mana_board_second_count: true, show_owned_degree_count: false
    } })
    const hidden = (await ok(a, "profile/get_profile", { target_viewer_id: b.viewerId })).data.target_user_info
    assert.equal(hidden.owned_character_count, null)
    assert.equal(hidden.max_owned_character_count, null)
    assert.equal(hidden.owned_degree_count, null)
    assert.equal(typeof hidden.opened_mana_board_second_count, "number")

    assert.equal((await post(a, "profile/get_profile", { target_viewer_id: 123 })).status, 400)
})

test("a save import keeps the player's follows both ways", async () => {
    const { getClientSerializedData, deserializePlayerData } = await import("../src/data/utils")
    const a = await newPlayer(), b = await newPlayer(), c = await newPlayer()
    await ok(a, "follow/add", { follow_id: b.viewerId })
    await ok(c, "follow/add", { follow_id: a.viewerId })
    const save = getClientSerializedData(a.playerId, { serializeSaveData: true })!
    data.replacePlayerDataSync(deserializePlayerData(a.playerId, save))
    assert.equal(await stateOf(a, b), 2)
    assert.equal(await stateOf(a, c), 3)
})

test("co-op: the host's follow state shows, and a mutual follow's guest pays no stamina", async () => {
    const host = await newPlayer(), mutual = await newPlayer(), stranger = await newPlayer()
    await ok(host, "follow/add", { follow_id: mutual.viewerId })
    await ok(mutual, "follow/add", { follow_id: host.viewerId })

    const openRoom = async () => (await ok(host, "multi_battle_quest/create_room", { quest_id: 1001001, category: 2, party_id: 1 })).data.room_number as string
    const roomNumber = await openRoom()
    const searched = await ok(mutual, "multi_battle_quest/search_room", { room_number: roomNumber })
    assert.equal(searched.data.establisher_follow, 1)
    assert.equal((await ok(stranger, "multi_battle_quest/search_room", { room_number: roomNumber })).data.establisher_follow, 0)

    // each guest joins a room of their own and starts its battle; the stamina it took
    const join = async (guest: Player, room: string) => {
        await ok(guest, "multi_battle_quest/select_room", { room_number: room, category: 2, quest_id: 1001001, party_id: 1, accepted_type: 1 })
        const before = data.getPlayerSync(guest.playerId)!.stamina
        await ok(guest, "multi_battle_quest/start", {
            room_number: room, quest_id: 1001001, category: 2, party_id: 1, play_id: "TEST",
            use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, mate_player_ids: []
        })
        return before - data.getPlayerSync(guest.playerId)!.stamina
    }
    assert.equal(await join(mutual, roomNumber), 0, "a mutual follow's guest pays nothing")
    assert.ok(await join(stranger, await openRoom()) > 0, "anyone else pays the quest's stamina")
})
