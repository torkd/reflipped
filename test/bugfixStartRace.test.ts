import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";
import { Client, enterBattle, enterLobby, lobbyMate } from "./coopHelpers";

// CO-7: StartBattle put every lobby member into the battle, also one between its handshake and its Enter. The host
// can't see that member (it isn't in Mates yet), so an auto-start could begin in that window; the member never got
// Start and the battle waited BATTLE_START_WAIT_MS (20 s) for it. The battle starts with the entered members only, and
// a member still entering is told the battle started (Disbanded) and leaves the lobby.

let cleanup: () => Promise<void>

before(async () => {
    ({ cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

let nextViewer = 62_000

test("a member still entering at StartBattle isn't in the battle, which starts without waiting for it", async (t) => {
    const { createRoom, admit, getRoom } = await import("../src/lib/coop/rooms")
    const { CoopSocketServer } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => {}, keepAliveMs: 0, abandonedRoomMs: 0 })
    const port = await server.listen(0, "127.0.0.1")
    t.after(() => server.close())

    const { roomNumber } = createRoom(nextViewer++, 1001001, 2)
    const hostViewer = getRoom(roomNumber)!.hostViewerId
    const host = await enterLobby(port, hostViewer, roomNumber, "Host", lobbyMate("Host", 111))
    const guest = await enterLobby(port, nextViewer++, roomNumber, "Guest", lobbyMate("Guest", 222))
    t.after(() => { host.client.close(); guest.client.close() })
    await host.client.next() // Mates with the guest

    // a third player: handshake only, no Enter yet
    const lateViewer = nextViewer++
    admit(getRoom(roomNumber)!, lateViewer)
    const late = new Client()
    await late.connect(port)
    t.after(() => late.close())
    late.send({ reconnected: 0, socklet: "cooperation_room", viewerId: lateViewer, roomNumber, questCategory: 2, questId: 1001001 })
    assert.equal((await late.next())[0], 0, "accepted")

    host.client.send([0, [6]]) // StartBattle
    assert.deepEqual(await late.next(), [1, [6, "multibattle_room_already_started"]], "the one entering is told and leaves")
    for (const member of [host, guest]) {
        const start = await member.client.next()
        assert.equal(start[1][0], 5, `Start, got ${JSON.stringify(start)}`)
        assert.equal(start[1][1].length, 2, "Start lists the two who entered")
    }

    // its late Enter changes nothing
    late.send([0, [0, lobbyMate("Late", 333), 1]])
    assert.ok(await late.silent(200), "no Welcome into a started lobby")

    // both who started connect and are ready: the battle starts at once, not after BATTLE_START_WAIT_MS
    const hostBattle = await enterBattle(port, host.id, roomNumber)
    const guestBattle = await enterBattle(port, guest.id, roomNumber)
    t.after(() => { hostBattle.close(); guestBattle.close() })
    hostBattle.send([0, [0]])
    guestBattle.send([0, [0]])
    assert.deepEqual(await hostBattle.next(1000), [1, [1]], "BattleStart")
    assert.deepEqual(await guestBattle.next(1000), [1, [1]], "BattleStart")
})
