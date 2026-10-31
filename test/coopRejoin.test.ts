import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";
import { apiPrefix, enterBattle, enterLobby, gameRequest as coopRequest, lobbyMate, newViewer } from "./coopHelpers";

// CO-2: co-op room links (verify_access_token, the link page, select_room by token) and Return to Room after a
// battle (select_room accepted_type 6, one round after another in the same room). Flow: docs/coop-research.md.

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

const signUp = () => newViewer(fastify)
const gameRequest = (route: string, body: Record<string, unknown>) => coopRequest(fastify, route, body)

const selectRoom = (viewerId: number, roomNumber: string, acceptedType: number) => gameRequest("multi_battle_quest/select_room", { viewer_id: viewerId, party_id: 1, room_number: roomNumber, quest_id: 1001001, accepted_type: acceptedType, category: 2 })
const startQuest = (viewerId: number, roomNumber: string) => gameRequest("multi_battle_quest/start", { viewer_id: viewerId, quest_id: 1001001, category: 2, party_id: 1, room_number: roomNumber, play_id: `P${viewerId}-${Date.now()}`, use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [] })

/** A socket server for one test, registered for the HTTP routes. */
async function socketServer(t: { after: (fn: () => Promise<void>) => void }, options: { abandonedRoomMs?: number, onExpire?: (roomNumber: string) => void } = {}) {
    const { CoopSocketServer, setCoopSocketServer } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => {}, abandonedRoomMs: 0, ...options })
    const port = await server.listen(0, "127.0.0.1")
    setCoopSocketServer(server)
    t.after(async () => { setCoopSocketServer(null); await server.close() })
    return { server, port }
}

/** A room the host created over HTTP, and one whole won round with these players: lobby, start, battle, Finalized, all sockets closed. */
async function playRound(port: number, roomNumber: string, hostViewer: number, guestViewers: number[]) {
    const host = await enterLobby(port, hostViewer, roomNumber, "Host", lobbyMate("Host", 151165, { rank: 42 }))
    const guests = []
    for (const viewer of guestViewers) {
        guests.push(await enterLobby(port, viewer, roomNumber, `Guest${viewer}`))
        await host.client.next() // Mates
        for (const earlier of guests.slice(0, -1)) await earlier.client.next()
    }
    const players = [host, ...guests]
    host.client.send([0, [6]]) // StartBattle
    for (const p of players) assert.equal((await p.client.next())[1][0], 5, "Start")
    for (const viewer of [hostViewer, ...guestViewers]) await startQuest(viewer, roomNumber)
    const battles = []
    for (const p of players) battles.push(await enterBattle(port, p.id, roomNumber))
    for (const b of battles) b.send([0, [0]])
    for (const b of battles) assert.deepEqual(await b.next(), [1, [1]], "BattleStart")
    for (const b of battles) b.send([0, [1]])
    for (const b of battles) assert.deepEqual(await b.next(), [1, [2]], "Finalized")
    for (const c of [...players.map(p => p.client), ...battles]) c.close()
    await new Promise(resolve => setTimeout(resolve, 50))
}

