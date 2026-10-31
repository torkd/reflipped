import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, readCapturedRoute } from "./helpers";
import { apiPrefix, Client, gameRequest as coopRequest, lobbyMate, newViewer } from "./coopHelpers";

// Co-op: HTTP room routes + the realtime socket, driven by simulated clients.
// Message shapes follow docs/coop-protocol.md (enums are [index, ...args]); flow: docs/coop-research.md.

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
const mate = (name: string, characterId: number) => lobbyMate(name, characterId)

test("co-op room over HTTP and socket", async (t) => {
    const { admit, createRoom } = await import("../src/lib/coop/rooms")
    const { CoopSocketServer } = await import("../src/lib/coop/socketServer")
    const log: string[] = []
    const server = new CoopSocketServer({ log: line => log.push(line), traffic: true })
    const port = await server.listen(0, "127.0.0.1")
    t.after(() => server.close())

    await t.test("create_room → prepare → select_room advertise the socket", async () => {
        const viewerId = await signUp()
        const created = await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: 1001001, party_id: 11, category: 2 })
        const roomNumber = created.data.room_number
        assert.match(roomNumber, /^\d{6}$/)

        const prepared = await gameRequest("multi_battle_quest/prepare", { viewer_id: viewerId, quest_id: 1001001, room_number: roomNumber, category: 2 })
        assert.equal(prepared.data_headers.result_code, 1)

        const shared = await gameRequest("multi_battle_quest/share_room", { viewer_id: viewerId, quest_id: 1001001, category: 2, room_number: roomNumber, share_type_list: [3] })
        // the captured config, plus the host's AI summon wait (nobody else online here: the short one)
        const capturedShare = readCapturedRoute("multi_battle_quest_share_room").responseBody.data
        assert.deepEqual(shared.data, { config: { ...capturedShare.config, summon_com_seconds: 15 } })

        const started = await gameRequest("multi_battle_quest/start", { viewer_id: viewerId, quest_id: 1001001, category: 2, party_id: 11, room_number: roomNumber, play_id: "TEST", use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [1, 2] })
        assert.equal(started.data.is_multi, "multi")
        const capturedStart = readCapturedRoute("multi_battle_quest_start").responseBody.data
        assert.deepEqual(Object.keys(started.data).sort(), Object.keys(capturedStart).sort())

        // finish: rewards via the single-player logic, marked as multi
        const capturedFinish = readCapturedRoute("multi_battle_quest_finish")
        const finished = await gameRequest("multi_battle_quest/finish", { ...capturedFinish.requestBody, viewer_id: viewerId, quest_id: 1001001, category: 2 })
        assert.equal(finished.data.is_multi, "multi")
        const missingFinish = Object.keys(capturedFinish.responseBody.data).filter(key => !(key in finished.data))
        assert.deepEqual(missingFinish, [], `finish is missing: ${missingFinish.join(", ")}`)

        // abort (a lost battle): same shape as the capture
        const capturedAbort = readCapturedRoute("multi_battle_quest_abort")
        await gameRequest("multi_battle_quest/start", { viewer_id: viewerId, quest_id: 1001001, category: 2, party_id: 11, room_number: roomNumber, play_id: "TEST2", use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [1, 2] })
        const { category: _ignored, ...abortBody } = capturedAbort.requestBody
        const aborted = await gameRequest("multi_battle_quest/abort", { ...abortBody, viewer_id: viewerId, room_number: roomNumber })
        assert.equal(aborted.data.is_multi, "multi")
        assert.equal(aborted.data.category_id, 2, "without a category in the body, the room's is used")
        assert.deepEqual(Object.keys(aborted.data).sort(), Object.keys(capturedAbort.responseBody.data).sort())

        const selected = await gameRequest("multi_battle_quest/select_room", { viewer_id: viewerId, party_id: 11, room_number: roomNumber, quest_id: 1001001, accepted_type: 1, category: 2 })
        const captured = readCapturedRoute("multi_battle_quest_select_room").responseBody.data
        assert.deepEqual(Object.keys(selected.data).sort(), Object.keys(captured).sort())
        assert.equal(selected.data.room_number, roomNumber)
        assert.equal(typeof selected.data.ip_address, "string")
        assert.equal(selected.data.port, 18888)

        // disband closes the room; repeating it still succeeds (the client retries)
        const disbanded = await gameRequest("multi_battle_quest/disband_room", { viewer_id: viewerId, room_number: roomNumber })
        assert.deepEqual(disbanded.data, [])
        await gameRequest("multi_battle_quest/disband_room", { viewer_id: viewerId, room_number: roomNumber })
    })

    await t.test("summon fills empty slots with AI companions (HTTP + EnterComs)", async () => {
        const { setCoopSocketServer } = await import("../src/lib/coop/socketServer")
        setCoopSocketServer(server)
        t.after(() => setCoopSocketServer(null))

        const viewerId = await signUp()
        const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number

        const host = new Client()
        await host.connect(port)
        host.send({ reconnected: 0, socklet: "cooperation_room", viewerId, roomNumber, questCategory: 2, questId: 1001001 })
        await host.next()
        host.send([0, [0, mate("Host", 111), 11]])
        await host.next() // Welcome

        // one human in a room of 3 → two companions, shaped like the captured reply
        const summoned = await gameRequest("multi_battle_quest/summon", { viewer_id: viewerId, category_id: 2, room_number: roomNumber, quest_id: 1001001 })
        assert.deepEqual(Object.keys(summoned.data), ["mate1", "mate2"])
        const captured = readCapturedRoute("multi_battle_quest_summon").responseBody.data.mate1
        assert.deepEqual(Object.keys(summoned.data.mate1).sort(), Object.keys(captured).sort())

        // equivalent to the host's party (one level-1 character), not the captured max-level parties
        for (const companion of Object.values(summoned.data) as any[]) {
            assert.equal(companion.party.characters.length, 1)
            for (const character of companion.party.characters) {
                assert.equal(character.exp, 0)
                assert.deepEqual(character.mana_node_ids, [])
                assert.equal(character.over_limit_step, 0)
                assert.equal(character.ex_boost, undefined)
            }
        }

        // the client then sends EnterComs; companions join as ready members
        const coms = Object.values(summoned.data).map((m: any) => ({ comId: m.com_id, degreeId: m.degree_id, name: "CPU", party: m.party, rank: m.rank }))
        host.send([0, [10, coms]])
        const mates = await host.next()
        assert.deepEqual([mates[0], mates[1][0]], [1, 1], "Mates")
        assert.equal(mates[1][1].length, 3)
        const companions = mates[1][1].filter((m: any) => m.comId !== null)
        assert.equal(companions.length, 2)
        assert.deepEqual(companions[0].state, [1], "companions are ready")
        assert.match(companions[0].connectionId, /^com-/)
        assert.ok(Number.isInteger(companions[0].viewerId) && companions[0].viewerId >= 1, "companions need a valid ViewerId (C5230)")
        assert.equal(companions[0].playerRoleKind, 99, "role 99: the host's client plays them, no network traffic")
        host.close()
    })

    await t.test("recruiting adds balanced companions after a fixed delay", async () => {
        const { admit, createRoom } = await import("../src/lib/coop/rooms")
        const { balancedCompanions, toMateParty } = await import("../src/lib/coop/companions")
        const room = createRoom(7, 1001001, 2)
        admit(room, 7)
        const host = new Client()
        await host.connect(port)
        host.send({ reconnected: 0, socklet: "cooperation_room", viewerId: 7, roomNumber: room.roomNumber, questCategory: 2, questId: 1001001 })
        await host.next()
        host.send([0, [0, mate("Host", 111), 11]])
        await host.next() // Welcome

        server.scheduleCompanions(room.roomNumber, 20, count => balancedCompanions(server.hostMate(room.roomNumber), count, 900).map((c, i) => ({
            comId: c.com_id, degreeId: c.degree_id, name: `Ally${i}`, party: toMateParty(c.party), rank: c.rank
        })))
        const mates = await host.next()
        assert.deepEqual([mates[0], mates[1][0]], [1, 1], "Mates")
        assert.equal(mates[1][1].length, 3, "two companions fill the free slots")
        const companion = mates[1][1].find((m: any) => m.comId === 900)
        assert.equal(companion.playerRoleKind, 99)
        assert.equal(companion.name, "Ally0")
        assert.deepEqual(companion.party.characters[0][0], 0, "Some(character) in lobby format")
        host.close()
    })

    await t.test("companions are equivalent to the host's party, not copies", async () => {
        const { balancedCompanions, companionCharacterPool } = await import("../src/lib/coop/companions")
        const characters = (await import("../assets/character.json")).default as Record<string, { rarity: number }>
        const pool = new Set(companionCharacterPool())
        const some = (x: any) => [0, x], none = [1]
        // the host: a 5★ and a 3★ character, one empty slot, a 4★ equipment at level 3, a 5★ soul
        const host = {
            rank: 42,
            party: {
                characters: [some({ id: 151165, exp: 5000, evolution_level: 1, over_limit_step: 2 }), some({ id: 311001, exp: 300, evolution_level: 0, over_limit_step: 0 }), none],
                unison_characters: [none, none, none],
                equipments: [some({ equipmentId: 4050004, level: 3, enhancementLevel: 1 }), none, none],
                abilitySoulIds: [some(5050039), none, none]
            }
        }
        const companions = balancedCompanions(host, 2, 1)
        const ids: number[] = []
        for (const companion of companions) {
            assert.equal(companion.rank, 42)
            const [first, second, third] = companion.party.characters
            assert.equal(characters[String(first.id)].rarity, characters["151165"].rarity)
            assert.equal(characters[String(second.id)].rarity, characters["311001"].rarity)
            assert.deepEqual([first.exp, first.evolution_level, first.over_limit_step], [5000, 1, 2])
            assert.deepEqual(first.mana_node_ids, [])
            assert.equal(third, null, "empty slots stay empty")
            assert.deepEqual(companion.party.unison_characters, [null, null, null])
            const [equipment, ...noEquipment] = companion.party.equipments
            assert.equal(String(equipment.equipment_id)[0], "4", "same equipment rarity")
            assert.deepEqual([equipment.level, equipment.enhancement_level], [3, 1])
            assert.deepEqual(noEquipment, [null, null])
            assert.equal(String(companion.party.ability_soul_ids[0])[0], "5", "same soul rarity")
            ids.push(first.id, second.id)
        }
        assert.ok(ids.every(id => pool.has(id)))
        assert.equal(new Set([...ids, 151165, 311001]).size, ids.length + 2, "no character twice in the room")
        const again = balancedCompanions(host, 2, 1).flatMap(c => c.party.characters.filter(Boolean).map((x: any) => x.id))
        assert.notDeepEqual(again, ids, "a new draw per room")
    })

    await t.test("a guest finds the room: get_rooms, search_room, select_room states", async () => {
        const { setCoopSocketServer } = await import("../src/lib/coop/socketServer")
        setCoopSocketServer(server)
        const hostViewer = await signUp(), guestViewer = await signUp()
        const created = await gameRequest("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })
        const roomNumber = created.data.room_number

        // the host's lobby is open, so the room shows its name and leader in the list
        const host = new Client()
        await host.connect(port)
        host.send({ reconnected: 0, socklet: "cooperation_room", viewerId: hostViewer, roomNumber, questCategory: 2, questId: 1001001 })
        await host.next()
        host.send([0, [0, mate("Host", 111), 11]])
        await host.next() // Welcome

        const listed = await gameRequest("multi_battle_quest/get_rooms", { viewer_id: guestViewer, category_id: 2 })
        const entry = listed.data.rooms.find((r: any) => r.room_number === roomNumber)
        assert.ok(entry, "listed for other players")
        assert.deepEqual([entry.establisher_name, entry.establisher_character, entry.mates, entry.quest_id], ["Host", 111, 1, 1001001])
        const own = await gameRequest("multi_battle_quest/get_rooms", { viewer_id: hostViewer, category_id: 2 })
        assert.equal(own.data.rooms.find((r: any) => r.room_number === roomNumber), undefined, "not the host's own")
        const otherCategory = await gameRequest("multi_battle_quest/get_rooms", { viewer_id: guestViewer, category_id: 9 })
        assert.equal(otherCategory.data.rooms.find((r: any) => r.room_number === roomNumber), undefined)

        // typing the room number
        const found = await gameRequest("multi_battle_quest/search_room", { viewer_id: guestViewer, room_number: roomNumber })
        assert.deepEqual(found.data, { room_exists: true, category_id: 2, establisher_follow: 0, quest_id: 1001001, room_number: roomNumber })
        const missing = await gameRequest("multi_battle_quest/search_room", { viewer_id: guestViewer, room_number: "000000" })
        assert.equal(missing.data.room_exists, false)

        // select_room: 1 = join, 9 = disbanded
        const select = (room: string) => gameRequest("multi_battle_quest/select_room", { viewer_id: guestViewer, party_id: 1, room_number: room, quest_id: 1001001, accepted_type: 1, category: 2 })
        assert.equal((await select(roomNumber)).data.raising_state, 1)
        assert.equal((await select("000000")).data.raising_state, 9)

        // restore_room: after a restart the game rejoins the room it saved (number and sequence)
        const restore = (room: string, sequence: number) => gameRequest("multi_battle_quest/restore_room", { viewer_id: hostViewer, room_number: room, room_sequence: sequence })
        const sequence = (await select(roomNumber)).data.room_sequence
        const restored = await restore(roomNumber, sequence)
        assert.equal(restored.data.raising_state, 1)
        assert.equal(typeof restored.data.ip_address, "string")
        assert.equal(typeof restored.data.port, "number")
        assert.equal((await restore(roomNumber, sequence + 1)).data.raising_state, 9, "another room reused the number")
        assert.equal((await restore("000000", 1)).data.raising_state, 9, "no such room")

        // once the battle started: 4, and gone from the list
        host.send([0, [6]])
        await host.next() // Start
        assert.equal((await select(roomNumber)).data.raising_state, 4)
        const afterStart = await gameRequest("multi_battle_quest/get_rooms", { viewer_id: guestViewer, category_id: 2 })
        assert.equal(afterStart.data.rooms.find((r: any) => r.room_number === roomNumber), undefined)
        host.close()
    })

    await t.test("a joining player replaces an AI companion; a room of players is full", async () => {
        const { admit, createRoom } = await import("../src/lib/coop/rooms")
        const { balancedCompanions, toMateParty } = await import("../src/lib/coop/companions")
        const room = createRoom(20, 1001001, 2)
        const join = async (viewerId: number) => {
            admit(room, viewerId)
            const client = new Client()
            await client.connect(port)
            client.send({ reconnected: 0, socklet: "cooperation_room", viewerId, roomNumber: room.roomNumber, questCategory: 2, questId: 1001001 })
            return { client, reply: await client.next() }
        }
        const { client: host } = await join(20)
        host.send([0, [0, mate("Host", 111), 11]])
        await host.next() // Welcome
        server.scheduleCompanions(room.roomNumber, 1, count => balancedCompanions(null, count, 970).map((c, i) => ({
            comId: c.com_id, degreeId: c.degree_id, name: `Ally${i}`, party: toMateParty(c.party), rank: c.rank
        })))
        assert.equal((await host.next())[1][1].length, 3, "host + 2 companions")

        // a player joins the full room: one companion makes way
        const { client: guest, reply } = await join(21)
        assert.equal(reply[0], 0, "accepted")
        guest.send([0, [0, mate("Guest", 222), 3]])
        const welcome = await guest.next()
        const mates = welcome[1][2]
        assert.equal(mates.length, 3)
        assert.equal(mates.filter((m: any) => m.comId !== null && m.comId !== undefined).length, 1, "one companion left")
        assert.ok(mates.some((m: any) => m.name === "Guest"))
        await host.next() // Mates with the guest

        // a second player takes the last companion's place, a third finds the room full
        const { client: second } = await join(22)
        second.send([0, [0, mate("Second", 333), 3]])
        assert.equal((await second.next())[1][2].length, 3)
        const { client: third, reply: denied } = await join(23)
        assert.deepEqual(denied, [1, "multibattle_room_filled"])
        for (const c of [host, guest, second, third]) c.close()
    })

    await t.test("event co-op quests: start and finish award like normal boss quests", async () => {
        const capturedFinish = readCapturedRoute("multi_battle_quest_finish")
        // category 8 = advent event (multi), 19 = world story event boss battle
        for (const [category, questId] of [[8, 1002], [19, 100100001]]) {
            const viewerId = await signUp()
            const created = await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: questId, party_id: 11, category })
            const roomNumber = created.data.room_number
            await gameRequest("multi_battle_quest/start", { viewer_id: viewerId, quest_id: questId, category, party_id: 11, room_number: roomNumber, play_id: `EV${category}`, use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [] })
            const finished = await gameRequest("multi_battle_quest/finish", { ...capturedFinish.requestBody, viewer_id: viewerId, quest_id: questId, category })
            assert.equal(finished.data.is_multi, "multi", `category ${category}`)
            const missing = Object.keys(capturedFinish.responseBody.data).filter(key => !(key in finished.data))
            assert.deepEqual(missing, [], `category ${category} finish is missing: ${missing.join(", ")}`)
        }
    })

    await t.test("handshake for an unknown room is denied", async () => {
        const client = new Client()
        await client.connect(port)
        client.send({ reconnected: 0, socklet: "cooperation_room", viewerId: 1, roomNumber: "000000", questCategory: 2, questId: 1001001 })
        const reply = await client.next()
        assert.equal(reply[0], 1, "Denied")
        client.close()
    })

    await t.test("two players: lobby, start, battle relay, finish", async () => {
        const room = createRoom(1, 1001001, 2)
        admit(room, 1)
        admit(room, 2)
        const host = new Client(), guest = new Client()
        await host.connect(port)
        await guest.connect(port)

        // lobby handshake → Accept(connectionId, roomNumber)
        host.send({ reconnected: 0, socklet: "cooperation_room", viewerId: 1, roomNumber: room.roomNumber, questCategory: 2, questId: 1001001 })
        const hostAccept = await host.next()
        assert.equal(hostAccept[0], 0)
        assert.equal(hostAccept[2], room.roomNumber)
        const hostId = hostAccept[1]

        // Notify(Enter(mate, partyId)) → Message(Welcome(room, mates))
        host.send([0, [0, mate("Host", 111), 11]])
        const welcome = await host.next()
        assert.equal(welcome[0], 1)
        assert.equal(welcome[1][0], 0, "Welcome")
        assert.equal(welcome[1][1].roomNumber, room.roomNumber)
        assert.equal(welcome[1][1].establisherName, "Host")
        assert.equal(welcome[1][1].establisherCharacter, 111)
        assert.equal(welcome[1][2].length, 1)
        assert.equal(welcome[1][2][0].connectionId, hostId)
        assert.deepEqual(welcome[1][2][0].state, [1], "the host is always Ready")

        guest.send({ reconnected: 0, socklet: "cooperation_room", viewerId: 2, roomNumber: room.roomNumber, questCategory: 2, questId: 1001001 })
        const guestId = (await guest.next())[1]
        guest.send([0, [0, mate("Guest", 222), 3]])
        const guestWelcome = await guest.next()
        assert.equal(guestWelcome[1][2].length, 2)
        const hostSeesMates = await host.next()
        assert.deepEqual([hostSeesMates[0], hostSeesMates[1][0]], [1, 1], "Mates")
        assert.equal(hostSeesMates[1][1].length, 2)

        // Heartbeat → AckHeartbeat(connectionId)
        guest.send([0, [4]])
        assert.deepEqual(await guest.next(), [1, [10, guestId]])

        // Ready(Ready) → StateChanged to everyone
        guest.send([0, [3, [1]]])
        assert.deepEqual(await host.next(), [1, [2, guestId, [1]]])
        assert.deepEqual(await guest.next(), [1, [2, guestId, [1]]])

        // the host's own Ready(Preparation) (sent on party edits) keeps it Ready
        host.send([0, [3, [0]]])
        assert.deepEqual(await host.next(), [1, [2, hostId, [1]]])
        assert.deepEqual(await guest.next(), [1, [2, hostId, [1]]])

        // StartBattle → Start(mates) to everyone
        host.send([0, [6]])
        assert.equal((await host.next())[1][0], 5)
        assert.equal((await guest.next())[1][0], 5)

        // battle sockets
        const hostBattle = new Client(), guestBattle = new Client()
        await hostBattle.connect(port)
        await guestBattle.connect(port)
        hostBattle.send({ reconnected: 0, socklet: "cooperation_battle", connectionId: hostId, roomNumber: room.roomNumber })
        guestBattle.send({ reconnected: 0, socklet: "cooperation_battle", connectionId: guestId, roomNumber: room.roomNumber })
        assert.deepEqual(await hostBattle.next(), [0, hostId, room.roomNumber])
        assert.deepEqual(await guestBattle.next(), [0, guestId, room.roomNumber])

        // BattleStart only once every player sent SceneReady
        hostBattle.send([0, [0]])
        guestBattle.send([0, [0]])
        assert.deepEqual(await hostBattle.next(), [1, [1]])
        assert.deepEqual(await guestBattle.next(), [1, [1]])

        // Broadcast([Command(senderCounter, 0, 0, frame, cmd)]) → Messages(sender, [Command(c1, order, 0, frame, cmd)])
        hostBattle.send([1, [[0, 0, 0, 0, 10, "host-cmd"]]])
        const expectedHost = [2, hostId, [[0, 0, 0, 0, 10, "host-cmd"]]]
        assert.deepEqual(await hostBattle.next(), expectedHost)
        assert.deepEqual(await guestBattle.next(), expectedHost)
        guestBattle.send([1, [[0, 0, 0, 0, 12, "guest-cmd"]]])
        const expectedGuest = [2, guestId, [[0, 0, 1, 0, 12, "guest-cmd"]]]
        assert.deepEqual(await hostBattle.next(), expectedGuest)
        assert.deepEqual(await guestBattle.next(), expectedGuest)

        // Measurement(n, appTime) → Measurement(n, appTime, span)
        guestBattle.send([0, [2, 7, 1234.5]])
        assert.deepEqual(await guestBattle.next(), [1, [3, 7, 1234.5, 0]])

        // Finalized once everyone finalized
        hostBattle.send([0, [1]])
        guestBattle.send([0, [1]])
        assert.deepEqual(await hostBattle.next(), [1, [2]])
        assert.deepEqual(await guestBattle.next(), [1, [2]])

        // Bye leaves the lobby without the server closing the socket (that reads as a lost connection)
        guest.send([0, [1]])
        const hostAfterBye = await host.next()
        assert.deepEqual([hostAfterBye[0], hostAfterBye[1][0]], [1, 1], "remaining members get Mates")
        assert.equal(guest.isOpen(), true, "server must not close the lobby socket on Bye")

        for (const client of [host, guest, hostBattle, guestBattle]) client.close()
        assert.ok(log.some(line => line.includes("<- ")), "messages are logged")
    })
})

