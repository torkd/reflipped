// Master table dates (gacha and shop periods) are Japan time, as the client reads them (FIX-2).

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
// app code opens the test database when first imported, so import it only after createTestServer()
let utils: typeof import("../src/utils")
let assets: typeof import("../src/lib/assets")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    utils = await import("../src/utils")
    assets = await import("../src/lib/assets")
})

afterEach(() => {
    utils.setServerTime(null)
})

after(async () => {
    await cleanup()
})

test("a master date is read as Japan time", () => {
    assert.equal(utils.masterDate("2024-06-25 14:00:00").toISOString(), "2024-06-25T05:00:00.000Z")
    assert.equal(utils.masterDate("2025-01-01 03:00:00").toISOString(), "2024-12-31T18:00:00.000Z")
})

test("a gacha opens and closes at its Japan-time dates", () => {
    // gacha 184 runs from "2024-12-31 14:00:00" to "2025-01-07 13:59:59", Japan time
    const isOpen = (time: string) => assets.getOpenGachaIdsSync(new Date(time)).includes("184")
    assert.equal(isOpen("2024-12-31T04:59:59Z"), false)
    assert.equal(isOpen("2024-12-31T05:00:00Z"), true)
    assert.equal(isOpen("2025-01-07T04:59:59Z"), true)
    assert.equal(isOpen("2025-01-07T05:00:00Z"), false)
})

test("portals are open at the default server clock", () => {
    const open = assets.getOpenGachaIdsSync(utils.parseServerTime(utils.DEFAULT_SERVER_TIME)!)
    assert.deepEqual(open.sort(), ["184", "185", "5038"])
})

test("the admin site gives the gacha period range in UTC", async () => {
    // the last gacha closes at "2025-01-31 13:59:59" Japan time, 04:59:59 UTC
    const response = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2025-01-31T05:00:00" } })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().message, /2018-10-03 06:00:00 and 2025-01-31 04:59:59 \(UTC\)/)
    const open = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time: "2025-01-31T04:59:59" } })
    assert.equal(open.statusCode, 302)
})

test("a shop item is on sale from its Japan-time start", async () => {
    const player = await createTestPlayer(fastify)
    let apiCount = 1
    // event item shop of event type 10, id 1: on sale from "2023-02-09 14:00:00", Japan time
    const salesList = async (): Promise<any[]> => {
        const response = await fastify.inject({
            method: "POST",
            url: "/latest/api/index.php/shop/get_sales_list",
            headers: gameHeaders(player.udid),
            payload: encodeGameBody({
                viewer_id: player.viewerId,
                api_count: apiCount++,
                boss_coin_shop_category_ids: [],
                equipment_enhancement_shop_category_ids: [],
                shop_types: [],
                event_list: [{ event_type: 10, event_ids: [1] }],
                browse_treasure_flag: false
            })
        })
        assert.equal(response.statusCode, 200)
        return decodeGameBody(response.body).data.sales_list
    }
    utils.setServerTime(new Date("2023-02-09T04:59:59Z"))
    assert.equal((await salesList()).length, 0)
    utils.setServerTime(new Date("2023-02-09T05:00:00Z"))
    assert.ok((await salesList()).some(item => item.shop_item_id === 1 && item.shop_type === 4))
})
