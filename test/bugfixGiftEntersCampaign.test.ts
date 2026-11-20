// FT-85: a Scouting Season ticket that comes as the campaign's gift. The client never sends enter_campaign for a
// campaign whose ticket it holds, so the gift itself enters the player; the ticket, still held after the exchange
// period, is then offered for its own campaign (FT-81's "no longer available" exchange) like a bought one.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";
import campaigns from "../assets/special_exchange_campaign.json";

const apiPrefix = "/latest/api/index.php"

const UNIT_CAMPAIGN = 11
const UNIT_TICKET = 999002
const IN_PERIOD = "2024-05-01T03:00:00Z"
const AFTER = "2024-06-01T03:00:00Z"
const unitTargets = (campaigns as Record<string, { targets: number[] }>)[String(UNIT_CAMPAIGN)].targets

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    const { setCampaignModes } = await import("../src/lib/campaignModes")
    // only this campaign free (the promos too would mail their tickets)
    setCampaignModes({ specialExchange: { ...(await import("../src/lib/campaignModes")).campaignModeOverrides().specialExchange, [UNIT_CAMPAIGN]: "free" } })
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

async function loadList(player: Player): Promise<{ campaign_id: number, status: number }[]> {
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.status, 200, String(response.body))
    return response.body.data.special_exchange_campaign_list
}

const statusIn = (list: { campaign_id: number, status: number }[], campaignId: number) =>
    list.find(entry => entry.campaign_id === campaignId)?.status

test("a campaign's gift enters the player, so the gifted ticket trades after the exchange period", async () => {
    const player = await newPlayer(IN_PERIOD)
    await loadList(player)
    assert.equal(data.getPlayerSpecialExchangeSync(player.playerId).get(UNIT_CAMPAIGN), 1, "entered by the gift")

    // the player claims the ticket from the gift box
    const ticketMail = data.getPlayerAllMailSync(player.playerId).find(mail => mail.typeId === UNIT_TICKET)!
    assert.equal((await post(player, "mail/receive", { mail_id: ticketMail.id })).status, 200)
    assert.equal(data.getPlayerItemSync(player.playerId, UNIT_TICKET), 1)

    // past the exchange period, still held: listed with status 2 and the exchange is taken
    await at(AFTER)
    assert.equal(statusIn(await loadList(player), UNIT_CAMPAIGN), 2)
    const unit = unitTargets.find(id => data.getPlayerCharacterSync(player.playerId, id) === null)!
    const exchanged = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unit })
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body))
    assert.equal(exchanged.body.data_headers.result_code, 1)
    assert.equal(data.getPlayerSpecialExchangeSync(player.playerId).get(UNIT_CAMPAIGN), 3)
})

test("a gift doesn't undo an exchange already made", async () => {
    const player = await newPlayer(IN_PERIOD)
    data.setPlayerSpecialExchangeSync(player.playerId, UNIT_CAMPAIGN, 3)
    await loadList(player)
    assert.ok(data.getPlayerAllMailSync(player.playerId).some(mail => mail.typeId === UNIT_TICKET), "the gift is sent")
    assert.equal(data.getPlayerSpecialExchangeSync(player.playerId).get(UNIT_CAMPAIGN), 3)
})
