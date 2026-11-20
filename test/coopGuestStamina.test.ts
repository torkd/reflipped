// FT-60: what a co-op battle start costs each player, as the client's StaminaCostCalculator shows it. The host pays the
// quest's full cost; a guest who joined through an invitation, or whose host is a mutual follow, pays nothing; any other
// guest (one-way follow either way, or none) pays half, rounded down, with an open stamina campaign applied to that half.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import staminaData from "../assets/stamina.json";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const QUEST = 1001001 // boss battle, 6 stamina
const ODD_QUEST = 1002001 // boss battle, 13 stamina
const BOSS = 2 // QuestCategory.BOSS_BATTLE

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    process.env.EVENT_SCHEDULING = "off";
    process.env.STAMINA = "on";
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

after(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    await cleanup()
})

interface Player extends TestPlayer { playerId: number }

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
    const playerId = data.getViewerPlayerIdSync(player.viewerId)!
    data.updatePlayerSync({ id: playerId, stamina: 500 })
    return { ...player, playerId }
}

const openRoom = async (host: Player, questId = QUEST) =>
    (await ok(host, "multi_battle_quest/create_room", { quest_id: questId, category: BOSS, party_id: 1 })).data.room_number as string

/** The stamina a co-op start took from the player, after joining the room the way `acceptedType` says. */
async function startCost(player: Player, room: string, questId = QUEST, acceptedType = 1): Promise<number> {
    await ok(player, "multi_battle_quest/select_room", { room_number: room, category: BOSS, quest_id: questId, party_id: 1, accepted_type: acceptedType })
    const before = data.getPlayerSync(player.playerId)!.stamina
    await ok(player, "multi_battle_quest/start", {
        room_number: room, quest_id: questId, category: BOSS, party_id: 1, play_id: "TEST",
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, mate_player_ids: []
    })
    return before - data.getPlayerSync(player.playerId)!.stamina
}

test("the host pays in full; a guest pays half unless a mutual follow", async () => {
    const host = await newPlayer()
    const stranger = await newPlayer(), following = await newPlayer(), follower = await newPlayer(), mutual = await newPlayer()
    await ok(following, "follow/add", { follow_id: host.viewerId })
    await ok(host, "follow/add", { follow_id: follower.viewerId })
    await ok(host, "follow/add", { follow_id: mutual.viewerId })
    await ok(mutual, "follow/add", { follow_id: host.viewerId })

    assert.equal(await startCost(host, await openRoom(host)), 6, "the host pays the quest's cost")
    assert.equal(await startCost(stranger, await openRoom(host)), 3, "no follow: half")
    assert.equal(await startCost(following, await openRoom(host)), 3, "the guest follows the host: half")
    assert.equal(await startCost(follower, await openRoom(host)), 3, "the host follows the guest: half")
    assert.equal(await startCost(mutual, await openRoom(host)), 0, "a mutual follow: nothing")
})

test("an odd cost halves rounded down, and an abort gives back what was taken", async () => {
    const host = await newPlayer(), guest = await newPlayer()
    const room = await openRoom(host, ODD_QUEST)
    assert.equal(await startCost(guest, room, ODD_QUEST), 6, "13 halves to 6")
    const before = data.getPlayerSync(guest.playerId)!.stamina
    await ok(guest, "multi_battle_quest/abort", {
        room_number: room, quest_id: ODD_QUEST, category: BOSS, play_id: "TEST", finish_kind: 2, statistics: {}, api_count: 5
    })
    assert.equal(data.getPlayerSync(guest.playerId)!.stamina - before, 6, "the abort refunds the half the guest paid")
})

test("a guest who joined through an invitation pays nothing", async () => {
    const { resetRecruitment } = await import("../src/lib/coop/recruitment")
    resetRecruitment()
    const host = await newPlayer(), guest = await newPlayer()
    await ok(guest, "attention/check", { holding_number: 0, request_number: 3 }) // online and free
    const room = await openRoom(host)
    await ok(host, "multi_battle_quest/share_room", { quest_id: QUEST, category: BOSS, room_number: room, share_type_list: [3] })
    const offered = await ok(guest, "attention/check", { holding_number: 0, request_number: 3 })
    assert.equal(offered.data.multi?.[0]?.quest_info?.room_number, room, "the room is offered to the guest")
    assert.equal(await startCost(guest, room, QUEST, 2), 0)

    // a player who claims an invitation the server never delivered pays like any guest
    const other = await newPlayer()
    assert.equal(await startCost(other, await openRoom(host), QUEST, 2), 3)
})

/** The abort of a co-op battle started in `room`. */
const abort = (player: Player, room: string, questId = QUEST) =>
    ok(player, "multi_battle_quest/abort", { room_number: room, quest_id: questId, category: BOSS, play_id: "TEST", finish_kind: 2, statistics: {}, api_count: 5 })

