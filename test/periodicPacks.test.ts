// FT-89: periodic packs given to every player (src/lib/periodicPacks.ts): a monthly term's start and daily parts, its
// renewal below 3 days left, turning a pack off, the Rank Achievement thresholds (passed ones included), receipts that
// pay once, /load's premium_bonus_list, and the admin route. Game days start at 20:00 UTC.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let packs: typeof import("../src/lib/periodicPacks")
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    packs = await import("../src/lib/periodicPacks")
    utils = await import("../src/utils")
})
afterEach(() => { packs.setEnabledPeriodicPacks([]); utils.setServerTime(null) })
after(async () => { await cleanup() })

async function newPlayer() {
    utils.setServerTime(new Date("2025-01-03T03:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return { player, id: (await data.getAccountPlayers(session!.accountId))[0] }
}

/** The pack mails (reason 9001-9010) a player has, as "reason:type:number". */
function packMails(id: number): string[] {
    return data.getPlayerReceivableMailListSync(id, new Date("2030-01-01T00:00:00Z"), 0, 500)
        .filter(mail => mail.reasonId !== undefined && mail.reasonId >= 9001 && mail.reasonId <= 9010)
        .map(mail => `${mail.reasonId}:${mail.type}:${mail.number}`).sort()
}

function at(time: string, id: number) {
    const date = new Date(time)
    utils.setServerTime(date)
    packs.applyPeriodicPacksSync(id, date)
    return date
}

test("monthly pack: the start part and one daily part a game day, nothing twice", async () => {
    const { id } = await newPlayer()
    packs.setEnabledPeriodicPacks(["monthly"])
    at("2025-01-03T03:00:00Z", id)
    at("2025-01-03T10:00:00Z", id) // same game day
    // free beads (type 4) 500 + 50, mana (type 8) 30,000
    assert.deepEqual(packMails(id), ["9002:4:50", "9002:4:500", "9002:8:30000"].sort())
    at("2025-01-03T21:00:00Z", id) // next game day
    assert.equal(packMails(id).filter(mail => mail === "9002:4:50").length, 2)
    const list = packs.premiumBonusListSync(id, new Date("2025-01-03T21:00:00Z"))
    assert.deepEqual(list, [{ store_product_id: "gs.kg.worldflipper.pakage_monthly", remain_days: 29 }])
})

test("monthly pack: renews below 3 days left; turned off, the term runs out and stops", async () => {
    const { id } = await newPlayer()
    packs.setEnabledPeriodicPacks(["staminade"])
    at("2025-01-03T03:00:00Z", id) // term 2025-01-02 20:00 to 2025-02-01 20:00
    at("2025-01-30T03:00:00Z", id) // 3 days left: no renewal yet
    assert.equal(packMails(id).filter(mail => mail === "9004:4:110").length, 1)
    at("2025-01-31T03:00:00Z", id) // 2 days left: renews, the start part again
    assert.equal(packMails(id).filter(mail => mail === "9004:4:110").length, 2)
    assert.equal(packs.premiumBonusListSync(id, new Date("2025-01-31T03:00:00Z"))[0].remain_days, 32)

    packs.setEnabledPeriodicPacks([])
    at("2025-02-10T03:00:00Z", id) // still in the renewed term: the day's Decanter (item 106) only
    assert.equal(packMails(id).filter(mail => mail === "9004:4:110").length, 2)
    at("2025-03-10T03:00:00Z", id) // past its end: nothing, and no term reported
    assert.deepEqual(packs.premiumBonusListSync(id, new Date("2025-03-10T03:00:00Z")), [])
    const decanters = packMails(id).filter(mail => mail.startsWith("9004:") && !mail.endsWith(":110")).length
    assert.equal(decanters, 4, "the days logged in during terms: 01-03, 01-30, 01-31, 02-10")
})

test("rank packs: the start part once, and every threshold reached, passed ones included", async () => {
    const { id } = await newPlayer()
    const { playerRankSync } = await import("../src/lib/assets")
    // the rank points of rank 30
    let points = 0
    while (playerRankSync(points) < 30) points += 100
    data.updatePlayerSync({ id, rankPoint: points })
    packs.setEnabledPeriodicPacks(["rank_1", "rank_2"])
    at("2025-01-03T03:00:00Z", id)
    at("2025-01-04T03:00:00Z", id)
    // Pack I: 3,000 once, 500 at ranks 10, 20, 30; Pack II: 3,000 once, no threshold below 105
    assert.deepEqual(packMails(id), ["9001:4:3000", "9001:4:500", "9001:4:500", "9001:4:500", "9008:4:3000"].sort())
})

test("periodic packs: /load reports the running terms, and the admin site saves the setting", async () => {
    const { player, id } = await newPlayer()
    const saved = await admin.inject({ method: "POST", url: "/api/server/periodicPacks", payload: { pack_monthly_90: "1", pack_rank_4: "1" } })
    assert.equal(saved.statusCode, 302)
    assert.equal(saved.headers.location, "/settings?message=packs_saved")
    assert.deepEqual([...packs.enabledPeriodicPacks()].sort(), ["monthly_90", "rank_4"])
    assert.equal((await admin.inject({ method: "POST", url: "/api/server/periodicPacks", payload: { pack_nothing: "1" } })).statusCode, 400)
    const page = await admin.inject({ method: "GET", url: "/settings" })
    assert.match(page.body, /Periodic packs/)
    assert.match(page.body, /name="pack_monthly_90" value="1" checked/)

    utils.setServerTime(new Date("2025-01-03T03:00:00Z"))
    const response = await fastify.inject({ method: "POST", url: "/latest/api/index.php/load", headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, access_token: player.zat }) })
    assert.equal(response.statusCode, 200)
    const body = decodeGameBody(response.body).data
    assert.deepEqual(body.premium_bonus_list, [{ store_product_id: "gs.kg.worldflipper.pakage_monthly_90", remain_days: 90 }])
    assert.equal(body.mail_arrived, true)
    assert.ok(packMails(id).includes("9003:4:1000"))
})
