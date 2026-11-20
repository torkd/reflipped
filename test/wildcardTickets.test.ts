// FIX-9: the wildcard tickets (Summoning Tickets 999001/999003, the 4 & 5-Star Portal Ticket 999008, the Armament
// Tickets 999004/999005) draw only on the portals whose gacha/gacha row allows them (assets/gacha_wildcard_tickets.json),
// as the client offers them: no ticket-only portal, no Star Heroes portal and none of the early bead portals.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const CHARACTER = 0 // GachaType.CHARACTER
const WEAPON = 1 // GachaType.WEAPON

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let ticketDraw: typeof import("../src/lib/gachaDraws").ticketDraw

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    ticketDraw = (await import("../src/lib/gachaDraws")).ticketDraw
})

after(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    await cleanup()
})

const unitKinds = [9, 10, 20]
const armamentKinds = [12, 13]

test("a unit portal that allows them takes the unit wildcard tickets, not the armament ones", () => {
    for (const kind of unitKinds) assert.notEqual(ticketDraw(184, CHARACTER, kind), null, `kind ${kind}`)
    for (const kind of armamentKinds) assert.equal(ticketDraw(184, CHARACTER, kind), null, `kind ${kind}`)
})

test("an armament portal that allows them takes the armament wildcard tickets", () => {
    for (const kind of armamentKinds) assert.notEqual(ticketDraw(5038, WEAPON, kind), null, `kind ${kind}`)
    for (const kind of unitKinds) assert.equal(ticketDraw(5038, WEAPON, kind), null, `kind ${kind}`)
})

test("portals whose row doesn't allow them refuse every wildcard ticket, but still take their own", () => {
    const refusing: [number, number, string][] = [
        [1, CHARACTER, "the Launch Gala Portal (an early bead portal)"],
        [3, WEAPON, "the first Armament Portal"],
        [57, CHARACTER, "the New Year's Grab Bag (TicketOnly)"],
        [2, CHARACTER, "the 4 & 5-Star Exclusive Portal (OneTimeTicketOnly)"],
        [9, CHARACTER, "the 2022 Grab Bag Portal (TenTimesTicketOnly)"],
        [800000, CHARACTER, "a Star Heroes portal"]
    ]
    for (const [gachaId, type, name] of refusing)
        for (const kind of [...unitKinds, ...armamentKinds]) assert.equal(ticketDraw(gachaId, type, kind), null, `${name}, kind ${kind}`)
    assert.deepEqual(ticketDraw(1, CHARACTER, 3), { itemId: 20001, pulls: 1, guaranteed: false }, "its own single ticket")
    assert.deepEqual(ticketDraw(57, CHARACTER, 4), { itemId: 20064, pulls: 10, guaranteed: false }, "the Grab Bag's 10-pull ticket")
})

async function exec(player: TestPlayer, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/gacha/exec`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ payment_type: 3, number_of_exec: 1, ...body, viewer_id: player.viewerId })
    })
    return response.statusCode
}

test("Summoning Tickets on the Grab Bag are refused and not spent", async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2023-03-20T03:00:00Z"))
    const player = await createTestPlayer(fastify)
    const playerId = data.getViewerPlayerIdSync(player.viewerId)!
    data.givePlayerItemSync(playerId, 999001, 1)
    data.givePlayerItemSync(playerId, 999003, 1)
    assert.equal(await exec(player, { gacha_id: 57, type: 9, api_count: 1 }), 400)
    assert.equal(await exec(player, { gacha_id: 57, type: 10, api_count: 2 }), 400)
    assert.equal(data.getPlayerItemSync(playerId, 999001), 1)
    assert.equal(data.getPlayerItemSync(playerId, 999003), 1)
})
