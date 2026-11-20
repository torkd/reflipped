// Free pull campaigns (src/lib/gachaCampaigns.ts): /load lists every portal of an open campaign with a pull left, as
// the original did (docs/routes/load.md), so the client shows the free pull button before the first pull; a free pull
// works only while its campaign is open, once a day.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
// campaign 16, "2.5 Year Flipperversary Free Daily 10-Pulls": 2024-01-17 14:00 to 02-01 04:59:59 Japan time, portals 123, 124
const CAMPAIGN = 16
const PORTAL = 124

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    await cleanup()
})

async function at(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function load(player: TestPlayer): Promise<{ campaign_id: number, gacha_id: number, count: number }[]> {
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/load`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data.gacha_campaign_list
}

async function freePull(player: TestPlayer, apiCount: number) {
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/gacha/exec`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ gacha_id: PORTAL, type: 8, payment_type: 4, number_of_exec: 1, api_count: apiCount, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const entry = (list: { campaign_id: number, gacha_id: number, count: number }[], gachaId: number) =>
    list.find(row => row.campaign_id === CAMPAIGN && row.gacha_id === gachaId)

test("an open campaign's portals are listed with a pull left before the first pull", async () => {
    await at("2024-01-27T05:00:00Z")
    const player = await createTestPlayer(fastify)
    const list = await load(player)
    assert.deepEqual(entry(list, PORTAL), { campaign_id: CAMPAIGN, gacha_id: PORTAL, count: 1 })
    assert.equal(entry(list, 123)?.count, 1)
})

test("the free pull gives the campaign's 10 units once, and /load then shows none left", async () => {
    await at("2024-01-27T05:00:00Z")
    const player = await createTestPlayer(fastify)
    await load(player)
    const drawn = await freePull(player, 1)
    assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
    assert.equal(drawn.body.data.draw.length, 10)
    assert.equal(entry(await load(player), PORTAL)?.count, 0, "the stored row, not a second free one")
    assert.equal((await freePull(player, 1)).status, 400, "once a day")
})

test("outside the campaign nothing is added and a free pull is refused", async () => {
    // campaign 16 ends at 04:59:59 Japan time on 1 February 2024, its portal 124 at 13:59:59 the same day
    await at("2024-01-31T23:00:00Z")
    const player = await createTestPlayer(fastify)
    assert.equal(entry(await load(player), PORTAL), undefined)
    const drawn = await freePull(player, 1)
    assert.equal(drawn.status, 400)
    assert.match(drawn.body.message, /isn't open/)

    // once the portal closed too, the client's "out of period" result code (FT-52)
    await at("2024-03-10T05:00:00Z")
    const late = await freePull(player, 2)
    assert.equal(late.status, 200)
    assert.equal(late.body.data_headers.result_code, 1351)
})

test("a campaign portal the server can't draw isn't offered", async () => {
    // campaign 19 (2024-05-28 to 07-25) covers 157, 155 and the Welcome Back Portal 700004, which isn't converted
    await at("2024-06-22T05:00:00Z")
    const player = await createTestPlayer(fastify)
    const list = (await load(player)).filter(row => row.campaign_id === 19)
    assert.deepEqual(list.map(row => row.gacha_id).sort(), [155, 157])
})
