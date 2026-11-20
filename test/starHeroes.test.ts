// Star Heroes portals (assets/star_heroes_gacha.json): one 10-pull per account for 1500 beads (any beads, free first),
// with one pull of it a 5-star unit; no other draw kind on them, and their draw kind on no other portal.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import characters from "../assets/character.json";

const apiPrefix = "/latest/api/index.php"
const STAR_HEROES = 800008
const UNIT_PORTAL = 184

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

after(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    await cleanup()
})

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2024-03-01T05:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

async function exec(player: TestPlayer, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/gacha/exec`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ gacha_id: STAR_HEROES, type: 7, payment_type: 2, number_of_exec: 1, ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const rarity = (id: number) => (characters as Record<string, { rarity: number }>)[String(id)]?.rarity

test("the 10-pull gives 10 units with a 5-star among them, once, for 1500 beads, free ones first", async () => {
    for (let run = 0; run < 5; run++) {
        const player = await newPlayer()
        data.updatePlayerSync({ id: player.playerId, freeVmoney: 1000, vmoney: 2000 })
        const drawn = await exec(player, { api_count: 1, payment_type: run % 2 === 0 ? 2 : 1 })
        assert.equal(drawn.status, 200, JSON.stringify(drawn.body))
        const ids = drawn.body.data.draw.map((entry: any) => entry.character_id)
        assert.equal(ids.length, 10)
        assert.ok(ids.some((id: number) => rarity(id) === 5), `a 5-star among ${ids.map((id: number) => rarity(id))}`)
        assert.deepEqual(drawn.body.data.user_info, { free_vmoney: 0, vmoney: 1500, star_crumb: 20 }, "1000 free, then 500 paid; 20 Star Slivers for 1500 beads")
        assert.equal(drawn.body.data.gacha_info_list[0].is_account_first, false)
        assert.equal((await exec(player, { api_count: 2 })).status, 400, "once per account")
    }
})

test("not enough beads is refused and leaves the pull", async () => {
    const player = await newPlayer()
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 100, vmoney: 0 })
    assert.equal((await exec(player, { api_count: 1 })).status, 400)
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 1500, vmoney: 0 })
    assert.equal((await exec(player, { api_count: 2 })).status, 200)
})

test("other draw kinds on a Star Heroes portal, and its draw kind elsewhere, are refused", async () => {
    const player = await newPlayer()
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 10000, vmoney: 0 })
    for (const type of [1, 2, 5]) {
        assert.equal((await exec(player, { type, payment_type: 1, api_count: type })).status, 400, `kind ${type}`)
    }
    assert.equal((await exec(player, { gacha_id: UNIT_PORTAL, api_count: 9 })).status, 400, "kind 7 on a regular portal")
    const { getOpenGachaIdsSync } = await import("../src/lib/assets")
    assert.equal(getOpenGachaIdsSync(new Date("2024-03-01T05:00:00Z")).includes(String(STAR_HEROES)), false, "not listed as a regular portal")
})
