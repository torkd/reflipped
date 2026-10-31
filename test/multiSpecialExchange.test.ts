import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
// campaign 5 (2024-06-25 14:00 to 2024-07-02 13:59:59, exchange until 2024-07-07 13:59:59), as captured
const campaignId = 5
const ticketItemId = 980007
const characterId = 111015 // a 5* fire unit on every single-set ticket
const notExchangeable = 111153
// what a duplicate 5* fire unit gives (dupeItemRewards in src/lib/character.ts)
const fireFiveStarDuplicateItem = 14003

const captured = {
    singleDrawTicket: readCapturedRoute("multi_special_exchange_single_draw_ticket"),
    exchangeCharacter: readCapturedRoute("multi_special_exchange_exchange_character"),
    loungeGetList: readCapturedRoute("lounge_get_list")
}

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let setServerTime: (date: Date | null) => void

interface Client {
    player: TestPlayer
    playerId: number
    apiCount: number
}

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    setServerTime = (await import("../src/utils")).setServerTime
})

after(async () => {
    setServerTime(null)
    await cleanup()
})

/** A new signed-up player; each test gets its own, so tests don't depend on each other's state. */
async function newClient(): Promise<Client> {
    const player = await createTestPlayer(fastify)
    // the data layer opens the test database, so import it only after createTestServer()
    const { getSession, getAccountPlayers } = await import("../src/data/wdfpData")
    const session = await getSession(String(player.viewerId))
    return { player, playerId: (await getAccountPlayers(session!.accountId))[0], apiCount: 1 }
}

async function gameRequest(client: Client, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(client.player.udid),
        payload: encodeGameBody({ ...body, api_count: client.apiCount++, viewer_id: client.player.viewerId })
    })
    return { statusCode: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.body }
}

function drawTicket(client: Client, campaign: number) {
    return gameRequest(client, "multi_special_exchange/single_draw_ticket", { ...captured.singleDrawTicket.requestBody, campaign_id: campaign })
}

function exchange(client: Client, campaign: number, character: number, ticket: number) {
    return gameRequest(client, "multi_special_exchange/exchange_character", {
        ...captured.exchangeCharacter.requestBody, campaign_id: campaign, character_id: character, ticket_item_id: ticket
    })
}

async function loadCampaignList(client: Client): Promise<any[]> {
    const response = await gameRequest(client, "load", { ...readCapturedRoute("load").requestBody, access_token: client.player.zat })
    assert.equal(response.statusCode, 200)
    return response.body.data.multi_special_exchange_campaign_list
}

async function itemCount(client: Client, itemId: number): Promise<number | null> {
    const { getPlayerItemSync } = await import("../src/data/wdfpData")
    return getPlayerItemSync(client.playerId, itemId)
}

async function setCampaign(client: Client, campaign: number, status: number, ticket: number | null) {
    const { upsertPlayerMultiSpecialExchangeCampaignSync } = await import("../src/data/wdfpData")
    upsertPlayerMultiSpecialExchangeCampaignSync(client.playerId, { campaignId: campaign, status, ticketItemId: ticket })
}