test("room links: create_room's link, the link page, verify_access_token, select_room by token", async (t) => {
    const { CoopSocketServer, setCoopSocketServer } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => {} })
    const port = await server.listen(0, "127.0.0.1")
    setCoopSocketServer(server)
    t.after(async () => { setCoopSocketServer(null); await server.close() })

    const hostViewer = await signUp(), guestViewer = await signUp()
    const created = await gameRequest("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })
    const roomNumber = created.data.room_number
    // the client rewrites everything before "/multi_invitation/join" onto its own server address
    const url = new URL(created.data.room_url)
    assert.equal(url.pathname, `${apiPrefix}/multi_invitation/join`)
    const token = url.searchParams.get("k")!
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    // the request log masks the token (src/lib/logging.ts)
    const { redactUrl } = await import("../src/lib/logging")
    assert.ok(!redactUrl(url.pathname + url.search).includes(token), "token kept out of the request log")

    // the page the shared link opens hands the token to the game's own scheme
    const pageResponse = await fastify.inject({ method: "GET", url: url.pathname + url.search })
    assert.equal(pageResponse.statusCode, 200)
    assert.match(String(pageResponse.headers["content-type"]), /^text\/html/)
    assert.ok(pageResponse.body.includes('href="/public/tailwind.css"'), "the shared stylesheet")
    assert.ok(!/style=|<style/.test(pageResponse.body), "no inline styles")
    assert.ok(pageResponse.body.includes(`href="wdfp://social-room?k=${token}"`), pageResponse.body)
    assert.ok(pageResponse.body.includes(roomNumber), "the room number as a fallback")
    const onAndroid = await fastify.inject({ method: "GET", url: url.pathname + url.search, headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120" } })
    assert.ok(onAndroid.body.includes(`intent://social-room?k=${token}#Intent;scheme=wdfp;end`))
    for (const bad of ["nope", "%3Cscript%3E"]) {
        const missing = await fastify.inject({ method: "GET", url: `${apiPrefix}/multi_invitation/join?k=${bad}` })
        assert.equal(missing.statusCode, 404)
        assert.ok(!missing.body.includes("<script>"))
    }

    // the host's lobby supplies the establisher's name, rank and leader
    const host = await enterLobby(port, hostViewer, roomNumber, "Host")
    host.client.send([0, [2, lobbyMate("Host", 151165, { rank: 42, evolutionLevel: 2 })]]) // ChangeParty
    await host.client.next()

    // verify_access_token: every field the client type-checks (MultiBattleQuestVerifyAccessTokenRealRemote)
    const verified = await gameRequest("multi_battle_quest/verify_access_token", { viewer_id: guestViewer, access_token: token })
    assert.deepEqual(verified.data, {
        room_exists: true, category_id: 2, quest_id: 1001001, room_number: roomNumber, establisher: hostViewer,
        establisher_name: "Host", establisher_rank: 42, establisher_character: 151165,
        establisher_character_evolution_img_level: 2, establisher_follow: 0, host_entry_time: verified.data.host_entry_time
    })
    assert.equal(typeof verified.data.host_entry_time, "number")
    const unknown = await gameRequest("multi_battle_quest/verify_access_token", { viewer_id: guestViewer, access_token: "nope" })
    assert.deepEqual(unknown.data, { room_exists: false })

    // the token flow names the room by access_token in prepare and select_room (RoomIdKind.AccessToken)
    await gameRequest("multi_battle_quest/prepare", { viewer_id: guestViewer, quest_id: 1001001, access_token: token, category: 2 })
    const selected = await gameRequest("multi_battle_quest/select_room", { viewer_id: guestViewer, party_id: 1, access_token: token, quest_id: 1001001, accepted_type: 4, category: 2 })
    assert.equal(selected.data.room_number, roomNumber, "the socket handshake needs the number")
    assert.equal(selected.data.raising_state, 1)
    const gone = await gameRequest("multi_battle_quest/select_room", { viewer_id: guestViewer, party_id: 1, access_token: "nope", quest_id: 1001001, accepted_type: 4, category: 2 })
    assert.equal(gone.data.raising_state, 9)
    host.client.close()
})

test("Return to Room: host and guest play a second round in the same room", async (t) => {
    const { CoopSocketServer, setCoopSocketServer } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => {}, abandonedRoomMs: 0 })
    const port = await server.listen(0, "127.0.0.1")
    setCoopSocketServer(server)
    t.after(async () => { setCoopSocketServer(null); await server.close() })

    const hostViewer = await signUp(), guestViewer = await signUp(), stranger = await signUp()
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    const select = (viewerId: number, acceptedType: number) => gameRequest("multi_battle_quest/select_room", { viewer_id: viewerId, party_id: 1, room_number: roomNumber, quest_id: 1001001, accepted_type: acceptedType, category: 2 })
    const start = (viewerId: number, playId: string) => gameRequest("multi_battle_quest/start", { viewer_id: viewerId, quest_id: 1001001, category: 2, party_id: 1, room_number: roomNumber, play_id: playId, use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [] })

    // round 1: lobby → Start → Bye → battle → Finalized
    const host = await enterLobby(port, hostViewer, roomNumber, "Host")
    const guest = await enterLobby(port, guestViewer, roomNumber, "Guest")
    await host.client.next() // Mates
    host.client.send([0, [6]]) // StartBattle
    assert.equal((await host.client.next())[1][0], 5)
    assert.equal((await guest.client.next())[1][0], 5)
    await start(hostViewer, "R1H")
    await start(guestViewer, "R1G")
    guest.client.send([0, [1]]) // Bye
    await host.client.next() // Mates
    host.client.send([0, [1]])
    const hostBattle = await enterBattle(port, host.id, roomNumber)
    const guestBattle = await enterBattle(port, guest.id, roomNumber)
    hostBattle.send([0, [0]])
    guestBattle.send([0, [0]])
    assert.deepEqual(await hostBattle.next(), [1, [1]])
    assert.deepEqual(await guestBattle.next(), [1, [1]])
    hostBattle.send([0, [1]])
    guestBattle.send([0, [1]])
    assert.deepEqual(await hostBattle.next(), [1, [2]])
    assert.deepEqual(await guestBattle.next(), [1, [2]])
    for (const c of [host.client, guest.client, hostBattle]) c.close()
    assert.deepEqual(await guestBattle.next(), [1, [0, host.id]], "the host left the battle")
    // the guest's battle socket stays open on the result screen

    // the battle is over (Finalized), but the room stays out of the list until somebody is back in it
    const { getRoom } = await import("../src/lib/coop/rooms")
    assert.equal(getRoom(roomNumber)!.inBattle, true)
    await gameRequest("multi_battle_quest/select_room", { viewer_id: stranger, party_id: 1, room_number: roomNumber, quest_id: 1001001, accepted_type: 6, category: 2 })
    assert.equal(getRoom(roomNumber)!.inBattle, true, "a stranger's accepted_type 6 doesn't reopen it")

    // the host taps Return to Room: prepare + select_room with accepted_type 6
    await gameRequest("multi_battle_quest/prepare", { viewer_id: hostViewer, quest_id: 1001001, room_number: roomNumber, category: 2 })
    assert.equal((await select(hostViewer, 6)).data.raising_state, 1)
    const listed = await gameRequest("multi_battle_quest/get_rooms", { viewer_id: stranger, category_id: 2 })
    assert.ok(listed.data.rooms.some((r: any) => r.room_number === roomNumber), "listed again for other players")

    // round 2: both are back in a fresh lobby (the guest's old battle socket is still open)
    const host2 = await enterLobby(port, hostViewer, roomNumber, "Host")
    assert.equal(host2.welcome[1][2].length, 1, "a new lobby, not the old members")
    assert.equal((await select(guestViewer, 6)).data.raising_state, 1)
    const guest2 = await enterLobby(port, guestViewer, roomNumber, "Guest")
    assert.equal(guest2.welcome[1][2].length, 2)
    await host2.client.next() // Mates
    host2.client.send([0, [6]])
    assert.equal((await host2.client.next())[1][0], 5)
    assert.equal((await guest2.client.next())[1][0], 5)
    await start(hostViewer, "R2H")
    const roomsDuring = await gameRequest("multi_battle_quest/get_rooms", { viewer_id: stranger, category_id: 2 })
    assert.ok(!roomsDuring.data.rooms.some((r: any) => r.room_number === roomNumber), "hidden again during round 2")

    const hostBattle2 = await enterBattle(port, host2.id, roomNumber)
    const guestBattle2 = await enterBattle(port, guest2.id, roomNumber)
    hostBattle2.send([0, [0]])
    guestBattle2.send([0, [0]])
    assert.deepEqual(await hostBattle2.next(), [1, [1]], "a fresh battle starts again")
    assert.deepEqual(await guestBattle2.next(), [1, [1]])

    // the old round's socket is cut off from the new battle, and its close doesn't end round 2
    guestBattle.send([1, [[0, 0, 0, 0, 999, "stale"]]])
    assert.ok(await hostBattle2.silent(), "stale command not relayed")
    guestBattle.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    hostBattle2.send([1, [[0, 0, 0, 0, 10, "round-2"]]])
    assert.deepEqual(await guestBattle2.next(), [2, host2.id, [[0, 0, 0, 0, 10, "round-2"]]], "order numbering starts over")
    for (const c of [host2.client, guest2.client, hostBattle2, guestBattle2]) c.close()
})

