import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";
import { Client, gameRequest as coopRequest, newViewer } from "./coopHelpers";

// CO-3: the multi special exchange lounge. HTTP (lounge/*) and its socket (`multi_special_exchange_socklet`), driven by
// simulated clients; the host's Go decides every member's ticket (status 2), and each one's pick is mailed to the
// others. Flow and wire format: docs/coop-polish-spec.md §3.

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let setServerTime: (date: Date | null) => void

// campaign 5: 2024-06-25 14:00 to 2024-07-02 13:59:59 (Japan time), exchange until 2024-07-07 13:59:59
const campaignId = 5
const ticketItemId = 980007
const characterId = 111015
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

interface Player { viewerId: number, playerId: number }

async function newPlayer(): Promise<Player> {
    const viewerId = await newViewer(fastify)
    const { getViewerPlayerIdSync } = await import("../src/data/wdfpData")
    return { viewerId, playerId: getViewerPlayerIdSync(viewerId)! }
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
    return { server, port }
}

const detail = (name: string) => ({ characterId: 111001, degreeId: 0, evolutionLevel: 0, name, rank: 10 })

interface Key { lounge_id: number, advice: string, establisher_viewer_id: number }

/** select, then the socket handshake and Enter; returns the client and its Welcome. */
async function enterLounge(port: number, player: Player, key: Key, name: string) {
    const selected = await gameRequest("lounge/select", { viewer_id: player.viewerId, use_case: 1, ...key, accepted_type: 1, campaign_id: campaignId })
    assert.equal(selected.data.raising_state, 2, `${name} selected`)
    assert.equal(typeof selected.data.port, "number")
    assert.match(selected.data.lounge_number, /^\d{6}$/)
    const client = new Client()
    await client.connect(port)
    client.send({ reconnected: 0, socklet: "multi_special_exchange_socklet", viewerId: player.viewerId, useCase: 1, loungeId: key.lounge_id, advice: key.advice, establisherViewerId: key.establisher_viewer_id })
    const accept = await client.next()
    assert.equal(accept[0], 0, `${name} accepted: ${JSON.stringify(accept)}`)
    assert.equal(accept[2], key.lounge_id)
    client.send([0, [0, detail(name)]]) // Enter
    const welcome = await client.next()
    assert.equal(welcome[1][0], 3, "Welcome")
    return { client, welcome, lounge_number: selected.data.lounge_number as string }
}

async function createLounge(host: Player): Promise<Key> {
    const created = await gameRequest("lounge/create", { viewer_id: host.viewerId, use_case: 1, campaign_id: campaignId })
    assert.equal(created.data_headers.result_code, 1, JSON.stringify(created))
    assert.equal(typeof created.data.advice, "string")
    const key = { lounge_id: created.data.lounge_id, advice: created.data.advice, establisher_viewer_id: host.viewerId }
    const prepared = await gameRequest("lounge/prepare", { viewer_id: host.viewerId, use_case: 1, ...key })
    assert.equal(prepared.data_headers.result_code, 1)
    return key
}