test("multi special exchange: draw a ticket alone and exchange it", async (t) => {
    const client = await newClient()

    await t.test("a closed campaign isn't listed at /load", async () => {
        setServerTime(new Date("2025-01-03T12:00:00Z"))
        const list = await loadCampaignList(client)
        assert.equal(list.some(campaign => campaign.campaign_id === campaignId), false)
    })

    await t.test("an open campaign is listed as not participated", async () => {
        setServerTime(new Date("2024-06-29T19:27:00Z"))
        const list = await loadCampaignList(client)
        assert.deepEqual(list.find(campaign => campaign.campaign_id === campaignId), { campaign_id: campaignId, status: 1 })
    })

    await t.test("the campaign scene's lounge list answers empty (lounge stub, as captured)", async () => {
        const response = await gameRequest(client, "lounge/get_list", captured.loungeGetList.requestBody)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.data_headers.result_code, 1)
        assert.deepEqual(response.body.data, captured.loungeGetList.responseBody.data)
    })

    await t.test("no exchange before a ticket is drawn", async () => {
        const response = await exchange(client, campaignId, characterId, ticketItemId)
        assert.equal(response.statusCode, 400)
    })

    await t.test("an unknown campaign is refused", async () => {
        const response = await drawTicket(client, 999)
        assert.equal(response.statusCode, 400)
    })

    await t.test("single_draw_ticket gives the ticket (as captured)", async () => {
        const response = await drawTicket(client, campaignId)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.data_headers.result_code, 1)
        assert.deepEqual(response.body.data, captured.singleDrawTicket.responseBody.data)
        assert.equal(await itemCount(client, ticketItemId), 1)
    })

    await t.test("a second draw answers TicketAlreadyDrawn (4902)", async () => {
        const response = await drawTicket(client, campaignId)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.data_headers.result_code, 4902)
        assert.equal(await itemCount(client, ticketItemId), 1)
    })

    await t.test("multi_draw_ticket then returns the drawn ticket without giving another", async () => {
        const response = await gameRequest(client, "multi_special_exchange/multi_draw_ticket", { campaign_id: campaignId })
        assert.equal(response.statusCode, 200)
        assert.deepEqual(response.body.data.multi_special_exchange_campaign_list, captured.singleDrawTicket.responseBody.data.multi_special_exchange_campaign_list)
        assert.equal(await itemCount(client, ticketItemId), 1)
    })

    await t.test("/load carries the drawn ticket", async () => {
        const list = await loadCampaignList(client)
        assert.deepEqual(list.find(campaign => campaign.campaign_id === campaignId), { campaign_id: campaignId, status: 3, ticket_item_id: ticketItemId })
    })

    await t.test("only the ticket's characters and the drawn ticket are accepted", async () => {
        const wrongCharacter = await exchange(client, campaignId, notExchangeable, ticketItemId)
        assert.equal(wrongCharacter.statusCode, 400)
        const wrongTicket = await exchange(client, campaignId, characterId, 980006)
        assert.equal(wrongTicket.statusCode, 400)
        assert.equal(await itemCount(client, ticketItemId), 1)
    })

    await t.test("exchange_character spends the ticket and gives the character (as captured)", async () => {
        // after the draw period, still inside the exchange period
        setServerTime(new Date("2024-07-05T00:00:00Z"))
        const response = await exchange(client, campaignId, characterId, ticketItemId)
        assert.equal(response.statusCode, 200)
        const data = response.body.data
        const capturedData = captured.exchangeCharacter.responseBody.data
        assert.deepEqual(data.multi_special_exchange_campaign_list, capturedData.multi_special_exchange_campaign_list)
        assert.deepEqual(Object.keys(data.encyclopedia_info), Object.keys(capturedData.encyclopedia_info))
        assert.deepEqual(Object.keys(data.character_list[0]).sort(), Object.keys(capturedData.character_list[0]).sort())
        assert.equal(data.character_list[0].character_id, characterId)
        assert.equal(data.character_list[0].entry_count, 1)
        assert.equal(data.character_list[0].viewer_id, client.player.viewerId)
        assert.equal(data.item_list[ticketItemId], 0)
        assert.equal(data.mail_arrived, true)
        assert.equal(await itemCount(client, ticketItemId), 0)

        const { getPlayerCharacterSync } = await import("../src/data/wdfpData")
        assert.notEqual(getPlayerCharacterSync(client.playerId, characterId), null)
    })

    await t.test("two random bonus units from the ticket's list arrive by mail", async () => {
        const response = await gameRequest(client, "mail/index", { current_page: 1, app_secret: "", app_admin: "" })
        assert.equal(response.statusCode, 200)
        // the gift box also holds mission rewards (FT-2: the loads on two game days clear the login-days missions)
        const mails = response.body.data.mail.filter((mail: { reason_id: number }) => mail.reason_id === 30002)
        assert.equal(mails.length, 2)
        const { getExchangeCharacterIds } = await import("../src/lib/multiSpecialExchange")
        const { MailType } = await import("../src/data/types")
        const pool = getExchangeCharacterIds(ticketItemId)
        for (const mail of mails) {
            assert.equal(mail.type, MailType.CHARACTER)
            assert.equal(mail.number, 1)
            assert.equal(mail.reason_id, 30002)
            assert.ok(pool.includes(mail.type_id), `${mail.type_id} is not on ticket ${ticketItemId}`)
        }
    })

    await t.test("one exchange per campaign", async () => {
        const response = await exchange(client, campaignId, characterId, ticketItemId)
        assert.equal(response.statusCode, 400)
        const list = await loadCampaignList(client)
        // as in the /load capture: no ticket_item_id once exchanged
        assert.deepEqual(list.find(campaign => campaign.campaign_id === campaignId), { campaign_id: campaignId, status: 4 })
    })
})

