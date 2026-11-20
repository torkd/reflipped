// Paid-only bead costs take any beads, free ones first (src/lib/beads.ts). The portals' daily discounted pull (draw kind
// 5: 50 beads on unit portals) works with free beads whichever payment type the client sends (1 from the patched AIR
// shell, 2 from the original app), once a day; other draws don't use up the day's discounted pull.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const UNIT_PORTAL = 184

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

async function draw(player: TestPlayer, type: number, paymentType: number) {
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/gacha/exec`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ gacha_id: UNIT_PORTAL, type, payment_type: paymentType, number_of_exec: 1, api_count: 1, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const beads = (playerId: number) => { const p = data.getPlayerSync(playerId)!; return [p.freeVmoney, p.vmoney] }

test("payBeads takes free beads first, then paid ones", async () => {
    const { payBeads } = await import("../src/lib/beads")
    assert.deepEqual(payBeads({ free: 100, paid: 0 }, 50), { free: 50, paid: 0 })
    assert.deepEqual(payBeads({ free: 30, paid: 40 }, 50), { free: 0, paid: 20 })
    assert.deepEqual(payBeads({ free: 0, paid: 60 }, 50), { free: 0, paid: 10 })
    assert.equal(payBeads({ free: 20, paid: 20 }, 50), null)
})

test("the daily discounted pull takes free beads, whichever payment type the client sends, once a day", async () => {
    for (const paymentType of [1, 2]) {
        const player = await newPlayer()
        data.updatePlayerSync({ id: player.playerId, freeVmoney: 120, vmoney: 0 })
        const first = await draw(player, 5, paymentType)
        assert.equal(first.status, 200, JSON.stringify(first.body))
        assert.deepEqual(beads(player.playerId), [70, 0], "50 free beads")
        assert.equal((await draw(player, 5, paymentType)).status, 400, "once a day")
    }
})

test("a regular pull leaves the day's discounted pull available", async () => {
    const player = await newPlayer()
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 100, vmoney: 100 })
    assert.equal((await draw(player, 1, 1)).status, 200)
    assert.deepEqual(beads(player.playerId), [0, 50], "150: 100 free, then 50 paid")
    assert.equal((await draw(player, 5, 2)).status, 200, "the discounted pull is still there")
    assert.deepEqual(beads(player.playerId), [0, 0])
    assert.equal((await draw(player, 1, 1)).status, 400, "no beads left")
})

test("the once-per-account 10-pull isn't available (its portals aren't converted)", async () => {
    const player = await newPlayer()
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 5000 })
    assert.equal((await draw(player, 7, 2)).status, 400)
})
