// FT-44: the Start Dash bundle. A new player (account under 7 days old) gets an entry at /load, for 7 days: the bundle
// sells once for any beads (the ticket, a 10-Pull Summoning Ticket, 20 Star Slivers by mail), and the ticket trades once
// for a 5- or 4-star unit of the entry's portal. An admin can give the whole bundle as a campaign gift.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer, useNoFreeCampaigns } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const CAMPAIGN = 1
const TICKET = 990007
const TEN_PULL_TICKET = 999001
const NOW = "2025-01-03T12:00:00Z"

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
    await useNoFreeCampaigns()
})

after(async () => {
    await cleanup()
})

type Player = TestPlayer & { playerId: number, accountId: number }

async function at(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function newPlayer(): Promise<Player> {
    await at(NOW)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId, accountId: session!.accountId }
}

async function load(player: TestPlayer) {
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/load`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, viewer_id: player.viewerId, access_token: player.zat })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/${route}`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

const entryOf = (list: any[]) => list.find(entry => entry.campaign_id === CAMPAIGN)

test("a new player's /load lists the bundle for 7 days; an older account gets none", async () => {
    const player = await newPlayer()
    const loaded = await load(player)
    const entry = entryOf(loaded.start_dash_exchange_campaign_list)
    assert.ok(entry, "listed")
    assert.equal(entry.status, 1)
    assert.equal(entry.period_end_time - entry.period_start_time, 7 * 24 * 60 * 60)
    assert.ok(entry.gacha_id > 0)

    const old = await newPlayer()
    const { default: getDatabase, Database } = await import("../src/data")
    getDatabase(Database.WDFP_DATA).prepare(`UPDATE accounts SET reg_time = ? WHERE id = ?`)
        .run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), old.accountId)
    assert.equal(entryOf((await load(old)).start_dash_exchange_campaign_list), undefined)
})

test("the bundle sells once for any beads, and its ticket trades once for a unit of the list", async () => {
    const player = await newPlayer()
    await load(player)
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 1000, vmoney: 600 })
    const bought = await post(player, "start_dash_exchange/buy_ticket", { campaign_id: CAMPAIGN })
    assert.equal(bought.status, 200, JSON.stringify(bought.body))
    assert.equal(entryOf(bought.body.data.start_dash_exchange_campaign_list).status, 2)
    assert.deepEqual([data.getPlayerSync(player.playerId)!.freeVmoney, data.getPlayerSync(player.playerId)!.vmoney], [0, 100])
    assert.equal(data.getPlayerItemSync(player.playerId, TICKET), 1)
    assert.equal(data.getPlayerItemSync(player.playerId, TEN_PULL_TICKET), 1)
    assert.ok(data.getPlayerAllMailSync(player.playerId).some(mail => mail.type === 7 && mail.number === 20))
    assert.equal((await post(player, "start_dash_exchange/buy_ticket", { campaign_id: CAMPAIGN })).body.data_headers.result_code, 4802, "once: the client's PeriodError (FT-91)")

    const { startDashEntrySync, startDashTargets } = await import("../src/lib/startDash")
    const targets = startDashTargets(startDashEntrySync(player.playerId, CAMPAIGN)!)
    assert.ok(targets.length > 0)
    assert.equal((await post(player, "start_dash_exchange/exchange_character", { campaign_id: CAMPAIGN, character_id: 999999 })).status, 400)
    const unit = targets.find(id => data.getPlayerCharacterSync(player.playerId, id) === null)!
    const exchanged = await post(player, "start_dash_exchange/exchange_character", { campaign_id: CAMPAIGN, character_id: unit })
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body))
    assert.equal(entryOf(exchanged.body.data.start_dash_exchange_campaign_list).status, 3)
    assert.notEqual(data.getPlayerCharacterSync(player.playerId, unit), null)
    assert.equal(data.getPlayerItemSync(player.playerId, TICKET), 0)
    assert.equal((await post(player, "start_dash_exchange/exchange_character", { campaign_id: CAMPAIGN, character_id: targets[0] })).status, 400, "once")
})

test("outside the player's 7 days the bundle isn't sold", async () => {
    const player = await newPlayer()
    await load(player)
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 5000 })
    await at("2025-01-12T12:00:00Z")
    const late = await post(player, "start_dash_exchange/buy_ticket", { campaign_id: CAMPAIGN })
    assert.equal(late.body.data_headers.result_code, 4802)
})

test("a free Start Dash bundle is mailed whole once, at the first login of the player's days, and not sold", async () => {
    const { setCampaignModes, campaignModeOverrides } = await import("../src/lib/campaignModes")
    setCampaignModes({ ...campaignModeOverrides(), startDash: { [CAMPAIGN]: "free" } })
    const player = await newPlayer()
    await load(player)
    const gift = () => data.getPlayerAllMailSync(player.playerId).filter(mail => mail.typeId === TICKET || mail.typeId === TEN_PULL_TICKET || mail.type === 7)
    assert.equal(gift().length, 3)
    await load(player)
    assert.equal(gift().length, 3, "once")
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 5000 })
    const bought = await post(player, "start_dash_exchange/buy_ticket", { campaign_id: CAMPAIGN })
    assert.equal(bought.body.data_headers.result_code, 4802, "a free bundle isn't sold")
})