test("multi special exchange: periods, lounge-decided tickets, duplicates", async (t) => {
    const client = await newClient()

    await t.test("drawing outside the campaign period answers PeriodError (4901)", async () => {
        // campaign 6 opens on 2024-07-09 14:00
        setServerTime(new Date("2024-07-05T00:00:00Z"))
        const response = await drawTicket(client, 6)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.data_headers.result_code, 4901)
        assert.equal(await itemCount(client, 980008), null)
    })

    await t.test("multi_draw_ticket hands over a ticket a lounge battle decided", async () => {
        setServerTime(new Date("2024-07-10T00:00:00Z"))
        await setCampaign(client, 6, 2, 980008)

        const response = await gameRequest(client, "multi_special_exchange/multi_draw_ticket", { campaign_id: 6 })
        assert.equal(response.statusCode, 200)
        assert.deepEqual(response.body.data.multi_special_exchange_campaign_list, [{ campaign_id: 6, status: 3, ticket_item_id: 980008 }])
        assert.deepEqual(response.body.data.item_list, { 980008: 1 })
        assert.equal(await itemCount(client, 980008), 1)
    })

    await t.test("a decided ticket isn't handed over after the exchange period (4901)", async () => {
        // campaign 4: exchange period ended 2024-06-23 13:59:59
        await setCampaign(client, 4, 2, 980006)
        const response = await gameRequest(client, "multi_special_exchange/multi_draw_ticket", { campaign_id: 4 })
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.data_headers.result_code, 4901)
        assert.equal(await itemCount(client, 980006), null)
    })

    await t.test("/load drops undrawn and unexchanged tickets outside the exchange period, keeps exchanged campaigns", async () => {
        await setCampaign(client, 2, 3, 980004)
        await setCampaign(client, 1, 4, 980001)
        const list = await loadCampaignList(client)
        assert.equal(list.some(campaign => campaign.campaign_id === 2), false) // drawn, exchange period over
        assert.equal(list.some(campaign => campaign.campaign_id === 4), false) // decided, exchange period over
        assert.deepEqual(list.find(campaign => campaign.campaign_id === 1), { campaign_id: 1, status: 4 })
        assert.deepEqual(list.find(campaign => campaign.campaign_id === 6), { campaign_id: 6, status: 3, ticket_item_id: 980008 })
    })

    await t.test("an exchange after the exchange period answers PeriodError (4901)", async () => {
        setServerTime(new Date("2024-07-22T00:00:00Z"))
        const response = await exchange(client, 6, characterId, 980008)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.data_headers.result_code, 4901)
        assert.equal(await itemCount(client, 980008), 1)
    })

    await t.test("exchanging for an owned character stacks it, even with a nearly full gift box", async () => {
        const now = new Date("2024-07-12T00:00:00Z")
        setServerTime(now)
        const { givePlayerCharacterSync } = await import("../src/lib/character")
        givePlayerCharacterSync(client.playerId, characterId)

        // leave one free slot: the chosen unit is still given, and one of the two bonus mails fits
        const { getPlayerReceivableMailCountSync } = await import("../src/data/wdfpData")
        const { sendPlayerMailSync } = await import("../src/lib/mail")
        const { mailLimits } = await import("../src/lib/limits")
        const { MailType } = await import("../src/data/types")
        while (getPlayerReceivableMailCountSync(client.playerId, now) < mailLimits.pendingMails - 1)
            sendPlayerMailSync(client.playerId, { type: MailType.FREE_MANA, number: 1, subject: "filler", description: "" })

        const response = await exchange(client, 6, characterId, 980008)
        assert.equal(response.statusCode, 200)
        assert.equal(getPlayerReceivableMailCountSync(client.playerId, now), mailLimits.pendingMails)
        const data = response.body.data
        assert.equal(data.mail_arrived, true)
        assert.equal(data.character_list[0].stack, 1)
        assert.deepEqual(data.encyclopedia_info, [])
        assert.equal(data.item_list[980008], 0)
        assert.equal(data.item_list[fireFiveStarDuplicateItem], 1)
    })
})

