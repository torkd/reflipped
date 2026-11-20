// FT-89: the Bundle Marketplace (shop type 3, assets/special_pack_shop.json from shop/special_pack_shop). Its bundles are
// listed by shop/get_sales_list and sold by shop/buy for any beads, free ones first (the original took paid beads only).
// At 2025-01-03 the Beginner's Bundle (200001, 400 beads, once ever) and the Monthly Fire Ether Bundle (200016, 300,
// once a month) are on sale; the 2022 Fire Unit Upgrade Bundle (200003) closed on 2023-01-10.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const SPECIAL_PACK = 3

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    utils = await import("../src/utils")
})
afterEach(() => utils.setServerTime(null))
after(async () => { await cleanup() })

type Player = TestPlayer & { playerId: number }

async function newPlayer(free: number, paid: number): Promise<Player> {
    utils.setServerTime(new Date("2025-01-03T03:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id: playerId, freeVmoney: free, vmoney: paid })
    return { ...player, playerId }
}

async function post(player: Player, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({ method: "POST", url: `${apiPrefix}/${route}`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId }) })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null }
}

const salesList = async (player: Player) => (await post(player, "shop/get_sales_list", {
    boss_coin_shop_category_ids: [], shop_types: [SPECIAL_PACK], event_list: [], browse_treasure_flag: false
})).body.data.sales_list as { shop_item_id: number }[]
const buy = (player: Player, id: number) => post(player, "shop/buy", { shop_type: SPECIAL_PACK, shop_item_id: id, number: 1, api_count: 1 })

test("bundle marketplace: lists the bundles on sale", async () => {
    const ids = (await salesList(await newPlayer(0, 0))).map(entry => entry.shop_item_id)
    assert.ok(ids.includes(200001) && ids.includes(200016) && ids.includes(200027))
    assert.ok(!ids.includes(200003), "a closed bundle isn't listed")
})

test("bundle marketplace: any beads, free first; the items arrive; once-ever and monthly limits hold", async () => {
    const player = await newPlayer(100, 1000)
    const before101 = data.getPlayerItemSync(player.playerId, 101) ?? 0
    const bought = await buy(player, 200001)
    assert.equal(bought.status, 200)
    assert.deepEqual([bought.body.data.user_info.free_vmoney, bought.body.data.user_info.vmoney], [0, 700])
    assert.equal(data.getPlayerItemSync(player.playerId, 101), before101 + 10)
    assert.equal((await buy(player, 200001)).status, 400, "the Beginner's Bundle sells once")

    assert.equal((await buy(player, 200016)).status, 200)
    assert.equal((await buy(player, 200016)).status, 400, "once a month")
    utils.setServerTime(new Date("2025-02-03T03:00:00Z"))
    assert.equal((await buy(player, 200016)).status, 200, "again the next month")
    assert.equal(data.getPlayerSync(player.playerId)!.vmoney, 100)
})

test("bundle marketplace: not enough beads takes nothing", async () => {
    const player = await newPlayer(100, 100)
    assert.equal((await buy(player, 200001)).status, 400)
    const after = data.getPlayerSync(player.playerId)!
    assert.deepEqual([after.freeVmoney, after.vmoney], [100, 100])
})
