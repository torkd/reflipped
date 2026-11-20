import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";
import { Client, gameRequest as coopRequest, newViewer } from "./coopHelpers";

// CO-9: the lounge host's client never sends Ready([1]) (only guests ready themselves), and its Go stays disabled
// while any mate shows Preparing. So the server lists the host as Ready, as the room lobby does, and a lounge whose
// host never readied starts once both guests are Ready. Found in the CO-3 device test on 2026-11-19.

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let setServerTime: (date: Date | null) => void

const campaignId = 5 // 2024-06-25 14:00 to 2024-07-02 13:59:59 (Japan time)
const inCampaign = new Date("2024-06-29T12:00:00Z")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    setServerTime = (await import("../src/utils")).setServerTime
})

after(async () => {
    setServerTime(null)
    await cleanup()
})

const gameRequest = (route: string, body: Record<string, unknown>) => coopRequest(fastify, route, body)

async function newViewerId(): Promise<number> {
    return newViewer(fastify)
}

async function socketServer(t: { after: (fn: () => Promise<void>) => void }) {
    const { CoopSocketServer, setCoopSocketServer } = await import("../src/lib/coop/socketServer")
    const { decideLoungeTicketsSync } = await import("../src/lib/multiSpecialExchange")
    const { getServerDate } = await import("../src/utils")
    const server = new CoopSocketServer({
        log: () => {}, abandonedRoomMs: 0,
        onLoungeStart: (lounge, members) => decideLoungeTicketsSync(lounge.campaignId, members.map(m => m.playerId), getServerDate())
    })
    const port = await server.listen(0, "127.0.0.1")
    setCoopSocketServer(server)
    t.after(async () => { setCoopSocketServer(null); await server.close() })
    return port
}

interface Key { lounge_id: number, advice: string, establisher_viewer_id: number }

async function enter(port: number, viewerId: number, key: Key, name: string) {
    const selected = await gameRequest("lounge/select", { viewer_id: viewerId, use_case: 1, ...key, accepted_type: 1, campaign_id: campaignId })
    assert.equal(selected.data.raising_state, 2, `${name} selected`)
    const client = new Client()
    await client.connect(port)
    client.send({ reconnected: 0, socklet: "multi_special_exchange_socklet", viewerId, useCase: 1, loungeId: key.lounge_id, advice: key.advice, establisherViewerId: key.establisher_viewer_id })
    assert.equal((await client.next())[0], 0, `${name} accepted`)
    client.send([0, [0, { characterId: 111001, degreeId: 0, evolutionLevel: 0, name, rank: 10 }]]) // Enter
    const welcome = await client.next()
    assert.equal(welcome[1][0], 3, "Welcome")
    return { client, welcome }
}

const readyOf = (list: any[], viewerId: number) => list.find(m => m.viewerId === viewerId)?.readyState

test("the lounge host is listed as Ready without sending Ready, and its Go starts with both guests Ready", async (t) => {
    setServerTime(inCampaign)
    const port = await socketServer(t)
    const a = await newViewerId(), b = await newViewerId(), c = await newViewerId()
    const created = await gameRequest("lounge/create", { viewer_id: a, use_case: 1, campaign_id: campaignId })
    assert.equal(created.data_headers.result_code, 1, JSON.stringify(created))
    const key = { lounge_id: created.data.lounge_id, advice: created.data.advice, establisher_viewer_id: a }
    await gameRequest("lounge/prepare", { viewer_id: a, use_case: 1, ...key })

    // the host enters and never readies itself
    const host = await enter(port, a, key, "A")
    t.after(() => host.client.close())
    assert.deepEqual(readyOf(host.welcome[1][1], a), [1], "the host's own Welcome shows it Ready")

    const guestB = await enter(port, b, key, "B")
    t.after(() => guestB.client.close())
    assert.deepEqual(readyOf(guestB.welcome[1][1], a), [1], "a guest sees the host Ready")
    assert.deepEqual(readyOf(guestB.welcome[1][1], b), [0], "a guest starts Preparing")
    const mates = await host.client.next()
    assert.equal(mates[1][0], 4, "Mates")
    assert.deepEqual(readyOf(mates[1][1], a), [1], "the host stays Ready in Mates")

    const guestC = await enter(port, c, key, "C")
    t.after(() => guestC.client.close())
    await host.client.next() // Mates
    await guestB.client.next()

    // the guests ready themselves; the host's Go then starts everyone
    for (const [guest, viewerId] of [[guestB, b], [guestC, c]] as const) {
        guest.client.send([0, [3, [1]]])
        for (const p of [host, guestB, guestC]) assert.deepEqual(await p.client.next(), [1, [0, viewerId, [1]]], "StateChanged")
    }
    host.client.send([0, [4]])
    for (const p of [host, guestB, guestC]) assert.deepEqual(await p.client.next(), [1, [5]], "Start")
})