test("multi special exchange: master dates are Japan time, as the client reads them", async () => {
    const client = await newClient()
    // campaign 5 opens at "2024-06-25 14:00:00" = 05:00 UTC
    setServerTime(new Date("2024-06-25T04:59:59Z"))
    assert.equal((await loadCampaignList(client)).some(campaign => campaign.campaign_id === campaignId), false)
    assert.equal((await drawTicket(client, campaignId)).body.data_headers.result_code, 4901)
    setServerTime(new Date("2024-06-25T05:00:00Z"))
    assert.equal((await loadCampaignList(client)).some(campaign => campaign.campaign_id === campaignId), true)
    assert.equal((await drawTicket(client, campaignId)).body.data_headers.result_code, 1)
    // the exchange closes at "2024-07-07 13:59:59" = 04:59:59 UTC
    setServerTime(new Date("2024-07-07T05:00:00Z"))
    assert.equal((await exchange(client, campaignId, characterId, ticketItemId)).body.data_headers.result_code, 4901)
    setServerTime(new Date("2024-07-07T04:59:59Z"))
    assert.equal((await exchange(client, campaignId, characterId, ticketItemId)).body.data_headers.result_code, 1)
})

test("multi special exchange: a drawn ticket survives a save export and import", async () => {
    const client = await newClient()
    await setCampaign(client, campaignId, 3, ticketItemId)

    const exported = await admin.inject({ method: "GET", url: `/api/player/save?id=${client.playerId}` })
    assert.equal(exported.statusCode, 200)
    const save = exported.json()
    assert.deepEqual(save.multi_special_exchange_campaign_list.find((campaign: any) => campaign.campaign_id === campaignId),
        { campaign_id: campaignId, status: 3, ticket_item_id: ticketItemId })

    await setCampaign(client, campaignId, 1, null)
    const boundary = "----save"
    const imported = await admin.inject({
        method: "POST",
        url: `/api/player/save?id=${client.playerId}`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="save-data"; filename="save.json"\r\nContent-Type: application/json\r\n\r\n`),
            Buffer.from(JSON.stringify(save)),
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ])
    })
    assert.equal(imported.statusCode, 302)
    assert.equal(imported.headers.location, `/player/${client.playerId}?message=save-imported`)

    const { getPlayerMultiSpecialExchangeCampaignSync } = await import("../src/data/wdfpData")
    assert.deepEqual(getPlayerMultiSpecialExchangeCampaignSync(client.playerId, campaignId), { campaignId, status: 3, ticketItemId })
})
