import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";
import { Client, enterLobby } from "./coopHelpers";

// CO-3: only the host starts the battle, and with coop.start_countdown_seconds the lobby counts down first
// (StartRemainingTime toasts), cancelled when a member is no longer ready. Flow: docs/coop-polish-spec.md §1.

let cleanup: () => Promise<void>

before(async () => {
    ({ cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

let nextViewer = 940_000
const viewer = () => nextViewer++

async function lobbyWithCountdown(t: { after: (fn: () => Promise<void>) => void }, seconds: number) {
    const { CoopSocketServer } = await import("../src/lib/coop/socketServer")
    const { createRoom } = await import("../src/lib/coop/rooms")
    const server = new CoopSocketServer({ log: () => {}, abandonedRoomMs: 0, startCountdownSeconds: seconds })
    const port = await server.listen(0, "127.0.0.1")
    const room = createRoom(viewer(), 1001001, 2)
    const host = await enterLobby(port, room.hostViewerId, room.roomNumber, "Host")
    const guest = await enterLobby(port, viewer(), room.roomNumber, "Guest")
    await host.client.next() // Mates
    guest.client.send([0, [3, [1]]]) // Ready
    await host.client.next() // StateChanged
    await guest.client.next()
    t.after(async () => { host.client.close(); guest.client.close(); await server.close() })
    return { server, port, room, host, guest }
}

test("a guest's StartBattle is ignored", async (t) => {
    const { host, guest } = await lobbyWithCountdown(t, 0)
    guest.client.send([0, [6]])
    assert.ok(await host.client.silent(200))
    assert.ok(await guest.client.silent(0))
    host.client.send([0, [6]])
    assert.equal((await guest.client.next())[1][0], 5, "the host's starts")
})

test("the countdown sends the seconds left, then Start", async (t) => {
    const { server, room, host, guest } = await lobbyWithCountdown(t, 2)
    host.client.send([0, [6]])
    for (const client of [host.client, guest.client]) assert.deepEqual(await client.next(), [1, [9, 2]])
    assert.equal(server.joinStatus(room.roomNumber), "battle", "no joins during the countdown")
    for (const client of [host.client, guest.client]) assert.deepEqual(await client.next(1500), [1, [9, 1]])
    for (const client of [host.client, guest.client]) assert.equal((await client.next(1500))[1][0], 5, "Start")
})

test("a guest no longer ready cancels the countdown, and the host can start again", async (t) => {
    const { server, room, host, guest } = await lobbyWithCountdown(t, 2)
    host.client.send([0, [6]])
    await host.client.next() // [9, 2]
    await guest.client.next()
    guest.client.send([0, [3, [0]]]) // Ready(Preparation)
    assert.deepEqual((await host.client.next())[1][0], 2, "StateChanged")
    await guest.client.next()
    assert.ok(await host.client.silent(2300), "no more ticks, no Start")
    assert.equal(server.joinStatus(room.roomNumber), "open")

    guest.client.send([0, [3, [1]]])
    await host.client.next()
    await guest.client.next()
    host.client.send([0, [6]])
    assert.deepEqual(await host.client.next(), [1, [9, 2]], "counting again")
})

test("a player joining during the countdown is turned away", async (t) => {
    const { port, room, host } = await lobbyWithCountdown(t, 3)
    const { admit } = await import("../src/lib/coop/rooms")
    host.client.send([0, [6]])
    await host.client.next() // [9, 3]
    const latecomer = viewer()
    admit(room, latecomer)
    const client = new Client()
    await client.connect(port)
    t.after(() => client.close())
    client.send({ reconnected: 0, socklet: "cooperation_room", viewerId: latecomer, roomNumber: room.roomNumber, questCategory: 2, questId: 1001001 })
    assert.deepEqual(await client.next(), [1, "multibattle_room_already_started"])
})
