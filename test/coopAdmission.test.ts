import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, readCapturedRoute } from "./helpers";

// SEC-12: the co-op socket only admits players the signed HTTP routes let into a room, and limits what one client can do.

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

/** XMLSocket framing: JSON + NUL. */
class Client {
    private socket!: net.Socket
    private buffer = Buffer.alloc(0)
    private queue: any[] = []
    private waiters: ((value: any) => void)[] = []
    closed!: Promise<void>

    async connect(port: number) {
        this.socket = net.connect(port, "127.0.0.1")
        this.closed = new Promise(resolve => this.socket.once("close", () => resolve()))
        await new Promise<void>((resolve, reject) => {
            this.socket.once("connect", () => resolve())
            this.socket.once("error", reject)
        })
        this.socket.on("error", () => {})
        this.socket.on("data", chunk => {
            this.buffer = Buffer.concat([this.buffer, chunk])
            let end: number
            while ((end = this.buffer.indexOf(0)) !== -1) {
                const value = JSON.parse(this.buffer.subarray(0, end).toString("utf8"))
                this.buffer = this.buffer.subarray(end + 1)
                const waiter = this.waiters.shift()
                if (waiter) waiter(value)
                else this.queue.push(value)
            }
        })
    }

    send(value: unknown) {
        this.socket.write(JSON.stringify(value) + "\0")
    }

    write(raw: Buffer) {
        this.socket.write(raw)
    }

    next(timeoutMs = 2000): Promise<any> {
        if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for a socket message")), timeoutMs)
            this.waiters.push(value => { clearTimeout(timer); resolve(value) })
        })
    }

    close() {
        this.socket.destroy()
    }
}

