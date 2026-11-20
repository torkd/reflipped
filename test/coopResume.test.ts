import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";
import { Client, enterBattle, enterLobby } from "./coopHelpers";

// CO-3: a lobby member whose game went to the background (Suspend, or a close without Bye) keeps its slot through the
// resume grace and takes it back with a fresh handshake; a battle starts without a player who never connects.
// Flow: docs/coop-polish-spec.md §2.

let cleanup: () => Promise<void>

before(async () => {
    ({ cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

let nextViewer = 930_000
const viewer = () => nextViewer++

type Options = { resumeGraceMs?: number, battleStartWaitMs?: number, closeRooms?: boolean }

async function socketServer(t: { after: (fn: () => Promise<void>) => void }, options: Options = {}) {
    const { CoopSocketServer, setCoopSocketServer } = await import("../src/lib/coop/socketServer")
    const { closeRoom } = await import("../src/lib/coop/closeRoom")
    const server = new CoopSocketServer({
        log: () => {}, abandonedRoomMs: 0, resumeGraceMs: options.resumeGraceMs ?? 60_000,
        battleStartWaitMs: options.battleStartWaitMs, onExpire: options.closeRooms ? closeRoom : undefined
    })
    const port = await server.listen(0, "127.0.0.1")
    setCoopSocketServer(server)
    t.after(async () => { setCoopSocketServer(null); await server.close() })
    return { server, port }
}

/** A room with its host and one guest in the lobby. */
async function hostAndGuest(port: number) {
    const { createRoom } = await import("../src/lib/coop/rooms")
    const hostViewer = viewer(), guestViewer = viewer()
    const room = createRoom(hostViewer, 1001001, 2)
    const host = await enterLobby(port, hostViewer, room.roomNumber, "Host")
    const guest = await enterLobby(port, guestViewer, room.roomNumber, "Guest")
    assert.equal((await host.client.next())[1][0], 1, "host: Mates with the guest")
    return { room, roomNumber: room.roomNumber, hostViewer, guestViewer, host, guest }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const matesIds = (message: any) => (message[1][0] === 0 ? message[1][2] : message[1][1]).map((m: any) => m.connectionId)

test("a guest that went to the background keeps its slot and comes back with its connection id", async (t) => {
    const { server, port } = await socketServer(t)
    const { roomNumber, guestViewer, host, guest } = await hostAndGuest(port)
    t.after(() => host.client.close())

    guest.client.send([0, [5]]) // Suspend
    guest.client.close()
    await wait(50)
    assert.ok(await host.client.silent(200), "the host isn't told")
    assert.equal(server.memberCount(roomNumber), 2, "the slot stays taken")
    assert.equal(server.isInLobby(guestViewer), true)

    const back = await enterLobby(port, guestViewer, roomNumber, "Guest")
    t.after(() => back.client.close())
    assert.equal(back.id, guest.id, "the same connection id")
    assert.deepEqual(matesIds(back.welcome).sort(), [host.id, guest.id].sort(), "its Welcome has everyone, itself included")
    const mates = await host.client.next()
    assert.equal(mates[1][0], 1, "the host gets Mates")
    assert.deepEqual(matesIds(mates).sort(), [host.id, guest.id].sort())
})

test("a guest that doesn't come back within the grace leaves the lobby", async (t) => {
    const { server, port } = await socketServer(t, { resumeGraceMs: 300 })
    const { roomNumber, host, guest } = await hostAndGuest(port)
    t.after(() => host.client.close())

    guest.client.close() // no Bye: a lost connection
    assert.ok(await host.client.silent(150), "nothing during the grace")
    const mates = await host.client.next(1000)
    assert.equal(mates[1][0], 1, "Mates")
    assert.deepEqual(matesIds(mates), [host.id], "without the guest")
    assert.equal(server.memberCount(roomNumber), 1)
})

test("a host that doesn't come back closes its room", async (t) => {
    const { port } = await socketServer(t, { resumeGraceMs: 300, closeRooms: true })
    const { getRoom } = await import("../src/lib/coop/rooms")
    const { roomNumber, host, guest } = await hostAndGuest(port)
    t.after(() => guest.client.close())

    host.client.send([0, [5]]) // Suspend
    host.client.close()
    assert.ok(await guest.client.silent(150), "the guest waits")
    assert.deepEqual(await guest.client.next(1000), [1, [6, "multibattle_room_dismissed"]], "then Disbanded")
    assert.equal(getRoom(roomNumber), undefined, "the room is gone")
})

test("a second connection of the same player replaces the stale one", async (t) => {
    const { port } = await socketServer(t)
    const { roomNumber, guestViewer, host, guest } = await hostAndGuest(port)
    t.after(() => host.client.close())

    const again = await enterLobby(port, guestViewer, roomNumber, "Guest")
    t.after(() => again.client.close())
    assert.equal(again.id, guest.id)
    await wait(50)
    assert.equal(guest.client.isOpen(), false, "the old socket is closed")
    const mates = await host.client.next()
    assert.deepEqual(matesIds(mates).sort(), [host.id, guest.id].sort(), "still two members")
    assert.ok(await host.client.silent(150), "the old socket's close changes nothing")
})

test("a member still away when the battle starts is left out", async (t) => {
    const { port } = await socketServer(t)
    const { roomNumber, guestViewer, host, guest } = await hostAndGuest(port)
    t.after(() => host.client.close())

    guest.client.send([0, [5]])
    guest.client.close()
    await wait(50)
    host.client.send([0, [6]]) // StartBattle
    const start = await host.client.next()
    assert.equal(start[1][0], 5, "Start")
    assert.deepEqual(start[1][1].map((m: any) => m.connectionId), [host.id], "with the host only")

    // coming back now finds the battle started
    const { admit, getRoom } = await import("../src/lib/coop/rooms")
    admit(getRoom(roomNumber)!, guestViewer)
    const late = new Client()
    await late.connect(port)
    t.after(() => late.close())
    late.send({ reconnected: 0, socklet: "cooperation_room", viewerId: guestViewer, roomNumber, questCategory: 2, questId: 1001001 })
    assert.deepEqual(await late.next(), [1, "multibattle_room_already_started"])
})

test("a battle starts without a player who never connects, and refuses it later", async (t) => {
    const { port } = await socketServer(t, { battleStartWaitMs: 300 })
    const { roomNumber, host, guest } = await hostAndGuest(port)
    host.client.send([0, [6]])
    assert.equal((await host.client.next())[1][0], 5)
    assert.equal((await guest.client.next())[1][0], 5)
    host.client.send([0, [1]]) // Bye
    guest.client.send([0, [1]])
    host.client.close()
    guest.client.close()

    const battle = await enterBattle(port, host.id, roomNumber)
    t.after(() => battle.close())
    battle.send([0, [0]]) // SceneReady
    assert.ok(await battle.silent(150), "waits for the guest first")
    assert.deepEqual(await battle.next(1000), [1, [0, guest.id]], "Leave for the missing guest")
    assert.deepEqual(await battle.next(), [1, [1]], "BattleStart")

    const late = new Client()
    await late.connect(port)
    t.after(() => late.close())
    late.send({ reconnected: 0, socklet: "cooperation_battle", connectionId: guest.id, roomNumber })
    assert.deepEqual(await late.next(), [1, "multibattle_room_already_started"])
})
