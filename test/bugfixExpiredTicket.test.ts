// FT-81: a Scouting Season ticket still held after the exchange period. The client keeps listing the entered campaign
// with status 2, shows "the exchange deadline has passed, moving to the exchange screen" at Home and opens the exchange
// without a back button (ExchangeCampaign.isHavingExpiredTicket), so the server takes the exchange then. A campaign
// the player never entered, or one whose exchange hasn't begun, still answers the period result code.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";
import campaigns from "../assets/special_exchange_campaign.json";

const apiPrefix = "/latest/api/index.php"

const UNIT_CAMPAIGN = 11
const UNIT_TICKET = 999002
const BEFORE = "2024-04-20T03:00:00Z"
const IN_PERIOD = "2024-05-01T03:00:00Z"
const AFTER = "2024-06-01T03:00:00Z"
const unitTargets = (campaigns as Record<string, { targets: number[] }>)[String(UNIT_CAMPAIGN)].targets

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
})

after(async () => {
    await cleanup()
})

type Player = TestPlayer & { playerId: number }

async function at(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.body }
}

async function newPlayer(date: string): Promise<Player> {
    await at(date)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

const statusIn = (list: { campaign_id: number, status: number }[], campaignId: number) =>
    list.find(entry => entry.campaign_id === campaignId)?.status

test("an entered campaign's ticket held past the exchange period is still listed with status 2 and trades", async () => {
    const player = await newPlayer(IN_PERIOD)
    data.givePlayerItemSync(player.playerId, UNIT_TICKET, 1)
    assert.equal((await post(player, "special_exchange/enter_campaign", { campaign_id: UNIT_CAMPAIGN })).body.data_headers.result_code, 1)

    await at(AFTER)
    const load = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(statusIn(load.body.data.special_exchange_campaign_list, UNIT_CAMPAIGN), 2, "the client's expired-ticket state")

    const unit = unitTargets.find(id => data.getPlayerCharacterSync(player.playerId, id) === null)!
    const exchanged = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unit })
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body))
    assert.equal(exchanged.body.data_headers.result_code, 1)
    assert.equal(statusIn(exchanged.body.data.special_exchange_campaign_list, UNIT_CAMPAIGN), 3)
    assert.notEqual(data.getPlayerCharacterSync(player.playerId, unit), null)
    assert.equal(data.getPlayerItemSync(player.playerId, UNIT_TICKET), 0)

    // once, as in the period
    data.givePlayerItemSync(player.playerId, UNIT_TICKET, 1)
    const again = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unitTargets[0] })
    assert.equal(again.status, 400)
})

test("past the period a campaign never entered, and before the exchange began any campaign, answer 4715", async () => {
    const stranger = await newPlayer(AFTER)
    data.givePlayerItemSync(stranger.playerId, UNIT_TICKET, 1)
    const late = await post(stranger, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unitTargets[0] })
    assert.equal(late.body.data_headers.result_code, 4715)
    assert.equal(data.getPlayerItemSync(stranger.playerId, UNIT_TICKET), 1, "the ticket is kept")

    const early = await newPlayer(BEFORE)
    data.givePlayerItemSync(early.playerId, UNIT_TICKET, 1)
    data.setPlayerSpecialExchangeSync(early.playerId, UNIT_CAMPAIGN, 1)
    const tooSoon = await post(early, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unitTargets[0] })
    assert.equal(tooSoon.body.data_headers.result_code, 4715)
})
