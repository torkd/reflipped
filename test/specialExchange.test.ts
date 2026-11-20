// FT-39: special exchange campaigns and scheduled campaign gifts. Campaign 11 (Dream Unit Scouting Season 9): tickets
// 2024-04-28 to 05-12, exchange until 05-19 (Japan time), ticket item 999002; campaign 12 (Dream Armament Exchange
// Ticket Gift Promo), armaments for ticket 999006: a gift promo, free as in the original (not sold; its ticket comes by
// mail). Tickets also come by mail from an admin, and an admin can make a sold season free (src/lib/campaignModes.ts):
// players then get it at their first login of the period.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer, useNoFreeCampaigns } from "./helpers";
import campaigns from "../assets/special_exchange_campaign.json";

const apiPrefix = "/latest/api/index.php"
const UNIT_CAMPAIGN = 11
const ARMAMENT_CAMPAIGN = 12
const UNIT_TICKET = 999002
const ARMAMENT_TICKET = 999006
const IN_PERIOD = "2024-05-01T03:00:00Z"
const EXCHANGE_ONLY = "2024-05-15T03:00:00Z"
const AFTER = "2024-06-01T03:00:00Z"
const unitTargets = (campaigns as Record<string, { targets: number[] }>)[String(UNIT_CAMPAIGN)].targets
const armamentTargets = (campaigns as Record<string, { targets: number[] }>)[String(ARMAMENT_CAMPAIGN)].targets

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
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
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : JSON.parse(response.body) }
}

