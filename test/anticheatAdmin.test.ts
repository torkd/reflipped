import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer, createTestPlayer } from "./helpers";
import { gameRequest, newViewer } from "./coopHelpers";

// SEC-18 phase 2: the anti-cheat mode, the review page and its actions, the Players page marks, and co-op visibility
// for restricted players.

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let flags: typeof import("../src/data/anticheatData")
let anticheat: typeof import("../src/lib/anticheat")
let follows: typeof import("../src/lib/follows")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    flags = await import("../src/data/anticheatData")
    anticheat = await import("../src/lib/anticheat")
    follows = await import("../src/lib/follows")
    anticheat.setAnticheatMode("log")
})
after(async () => {
    delete process.env.REFLIPPED_PROFILE
    anticheat.setAnticheatMode(null)
    await cleanup()
})

const headers = { host: "127.0.0.1:8001", "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:8001" }

function adminPost(url: string, form: Record<string, string>) {
    return admin.inject({
        method: "POST", url,
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(form).toString()
    })
}

function adminGet(url: string) {
    return admin.inject({ method: "GET", url, headers: { host: "127.0.0.1:8001" } })
}

async function newPlayer() {
    const viewerId = await newViewer(fastify)
    const session = await data.getSession(String(viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { viewerId, playerId, accountId: session!.accountId }
}

function addFlag(playerId: number, details: Record<string, unknown> = {}, rule = "wall-clock", severity: "hard" | "soft" | "info" = "hard") {
    return flags.insertAnticheatFlagSync({ playerId, rule, severity, route: "single_battle_quest/finish", questId: 1001001, details, reqId: "req-abc", created: new Date() })
}

test("the mode is chosen from the admin API and bad input is refused", async () => {
    const saved = await adminPost("/api/anticheat/mode", { mode: "enforce" })
    assert.equal(saved.statusCode, 302)
    assert.equal(saved.headers.location, "/security?message=mode_enforce#anticheat")
    assert.equal(anticheat.anticheatMode(), "enforce")

    const bad = await adminPost("/api/anticheat/mode", { mode: "strict" })
    assert.equal(bad.statusCode, 400)
    assert.equal((await adminPost("/api/anticheat/mode", {})).statusCode, 400)
    assert.equal(anticheat.anticheatMode(), "enforce", "a refused change changes nothing")

    await adminPost("/api/anticheat/mode", { mode: "off" })
    assert.equal(anticheat.anticheatMode(), "off")
    const page = (await adminGet("/security?message=mode_off")).body
    assert.match(page, /Anti-cheat is off/)

    await adminPost("/api/anticheat/mode", { mode: "default" })
    assert.equal(anticheat.anticheatMode(), "log", "default follows ANTICHEAT, else log")
    await adminPost("/api/anticheat/mode", { mode: "log" })
})

test("the Security page holds the mode and the timing tolerance; Settings no longer shows the tolerance", async () => {
    const page = (await adminGet("/security")).body
    assert.match(page, /data-tab="anticheat"/)
    assert.match(page, /data-tab="review"/)
    assert.match(page, /name="anticheat.wall_clock_slack_seconds"/)
    assert.doesNotMatch((await adminGet("/settings")).body, /name="anticheat.wall_clock_slack_seconds"/)
    const saved = await adminPost("/api/anticheat/settings", { "anticheat.wall_clock_slack_seconds": "25" })
    assert.equal(saved.headers.location, "/security?message=settings_saved#anticheat")
    const { getSetting } = await import("../src/data/serverSettings")
    assert.equal(getSetting("anticheat.wall_clock_slack_seconds"), 25)
    const refused = await adminPost("/api/anticheat/settings", { "anticheat.wall_clock_slack_seconds": "100000" })
    assert.equal(refused.headers.location, "/security?error=invalid_setting#anticheat")
    assert.equal(getSetting("anticheat.wall_clock_slack_seconds"), 25)
    // the page's first address still leads there
    const old = await adminGet("/anticheat?status=all")
    assert.equal(old.statusCode, 302)
    assert.equal(old.headers.location, "/security?status=all")
})

test("on the phone's own server the mode can't be changed and shows as off", async () => {
    process.env.REFLIPPED_PROFILE = "local"
    try {
        const refused = await adminPost("/api/anticheat/mode", { mode: "enforce" })
        assert.equal(refused.statusCode, 409)
        const page = (await adminGet("/security")).body
        assert.match(page, /always off on the server on the phone/)
        assert.doesNotMatch(page, /name="mode"/)
    } finally {
        delete process.env.REFLIPPED_PROFILE
    }
    assert.equal(anticheat.anticheatMode(), "log")
})

test("the review page lists open flags with HTML-like details escaped, and filters", async () => {
    const { playerId } = await newPlayer()
    const flagId = addFlag(playerId, { note: "<script>alert(1)</script>", seconds: 3, excluded: true })
    const other = await newPlayer()
    addFlag(other.playerId, { n: 1 }, "<img src=x onerror=alert(2)>", "soft")

    const page = (await adminGet("/security")).body
    assert.ok(page.includes("Clear time"), "the rule's plain title")
    assert.ok(page.includes("note: &lt;script&gt;alert(1)&lt;/script&gt;"), "details are escaped")
    assert.ok(!page.includes("<script>alert(1)"), "no raw details")
    assert.ok(!page.includes("<img src=x"), "a rule name is escaped too")
    assert.match(page, /kept off boards/)
    assert.match(page, /req-abc/)
    assert.match(page, new RegExp(`href="/player/${playerId}"`))

    const one = (await adminGet(`/security?player=${playerId}`)).body
    assert.ok(one.includes("note: &lt;script&gt;"))
    assert.ok(!one.includes("&lt;img"), "the other player's flag is filtered out")

    const dismissed = await adminPost("/api/anticheat/dismiss", { flagId: String(flagId), back: "review" })
    assert.equal(dismissed.statusCode, 302)
    assert.equal(dismissed.headers.location, "/security?message=dismissed#review")
    assert.equal(flags.getAnticheatFlagSync(flagId)!.status, "dismissed")
    assert.ok(!(await adminGet("/security")).body.includes("note: &lt;script&gt;"), "gone from the open list")
    assert.ok((await adminGet("/security?status=dismissed")).body.includes("note: &lt;script&gt;"))
    assert.ok((await adminGet("/security?status=all")).body.includes("<img src=x") === false)

    const again = await adminPost("/api/anticheat/dismiss", { flagId: String(flagId) })
    assert.equal(again.headers.location, "/security?error=flag_closed#review")
    assert.equal((await adminPost("/api/anticheat/dismiss", { flagId: "abc" })).statusCode, 400)
    assert.match((await adminGet("/security?error=flag_closed")).body, /not open any more/)
    assert.doesNotMatch((await adminGet("/security?error=<b>x</b>")).body, /<b>x<\/b>/)
})

test("restrict, lift and block change the player and close their open flags", async () => {
    const player = await newPlayer()
    const flagId = addFlag(player.playerId)
    const restricted = await adminPost("/api/anticheat/restrict", { playerId: String(player.playerId), back: "player" })
    assert.equal(restricted.headers.location, `/player/${player.playerId}?message=restricted`)
    assert.equal(flags.isPlayerRestrictedSync(player.playerId), true)
    assert.equal(flags.getAnticheatFlagSync(flagId)!.status, "actioned")

    const playersPage = (await adminGet("/player")).body
    assert.match(playersPage, /restricted/)
    const detail = (await adminGet(`/player/${player.playerId}`)).body
    assert.match(detail, /Cheat review/)
    assert.match(detail, /action="\/api\/anticheat\/unrestrict"/)

    const lifted = await adminPost("/api/anticheat/unrestrict", { playerId: String(player.playerId) })
    assert.equal(lifted.headers.location, "/security?message=unrestricted#review")
    assert.equal(flags.isPlayerRestrictedSync(player.playerId), false)

    assert.equal((await adminPost("/api/anticheat/restrict", { playerId: "x" })).statusCode, 400)
    assert.equal((await adminPost("/api/anticheat/restrict", { playerId: "999999" })).headers.location, "/security?error=unknown_player#review")

    // block: restricted, signed out, device unbound
    const blocked = await createTestPlayer(fastify)
    const session = await data.getSession(String(blocked.viewerId))
    const blockedPlayerId = (await data.getAccountPlayers(session!.accountId))[0]
    addFlag(blockedPlayerId)
    assert.notEqual(data.getAccountDeviceSecretHashSync(session!.accountId), null, "the device is bound before")
    const response = await adminPost("/api/anticheat/block", { playerId: String(blockedPlayerId), back: "player" })
    assert.equal(response.headers.location, `/player/${blockedPlayerId}?message=blocked`)
    assert.equal(flags.isPlayerRestrictedSync(blockedPlayerId), true)
    assert.equal(await data.getSession(String(blocked.viewerId)), null, "the viewer session is gone")
    assert.equal(data.getAccountDeviceSecretHashSync(session!.accountId), null, "the device is unbound")
    assert.equal(flags.listAnticheatFlagsSync({ playerId: blockedPlayerId, status: "open" }).length, 0)

    // the Players page counts open flags
    const flagged = await newPlayer()
    addFlag(flagged.playerId); addFlag(flagged.playerId)
    assert.match((await adminGet("/player")).body, /2 flags/)
})

test("the co-op restriction checks follow the mode and the cached restricted set at once", async () => {
    const { roomHiddenFrom, joinRefusedFor } = await import("../src/lib/coop/restricted")
    const host = await newPlayer(), guest = await newPlayer()
    const room = { hostViewerId: host.viewerId } as import("../src/lib/coop/rooms").CoopRoom
    assert.equal(roomHiddenFrom(room, guest.viewerId), false)
    flags.setPlayerRestrictedSync(host.playerId, true, null)
    flags.setPlayerRestrictedSync(guest.playerId, true, null)
    try {
        assert.equal(roomHiddenFrom(room, guest.viewerId), true, "a restriction is seen at once (the cache is dropped)")
        assert.equal(joinRefusedFor(room, guest.viewerId), true)
        assert.equal(roomHiddenFrom(room, host.viewerId), false, "never for the host")
        anticheat.setAnticheatMode("off")
        assert.equal(roomHiddenFrom(room, guest.viewerId), false, "off: no restriction applies")
        assert.equal(joinRefusedFor(room, guest.viewerId), false)
    } finally {
        anticheat.setAnticheatMode("log")
        flags.setPlayerRestrictedSync(host.playerId, false, null)
        flags.setPlayerRestrictedSync(guest.playerId, false, null)
    }
    assert.equal(joinRefusedFor(room, guest.viewerId), false, "lifted at once")
})

test("a restricted player's rooms stay off the public list and invitations, and they can't join strangers", async () => {
    const { resetRecruitment, shareRoomWithFollows, takeAttentions } = await import("../src/lib/coop/recruitment")
    const { getRoom } = await import("../src/lib/coop/rooms")
    resetRecruitment()
    const host = await newPlayer(), stranger = await newPlayer(), friend = await newPlayer()
    follows.followPlayerSync(friend.playerId, host.playerId, new Date())
    const create = async (viewerId: number) => (await gameRequest(fastify, "multi_battle_quest/create_room",
        { viewer_id: viewerId, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number as string
    const list = async (viewerId: number) => (await gameRequest(fastify, "multi_battle_quest/get_rooms", { viewer_id: viewerId, category_id: 2 })).data.rooms.map((room: any) => room.room_number)
    const select = (viewerId: number, room: string, acceptedType = 1) => gameRequest(fastify, "multi_battle_quest/select_room",
        { viewer_id: viewerId, party_id: 1, room_number: room, quest_id: 1001001, accepted_type: acceptedType, category: 2 })

    const room = await create(host.viewerId)
    assert.ok((await list(stranger.viewerId)).includes(room), "listed before the restriction")

    flags.setPlayerRestrictedSync(host.playerId, true, null)
    assert.ok(!(await list(stranger.viewerId)).includes(room), "hidden from a stranger")
    assert.ok((await list(friend.viewerId)).includes(room), "friends still see it")

    // invitations: a recruiting room reaches the friend but not the stranger
    shareRoomWithFollows(getRoom(room)!)
    const roomRecord = getRoom(room)!
    roomRecord.shareTypes = [3]
    assert.equal(takeAttentions(stranger.viewerId, 5).length, 0, "no invitation to a stranger")
    assert.equal(takeAttentions(friend.viewerId, 5).length, 1, "the host's friend is invited")

    // the host's room by its number is still joinable by anyone: the host gave the number out
    const joined = await select(stranger.viewerId, room, 3)
    assert.equal(joined.data.raising_state, 1)
    assert.equal(joined.data_headers.result_code, 1)

    // a restricted guest can't join a stranger's room, can join a friend's, and nothing tells them why
    flags.setPlayerRestrictedSync(host.playerId, false, null)
    const open = await create((await newPlayer()).viewerId)
    flags.setPlayerRestrictedSync(stranger.playerId, true, null)
    const refused = await select(stranger.viewerId, open)
    assert.equal(refused.data_headers.result_code, 4020)
    assert.deepEqual(refused.data, [])
    const strangerHostRoom = await select(stranger.viewerId, room)
    assert.equal(strangerHostRoom.data_headers.result_code, 4020, "the host is still a stranger")
    follows.followPlayerSync(stranger.playerId, host.playerId, new Date())
    const allowed = await select(stranger.viewerId, room)
    assert.equal(allowed.data_headers.result_code, 1)
    assert.equal(allowed.data.raising_state, 1)

    // with anti-cheat off a restriction has no effect
    anticheat.setAnticheatMode("off")
    try {
        assert.equal((await select(stranger.viewerId, open)).data_headers.result_code, 1)
    } finally {
        anticheat.setAnticheatMode("log")
    }
})
