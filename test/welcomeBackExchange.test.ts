// FT-65: the Star Sliver Exchange's Welcome Back rows (comebackGachaId set) follow the player's own Welcome Back
// Portal period (FT-62, src/lib/comebackGacha.ts) instead of their master period: open while that portal is the
// player's open one, 3006 (ExchangePeriodError) otherwise. A player back on 2025-03-05 after 60+ days gets portal
// 700004 (the newest lineup then): exchange 879 (5-star unit 111004, 600 Slivers) belongs to it, 475 (the same unit)
// to portal 700000.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const DAY_MS = 24 * 60 * 60 * 1000

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    utils = await import("../src/utils")
})

after(async () => {
    utils.setServerTime(null)
    await cleanup?.()
})

interface Player extends TestPlayer { id: number }

async function newPlayer(time: string): Promise<Player> {
    utils.setServerTime(new Date(time))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const id = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id, starCrumb: 5000 })
    return { ...player, id }
}

async function post(player: Player, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null }
}

/** /load at `time` after the player's last login at `previous` (records a return after 60+ days). */
async function load(player: Player, time: string, previous: string) {
    data.updatePlayerSync({ id: player.id, lastLoginTime: new Date(previous) })
    utils.setServerTime(new Date(time))
    assert.equal((await post(player, "load", { access_token: player.zat })).status, 200)
}

async function exchange(player: Player, time: string, exchangeId: number) {
    utils.setServerTime(new Date(time))
    return post(player, "exchange/star_crumb", { exchange_id: exchangeId })
}

const resultCode = (reply: Awaited<ReturnType<typeof exchange>>) => reply.body?.data_headers.result_code
const starCrumb = (player: Player) => data.getPlayerSync(player.id)!.starCrumb

test("welcome back exchange: the returning player's portal rows are open for its 3 days", async () => {
    const player = await newPlayer("2025-01-01T12:00:00Z")
    await load(player, "2025-03-05T12:00:00Z", "2025-01-01T12:00:00Z")

    // another portal's row stays closed
    const other = await exchange(player, "2025-03-06T12:00:00Z", 475)
    assert.equal(other.status, 200)
    assert.equal(resultCode(other), 3006)
    assert.equal(starCrumb(player), 5000)

    // the player's portal's row trades: 600 Slivers for the unit
    const taken = await exchange(player, "2025-03-06T12:00:00Z", 879)
    assert.equal(taken.status, 200)
    assert.equal(resultCode(taken), 1)
    assert.equal(taken.body.data.user_info.star_crumb, 4400)
    assert.notEqual(data.getPlayerCharacterSync(player.id, 111004), null)
    // owned now: the same unit isn't offered again
    assert.equal((await exchange(player, "2025-03-06T12:00:00Z", 879)).status, 400)
})

test("welcome back exchange: closed after the 3 days, and to a player who didn't return", async () => {
    const returning = await newPlayer("2025-01-01T12:00:00Z")
    await load(returning, "2025-03-05T12:00:00Z", "2025-01-01T12:00:00Z")
    const end = Date.parse("2025-03-05T12:00:00Z") + 3 * DAY_MS
    // the period's last second is in it (880: unit 111005 of the same portal); a second later it's closed
    assert.equal(resultCode(await exchange(returning, new Date(end + 1000).toISOString(), 880)), 3006)
    assert.equal(resultCode(await exchange(returning, new Date(end).toISOString(), 880)), 1)

    const stayed = await newPlayer("2025-01-01T12:00:00Z")
    await load(stayed, "2025-02-20T12:00:00Z", "2025-01-01T12:00:00Z")
    assert.equal(resultCode(await exchange(stayed, "2025-02-20T13:00:00Z", 879)), 3006)
    assert.equal(starCrumb(stayed), 5000)
})
