// FT-62: the Welcome Back Portals (assets/comeback_gacha.json, src/lib/comebackGacha.ts). A player back after 60 days
// or more (the comeback present's rule, src/lib/loginBonus.ts) gets the newest lineup for 3 days from that login: /load
// sends its period in gacha_info_list, and gacha/exec draws on it only then. The test server runs the frozen historical
// clock, so master dates apply as they are: 700000 opens 2023-07-25, 700001 2023-11-06, ... 700004 2024-05-07.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const DAY_MS = 24 * 60 * 60 * 1000

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let bonus: typeof import("../src/lib/loginBonus")
let comeback: typeof import("../src/lib/comebackGacha")
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    bonus = await import("../src/lib/loginBonus")
    comeback = await import("../src/lib/comebackGacha")
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
    return { ...player, id: (await data.getAccountPlayers(session!.accountId))[0] }
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

/** /load at `time` after the player's last login at `previous`. */
async function load(player: Player, time: string, previous: string) {
    data.updatePlayerSync({ id: player.id, lastLoginTime: new Date(previous) })
    utils.setServerTime(new Date(time))
    const reply = await post(player, "load", { access_token: player.zat })
    assert.equal(reply.status, 200)
    return reply.body.data.gacha_info_list as { gacha_id: number, is_account_first: boolean, comeback_campaign?: { period_start_time: number, period_end_time: number } }[]
}

const comebackEntries = (list: Awaited<ReturnType<typeof load>>) => list.filter(entry => entry.gacha_id >= 700000 && entry.gacha_id <= 700004)

async function draw(player: Player, time: string, gachaId: number, type = 1) {
    utils.setServerTime(new Date(time))
    data.updatePlayerSync({ id: player.id, freeVmoney: 3000, vmoney: 0 })
    return post(player, "gacha/exec", { gacha_id: gachaId, type, payment_type: 1, number_of_exec: 1, api_count: 2 })
}

test("welcome back portal: a returning player gets the newest lineup for 3 days from the returning login", async () => {
    const player = await newPlayer("2025-01-01T12:00:00Z")
    const list = await load(player, "2025-03-05T12:00:00Z", "2025-01-01T12:00:00Z")
    const returned = Date.parse("2025-03-05T12:00:00Z") / 1000
    assert.deepEqual(comebackEntries(list), [{
        gacha_id: 700004, is_daily_first: true, is_account_first: true, gacha_exchange_point: 0,
        comeback_campaign: { period_start_time: returned, period_end_time: returned + 3 * 24 * 60 * 60 }
    }])

    // drawable now, with the period in the reply's entry; the other lineups aren't
    const drawn = await draw(player, "2025-03-06T12:00:00Z", 700004)
    assert.equal(drawn.status, 200)
    assert.equal(drawn.body.data.draw.length, 1)
    assert.deepEqual(drawn.body.data.gacha_info_list[0].comeback_campaign, { period_start_time: returned, period_end_time: returned + 3 * 24 * 60 * 60 })
    assert.equal((await draw(player, "2025-03-06T12:00:00Z", 700003)).status, 400)
    // a 10-pull works; it has no daily discounted pull, which would cost nothing
    assert.equal((await draw(player, "2025-03-06T12:00:00Z", 700004, 2)).status, 200)
    assert.equal((await draw(player, "2025-03-06T12:00:00Z", 700004, 5)).status, 400)

    // a relaunch keeps the same period (the return isn't a new one)
    const relaunch = await load(player, "2025-03-07T12:00:00Z", "2025-03-06T12:00:00Z")
    assert.equal(comebackEntries(relaunch)[0].comeback_campaign?.period_start_time, returned)
    assert.equal(comebackEntries(relaunch)[0].is_account_first, false, "the drawn entry, with the period added")

    // the period's last second is in it; one second later the portal is gone
    const end = new Date((returned + 3 * 24 * 60 * 60) * 1000)
    assert.equal((await draw(player, end.toISOString(), 700004)).status, 200)
    assert.equal((await draw(player, new Date(end.getTime() + 1000).toISOString(), 700004)).status, 400)
    const later = await load(player, "2025-03-09T12:00:00Z", "2025-03-07T12:00:00Z")
    assert.equal(comebackEntries(later).some(entry => entry.comeback_campaign !== undefined), false)
})

