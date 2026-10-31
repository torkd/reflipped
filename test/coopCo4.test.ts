import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";
import { Client, enterLobby, gameRequest, lobbyMate } from "./coopHelpers";

// CO-4: what the client does around the SEC-12 admission and the SEC-15 mate check (docs/coop-research.md, "Admission").

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

async function signUp(): Promise<{ viewerId: number, playerId: number }> {
    const { viewerId } = await createTestPlayer(fastify)
    const { getAllPlayersSync } = await import("../src/data/wdfpData")
    const players = getAllPlayersSync()
    return { viewerId, playerId: players[players.length - 1].id }
}

const startBody = (viewerId: number, roomNumber: string) => ({
    viewer_id: viewerId, quest_id: 1001001, category: 2, party_id: 11, room_number: roomNumber, play_id: "CO4",
    use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: []
})

/** Messages until one matches; fails on a timeout. */
async function until(client: Client, match: (message: any) => boolean): Promise<any> {
    for (;;) {
        const message = await client.next()
        if (match(message)) return message
    }
}

test("an admission waits through the boss boost point dialog, but not forever", async () => {
    const { admit, createRoom, takeAdmission, ADMISSION_TTL_MS } = await import("../src/lib/coop/rooms")
    const room = createRoom(900_001, 1001001, 2)
    const t0 = 1_000_000
    admit(room, 900_002, undefined, t0)
    assert.notEqual(takeAdmission(room, 900_002, t0 + 5 * 60_000), null, "five minutes on the dialog")
    admit(room, 900_002, undefined, t0)
    assert.equal(takeAdmission(room, 900_002, t0 + ADMISSION_TTL_MS + 1), null)
    assert.ok(ADMISSION_TTL_MS <= 10 * 60_000)
})

test("a battle connection from a new address needs the member's own start", async (t) => {
    const { CoopSocketServer } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => {}, keepAliveMs: 0, abandonedRoomMs: 0 })
    const port = await server.listen(0, "127.0.0.1")
    t.after(() => server.close())

    const host = await signUp(), guest = await signUp(), other = await signUp()
    const created = await gameRequest(fastify, "multi_battle_quest/create_room", { viewer_id: host.viewerId, quest_id: 1001001, party_id: 11, category: 2 })
    const roomNumber = created.data.room_number as string
    const hostLobby = await enterLobby(port, host.viewerId, roomNumber, "Host")
    const guestLobby = await enterLobby(port, guest.viewerId, roomNumber, "Guest")
    t.after(() => { hostLobby.client.close(); guestLobby.client.close() })
    hostLobby.client.send([0, [6]]) // StartBattle
    await until(hostLobby.client, message => message[0] === 1 && message[1][0] === 5) // Start

    const battle = async (connectionId: string, localAddress: string) => {
        const client = new Client()
        await client.connect(port, localAddress)
        t.after(() => client.close())
        client.send({ reconnected: 0, socklet: "cooperation_battle", connectionId, roomNumber })
        return client.next()
    }

    // the host comes from its lobby's address: no start needed
    assert.deepEqual(await battle(hostLobby.id, "127.0.0.1"), [0, hostLobby.id, roomNumber])
    // the guest's phone changed networks: refused until its own signed start
    assert.deepEqual(await battle(guestLobby.id, "127.0.0.2"), [1, "multibattle_room_not_found"])
    await gameRequest(fastify, "multi_battle_quest/start", startBody(other.viewerId, roomNumber))
    assert.deepEqual(await battle(guestLobby.id, "127.0.0.2"), [1, "multibattle_room_not_found"], "another viewer's start doesn't count")
    await gameRequest(fastify, "multi_battle_quest/start", startBody(guest.viewerId, roomNumber))
    assert.deepEqual(await battle(guestLobby.id, "127.0.0.2"), [0, guestLobby.id, roomNumber])
    assert.deepEqual(await battle(guestLobby.id, "127.0.0.3"), [1, "multibattle_room_not_found"], "a connected member's slot can't be taken")
})

test("IPv4 clients of a dual-stack listener count under their IPv4 address", async () => {
    const { normaliseAddress } = await import("../src/lib/coop/socketServer")
    assert.equal(normaliseAddress("::ffff:203.0.113.7"), "203.0.113.7")
    assert.equal(normaliseAddress("203.0.113.7"), "203.0.113.7")
    assert.equal(normaliseAddress("2001:db8::1"), "2001:db8::1")
})

test("an empty stored number list reads back empty", async () => {
    const { deserializeNumberList, serializeNumberList } = await import("../src/data/utils")
    assert.deepEqual(deserializeNumberList(serializeNumberList([])), [])
    assert.deepEqual(deserializeNumberList(serializeNumberList([3, 1])), [3, 1])
})

test("the mate check takes ability souls from the items and caps armament levels", async () => {
    const data = await import("../src/data/wdfpData")
    const { givePlayerEquipmentSync } = await import("../src/lib/equipment")
    const { clampEquipmentLevel } = await import("../src/lib/assets")
    const { checkMateAgainstSave } = await import("../src/lib/coop/mateCheck")
    const { playerId } = await signUp()
    // a sold armament leaves its soul as an item; another soul held twice; an armament levelled past its maximum
    data.givePlayerItemSync(playerId, 5030037, 1)
    data.givePlayerItemSync(playerId, 5020010, 2)
    givePlayerEquipmentSync(playerId, 5050039, 1)
    data.updatePlayerEquipmentSync(playerId, 5050039, { level: 999 })

    const mate = lobbyMate("Saved", 111)
    mate.party.equipments = [[0, { equipmentId: 5050039, level: 999, enhancementLevel: 0 }]] as any
    mate.party.abilitySoulIds = [[0, 5030037], [0, 5030037], [0, 5020010], [0, 5020010], [0, 5050039]] as any
    const checked = checkMateAgainstSave(playerId, mate)
    assert.deepEqual(checked.party.abilitySoulIds, [[0, 5030037], [1], [0, 5020010], [0, 5020010], [1]],
        "one slot per soul held; an armament isn't a soul")
    const level = checked.party.equipments[0][1].level
    assert.equal(level, clampEquipmentLevel(5050039, 999))
    assert.ok(level < 999)
})