test("lobby members are acknowledged on a timer, without sending a Heartbeat", async (t) => {
    const { CoopSocketServer } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => {}, keepAliveMs: 50 })
    const port = await server.listen(0, "127.0.0.1")
    t.after(() => server.close())

    const viewerId = await signUp()
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    const handshake = (id: number) => ({ reconnected: 0, socklet: "cooperation_room", viewerId: id, roomNumber, questCategory: 2, questId: 1001001 })

    const host = new Client()
    await host.connect(port)
    t.after(() => host.close())
    host.send(handshake(viewerId))
    const connectionId = (await host.next())[1]

    // a second connection that has been accepted but hasn't entered the lobby yet
    const lurker = new Client()
    await lurker.connect(port)
    t.after(() => lurker.close())
    const lurkerId = await signUp()
    await gameRequest("multi_battle_quest/select_room", { viewer_id: lurkerId, party_id: 1, room_number: roomNumber, quest_id: 1001001, accepted_type: 1, category: 2 })
    lurker.send(handshake(lurkerId))
    await lurker.next() // Accept

    host.send([0, [0, mate("Host", 111), 11]])
    const welcome = await host.next()
    assert.deepEqual([welcome[0], welcome[1][0]], [1, 0], "Welcome comes first")

    await t.test("an entered member gets an AckHeartbeat (the client leaves after 30 s without one)", async () => {
        assert.deepEqual(await host.next(), [1, [10, connectionId]])
    })

    await t.test("a member that has not entered gets none", async () => {
        // it still gets the lobby's member list when the host enters; what it must not get is an AckHeartbeat
        const seen: any[] = []
        while (true) {
            try { seen.push(await lurker.next(300)) } catch { break }
        }
        assert.ok(seen.length > 0, "the member list reaches it")
        assert.ok(!seen.some(message => message[0] === 1 && message[1][0] === 10), "no AckHeartbeat")
    })

    await t.test("a member that said Bye gets no more", async () => {
        host.send([0, [1]])
        while (true) {
            try { await host.next(300) } catch { break } // drain what was already on the way, then silence
        }
        await assert.rejects(host.next(300), /timed out/)
        // after Bye the server keeps the socket open for the client to close, and server.close() would wait for it
        host.close()
    })
})

