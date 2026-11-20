// FT-91: a player who already holds a campaign's ticket (its gift, claimed before the owner made the campaign paid) is
// still offered the bundle: the client learns about a ticket that came by mail only at the next /load. Buying then must
// get the client's PeriodError ("This item is no longer available for purchase"), not an HTTP error that sends the
// game back to the title, and charge nothing.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"

const UNIT_CAMPAIGN = 11
const UNIT_TICKET = 999002
const IN_PERIOD = "2024-05-01T03:00:00Z"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let campaignModes: typeof import("../src/lib/campaignModes")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    campaignModes = await import("../src/lib/campaignModes")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

type Player = TestPlayer & { playerId: number }

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
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

/** Only `campaignId` in the given mode; the other campaigns paid, so no other gift mail comes. */
function onlyMode(campaignId: number, mode: "free" | "paid") {
    const special: Record<number, string> = {}
    for (let id = 1; id <= 17; id++) special[id] = "paid"
    special[campaignId] = mode
    campaignModes.setCampaignModes({ specialExchange: special })
}

test("a held gift ticket: buying the campaign made paid gets PeriodError and charges nothing", async () => {
    onlyMode(UNIT_CAMPAIGN, "free")
    const player = await newPlayer(IN_PERIOD)
    const loaded = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(loaded.status, 200, String(loaded.body))
    const ticketMail = data.getPlayerAllMailSync(player.playerId).find(mail => mail.typeId === UNIT_TICKET)
    assert.ok(ticketMail, "the free campaign's ticket by mail")
    assert.equal((await post(player, "mail/receive", { mail_id: ticketMail!.id })).status, 200)
    assert.equal(data.getPlayerItemSync(player.playerId, UNIT_TICKET), 1)

    onlyMode(UNIT_CAMPAIGN, "paid")
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 3000, vmoney: 0 })
    const mailsBefore = data.getPlayerAllMailSync(player.playerId).length
    const bought = await post(player, "special_exchange/buy_ticket", { campaign_id: UNIT_CAMPAIGN })
    assert.equal(bought.status, 200, String(bought.body))
    assert.equal(bought.body.data_headers.result_code, 4702, "the client's PeriodError")
    assert.equal(data.getPlayerSync(player.playerId)!.freeVmoney, 3000, "no beads taken")
    assert.equal(data.getPlayerItemSync(player.playerId, UNIT_TICKET), 1, "still one ticket")
    assert.equal(data.getPlayerAllMailSync(player.playerId).length, mailsBefore, "no Star Sliver mail")
})

test("an exchanged campaign: buying again gets PeriodError", async () => {
    onlyMode(UNIT_CAMPAIGN, "paid")
    const player = await newPlayer(IN_PERIOD)
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 3000, vmoney: 0 })
    assert.equal((await post(player, "special_exchange/buy_ticket", { campaign_id: UNIT_CAMPAIGN })).body.data_headers.result_code, 1)
    const { SpecialExchangeStatus } = await import("../src/lib/specialExchange")
    data.setPlayerSpecialExchangeSync(player.playerId, UNIT_CAMPAIGN, SpecialExchangeStatus.EXCHANGED)
    data.updatePlayerItemSync(player.playerId, UNIT_TICKET, 0)
    const again = await post(player, "special_exchange/buy_ticket", { campaign_id: UNIT_CAMPAIGN })
    assert.equal(again.body.data_headers.result_code, 4702)
    assert.equal(data.getPlayerSync(player.playerId)!.freeVmoney, 1500, "only the first purchase was charged")
})
