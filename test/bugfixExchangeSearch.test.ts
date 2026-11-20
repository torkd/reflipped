// FT-80: /load lists the open Scouting Season and Dream Armament campaigns. FT-81: an exchange after its period answers
// the period result code instead of a 400. FT-82: the player search takes the account ID the game shows.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";
import campaigns from "../assets/special_exchange_campaign.json";

const apiPrefix = "/latest/api/index.php"
// campaign 11: sale 2024-04-28 to 05-12, exchange until 05-19; campaign 1 ended in 2022
const UNIT_CAMPAIGN = 11
const OLD_CAMPAIGN = 1
const UNIT_TICKET = 999002
const IN_PERIOD = "2024-05-01T03:00:00Z"
const EXCHANGE_ONLY = "2024-05-15T03:00:00Z"
const AFTER = "2024-06-01T03:00:00Z"
const armamentTargets = (campaigns as Record<string, { targets: number[] }>)["12"].targets
const unitTargets =(campaigns as Record<string, { targets: number[] }>)[String(UNIT_CAMPAIGN)].targets

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

type Player = TestPlayer & { playerId: number, accountId: number }

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
    return { ...player, playerId, accountId: session!.accountId }
}

async function loadList(player: Player): Promise<{ campaign_id: number, status: number }[]> {
    const response = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.status, 200, String(response.body))
    return response.body.data.special_exchange_campaign_list
}

const statusIn = (list: { campaign_id: number, status: number }[], campaignId: number) =>
    list.find(entry => entry.campaign_id === campaignId)?.status

test("FT-80: /load lists a campaign in its sale period with status 1, 2 with the ticket, 3 once exchanged", async () => {
    const player = await newPlayer(IN_PERIOD)
    const fresh = await loadList(player)
    assert.equal(statusIn(fresh, UNIT_CAMPAIGN), 1, "open, not entered")
    assert.equal(statusIn(fresh, OLD_CAMPAIGN), undefined, "a campaign of 2022 is over")

    data.givePlayerItemSync(player.playerId, UNIT_TICKET, 1)
    assert.equal(statusIn(await loadList(player), UNIT_CAMPAIGN), 2, "holding the ticket")

    const unit = unitTargets.find(id => data.getPlayerCharacterSync(player.playerId, id) === null)!
    const exchanged = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unit })
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body))
    assert.equal(statusIn(await loadList(player), UNIT_CAMPAIGN), 3, "exchanged")
})

test("FT-80: /load lists a campaign in its exchange period after the sale, and drops it when everything is over", async () => {
    const player = await newPlayer(EXCHANGE_ONLY)
    assert.equal(statusIn(await loadList(player), UNIT_CAMPAIGN), 1, "exchange period still open")
    await at(AFTER)
    assert.equal(statusIn(await loadList(player), UNIT_CAMPAIGN), undefined, "past the exchange period, never entered")
})

test("FT-81: an exchange after the exchange period answers the period result code, not a 400", async () => {
    const player = await newPlayer(IN_PERIOD)
    data.givePlayerItemSync(player.playerId, UNIT_TICKET, 1)
    await at(AFTER)
    const unit = unitTargets[0]
    const late = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: unit })
    assert.equal(late.status, 200)
    assert.equal(late.body.data_headers.result_code, 4715)
    assert.equal(data.getPlayerItemSync(player.playerId, UNIT_TICKET), 1, "the ticket is kept")

    // an armament campaign (12) past its period answers the same on the armament route (the campaign's ticket gift
    // and exchange period ended in mid-2024); a kind mismatch is tampering whatever the date
    const lateEquipment = await post(player, "special_exchange/exchange_equipment", { campaign_id: 12, equipment_id: armamentTargets[0] })
    assert.equal(lateEquipment.status, 200)
    assert.equal(lateEquipment.body.data_headers.result_code, 4715)
    const wrongKind = await post(player, "special_exchange/exchange_equipment", { campaign_id: UNIT_CAMPAIGN, equipment_id: armamentTargets[0] })
    assert.equal(wrongKind.status, 400, "a unit campaign on the armament route")
})

test("FT-81: tampering still answers 400 in the period", async () => {
    const player = await newPlayer(IN_PERIOD)
    data.givePlayerItemSync(player.playerId, UNIT_TICKET, 1)
    const outside = await post(player, "special_exchange/exchange_character", { campaign_id: UNIT_CAMPAIGN, character_id: 999999 })
    assert.equal(outside.status, 400, "not in the list")
    const unknown = await post(player, "special_exchange/exchange_character", { campaign_id: 99999, character_id: unitTargets[0] })
    assert.equal(unknown.status, 400, "unknown campaign")
})

test("FT-82: the player search finds a player by the account ID the game shows", async () => {
    const a = await newPlayer(IN_PERIOD), b = await newPlayer(IN_PERIOD)
    const found = await post(a, "follow/search_kakao_pid", { search_kakao_pid: String(b.accountId) })
    assert.equal(found.body.data_headers.result_code, 1)
    assert.equal(found.body.data.search_result.viewer_id, b.viewerId)
    assert.equal(found.body.data.search_result.kakao_pid, String(b.accountId), "the ID the search result shows is the one searched")

    const asNumber = await post(a, "follow/search_kakao_pid", { search_kakao_pid: b.accountId })
    assert.equal(asNumber.body.data.search_result.viewer_id, b.viewerId)

    const own = await post(a, "follow/search_kakao_pid", { search_kakao_pid: String(a.accountId) })
    assert.equal(own.body.data_headers.result_code, 1455, "not yourself")
    const unknown = await post(a, "follow/search_kakao_pid", { search_kakao_pid: "999999999999" })
    assert.equal(unknown.body.data_headers.result_code, 1455)
})

test("FT-82: a viewer ID still finds its player when no account has that number", async () => {
    const a = await newPlayer(IN_PERIOD), b = await newPlayer(IN_PERIOD)
    const found = await post(a, "follow/search_kakao_pid", { search_kakao_pid: String(b.viewerId) })
    assert.equal(found.body.data.search_result.viewer_id, b.viewerId)
})