test("welcome back portal: a player who stayed, or is new, gets none", async () => {
    const stayed = await newPlayer("2025-01-01T12:00:00Z")
    assert.deepEqual(comebackEntries(await load(stayed, "2025-02-20T12:00:00Z", "2025-01-01T12:00:00Z")), [])
    assert.equal((await draw(stayed, "2025-02-20T13:00:00Z", 700004)).status, 400)

    const fresh = await newPlayer("2025-02-20T12:00:00Z")
    assert.deepEqual(comebackEntries(await load(fresh, "2025-02-20T12:05:00Z", "2025-02-20T12:00:00Z")), [])
    assert.equal(comeback.comebackGachaPeriodSync(fresh.id, new Date("2025-02-20T12:05:00Z")), null)
})

test("welcome back portal: the lineup is the newest one open at the return", async () => {
    for (const [time, expected] of [["2023-10-01T12:00:00Z", 700000], ["2023-12-01T12:00:00Z", 700001], ["2024-03-10T12:00:00Z", 700003]] as const) {
        const previous = new Date(Date.parse(time) - 61 * DAY_MS)
        const player = await newPlayer(previous.toISOString())
        bonus.applyLoginBonuses(player.id, new Date(time), previous)
        assert.equal(comeback.comebackGachaPeriodSync(player.id, new Date(time))?.gachaId, expected, time)
    }
})

test("welcome back portal: a clock set back before the return closes it, and the next return opens a new period", async () => {
    const player = await newPlayer("2025-01-01T12:00:00Z")
    const first = new Date("2025-03-05T12:00:00Z")
    bonus.applyLoginBonuses(player.id, first, new Date("2025-01-01T12:00:00Z"))
    assert.equal(comeback.comebackGachaPeriodSync(player.id, new Date("2025-03-05T11:59:59Z")), null)
    assert.equal(comeback.comebackGachaPeriodSync(player.id, first)?.start.getTime(), first.getTime())

    const second = new Date("2025-06-01T12:00:00Z")
    bonus.applyLoginBonuses(player.id, second, new Date("2025-03-06T12:00:00Z"))
    const period = comeback.comebackGachaPeriodSync(player.id, new Date("2025-06-02T12:00:00Z"))
    assert.equal(period?.start.getTime(), second.getTime())
    assert.equal(period?.end.getTime(), second.getTime() + 3 * DAY_MS)
})

test("welcome back portal: a free pull campaign that lists it offers its pull only to the player it's open to", async () => {
    // campaign 19 (2024-05-28 to 2024-07-25) lists 700004, the lineup open then; a free pull there would fail for anyone
    // else, so their /load leaves it out
    const campaignPortals = async (player: Player, time: string, previous: string) => {
        data.updatePlayerSync({ id: player.id, lastLoginTime: new Date(previous) })
        utils.setServerTime(new Date(time))
        const reply = await post(player, "load", { access_token: player.zat })
        assert.equal(reply.status, 200)
        return (reply.body.data.gacha_campaign_list as { campaign_id: number, gacha_id: number }[])
            .filter(entry => entry.campaign_id === 19).map(entry => entry.gacha_id)
    }

    const stayed = await newPlayer("2024-06-01T12:00:00Z")
    const stayedPortals = await campaignPortals(stayed, "2024-06-10T12:00:00Z", "2024-06-01T12:00:00Z")
    assert.ok(stayedPortals.length > 0, "the campaign's other portals are listed")
    assert.ok(!stayedPortals.includes(700004))

    const returning = await newPlayer("2024-04-01T12:00:00Z")
    assert.ok((await campaignPortals(returning, "2024-06-10T12:00:00Z", "2024-04-01T12:00:00Z")).includes(700004))
})
