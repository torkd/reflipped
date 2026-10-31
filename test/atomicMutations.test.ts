// SEC-7: multi-step mutations run in one transaction (src/lib/atomic.ts) and a retried request gets the reply it
// already had instead of running again (src/lib/replayGuard.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let player: TestPlayer
let playerId: number
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    player = await createTestPlayer(fastify)

    // the data layer opens the test database, so import it only after createTestServer()
    data = await import("../src/data/wdfpData")
    const session = await data.getSession(String(player.viewerId))
    playerId = (await data.getAccountPlayers(session!.accountId))[0]
})

after(async () => {
    await cleanup()
})

function beads(): number {
    return data.getPlayerSync(playerId)!.freeVmoney
}

function setBeads(amount: number) {
    data.updatePlayerSync({ id: playerId, freeVmoney: amount })
}

test("runInTransactionSync rolls back on a throw and on shouldRollback, and nests as a savepoint", () => {
    setBeads(100)

    assert.throws(() => data.runInTransactionSync(() => {
        setBeads(1)
        throw new Error("mid-way failure")
    }), /mid-way failure/)
    assert.equal(beads(), 100, "rolled back after a throw")

    const result = data.runInTransactionSync(() => { setBeads(2); return "rejected" }, result => result === "rejected")
    assert.equal(result, "rejected", "the result is still returned")
    assert.equal(beads(), 100, "rolled back by shouldRollback")

    data.runInTransactionSync(() => {
        setBeads(3)
        data.runInTransactionSync(() => setBeads(4), () => true)
        assert.equal(beads(), 3, "the inner rollback undoes only the inner write")
    })
    assert.equal(beads(), 3, "the outer write commits")
})

test("atomicHandler commits a 2xx reply and rolls back an error reply or a throw", async () => {
    const { atomicHandler } = await import("../src/lib/atomic")
    const app = Fastify()
    app.post("/ok", atomicHandler((_request, reply) => { setBeads(10); return reply.send({}) }))
    app.post("/rejected", atomicHandler((_request, reply) => { setBeads(11); return reply.status(400).send({}) }))
    app.post("/throws", atomicHandler(() => { setBeads(12); throw new Error("handler bug") }))

    setBeads(0)
    assert.equal((await app.inject({ method: "POST", url: "/ok" })).statusCode, 200)
    assert.equal(beads(), 10)
    assert.equal((await app.inject({ method: "POST", url: "/rejected" })).statusCode, 400)
    assert.equal(beads(), 10, "a 400 after a write leaves nothing behind")
    assert.equal((await app.inject({ method: "POST", url: "/throws" })).statusCode, 500)
    assert.equal(beads(), 10, "a throw after a write leaves nothing behind")
    await app.close()
})

async function buy(apiCount: number, retryCount?: number) {
    const body: Record<string, unknown> = { shop_type: 2, api_count: apiCount, shop_item_id: 200032, number: 1, viewer_id: player.viewerId }
    if (retryCount !== undefined) body.retry_count = retryCount
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/shop/buy`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody(body)
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body)
}

test("a retried purchase gets the first reply and is charged once", async () => {
    data.updatePlayerSync({ id: playerId, freeVmoney: 500000, freeMana: 99999999 })
    const before = data.getPlayerSync(playerId)!

    const first = await buy(64)
    const afterFirst = data.getPlayerSync(playerId)!
    assert.notDeepEqual(afterFirst, before, "the purchase changed the player")

    const retry = await buy(64, 1)
    assert.deepEqual(retry, first, "the retry gets the same reply")
    assert.deepEqual(data.getPlayerSync(playerId), afterFirst, "the retry is not charged again")

    // the next request (api_count raised) and a repeat without retry_count both run
    await buy(65)
    const afterSecond = data.getPlayerSync(playerId)!
    assert.notDeepEqual(afterSecond, afterFirst, "a new purchase runs")
    await buy(65)
    assert.notDeepEqual(data.getPlayerSync(playerId), afterSecond, "a request without retry_count is never a replay")
})

test("a retry that doesn't match the kept request runs normally", async () => {
    await buy(70)
    const afterFirst = data.getPlayerSync(playerId)!
    await buy(71, 1)
    assert.notDeepEqual(data.getPlayerSync(playerId), afterFirst, "a retry of a request the server never answered runs")
})