test("a room without its host closes after the delay, however players come and go; the host's return keeps it", async (t) => {
    // generous margins: rooms close 600 ms after their host is gone; "still there" is checked well before, "gone" well after
    const { closeRoom } = await import("../src/lib/coop/closeRoom")
    const { port } = await socketServer(t, { abandonedRoomMs: 600, onExpire: closeRoom })
    const { getRoom } = await import("../src/lib/coop/rooms")
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const newRoom = async (hostViewer: number) => (await gameRequest("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number as string

    // (a) nobody comes back after the battle
    const hostA = await signUp(), guestA = await signUp()
    const roomA = await newRoom(hostA)
    await playRound(port, roomA, hostA, [guestA])
    assert.ok(getRoom(roomA), "kept during the delay")

    // (b) only a guest comes back (Return to Room over HTTP): it doesn't keep the hostless room alive
    const hostB = await signUp(), guestB = await signUp()
    const roomB = await newRoom(hostB)
    await playRound(port, roomB, hostB, [guestB])
    assert.equal((await selectRoom(guestB, roomB, 6)).data.raising_state, 1)
    const guest = await enterLobby(port, guestB, roomB, "Guest")

    // (c) the host comes back: the room stays
    const hostC = await signUp(), guestC = await signUp()
    const roomC = await newRoom(hostC)
    await playRound(port, roomC, hostC, [guestC])
    assert.equal((await selectRoom(hostC, roomC, 6)).data.raising_state, 1)
    const host = await enterLobby(port, hostC, roomC, "Host")

    // (d) the host leaves its lobby before any battle; a guest stays
    const hostD = await signUp(), guestD = await signUp()
    const roomD = await newRoom(hostD)
    const lobbyHost = await enterLobby(port, hostD, roomD, "Host")
    const lobbyGuest = await enterLobby(port, guestD, roomD, "Guest")
    await lobbyHost.client.next() // Mates
    lobbyHost.client.close()
    await lobbyGuest.client.next() // Mates without the host

    await sleep(1500)
    assert.equal(getRoom(roomA), undefined, "(a) closed")
    assert.equal(getRoom(roomB), undefined, "(b) closed although a guest is in it")
    assert.deepEqual(await guest.client.next(), [1, [6, "multibattle_room_dismissed"]], "(b) the guest is told")
    assert.ok(getRoom(roomC), "(c) the host is back")
    assert.equal(getRoom(roomD), undefined, "(d) closed")
    assert.deepEqual(await lobbyGuest.client.next(), [1, [6, "multibattle_room_dismissed"]])
    for (const c of [guest.client, host.client, lobbyGuest.client]) c.close()
})

test("a guest who returns before the host doesn't become the establisher", async (t) => {
    const { port } = await socketServer(t)
    const hostViewer = await signUp(), guestViewer = await signUp()
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    await playRound(port, roomNumber, hostViewer, [guestViewer])

    // the guest is back first: the room still names the host (as last seen), with no connection to point at
    assert.equal((await selectRoom(guestViewer, roomNumber, 6)).data.raising_state, 1)
    const guest = await enterLobby(port, guestViewer, roomNumber, "Guest")
    const room = guest.welcome[1][1]
    assert.equal(room.establisherConnectionId, "", "not the guest's connection")
    assert.equal(room.establisherName, "Host")
    assert.equal(room.establisherCharacter, 151165)

    // the host comes back: listed first, as when it created the room
    assert.equal((await selectRoom(hostViewer, roomNumber, 6)).data.raising_state, 1)
    const host = await enterLobby(port, hostViewer, roomNumber, "Host", lobbyMate("Host", 151165, { rank: 42 }))
    assert.deepEqual(host.welcome[1][2].map((m: any) => m.name), ["Host", "Guest"])
    assert.equal(host.welcome[1][1].establisherConnectionId, host.id)
    const mates = await guest.client.next()
    assert.deepEqual([mates[0], mates[1][0]], [1, 1], "Mates")
    assert.deepEqual(mates[1][1].map((m: any) => m.name), ["Host", "Guest"])
    guest.client.close()
    host.client.close()
})

test("no Return to Room while the room's next round is starting or still being played", async (t) => {
    const { port } = await socketServer(t)
    const hostViewer = await signUp(), guestViewer = await signUp(), stranger = await signUp()
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    await playRound(port, roomNumber, hostViewer, [guestViewer])

    // round 2 starts in the same room
    assert.equal((await selectRoom(hostViewer, roomNumber, 6)).data.raising_state, 1)
    const host = await enterLobby(port, hostViewer, roomNumber, "Host")
    assert.equal((await selectRoom(guestViewer, roomNumber, 6)).data.raising_state, 1)
    const guest = await enterLobby(port, guestViewer, roomNumber, "Guest")
    await host.client.next() // Mates
    host.client.send([0, [6]]) // StartBattle
    assert.equal((await host.client.next())[1][0], 5)
    assert.equal((await guest.client.next())[1][0], 5)

    // between StartBattle and the first start: a round-1 player's Return to Room must not reopen round 2's lobby
    assert.equal((await selectRoom(guestViewer, roomNumber, 6)).data.raising_state, 4, "battle")
    const listed = await gameRequest("multi_battle_quest/get_rooms", { viewer_id: stranger, category_id: 2 })
    assert.ok(!listed.data.rooms.some((r: any) => r.room_number === roomNumber), "not listed during round 2")
    assert.equal((await selectRoom(stranger, roomNumber, 3)).data.raising_state, 4, "a typed number can't get in")

    // the battle still waits for every player of round 2
    guest.client.send([0, [1]]) // Bye
    await host.client.next() // Mates
    host.client.send([0, [1]])
    await startQuest(hostViewer, roomNumber)
    await startQuest(guestViewer, roomNumber)
    const hostBattle = await enterBattle(port, host.id, roomNumber)
    hostBattle.send([0, [0]])
    assert.ok(await hostBattle.silent(), "no BattleStart with only the host")
    const guestBattle = await enterBattle(port, guest.id, roomNumber)
    guestBattle.send([0, [0]])
    assert.deepEqual(await hostBattle.next(), [1, [1]])
    assert.deepEqual(await guestBattle.next(), [1, [1]])

    // the guest gives up and leaves while the host plays on: no way back into the room yet
    await gameRequest("multi_battle_quest/abort", { viewer_id: guestViewer, category: 2, room_number: roomNumber, quest_id: 1001001, play_id: "ABORT", finish_kind: 1 })
    guestBattle.close()
    assert.deepEqual(await hostBattle.next(), [1, [0, guest.id]], "Leave")
    assert.equal((await selectRoom(guestViewer, roomNumber, 6)).data.raising_state, 4, "the host is still fighting")

    // the host's battle ends: now the guest can come back
    hostBattle.send([0, [1]])
    assert.deepEqual(await hostBattle.next(), [1, [2]], "Finalized")
    assert.equal((await selectRoom(guestViewer, roomNumber, 6)).data.raising_state, 1)
    for (const c of [host.client, guest.client, hostBattle]) c.close()
})

test("coming back after a battle by restore_room or a typed number opens the room again", async (t) => {
    const { port } = await socketServer(t)
    const { getRoom } = await import("../src/lib/coop/rooms")
    const hostViewer = await signUp(), guestViewer = await signUp(), stranger = await signUp()
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    const sequence = (await selectRoom(hostViewer, roomNumber, 1)).data.room_sequence
    await playRound(port, roomNumber, hostViewer, [guestViewer])
    const isListed = async () => (await gameRequest("multi_battle_quest/get_rooms", { viewer_id: stranger, category_id: 2 })).data.rooms.some((r: any) => r.room_number === roomNumber)
    assert.equal(await isListed(), false, "hidden after the battle until somebody is back")

    // the guest's game was force-stopped on the result screen: restore_room puts it back, and the room opens again
    const restored = await gameRequest("multi_battle_quest/restore_room", { viewer_id: guestViewer, room_number: roomNumber, room_sequence: sequence })
    assert.equal(restored.data.raising_state, 1)
    const guest = await enterLobby(port, guestViewer, roomNumber, "Guest")
    assert.equal(getRoom(roomNumber)!.inBattle, false)
    assert.equal(await isListed(), true, "listed again")
    guest.client.close()
    await new Promise(resolve => setTimeout(resolve, 50))

    // a player who typed the number and the host form round 2, which starts with exactly its own players
    assert.equal((await selectRoom(stranger, roomNumber, 3)).data.raising_state, 1)
    const newcomer = await enterLobby(port, stranger, roomNumber, "Newcomer")
    const host = await enterLobby(port, hostViewer, roomNumber, "Host")
    await newcomer.client.next() // Mates
    host.client.send([0, [6]])
    await host.client.next() // Start
    assert.deepEqual([...getRoom(roomNumber)!.lastRoundViewerIds].sort(), [hostViewer, stranger].sort())
    newcomer.client.close()
    host.client.close()
})

test("a typed number gets into a room whose battle sockets are still open after Finalized", async (t) => {
    const { port } = await socketServer(t)
    const { getRoom } = await import("../src/lib/coop/rooms")
    const hostViewer = await signUp(), stranger = await signUp()
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    const host = await enterLobby(port, hostViewer, roomNumber, "Host")
    host.client.send([0, [6]])
    await host.client.next() // Start
    host.client.send([0, [1]]) // Bye
    const battle = await enterBattle(port, host.id, roomNumber)
    battle.send([0, [0]])
    await battle.next() // BattleStart
    battle.send([0, [1]])
    assert.deepEqual(await battle.next(), [1, [2]], "Finalized")

    // the host is still on the result screen with its battle socket open
    assert.equal((await selectRoom(stranger, roomNumber, 3)).data.raising_state, 1)
    const newcomer = await enterLobby(port, stranger, roomNumber, "Newcomer")
    assert.equal(newcomer.welcome[1][2].length, 1, "a fresh lobby")
    assert.equal(getRoom(roomNumber)!.inBattle, false)
    for (const c of [host.client, battle, newcomer.client]) c.close()
})
