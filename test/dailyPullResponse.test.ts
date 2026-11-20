import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders } from "./helpers"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
})
after(async () => { await cleanup() })

test("draw replies retain each portal's daily allowance until its daily pull", async () => {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, freeVmoney: 500 })
    data.givePlayerItemSync(playerId, 999003, 2)
    data.givePlayerItemSync(playerId, 999005, 2)
    let apiCount = 0
    async function draw(gachaId: number, type: number, paymentType: number) {
        const response = await fastify.inject({
            method: "POST", url: "/latest/api/index.php/gacha/exec", headers: gameHeaders(player.udid),
            payload: encodeGameBody({ gacha_id: gachaId, type, payment_type: paymentType, number_of_exec: 1, api_count: ++apiCount, viewer_id: player.viewerId })
        })
        assert.equal(response.statusCode, 200, response.body)
        return decodeGameBody(response.body).data.gacha_info_list[0].is_daily_first
    }
    assert.equal(await draw(184, 10, 3), true)
    assert.equal(await draw(5038, 12, 3), true)
    assert.equal(await draw(184, 5, 1), false)
    assert.equal(await draw(184, 10, 3), false)
    assert.equal(await draw(5038, 12, 3), true)
})