async function newPlayer(date: string): Promise<Player> {
    await at(date)
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

async function load(player: TestPlayer) {
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/load`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, viewer_id: player.viewerId, access_token: player.zat })
    })
    assert.equal(response.statusCode, 200, response.body)
}

const statusOf = (reply: any, campaignId: number) =>
    reply.data.special_exchange_campaign_list.find((entry: any) => entry.campaign_id === campaignId)?.status

test("entering a campaign lists it, and only in its exchange period", async () => {
    const player = await newPlayer(IN_PERIOD)
    const entered = await post(player, "special_exchange/enter_campaign", { campaign_id: UNIT_CAMPAIGN })
    assert.equal(entered.body.data_headers.result_code, 1)
    assert.equal(statusOf(entered.body, UNIT_CAMPAIGN), 1, "entered without a ticket")

    await at(AFTER)
    const late = await post(player, "special_exchange/enter_campaign", { campaign_id: UNIT_CAMPAIGN })
    assert.equal(late.body.data_headers.result_code, 4715)
})

test("the ticket bundle sells for any beads, free ones first, once, in its sale period", async () => {
    const player = await newPlayer(IN_PERIOD)
    const buy = (campaignId: number) => post(player, "special_exchange/buy_ticket", { campaign_id: campaignId })
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 1000, vmoney: 0 })
    assert.equal((await buy(UNIT_CAMPAIGN)).status, 400, "1000 beads don't cover 1500")

    // 1000 free and 600 paid: the 1500 takes all the free ones and 500 paid
    data.updatePlayerSync({ id: player.playerId, freeVmoney: 1000, vmoney: 600 })
    const bought = await buy(UNIT_CAMPAIGN)
    assert.equal(bought.status, 200, JSON.stringify(bought.body))
    assert.equal(statusOf(bought.body, UNIT_CAMPAIGN), 2, "holding the ticket")
    assert.equal(data.getPlayerItemSync(player.playerId, UNIT_TICKET), 1)
    const after = data.getPlayerSync(player.playerId)!
    assert.deepEqual([after.freeVmoney, after.vmoney], [0, 100])
    assert.ok(data.getPlayerAllMailSync(player.playerId).some(mail => mail.type === 7 && mail.number === 20), "the bundle's Star Slivers")

    data.updatePlayerSync({ id: player.playerId, freeVmoney: 5000 })
    const again = await buy(UNIT_CAMPAIGN)
    assert.equal(again.body.data_headers.result_code, 4702, "once: the client's PeriodError (FT-91)")
    assert.equal(data.getPlayerSync(player.playerId)!.freeVmoney, 5000, "nothing charged")
    const { setCampaignModes } = await import("../src/lib/campaignModes")
    setCampaignModes({})   // the original's modes, not the test server's all-paid start
    const promo = await buy(ARMAMENT_CAMPAIGN)
    assert.equal(promo.status, 200)
    assert.equal(promo.body.data_headers.result_code, 4702, "a ticket gift promo is free, not sold")
    await at(EXCHANGE_ONLY)
    const late = await newPlayer(EXCHANGE_ONLY)
    data.updatePlayerSync({ id: late.playerId, freeVmoney: 5000 })
    assert.equal((await post(late, "special_exchange/buy_ticket", { campaign_id: UNIT_CAMPAIGN })).body.data_headers.result_code, 4702, "after the sale period")
})

test("a ticket trades for one unit of the campaign's list, once", async () => {
    const player = await newPlayer(EXCHANGE_ONLY)
    data.givePlayerItemSync(player.playerId, UNIT_TICKET, 2)
    const entered = await post(player, "special_exchange/enter_campaign", { campaign_id: UNIT_CAMPAIGN })
    assert.equal(statusOf(entered.body, UNIT_CAMPAIGN), 2, "holding the ticket")

    const outside = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: 999999 })
    assert.equal(outside.status, 400, "not in the list")

    const unit = unitTargets.find(id => data.getPlayerCharacterSync(player.playerId, id) === null)!
    const exchanged = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unit })
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body))
    assert.equal(statusOf(exchanged.body, UNIT_CAMPAIGN), 3)
    assert.equal(exchanged.body.data.character_list[0].character_id, unit)
    assert.notEqual(data.getPlayerCharacterSync(player.playerId, unit), null)
    assert.equal(data.getPlayerItemSync(player.playerId, UNIT_TICKET), 1)

    const again = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unitTargets[0] })
    assert.equal(again.status, 400, "one exchange per campaign")
})

test("an armament campaign trades its ticket for an armament", async () => {
    const player = await newPlayer(IN_PERIOD)
    data.givePlayerItemSync(player.playerId, ARMAMENT_TICKET, 1)
    assert.equal((await post(player, "special_exchange/exchange_equipment", { campaign_id: UNIT_CAMPAIGN, equipment_id: armamentTargets[0] })).status, 400, "a unit campaign")
    const exchanged = await post(player, "special_exchange/exchange_equipment", { campaign_id: ARMAMENT_CAMPAIGN, equipment_id: armamentTargets[0] })
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body))
    assert.equal(statusOf(exchanged.body, ARMAMENT_CAMPAIGN), 3)
    assert.notEqual(data.getPlayerEquipmentSync(player.playerId, armamentTargets[0]), null)
    assert.equal(data.getPlayerItemSync(player.playerId, ARMAMENT_TICKET), 0)
})

test("a campaign made free arrives by mail at the first login of its period, once", async () => {
    const player = await newPlayer(IN_PERIOD)
    const giftMail = () => data.getPlayerAllMailSync(player.playerId).filter(mail => mail.typeId === UNIT_TICKET || mail.type === 7)

    await load(player)
    assert.equal(giftMail().length, 0, "paid: nothing")

    // the admin makes campaign 11 free (the Settings page's form)
    const saved = await admin.inject({
        method: "POST", url: "/api/server/campaignGifts", remoteAddress: "127.0.0.1",
        headers: { host: "localhost:8001", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:8001" },
        payload: `special_${UNIT_CAMPAIGN}=free`
    })
    assert.equal(saved.statusCode, 302, saved.body)
    const { enabledSpecialExchangeGifts } = await import("../src/lib/campaignGifts")
    assert.ok(enabledSpecialExchangeGifts().has(UNIT_CAMPAIGN))

    await load(player)
    const mails = giftMail()
    assert.equal(mails.length, 2, "the ticket and the bundle's Star Slivers")
    assert.equal(mails.find(mail => mail.typeId === UNIT_TICKET)?.number, 1)
    assert.equal(mails.find(mail => mail.type === 7)?.number, 20)

    await load(player)
    assert.equal(giftMail().length, 2, "only once")

    // after the ticket period, a new player gets nothing
    const late = await newPlayer(EXCHANGE_ONLY)
    await load(late)
    assert.equal(data.getPlayerAllMailSync(late.playerId).filter(mail => mail.typeId === UNIT_TICKET).length, 0)
})

test("the Settings page lists the campaign bundles with their paid/free choice", async () => {
    const { setCampaignModes } = await import("../src/lib/campaignModes")
    setCampaignModes({ specialExchange: { [ARMAMENT_CAMPAIGN]: "paid" } })
    const page = await admin.inject({ method: "GET", url: "/settings", remoteAddress: "127.0.0.1", headers: { host: "localhost:8001" } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Campaign bundles/)
    const select = (id: number) => page.body.match(new RegExp(`<select id="setting-special_${id}"[^>]*>(.*?)</select>`))?.[1] ?? ""
    assert.match(select(UNIT_CAMPAIGN), /<option value="paid" selected>Paid: 1,500 beads \(original\)<\/option>/)
    assert.match(select(ARMAMENT_CAMPAIGN), /<option value="paid" selected>Paid: 750 beads<\/option><option value="free">Free: mailed to everyone \(original\)/)
    assert.match(page.body, /changed from the original/)
})