test("co-op play_continue buys a continue for 50 beads, and needs a battle in progress", async () => {
    const viewerId = await signUp()
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    const body = { viewer_id: viewerId, quest_id: 1001001, play_id: "CONTINUE", payment_type: 1, category: 2, room_number: roomNumber, statistics: {}, api_count: 1 }

    // before start there is no quest to continue
    const early = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/multi_battle_quest/play_continue`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody(body)
    })
    assert.equal(early.statusCode, 400)

    await gameRequest("multi_battle_quest/start", { viewer_id: viewerId, quest_id: 1001001, category: 2, party_id: 11, room_number: roomNumber, play_id: "CONTINUE", use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [1, 2] })
    const first = await gameRequest("multi_battle_quest/play_continue", body)
    assert.equal(first.data.is_multi, "multi")
    const second = await gameRequest("multi_battle_quest/play_continue", body)
    assert.equal(second.data.user_info.free_vmoney, first.data.user_info.free_vmoney - 50)
})

test("co-op play_continue spends free beads first, then paid ones, and refuses only when both fall short", async () => {
    const data = await import("../src/data/wdfpData")
    const viewerId = await signUp()
    const players = data.getAllPlayersSync()
    const playerId = players[players.length - 1].id
    const roomNumber = (await gameRequest("multi_battle_quest/create_room", { viewer_id: viewerId, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    await gameRequest("multi_battle_quest/start", { viewer_id: viewerId, quest_id: 1001001, category: 2, party_id: 11, room_number: roomNumber, play_id: "BEADS", use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [1, 2] })
    const body = { viewer_id: viewerId, quest_id: 1001001, play_id: "BEADS", payment_type: 1, category: 2, room_number: roomNumber, statistics: {}, api_count: 1 }

    async function continueWith(freeBeads: number, paidBeads: number) {
        data.updatePlayerSync({ id: playerId, freeVmoney: freeBeads, vmoney: paidBeads })
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/multi_battle_quest/play_continue`,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeGameBody(body)
        })
        const after = data.getPlayerSync(playerId)!
        return { status: response.statusCode, reply: response.statusCode === 200 ? decodeGameBody(response.body).data.user_info : null, free: after.freeVmoney, paid: after.vmoney }
    }

    assert.deepEqual(await continueWith(30, 100), { status: 200, reply: { free_vmoney: 0, vmoney: 80 }, free: 0, paid: 80 }, "30 free + 20 paid")
    assert.deepEqual(await continueWith(49, 1), { status: 200, reply: { free_vmoney: 0, vmoney: 0 }, free: 0, paid: 0 }, "49 free + 1 paid")
    assert.deepEqual(await continueWith(50, 0), { status: 200, reply: { free_vmoney: 0, vmoney: 0 }, free: 0, paid: 0 }, "exactly 50 free")
    assert.deepEqual(await continueWith(0, 50), { status: 200, reply: { free_vmoney: 0, vmoney: 0 }, free: 0, paid: 0 }, "exactly 50 paid")
    assert.deepEqual(await continueWith(0, 49), { status: 400, reply: null, free: 0, paid: 49 }, "49 in total: refused, nothing taken")
    assert.deepEqual(await continueWith(20, 29), { status: 400, reply: null, free: 20, paid: 29 }, "49 split across both: refused, nothing taken")

    // a balance past the limit (an imported save) is clamped in the reply like /load does
    const huge = await continueWith(1_200_000, 0)
    assert.equal(huge.status, 200)
    assert.ok(huge.reply.free_vmoney <= 999_999, `free beads in the reply are clamped: ${huge.reply.free_vmoney}`)
})