test("an abort refunds what the start took, once; the host's abort gives back the full cost", async () => {
    const host = await newPlayer(), guest = await newPlayer()
    const guestRoom = await openRoom(host, ODD_QUEST)
    assert.equal(await startCost(guest, guestRoom, ODD_QUEST), 6)
    const before = data.getPlayerSync(guest.playerId)!.stamina
    await abort(guest, guestRoom, ODD_QUEST)
    await abort(guest, guestRoom, ODD_QUEST) // a second abort finds no battle to give back
    assert.equal(data.getPlayerSync(guest.playerId)!.stamina - before, 6)

    const hostRoom = await openRoom(host, ODD_QUEST)
    assert.equal(await startCost(host, hostRoom, ODD_QUEST), 13)
    const hostBefore = data.getPlayerSync(host.playerId)!.stamina
    await abort(host, hostRoom, ODD_QUEST)
    assert.equal(data.getPlayerSync(host.playerId)!.stamina - hostBefore, 13)
})

test("an invitation for another room, or one that was declined, does not make a join free", async () => {
    const { resetRecruitment } = await import("../src/lib/coop/recruitment")
    resetRecruitment()
    const hostA = await newPlayer(), hostB = await newPlayer(), guest = await newPlayer()
    await ok(guest, "attention/check", { holding_number: 0, request_number: 3 })
    const roomA = await openRoom(hostA)
    await ok(hostA, "multi_battle_quest/share_room", { quest_id: QUEST, category: BOSS, room_number: roomA, share_type_list: [3] })
    const offered = await ok(guest, "attention/check", { holding_number: 0, request_number: 3 })
    assert.equal(offered.data.multi?.[0]?.quest_info?.room_number, roomA)

    // the invitation was for room A: claiming it for hostB's room (never shared) is an ordinary join
    assert.equal(await startCost(guest, await openRoom(hostB), QUEST, 2), 3)

    // a declined invitation (the client sends attention/action): a later claim for the room pays like any guest
    await ok(guest, "attention/action", { priority_factors: ["Decline"] })
    assert.equal(await startCost(guest, roomA, QUEST, 2), 3)
})

test("an invited guest who comes back to the room another way pays like any guest", async () => {
    const { resetRecruitment } = await import("../src/lib/coop/recruitment")
    resetRecruitment()
    const host = await newPlayer(), guest = await newPlayer()
    await ok(guest, "attention/check", { holding_number: 0, request_number: 3 })
    const room = await openRoom(host)
    await ok(host, "multi_battle_quest/share_room", { quest_id: QUEST, category: BOSS, room_number: room, share_type_list: [3] })
    await ok(guest, "attention/check", { holding_number: 0, request_number: 3 })
    const join = (acceptedType: number) => ok(guest, "multi_battle_quest/select_room", { room_number: room, category: BOSS, quest_id: QUEST, party_id: 1, accepted_type: acceptedType })

    await join(2)
    await join(5) // left and found the room in the list: the client has no invitation for this join
    assert.equal(await startCost(guest, room, QUEST, 5), 3)
})

test("questStaminaCost: shares, a cost of 1, and a campaign on the halved cost", async () => {
    const { questStaminaCost, coopGuestStaminaShare } = await import("../src/lib/stamina")
    const date = new Date("2025-01-03T12:00:00Z")
    assert.equal(coopGuestStaminaShare(true, false), "free")
    assert.equal(coopGuestStaminaShare(false, true), "free")
    assert.equal(coopGuestStaminaShare(false, false), "half")
    assert.equal(questStaminaCost(BOSS, QUEST, 6, date, "full"), 6)
    assert.equal(questStaminaCost(BOSS, QUEST, 6, date, "free"), 0)
    assert.equal(questStaminaCost(BOSS, QUEST, 1, date, "half"), 0, "half of 1 is 0, as the client's getHalvedCost")

    // a campaign covering the quest applies to the halved cost: max(1, floor(half × rate)), or 0 at rate 0
    const campaign = staminaData.campaigns
        .map(campaign => ({ campaign, at: new Date(campaign.start.replace(" ", "T") + "Z") }))
        .find(({ at }) => questStaminaCost(BOSS, ODD_QUEST, 13, at) < 13)
    assert.ok(campaign, "a stamina campaign covers boss battles")
    const rate = questStaminaCost(BOSS, ODD_QUEST, 100000, campaign.at) / 100000 // the campaigns' rates are 0.25, 0.5, …
    const halved = questStaminaCost(BOSS, ODD_QUEST, 13, campaign.at, "half")
    assert.equal(halved, rate <= 0 ? 0 : Math.max(1, Math.floor(6 * rate)))
})
