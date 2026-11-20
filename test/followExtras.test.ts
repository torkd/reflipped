// FT-43: follow extras. Co-op players who follow each other both ways get the follow bonus in the start reply (10 per
// battle the pair has started together, capped at 9990); a room recruited for follows only is kept from everyone
// else (left out of the room list, NotFollowHost from select_room); a shared profile link opens a page that hands the
// player's viewer ID to the game's own scheme.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let rooms: typeof import("../src/lib/coop/rooms")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    rooms = await import("../src/lib/coop/rooms")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

type Player = TestPlayer & { playerId: number, accountId: number }

async function ok(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body) as any
}

async function newPlayer(): Promise<Player> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId, accountId: session!.accountId }
}

async function mutual(a: Player, b: Player) {
    await ok(a, "follow/add", { follow_id: b.viewerId })
    await ok(b, "follow/add", { follow_id: a.viewerId })
}

const quest = { quest_id: 1001001, category: 2, party_id: 1 }

async function openRoom(host: Player): Promise<string> {
    return (await ok(host, "multi_battle_quest/create_room", quest)).data.room_number
}

/**
 * One round of the room's battle with these players, as the lobby's StartBattle begins it; the start replies. Each player
 * then ends it as `ends` says: by `finish` (played to the end, the default), by `abort`, or without a word.
 */
async function playRound(roomNumber: string, players: Player[], ends: ("finish" | "abort" | "none")[] = []): Promise<any[]> {
    const room = rooms.getRoom(roomNumber)!
    for (const player of players) rooms.admit(room, player.viewerId)
    rooms.openRound(room)
    rooms.startRound(room, players.map(player => player.viewerId))
    const replies = []
    for (const player of players) replies.push((await ok(player, "multi_battle_quest/start", {
        ...quest, room_number: roomNumber, play_id: "FT43", use_boost_point: false, use_boss_boost_point: false,
        is_auto_start_mode: false, mate_player_ids: []
    })).data)
    for (const [index, player] of players.entries()) {
        const end = ends[index] ?? "finish"
        if (end === "finish") {
            await ok(player, "multi_battle_quest/finish", { ...readCapturedRoute("multi_battle_quest_finish").requestBody, ...quest })
        } else if (end === "abort") {
            const { category: _ignored, ...abort } = readCapturedRoute("multi_battle_quest_abort").requestBody
            await ok(player, "multi_battle_quest/abort", { ...abort, room_number: roomNumber })
        }
        rooms.noteRoundEnded(player.viewerId)
    }
    return replies
}

test("the follow bonus: 10 per battle a mutual pair played to the end together, the same list for every player", async () => {
    const host = await newPlayer(), friend = await newPlayer(), stranger = await newPlayer()
    await mutual(host, friend)
    const roomNumber = await openRoom(host)

    const first = await playRound(roomNumber, [host, friend, stranger])
    const info = first[0].follow_bonus_info
    for (const reply of first) assert.deepEqual(reply.follow_bonus_info, info, "every player gets the same list")
    const entry = (player: Player) => info.find((e: any) => e.viewer_id === player.viewerId)
    assert.deepEqual(entry(host), { viewer_id: host.viewerId, follow_bonus_list: { [String(friend.viewerId)]: 10 }, total_follow_bonus: 10 })
    assert.deepEqual(entry(friend), { viewer_id: friend.viewerId, follow_bonus_list: { [String(host.viewerId)]: 10 }, total_follow_bonus: 10 })
    assert.deepEqual(entry(stranger), { viewer_id: stranger.viewerId, follow_bonus_list: {}, total_follow_bonus: 0 })

    // the next round counts again
    const second = await playRound(roomNumber, [host, friend])
    assert.equal(second[1].follow_bonus_info.find((e: any) => e.viewer_id === friend.viewerId).total_follow_bonus, 20)

    // a battle one of the pair abandoned, or left without a word, isn't counted: starting and aborting battles costs
    // nothing, so it mustn't raise the bonus
    const total = async (ends: ("finish" | "abort" | "none")[]) => (await playRound(roomNumber, [host, friend], ends))[0]
        .follow_bonus_info.find((e: any) => e.viewer_id === host.viewerId).total_follow_bonus
    assert.equal(await total(["abort", "abort"]), 30)
    assert.equal(await total(["finish", "abort"]), 30)
    assert.equal(await total(["none", "finish"]), 30)
    assert.equal(await total(["finish", "finish"]), 30, "counted once both finished")
    assert.equal(await total([]), 40)

    // a one-way follow gives nothing, and the key is left out like in the captured start
    const other = await newPlayer()
    await ok(other, "follow/add", { follow_id: stranger.viewerId })
    const plain = await playRound(await openRoom(stranger), [stranger, other])
    for (const reply of plain) assert.equal(reply.follow_bonus_info, undefined)
})