test("three players gather in a lounge, Go decides their tickets, and each pick reaches the others", async (t) => {
    setServerTime(inCampaign)
    const { port } = await socketServer(t)
    const a = await newPlayer(), b = await newPlayer(), c = await newPlayer(), d = await newPlayer()
    const key = await createLounge(a)

    const host = await enterLounge(port, a, key, "A")
    t.after(() => host.client.close())
    assert.equal(host.welcome[1][1].length, 1)
    host.client.send([0, [3, [1]]]) // a guest's client readies itself on entering; a host's never does (CO-9), so this is harmless
    assert.deepEqual(await host.client.next(), [1, [0, a.viewerId, [1]]], "StateChanged")

    // B finds it in the list
    const list = await gameRequest("lounge/get_list", { viewer_id: b.viewerId, use_case: 1 })
    const listed = list.data.lounge_list.find((l: any) => l.lounge_id === key.lounge_id)
    assert.ok(listed, "listed")
    assert.equal(listed.advice, key.advice)
    assert.equal(listed.establisher_name, "A")
    assert.equal(listed.mates, 1)
    assert.equal(listed.raising_state, 2)
    const own = await gameRequest("lounge/get_list", { viewer_id: a.viewerId, use_case: 1 })
    assert.equal(own.data.lounge_list.some((l: any) => l.lounge_id === key.lounge_id), false, "not to its host")

    const guestB = await enterLounge(port, b, { lounge_id: listed.lounge_id, advice: listed.advice, establisher_viewer_id: listed.establisher_viewer_id }, "B")
    t.after(() => guestB.client.close())
    assert.deepEqual(guestB.welcome[1][1].map((m: any) => m.viewerId), [a.viewerId, b.viewerId], "the host first")
    assert.deepEqual(guestB.welcome[1][1][0].readyState, [1])
    const matesForA = await host.client.next()
    assert.equal(matesForA[1][0], 4, "Mates to the host")

    // C types the number
    const found = await gameRequest("lounge/search", { viewer_id: c.viewerId, use_case: 1, lounge_number: guestB.lounge_number })
    assert.deepEqual(found.data, { lounge_exists: true, advice: key.advice, establisher_follow: found.data.establisher_follow, establisher_viewer_id: a.viewerId, lounge_id: key.lounge_id })
    assert.deepEqual((await gameRequest("lounge/search", { viewer_id: c.viewerId, use_case: 1, lounge_number: "000000x" })).data, { lounge_exists: false }, "an unknown number")
    const guestC = await enterLounge(port, c, key, "C")
    t.after(() => guestC.client.close())
    await host.client.next() // Mates
    await guestB.client.next()

    // full now: no fourth player, in the list or by select
    assert.equal((await gameRequest("lounge/get_list", { viewer_id: d.viewerId, use_case: 1 })).data.lounge_list.some((l: any) => l.lounge_id === key.lounge_id), false)
    assert.equal((await gameRequest("lounge/select", { viewer_id: d.viewerId, use_case: 1, ...key, accepted_type: 1, campaign_id: campaignId })).data.raising_state, 98, "Filled")
    assert.equal((await gameRequest("lounge/select", { viewer_id: d.viewerId, use_case: 1, ...key, advice: "wrong" })).data.raising_state, 99, "wrong advice")

    // Go with C not ready: not enough
    guestB.client.send([0, [3, [1]]])
    for (const p of [host, guestB, guestC]) assert.deepEqual(await p.client.next(), [1, [0, b.viewerId, [1]]])
    host.client.send([0, [4]])
    assert.deepEqual(await host.client.next(), [1, [6, [1]]], "StartError(NOT_ENOUGH)")
    guestB.client.send([0, [4]]) // a guest's Go is ignored
    assert.ok(await guestB.client.silent(150))

    guestC.client.send([0, [3, [1]]])
    for (const p of [host, guestB, guestC]) await p.client.next()
    host.client.send([0, [4]])
    for (const p of [host, guestB, guestC]) assert.deepEqual(await p.client.next(), [1, [5]], "Start")

    const { getPlayerMultiSpecialExchangeCampaignSync, getPlayerReceivableMailListSync } = await import("../src/data/wdfpData")
    for (const p of [a, b, c]) {
        assert.deepEqual(getPlayerMultiSpecialExchangeCampaignSync(p.playerId, campaignId), { campaignId, status: 2, ticketItemId }, "decided")
    }
    // after the Go: restore sends the client to the draw, and nobody gets in any more
    assert.equal((await gameRequest("lounge/restore", { viewer_id: b.viewerId, use_case: 1, ...key })).data_headers.result_code, 4902)
    assert.equal((await gameRequest("lounge/restore", { viewer_id: d.viewerId, use_case: 1, ...key })).data.raising_state, 95, "not a member")

    // each draws and exchanges
    for (const p of [a, b]) {
        const drawn = await gameRequest("multi_special_exchange/multi_draw_ticket", { viewer_id: p.viewerId, campaign_id: campaignId })
        assert.deepEqual(drawn.data.multi_special_exchange_campaign_list, [{ campaign_id: campaignId, status: 3, ticket_item_id: ticketItemId }])
    }
    const exchanged = await gameRequest("multi_special_exchange/exchange_character", { viewer_id: a.viewerId, campaign_id: campaignId, character_id: characterId, ticket_item_id: ticketItemId })
    assert.equal(exchanged.data.multi_special_exchange_campaign_list[0].status, 4)
    const mails = (p: Player) => getPlayerReceivableMailListSync(p.playerId, inCampaign, 0, 100).filter(m => m.reasonId === 30001 || m.reasonId === 30002)
    assert.deepEqual(mails(a), [], "no random bonus units after a lounge: the mates' picks come instead")
    for (const p of [b, c]) {
        assert.deepEqual(mails(p).map(m => [m.typeId, m.reasonId]), [[characterId, 30001]], "A's pick reaches each mate")
    }
})

test("the host leaving disbands the lounge; refusals over HTTP", async (t) => {
    setServerTime(inCampaign)
    const { port } = await socketServer(t)
    const a = await newPlayer(), b = await newPlayer()
    const key = await createLounge(a)
    const host = await enterLounge(port, a, key, "A")
    const guest = await enterLounge(port, b, key, "B")
    t.after(() => guest.client.close())
    await host.client.next() // Mates

    host.client.send([0, [6]]) // Bye
    host.client.close()
    assert.deepEqual(await guest.client.next(), [1, [1, "multibattle_room_dismissed"]], "Disbanded")
    assert.equal((await gameRequest("lounge/restore", { viewer_id: b.viewerId, use_case: 1, ...key })).data.raising_state, 99, "gone")
    assert.equal((await gameRequest("lounge/prepare", { viewer_id: a.viewerId, use_case: 1, ...key })).data_headers.result_code, 4511)

    // outside the campaign
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    assert.equal((await gameRequest("lounge/create", { viewer_id: a.viewerId, use_case: 1, campaign_id: campaignId })).data_headers.result_code, 4513)

    // a ticket already drawn alone
    setServerTime(inCampaign)
    await gameRequest("multi_special_exchange/single_draw_ticket", { viewer_id: b.viewerId, campaign_id: campaignId })
    assert.equal((await gameRequest("lounge/create", { viewer_id: b.viewerId, use_case: 1, campaign_id: campaignId })).data_headers.result_code, 4902)
    // and joining someone else's lounge with it: Spent (the guest's handler knows it)
    const another = await createLounge(a)
    assert.equal((await gameRequest("lounge/select", { viewer_id: b.viewerId, use_case: 1, ...another, accepted_type: 1, campaign_id: campaignId })).data.raising_state, 97, "Spent")

    // a handshake without select is refused
    const other = await createLounge(a)
    const client = new Client()
    await client.connect(port)
    t.after(() => client.close())
    client.send({ reconnected: 0, socklet: "multi_special_exchange_socklet", viewerId: b.viewerId, useCase: 1, loungeId: other.lounge_id, advice: other.advice, establisherViewerId: a.viewerId })
    assert.deepEqual(await client.next(), [1, "multibattle_room_not_found"])
})
