import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";
import { Client, enterLobby, lobbyMate } from "./coopHelpers";

// CO-6: two guests joined a room within 0.4 s. The first guest's Enter broadcast Mates to the second guest's connection
// between its Accept and its Welcome. The client's EnterRoomService takes only Welcome (or Disbanded) and leaves every
// other message queued for the room scene, which handles that Mates after the Welcome, can't find its own viewer id in
// it (the newcomer had no mate yet) and fails with C15202. Nothing but Disbanded may reach a member before its Welcome.

let cleanup: () => Promise<void>

before(async () => {
    ({ cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

let nextViewer = 61_000

async function room(t: { after: (fn: () => Promise<void>) => void }) {
    const { createRoom } = await import("../src/lib/coop/rooms")
    const { CoopSocketServer } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => {}, keepAliveMs: 0, abandonedRoomMs: 0 })
    const port = await server.listen(0, "127.0.0.1")
    t.after(() => server.close())
    const hostViewer = nextViewer++
    const { roomNumber } = createRoom(hostViewer, 1001001, 2)
    const host = await enterLobby(port, hostViewer, roomNumber, "Host", lobbyMate("Host", 111))
    t.after(async () => host.client.close())
    return { server, port, roomNumber, host }
}

/** A guest's lobby handshake, up to its Accept, without Enter. */
async function handshake(t: { after: (fn: () => Promise<void>) => void }, port: number, roomNumber: string) {
    const { admit, getRoom } = await import("../src/lib/coop/rooms")
    const viewerId = nextViewer++
    admit(getRoom(roomNumber)!, viewerId)
    const client = new Client()
    await client.connect(port)
    t.after(async () => client.close())
    client.send({ reconnected: 0, socklet: "cooperation_room", viewerId, roomNumber, questCategory: 2, questId: 1001001 })
    const accept = await client.next()
    assert.equal(accept[0], 0, `accepted: ${JSON.stringify(accept)}`)
    return { client, viewerId, id: accept[1] as string }
}

/**
 * Everything that arrives until the socket is quiet for `quietMs`. (Not a loop of `next(timeout)`: a timed-out `next`
 * leaves its waiter behind, which would swallow the next message.)
 */
async function drain(client: Client, quietMs = 200): Promise<any[]> {
    const seen: any[] = []
    while (!(await client.silent(quietMs))) {
        while (!(await client.silent(0))) seen.push(await client.next())
    }
    return seen
}

/** The mates lists a lobby message carries: Welcome's, Mates' and Start's. */
function matesOf(message: any): any[] | null {
    if (message[0] !== 1) return null
    const [kind, ...args] = message[1]
    if (kind === 0) return args[1]
    if (kind === 1 || kind === 5) return args[0]
    return null
}

test("two guests entering in the same tick: Welcome comes first, and every mates list holds its receiver", async (t) => {
    const { port, roomNumber, host } = await room(t)
    const a = await handshake(t, port, roomNumber)
    const b = await handshake(t, port, roomNumber)

    // both Enters leave in the same tick, so the server handles one while the other is already on its way
    a.client.send([0, [0, lobbyMate("A", 222), 1]])
    b.client.send([0, [0, lobbyMate("B", 333), 1]])

    for (const guest of [a, b]) {
        const messages = await drain(guest.client)
        assert.ok(messages.length > 0, "the guest got its Welcome")
        assert.deepEqual([messages[0][0], messages[0][1][0]], [1, 0], `Welcome first, got ${JSON.stringify(messages[0])}`)
        for (const message of messages) {
            const mates = matesOf(message)
            if (mates === null) continue
            assert.ok(mates.some((mate: any) => mate.connectionId === guest.id), "the guest is in every mates list it gets (else C15202)")
        }
        const last = messages.map(matesOf).filter(mates => mates !== null).pop()!
        assert.equal(last.length, 3, "it ends with the whole room")
    }

    const hostMates = await drain(host.client)
    assert.equal(hostMates.length, 2, "the host gets one Mates per entry")
    assert.equal(matesOf(hostMates[1])!.length, 3)
})

test("a member between its handshake and its Welcome gets nothing of the lobby's traffic, then a full Welcome", async (t) => {
    const { port, roomNumber, host } = await room(t)
    const early = await enterLobby(port, nextViewer++, roomNumber, "Early", lobbyMate("Early", 222))
    t.after(async () => early.client.close())
    assert.equal(matesOf(await host.client.next())!.length, 2, "Mates to the host")

    const late = await handshake(t, port, roomNumber)
    // another player's party change, ready state, emotion and auto-start switch
    early.client.send([0, [2, lobbyMate("Early", 223)]])
    early.client.send([0, [3, [1]]])
    early.client.send([1, [[0]]])
    host.client.send([0, [8, true]])
    await drain(host.client)
    await drain(early.client)
    assert.deepEqual(await drain(late.client), [], "nothing reaches it before its Welcome")

    late.client.send([0, [0, lobbyMate("Late", 333), 1]])
    const welcome = await late.client.next()
    assert.deepEqual([welcome[0], welcome[1][0]], [1, 0], "Welcome")
    const mates = matesOf(welcome)!
    assert.equal(mates.length, 3)
    assert.ok(mates.some((mate: any) => mate.connectionId === late.id))
    assert.deepEqual(mates.find((mate: any) => mate.connectionId === early.id).state, [1], "the Welcome has the room as it is now")

    // from its Welcome on it gets the lobby's traffic
    early.client.send([0, [3, [0]]])
    assert.deepEqual(await late.client.next(), [1, [2, early.id, [0]]])
})

test("a member that leaves while another is still entering: no Mates to the one entering", async (t) => {
    const { port, roomNumber, host } = await room(t)
    const leaving = await enterLobby(port, nextViewer++, roomNumber, "Leaving", lobbyMate("Leaving", 222))
    await host.client.next() // Mates
    const late = await handshake(t, port, roomNumber)

    leaving.client.close()
    assert.equal(matesOf(await host.client.next())!.length, 1, "the host sees it leave")
    assert.deepEqual(await drain(late.client), [], "the one entering gets nothing")

    late.client.send([0, [0, lobbyMate("Late", 333), 1]])
    const welcome = await late.client.next()
    assert.deepEqual([welcome[0], welcome[1][0]], [1, 0], "Welcome")
    assert.equal(matesOf(welcome)!.length, 2)
})

test("Disbanded still reaches a member that hasn't entered (EnterRoomService shows it and leaves)", async (t) => {
    const { server, port, roomNumber, host } = await room(t)
    const late = await handshake(t, port, roomNumber)
    server.disband(roomNumber)
    assert.deepEqual(await host.client.next(), [1, [6, "multibattle_room_dismissed"]])
    assert.deepEqual(await late.client.next(), [1, [6, "multibattle_room_dismissed"]])
})
