// The Start Dash bundle is always open (owner decision 2026-11-18, src/lib/startDash.ts): a new player gets it even on a
// server date before the campaign's master start (2022-06-12), still for 7 days from that login. (Before the global
// launch, 2021-07-24, no unit portal is open, so there is nothing to trade the ticket for and no entry is made.)
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    utils = await import("../src/utils")
})
afterEach(() => utils.setServerTime(null))
after(async () => { await cleanup() })

test("a new player gets the Start Dash bundle on a date before the campaign's master start", async () => {
    utils.setServerTime(new Date("2021-09-01T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const response = await fastify.inject({
        method: "POST", url: "/latest/api/index.php/load", headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, viewer_id: player.viewerId, access_token: player.zat })
    })
    assert.equal(response.statusCode, 200, response.body)
    const entry = (decodeGameBody(response.body).data.start_dash_exchange_campaign_list as any[]).find(e => e.campaign_id === 1)
    assert.ok(entry, "listed")
    assert.equal(entry.status, 1)
    assert.equal(entry.period_start_time, Date.parse("2021-09-01T12:00:00Z") / 1000)
    assert.equal(entry.period_end_time - entry.period_start_time, 7 * 24 * 60 * 60)
})
