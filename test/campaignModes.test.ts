// Paid or free campaign bundles (src/lib/campaignModes.ts): by default as the original ran them, the paid seasons
// (campaigns 1-11) sold and the ticket gift promos (12-17) free, mailed at the first login of their period. The owner
// can change each: a promo made paid sells once per season at the paid seasons' prices, a season made free isn't sold,
// and the schedule overlay gives the client's rows the changed mode.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    // the original's modes, not the test server's all-paid start (test/helpers.ts)
    ;(await import("../src/lib/campaignModes")).setCampaignModes({})
    data = await import("../src/data/wdfpData")
    utils = await import("../src/utils")
})
afterEach(() => utils.setServerTime(null))
after(async () => { await cleanup() })

async function newPlayer(time: string, free: number) {
    utils.setServerTime(new Date(time))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const id = (await data.getAccountPlayers(session!.accountId))[0]
    data.updatePlayerSync({ id, freeVmoney: free, vmoney: 0 })
    return { player, id }
}

async function buy(player: Awaited<ReturnType<typeof newPlayer>>["player"], campaignId: number) {
    const response = await fastify.inject({ method: "POST", url: "/latest/api/index.php/special_exchange/buy_ticket", headers: gameHeaders(player.udid),
        payload: encodeGameBody({ campaign_id: campaignId, viewer_id: player.viewerId }) })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null }
}

async function load(player: Awaited<ReturnType<typeof newPlayer>>["player"]) {
    const response = await fastify.inject({ method: "POST", url: "/latest/api/index.php/load", headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, access_token: player.zat }) })
    assert.equal(response.statusCode, 200)
}

afterEach(async () => (await import("../src/lib/campaignModes")).setCampaignModes({}))

// campaign 13: sale 2024-12-01 to 12-24 (Japan time), ticket 999009; campaign 11 sells 2024-04-28 to 05-12
test("a Scouting Ticket Gift Promo is free by default: mailed at the first login, not sold", async () => {
    const { player, id } = await newPlayer("2024-12-10T03:00:00Z", 4000)
    const refused = await buy(player, 13)
    assert.equal(refused.status, 200)
    assert.equal(refused.body.data_headers.result_code, 4702)
    await load(player)
    const mails = data.getPlayerAllMailSync(id)
    assert.equal(mails.filter(mail => mail.typeId === 999009).length, 1, "the ticket")
    assert.ok(!mails.some(mail => mail.type === 7), "no Star Slivers: the promo gave the ticket alone")
    assert.equal(data.getPlayerSync(id)!.freeVmoney, 4000)
})

test("a promo made paid sells its bundle for 1,500 beads, once per season; a season made free isn't sold", async () => {
    const { setCampaignModes, campaignMode } = await import("../src/lib/campaignModes")
    setCampaignModes({ specialExchange: { 13: "paid", 11: "free" } })
    assert.equal(campaignMode("specialExchange", 13), "paid")
    const { player, id } = await newPlayer("2024-12-10T03:00:00Z", 4000)
    const bought = await buy(player, 13)
    assert.equal(bought.status, 200)
    assert.equal(bought.body.data_headers.result_code, 1)
    assert.deepEqual(bought.body.data.user_info, { free_vmoney: 2500, vmoney: 0 })
    assert.equal(data.getPlayerItemSync(id, 999009), 1)
    assert.ok(data.getPlayerAllMailSync(id).some(mail => mail.type === 7 && mail.number === 20), "the bundle's 20 Star Slivers")
    const again = await buy(player, 13)
    assert.equal(again.body.data_headers.result_code, 4702, "once per season: the client's PeriodError (FT-91)")
    assert.equal(data.getPlayerSync(id)!.freeVmoney, 2500, "nothing charged the second time")

    const season = await newPlayer("2024-05-01T03:00:00Z", 4000)
    assert.equal((await buy(season.player, 11)).body.data_headers.result_code, 4702)
})

test("unknown campaigns and modes are refused; the original's mode isn't stored", async () => {
    const { setCampaignModes, campaignModeOverrides } = await import("../src/lib/campaignModes")
    assert.throws(() => setCampaignModes({ specialExchange: { 999: "free" } }), RangeError)
    assert.throws(() => setCampaignModes({ specialExchange: { 11: "cheap" } }), RangeError)
    setCampaignModes({ specialExchange: { 11: "paid", 12: "free", 13: "paid" }, startDash: { 1: "paid" } })
    assert.deepEqual(campaignModeOverrides(), { specialExchange: { 13: "paid" }, startDash: {} })
})

test("the overlay gives changed campaigns' client rows their mode, and leaves the rest", async () => {
    const { buildScheduleOverlay } = await import("../src/lib/scheduleOverlay")
    const { buildOrderedMap, decodeOrderedMap } = await import("../src/lib/orderedmap")
    const table = "campaign/special_exchange/special_exchange_campaign"
    const row = (gift: string, kind: string, price: string, name: string) =>
        [["id", "name", kind, "2024-12-01 14:00:00", "2024-12-24 13:59:59", "2024-12-01 14:00:00", "2024-12-24 13:59:59",
            "banner", "999009", gift, price, "icon", name, "how", "rich"]]
    const master = buildOrderedMap([["11", row("0", "0", "1500", "Dream Unit Scouting Bundle")],
        ["12", row("1", "1", "(None)", "Dream Armament Exchange Ticket")], ["13", row("1", "0", "(None)", "【ギフト】キャラ交換チケット")]]).encode()
    const result = buildScheduleOverlay({ readMaster: name => name === table ? master : undefined },
        { sourceStart: 0, targetStart: 0, rate: 1 }, [table], null, { 12: "paid", 11: "free" })
    // the archive's one member (a single table), stored or deflated
    const archive = result.archive
    const size = archive.readUInt32LE(18)
    const offset = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28)
    const member = archive.subarray(offset, offset + size)
    const { inflateRawSync } = await import("node:zlib")
    const node = decodeOrderedMap(archive.readUInt16LE(8) === 8 ? inflateRawSync(member) : member) as any
    const cells = (key: string) => [9, 10, 12].map(column => node.get(key).getCell(0, column))
    assert.deepEqual(cells("12"), ["0", "750", "Dream Armament Bundle"], "a promo made paid")
    assert.deepEqual(cells("11"), ["1", "1500", "Dream Unit Scouting Bundle"], "a season made free")
    assert.deepEqual(cells("13"), ["1", "(None)", "【ギフト】キャラ交換チケット"], "an unchanged promo")
})