test("the follow bonus stops at 9990", async () => {
    const { followBonusRoundSync } = await import("../src/lib/follows")
    const followBonusInfoSync = (viewerIds: number[]) => followBonusRoundSync(viewerIds).info
    const a = await newPlayer(), b = await newPlayer(), c = await newPlayer()
    await mutual(a, b)
    await mutual(a, c)
    for (let i = 0; i < 700; i++) data.addCoopPartnerBattleSync(a.playerId, b.playerId)
    for (let i = 0; i < 700; i++) data.addCoopPartnerBattleSync(c.playerId, a.playerId)
    const info = followBonusInfoSync([a.viewerId, b.viewerId, c.viewerId])
    const ofA = info.find(e => e.viewer_id === a.viewerId)!
    assert.deepEqual(ofA.follow_bonus_list, { [String(b.viewerId)]: 7010, [String(c.viewerId)]: 7010 })
    assert.equal(ofA.total_follow_bonus, 9990)
    for (let i = 0; i < 400; i++) data.addCoopPartnerBattleSync(a.playerId, b.playerId)
    assert.equal(followBonusInfoSync([a.viewerId, b.viewerId]).find(e => e.viewer_id === b.viewerId)!.follow_bonus_list[String(a.viewerId)], 9990)
})

test("a room recruited for follows only is left out of other players' room lists and turns them away", async () => {
    const host = await newPlayer(), follower = await newPlayer(), stranger = await newPlayer()
    await ok(follower, "follow/add", { follow_id: host.viewerId })
    const roomNumber = await openRoom(host)
    const listed = async (player: Player) => (await ok(player, "multi_battle_quest/get_rooms", { category_id: 2 })).data.rooms
        .some((room: any) => room.room_number === roomNumber)
    const select = async (player: Player, accepted_type: number) => (await ok(player, "multi_battle_quest/select_room", {
        ...quest, room_number: roomNumber, accepted_type
    })).data.raising_state

    // not recruited yet: open to all
    assert.equal(await listed(stranger), true)

    await ok(host, "multi_battle_quest/share_room", { ...quest, room_number: roomNumber, share_type_list: [1, 2] })
    assert.equal(await listed(stranger), false)
    assert.equal(await listed(follower), true)
    assert.equal(await select(stranger, 5), 12, "NotFollowHost from the room list")
    assert.equal(await select(stranger, 2), 12, "NotFollowHost from an invitation")
    assert.equal(rooms.getRoom(roomNumber)!.members.has(stranger.viewerId), false)
    assert.equal(await select(follower, 5), 1)
    assert.equal(await select(stranger, 3), 1, "a typed room number still lets them in")

    // recruiting anyone as well opens it again
    const other = await openRoom(follower)
    await ok(follower, "multi_battle_quest/share_room", { ...quest, room_number: other, share_type_list: [1] })
    await ok(follower, "multi_battle_quest/share_room", { ...quest, room_number: other, share_type_list: [3] })
    assert.equal((await ok(stranger, "multi_battle_quest/get_rooms", { category_id: 2 })).data.rooms
        .some((room: any) => room.room_number === other), true)
})

test("a shared profile link opens a page that hands the player's viewer ID to the game", async () => {
    const player = await newPlayer()
    const url = `${apiPrefix}/friend/follow?kid=${player.accountId}&c=12345`
    const page = await fastify.inject({ method: "GET", url })
    assert.equal(page.statusCode, 200)
    assert.match(String(page.headers["content-type"]), /^text\/html/)
    assert.ok(page.body.includes(`href="wdfp://profile?id=${player.viewerId}"`), page.body)
    assert.ok(page.body.includes(String(player.viewerId)))
    assert.ok(!/style=|<style|<script/.test(page.body), "no inline styles or scripts")
    const onAndroid = await fastify.inject({ method: "GET", url, headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120" } })
    assert.ok(onAndroid.body.includes(`intent://profile?id=${player.viewerId}#Intent;scheme=wdfp;end`))

    for (const kid of ["999999999", "nope", "%3Cscript%3E", ""]) {
        const missing = await fastify.inject({ method: "GET", url: `${apiPrefix}/friend/follow?kid=${kid}&c=1` })
        assert.equal(missing.statusCode, 404, kid)
        assert.ok(!missing.body.includes("<script>"))
    }
})