async function signUp(): Promise<number> {
    const deviceId = randomUUID()
    const login = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey: randomUUID(), accessToken: "" }
    })
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tool/signup`,
        headers: { "content-type": "application/x-www-form-urlencoded", "udid": randomUUID().toUpperCase() },
        payload: encodeGameBody({
            app_secret: captured.app_secret, access_token: login.json().zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
        })
    })
    return decodeGameBody(signup.body).data_headers.viewer_id
}

async function gameRequest(route: string, body: Record<string, unknown>): Promise<{ status: number, body: any }> {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody(body)
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.json() }
}

const createRoom = async (viewerId: number) =>
    (await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: 1001001, party_id: 11, category: 2 })).body.data.room_number as string
const selectRoom = (viewerId: number, roomNumber: string) =>
    gameRequest("multi_battle_quest/select_room", { viewer_id: viewerId, party_id: 1, room_number: roomNumber, quest_id: 1001001, accepted_type: 1, category: 2 })
const lobbyHandshake = (viewerId: unknown, roomNumber: string) =>
    ({ reconnected: 0, socklet: "cooperation_room", viewerId, roomNumber, questCategory: 2, questId: 1001001 })

test("co-op socket admission and limits", async (t) => {
    const { CoopSocketServer, MAX_MESSAGE_BYTES } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => {}, keepAliveMs: 0 })
    const port = await server.listen(0, "127.0.0.1")
    t.after(() => server.close())
    const connect = async () => {
        const client = new Client()
        await client.connect(port)
        t.after(() => client.close())
        return client
    }

    const host = await signUp(), guest = await signUp(), stranger = await signUp()
    const roomNumber = await createRoom(host)

    await t.test("a viewer no route admitted is refused, also under another player's id", async () => {
        const client = await connect()
        client.send(lobbyHandshake(stranger, roomNumber))
        assert.deepEqual(await client.next(), [1, "multibattle_room_not_found"])
        const spoof = await connect()
        spoof.send(lobbyHandshake(guest, roomNumber))
        assert.deepEqual(await spoof.next(), [1, "multibattle_room_not_found"], "guest hasn't selected the room")
        const junk = await connect()
        junk.send(lobbyHandshake("1e3", roomNumber))
        assert.equal((await junk.next())[0], 1)
    })

    let hostConnection = "", guestConnection = ""
    await t.test("create_room and select_room admit their caller once", async () => {
        const hostSocket = await connect()
        hostSocket.send(lobbyHandshake(host, roomNumber))
        const accepted = await hostSocket.next()
        assert.equal(accepted[0], 0)
        hostConnection = accepted[1]

        const again = await connect()
        again.send(lobbyHandshake(host, roomNumber))
        assert.deepEqual(await again.next(), [1, "multibattle_room_not_found"], "the admission is used up")

        assert.equal((await selectRoom(guest, roomNumber)).body.data.raising_state, 1)
        const guestSocket = await connect()
        guestSocket.send(lobbyHandshake(guest, roomNumber))
        const guestAccepted = await guestSocket.next()
        assert.equal(guestAccepted[0], 0)
        guestConnection = guestAccepted[1]

        // start the battle from the lobby
        hostSocket.send([0, [6]])
        assert.equal((await hostSocket.next())[1][0], 5)
    })

    await t.test("a battle connection needs a started member's id, once", async () => {
        const unknown = await connect()
        unknown.send({ reconnected: 0, socklet: "cooperation_battle", connectionId: "deadbeefdeadbeef", roomNumber })
        assert.deepEqual(await unknown.next(), [1, "multibattle_room_not_found"])

        const guestBattle = await connect()
        guestBattle.send({ reconnected: 0, socklet: "cooperation_battle", connectionId: guestConnection, roomNumber })
        assert.deepEqual(await guestBattle.next(), [0, guestConnection, roomNumber])
        const hijack = await connect()
        hijack.send({ reconnected: 0, socklet: "cooperation_battle", connectionId: guestConnection, roomNumber })
        assert.deepEqual(await hijack.next(), [1, "multibattle_room_not_found"], "a connected member's slot can't be taken")

        const hostBattle = await connect()
        hostBattle.send({ reconnected: 0, socklet: "cooperation_battle", connectionId: hostConnection, roomNumber })
        assert.deepEqual(await hostBattle.next(), [0, hostConnection, roomNumber])
    })

    await t.test("select_room by a room link's token admits its caller", async () => {
        const linkHost = await signUp(), linkGuest = await signUp()
        const created = await gameRequest("multi_battle_quest/create_room", { viewer_id: linkHost, quest_id: 1001001, party_id: 11, category: 2 })
        const linkRoom = created.body.data.room_number as string
        const token = new URL(created.body.data.room_url).searchParams.get("k")!
        const before = await connect()
        before.send(lobbyHandshake(linkGuest, linkRoom))
        assert.deepEqual(await before.next(), [1, "multibattle_room_not_found"])

        const selected = await gameRequest("multi_battle_quest/select_room", { viewer_id: linkGuest, party_id: 1, access_token: token, quest_id: 1001001, accepted_type: 4, category: 2 })
        assert.equal(selected.body.data.raising_state, 1)
        const after = await connect()
        after.send(lobbyHandshake(linkGuest, linkRoom))
        assert.equal((await after.next())[0], 0)
    })

    await t.test("a message over the size limit closes the connection", async () => {
        const client = await connect()
        client.write(Buffer.alloc(MAX_MESSAGE_BYTES + 1024, 0x61))
        await client.closed
    })
})

test("co-op routes only let the room's own players change it", async (t) => {
    const { getRoom } = await import("../src/lib/coop/rooms")
    const host = await signUp(), other = await signUp()
    const roomNumber = await createRoom(host)

    await t.test("share_room is the host's", async () => {
        const shared = await gameRequest("multi_battle_quest/share_room", { viewer_id: other, quest_id: 1001001, category: 2, room_number: roomNumber, share_type_list: [3] })
        assert.equal(shared.status, 400)
        assert.deepEqual(getRoom(roomNumber)?.shareTypes, [])
    })

    await t.test("start by a player who never joined doesn't mark the room started", async () => {
        await gameRequest("multi_battle_quest/start", { viewer_id: other, quest_id: 1001001, category: 2, party_id: 11, room_number: roomNumber, play_id: "X", use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [] })
        assert.equal(getRoom(roomNumber)?.inBattle, false)
    })

    await t.test("a host has one room: creating another closes the first", async () => {
        const second = await createRoom(host)
        assert.notEqual(second, roomNumber)
        assert.equal(getRoom(roomNumber), undefined)
        assert.ok(getRoom(second))
    })
})

test("after a battle only an admitted player's lobby connection opens the room again", async (t) => {
    const { CoopSocketServer, setCoopSocketServer } = await import("../src/lib/coop/socketServer")
    const { getRoom } = await import("../src/lib/coop/rooms")
    const server = new CoopSocketServer({ log: () => {}, keepAliveMs: 0, abandonedRoomMs: 0 })
    const port = await server.listen(0, "127.0.0.1")
    setCoopSocketServer(server)
    const clients: Client[] = []
    t.after(async () => { for (const c of clients) c.close(); setCoopSocketServer(null); await server.close() })
    const connect = async () => {
        const client = new Client()
        await client.connect(port)
        clients.push(client)
        return client
    }

    // one round, host alone: lobby → StartBattle → Bye → battle → Finalized, every socket closed
    const host = await signUp(), stranger = await signUp()
    const roomNumber = await createRoom(host)
    const lobby = await connect()
    lobby.send(lobbyHandshake(host, roomNumber))
    const connectionId = (await lobby.next())[1]
    lobby.send([0, [6]])
    await lobby.next() // Start
    lobby.send([0, [1]]) // Bye
    const battle = await connect()
    battle.send({ reconnected: 0, socklet: "cooperation_battle", connectionId, roomNumber })
    await battle.next() // Accept
    battle.send([0, [0]])
    await battle.next() // BattleStart
    battle.send([0, [1]])
    assert.deepEqual(await battle.next(), [1, [2]], "Finalized")
    lobby.close()
    battle.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(getRoom(roomNumber)!.inBattle, true)

    // a lobby handshake without an admission is refused before it can reopen the room
    for (const viewerId of [host, stranger]) {
        const client = await connect()
        client.send(lobbyHandshake(viewerId, roomNumber))
        assert.deepEqual(await client.next(), [1, "multibattle_room_not_found"])
    }
    assert.equal(getRoom(roomNumber)!.inBattle, true, "still closed")

    // Return to Room (select_room accepted_type 6) admits the round's player
    const rejoined = await gameRequest("multi_battle_quest/select_room", { viewer_id: host, party_id: 1, room_number: roomNumber, quest_id: 1001001, accepted_type: 6, category: 2 })
    assert.equal(rejoined.body.data.raising_state, 1)
    const back = await connect()
    back.send(lobbyHandshake(host, roomNumber))
    assert.equal((await back.next())[0], 0)
    assert.equal(getRoom(roomNumber)!.inBattle, false)
})

test("the establisher fields other players see are bounded", async () => {
    const { establisherOf } = await import("../src/lib/coop/mates")
    const huge = establisherOf({ name: "x".repeat(10_000), rank: 1e12, party: { characters: [[0, { id: 1.5, evolution_level: -3 }]] } })
    assert.equal(huge.name.length, 32)
    assert.equal(huge.rank, 1)
    assert.equal(huge.characterId, 1)
    assert.equal(huge.evolutionLevel, 0)
    assert.deepEqual(establisherOf({ name: "Host", rank: 42, party: { characters: [[0, { id: 151165, evolution_level: 2 }]] } }),
        { name: "Host", rank: 42, characterId: 151165, evolutionLevel: 2 })
})
