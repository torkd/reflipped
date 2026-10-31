import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const characterId = 111001
const itemId = 14018

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let player: TestPlayer
let playerId: number

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    player = await createTestPlayer(fastify)

    // the data layer opens the test database, so import it only after createTestServer()
    const { getSession, getAccountPlayers } = await import("../src/data/wdfpData")
    const session = await getSession(String(player.viewerId))
    playerId = (await getAccountPlayers(session!.accountId))[0]
})

after(async () => {
    await cleanup()
})

async function gameRequest(route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ api_count: 1, ...body, viewer_id: player.viewerId })
    })
    return { statusCode: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.body }
}

async function sendMail(mail: Record<string, unknown>) {
    return admin.inject({ method: "POST", url: `/api/player/mail?id=${playerId}`, payload: mail })
}

async function loadMailArrived(): Promise<boolean> {
    const response = await gameRequest("load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(response.statusCode, 200)
    return response.body.data.mail_arrived
}

async function indexMail() {
    const response = await gameRequest("mail/index", { current_page: 1, app_secret: "", app_admin: "" })
    assert.equal(response.statusCode, 200)
    return response.body.data
}

test("mail: send, list, receive one, receive all", async (t) => {
    const ids: Record<string, number> = {}

    await t.test("an empty gift box", async () => {
        assert.deepEqual(await indexMail(), { mail: [], total_count: 0 })
        assert.equal(await loadMailArrived(), false)
    })

    await t.test("the admin player page has the send mail form", async () => {
        const response = await admin.inject({ method: "GET", url: `/player/${playerId}` })
        assert.equal(response.statusCode, 200)
        assert.match(response.body, new RegExp(`id="send-mail" class="card" data-player-id="${playerId}"`))
        assert.match(response.body, /<script src="\/public\/js\/mail-picker.js"><\/script>/)

        const script = await fastify.inject({ method: "GET", url: "/public/js/mail-picker.js" })
        assert.equal(script.statusCode, 200)
        assert.match(script.body, /\/api\/player\/mail\?id=/)
    })

    await t.test("the catalog lists what the mail picker offers", async () => {
        const response = await admin.inject({ method: "GET", url: "/api/catalog" })
        assert.equal(response.statusCode, 200)
        const catalog = response.json()

        const unit = catalog.units.find((candidate: any) => candidate.id === characterId)
        assert.ok(unit, `unit ${characterId} is missing`)
        assert.equal(typeof unit.rarity, "number")
        assert.equal(typeof unit.element, "number")
        assert.ok(catalog.units.every((candidate: any) => /^[1-6]\d{5}$/.test(String(candidate.id))), "only playable units")
        assert.ok(catalog.items.some((candidate: any) => candidate.id === itemId), `item ${itemId} is missing`)
        assert.ok(catalog.equipment.length > 0)
        assert.equal(typeof catalog.hasNames, "boolean")
    })

    await t.test("the admin API validates mail", async () => {
        const base = { subject: "s", description: "d", number: 1 }
        assert.equal((await sendMail({ ...base, type: "ITEM" })).statusCode, 400, "item without type id")
        assert.equal((await sendMail({ ...base, type: "FREE_VMONEY", typeId: 1 })).statusCode, 400, "currency with type id")
        assert.equal((await sendMail({ ...base, type: "NOPE" })).statusCode, 400, "unknown type")
        assert.equal((await sendMail({ ...base, type: "DAILY_CHALLENGE_POINT", typeId: 1 })).statusCode, 400, "type with no server storage")
        assert.equal((await sendMail({ ...base, type: "CHARACTER", typeId: 1234567 })).statusCode, 400, "unknown character")
        assert.equal((await sendMail({ ...base, type: "CHARACTER", typeId: 700000 })).statusCode, 400, "event or guest unit")
        assert.equal((await sendMail({ ...base, type: "FREE_MANA", number: 0 })).statusCode, 400, "zero amount")
        assert.equal((await admin.inject({ method: "POST", url: "/api/player/mail?id=999999", payload: { ...base, type: "FREE_MANA" } })).statusCode, 404)
    })

    await t.test("the admin API sends mail", async () => {
        const mails: Record<string, Record<string, unknown>> = {
            beads: { type: "FREE_VMONEY", number: 300, subject: "Beads", description: "Compensation" },
            item: { type: 1, typeId: itemId, number: 5, subject: "Items", description: "Some items" },
            character: { type: "CHARACTER", typeId: characterId, number: 1, subject: "Unit", description: "A unit", rewardLimitTime: "2030-01-01T00:00Z" }, // the admin page sends datetime-local + "Z"
            // the default server clock is 2025-01-03, so this one has already expired
            expired: { type: "FREE_MANA", number: 1000, subject: "Old", description: "Expired", rewardLimitTime: "2025-01-01T00:00:00Z" }
        }
        for (const [name, mail] of Object.entries(mails)) {
            const response = await sendMail(mail)
            assert.equal(response.statusCode, 200, response.body)
            ids[name] = response.json().id
        }
    })

    await t.test("load lights the gift box badge", async () => {
        assert.equal(await loadMailArrived(), true)
    })

    await t.test("mail/index lists receivable mail, newest first, in the client's format", async () => {
        const data = await indexMail()
        assert.equal(data.total_count, 3)
        assert.deepEqual(data.mail.map((mail: any) => mail.id), [ids.character, ids.item, ids.beads])

        const [character, item, beads] = data.mail
        assert.equal(beads.type, 4)
        assert.equal(beads.type_id, null)
        assert.equal(beads.number, 300)
        assert.equal(beads.subject, "Beads")
        assert.equal(beads.description, "Compensation")
        assert.equal(beads.receive_time, "0000-00-00 00:00:00")
        assert.equal(beads.reward_limit_time, null)
        assert.equal(beads.reward_period_limited, false)
        assert.match(beads.create_time, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
        assert.equal(typeof beads.reason_id, "number")
        assert.equal(item.type_id, itemId)
        assert.equal(character.type, 5)
        assert.equal(character.reward_limit_time, "2030-01-01 00:00:00")
        assert.equal(character.reward_period_limited, true)
    })

    await t.test("mail/index pages past the end are empty", async () => {
        const response = await gameRequest("mail/index", { current_page: 2, app_secret: "", app_admin: "" })
        assert.deepEqual(response.body.data, { mail: [], total_count: 3 })
    })

    let freeVmoney = 0
    await t.test("mail/receive grants one mail", async () => {
        const response = await gameRequest("mail/receive", { mail_id: ids.beads })
        assert.equal(response.statusCode, 200, response.body)
        const data = response.body.data

        const { getPlayerSync } = await import("../src/data/wdfpData")
        freeVmoney = getPlayerSync(playerId)!.freeVmoney
        assert.equal(data.user_info.free_vmoney, freeVmoney)
        assert.ok(freeVmoney >= 300)
        assert.equal(data.total_count, 2)
        assert.equal(data.mail_arrived, true)
        assert.equal(data.dispose_expired_mail, false)
        assert.equal(data.auto_sale_expired_mail, false)
        assert.deepEqual(data.character_list, [])
        assert.deepEqual(data.item_list, {})
    })

    await t.test("mail/receive refuses a mail twice", async () => {
        const response = await gameRequest("mail/receive", { mail_id: ids.beads })
        assert.equal(response.statusCode, 400)
    })

    await t.test("mail/receive_all grants the rest and counts what it skipped", async () => {
        const response = await gameRequest("mail/receive_all", { mail_ids: [ids.character, ids.item, ids.beads, ids.expired, 999999] })
        assert.equal(response.statusCode, 200, response.body)
        const data = response.body.data

        assert.deepEqual(data.mail_ids, [ids.character, ids.item])
        assert.equal(data.already_mail_count, 1)
        assert.equal(data.outdated_mail_count, 1)
        assert.equal(data.deleted_mail_count, 1)
        assert.equal(data.total_count, 0)
        assert.equal(data.mail_arrived, false)
        assert.equal(data.item_list[itemId], 5)
        assert.deepEqual(data.character_list.map((character: any) => character.character_id), [characterId])
        assert.equal(data.user_info.free_vmoney, freeVmoney)
        for (const key of ["max_overed_mail_count", "dispose_expired_mail_count", "auto_sale_expired_mail_count"]) {
            assert.equal(data[key], 0)
        }
    })

    await t.test("the gift box is empty again", async () => {
        assert.deepEqual(await indexMail(), { mail: [], total_count: 0 })
        assert.equal(await loadMailArrived(), false)
    })

    await t.test("pooled exp from mail is usable at once", async () => {
        const { getPlayerSync } = await import("../src/data/wdfpData")
        const expPool = getPlayerSync(playerId)!.expPool
        const sent = await sendMail({ type: "EXP_POOL", number: 500, subject: "Exp", description: "Pooled exp" })
        assert.equal(sent.statusCode, 200, sent.body)

        const response = await gameRequest("mail/receive", { mail_id: sent.json().id })
        assert.equal(response.statusCode, 200, response.body)
        const userInfo = response.body.data.user_info
        assert.equal(userInfo.exp_pool, expPool + 500)
        // the client adds exp for the time since exp_pooled_time and clamps at 0, so it must not be in the future
        assert.ok(userInfo.exp_pooled_time <= response.body.data_headers.servertime,
            `exp_pooled_time ${userInfo.exp_pooled_time} is after servertime ${response.body.data_headers.servertime}`)
    })
})
