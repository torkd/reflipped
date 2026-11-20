import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, signedGameHeaders, TestPlayer } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let clock: typeof import("../src/utils")
let playerClock: typeof import("../src/lib/playerClock")
let db: ReturnType<typeof import("../src/data").default>
let apiCount = 0

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer({ paramCheck: "enforce" }))
    data = await import("../src/data/wdfpData")
    clock = await import("../src/utils")
    playerClock = await import("../src/lib/playerClock")
    db = (await import("../src/data")).default(0)
})
after(async () => { await cleanup?.() })

async function newPlayer() {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return { ...player, id: (await data.getAccountPlayers(session!.accountId))[0] }
}
async function post(player: TestPlayer, route: string, body: Record<string, unknown> = {}) {
    const url = `/latest/api/index.php/${route}`
    const payload = encodeGameBody({ ...body, viewer_id: player.viewerId, api_count: ++apiCount })
    return fastify.inject({ method: "POST", url, payload, headers: signedGameHeaders(player.udid, player.viewerId, url, payload) })
}
async function load(player: TestPlayer) {
    const response = await post(player, "load", { access_token: player.zat })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body)
}
async function save(id: number) {
    const response = await admin.inject({ method: "GET", url: `/api/player/save?id=${id}` })
    assert.equal(response.statusCode, 200, response.body)
    return response.json()
}
async function importSave(id: number, document: unknown) {
    const boundary = "review-login-bonus-save"
    const response = await admin.inject({
        method: "POST", url: `/api/player/save?id=${id}`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="save-data"; filename="save.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(document)}\r\n--${boundary}--\r\n`
    })
    assert.equal(response.statusCode, 302, response.body)
    assert.equal(response.headers.location, `/player/${id}?message=save-imported`)
}
function bonusMails(id: number) {
    return data.getPlayerAllMailSync(id).filter(mail => mail.reasonId === 55)
}
function at(time: string) { clock.setServerTime(new Date(time)) }

test("login integration: concurrent loads use each account's clock for campaign, receipt, and gift time", async () => {
    at("2025-01-03T12:00:00Z")
    const past = await newPlayer()
    const present = await newPlayer()
    playerClock.setPlayerClockSync(past.id, new Date("2023-06-24T12:00:00Z"))
    const [oldLoad, currentLoad] = await Promise.all([load(past), load(present)])
    assert.equal(oldLoad.data_headers.servertime, Date.parse("2023-06-24T12:00:00Z") / 1000)
    assert.equal(currentLoad.data_headers.servertime, Date.parse("2025-01-03T12:00:00Z") / 1000)
    assert.ok(oldLoad.data.bonus_index_list.some((entry: { bonus_group_id: string }) => entry.bonus_group_id === "hw_v21_02"))
    assert.deepEqual(currentLoad.data.bonus_index_list, [{ bonus_group_id: "normal_2022", bonus_group_type: "Normal", index: 1 }])
    for (const [player, expected] of [[past, "2023-06-24T12:00:00.000Z"], [present, "2025-01-03T12:00:00.000Z"]] as const) {
        assert.ok(bonusMails(player.id).length > 0)
        assert.ok(bonusMails(player.id).every(mail => mail.createTime.toISOString() === expected))
        const receipts = db.prepare("SELECT received_at FROM players_login_bonus_receipts WHERE player_id = ?").all(player.id) as { received_at: number }[]
        assert.ok(receipts.every(receipt => receipt.received_at === Date.parse(expected) / 1000))
    }
})

test("login integration: a new calendar era advances the normal calendar once on a repeated date", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const bonus = await import("../src/lib/loginBonus")
    const { runOnClock } = await import("../src/lib/serverClock")
    const first = runOnClock({ offsetMs: 0, era: 80 }, () => bonus.applyLoginBonuses(player.id))
    assert.equal(first.bonusIndexList[0].index, 1)
    const second = runOnClock({ offsetMs: 0, era: 81 }, () => bonus.applyLoginBonuses(player.id))
    assert.equal(second.bonusIndexList[0].index, 2)
    runOnClock({ offsetMs: 0, era: 81 }, () => bonus.applyLoginBonuses(player.id))
    const count = db.prepare("SELECT COUNT(*) AS n FROM players_login_bonus_receipts WHERE player_id = ?").get(player.id) as { n: number }
    assert.equal(count.n, 2)
    assert.equal(bonusMails(player.id).length, 2)
})

test("login integration: importing explicit older mail keeps the already earned login gift", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const older = await save(player.id)
    assert.deepEqual(older.user_mail_list, [])
    await load(player)
    assert.equal(bonusMails(player.id).length, 1)
    await importSave(player.id, older)
    await load(player)
    assert.equal(bonusMails(player.id).filter(mail => mail.receiveTime === null).length, 1)
})

test("login integration: importing a pending-mail snapshot cannot reopen a received login gift", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    await load(player)
    const pending = await save(player.id)
    const mail = bonusMails(player.id)[0]
    const received = await post(player, "mail/receive", { mail_id: mail.id })
    assert.equal(received.statusCode, 200, received.body)
    assert.equal(data.getPlayerMailSync(player.id, mail.id)?.receiveTime instanceof Date, true)
    await importSave(player.id, pending)
    await load(player)
    assert.equal(bonusMails(player.id).filter(gift => gift.receiveTime === null).length, 0)
    assert.equal(bonusMails(player.id).filter(gift => gift.receiveTime !== null).length, 1)
})

test("login integration: a save without mail preserves the earned gift's ID and bonus acknowledgement", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    await load(player)
    assert.equal((await post(player, "bonus/shown")).statusCode, 200)
    const oldFormat = await save(player.id)
    delete oldFormat.user_mail_list
    const gifts = bonusMails(player.id)
    await importSave(player.id, oldFormat)
    assert.deepEqual(bonusMails(player.id), gifts)
    assert.deepEqual((await load(player)).data.bonus_index_list, [])
})

test("login integration: retaining ordinary mission claims through import also retains their earned gifts", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const older = await save(player.id)
    const missions = await import("../src/lib/missions")
    data.runInTransactionSync(() => missions.updateMissionsSync(player.id, clock.getServerDate(), [
        { pattern: missions.MissionPattern.CHARACTER_LEVEL_ACHIEVEMENT, value: 10 }
    ]))
    const earned = data.getPlayerAllMailSync(player.id).filter(mail => mail.reasonId === missions.missionRewardMailReasonId)
    assert.ok(earned.length > 0)
    await importSave(player.id, older)
    assert.equal(data.getPlayerClearedRegularMissionListSync(player.id)["9"], 1)
    const remaining = data.getPlayerAllMailSync(player.id).filter(mail => mail.reasonId === missions.missionRewardMailReasonId)
    assert.deepEqual(remaining.map(mail => [mail.type, mail.typeId, mail.number]), earned.map(mail => [mail.type, mail.typeId, mail.number]))
})

test("login integration: trimmed reward history still suppresses an older pending snapshot", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    await load(player)
    const pending = await save(player.id)
    const mail = bonusMails(player.id)[0]
    assert.equal(typeof mail.rewardSourceKey, "string")
    assert.equal(pending.user_mail_list.find((entry: { reward_source_key?: string }) => entry.reward_source_key === mail.rewardSourceKey)?.receive_time, null)
    assert.equal((await post(player, "mail/receive", { mail_id: mail.id })).statusCode, 200)
    data.trimPlayerMailHistorySync(player.id, 0)
    assert.equal(data.getPlayerMailSync(player.id, mail.id), null)
    assert.deepEqual(db.prepare("SELECT mail_id FROM players_reward_mail_sources WHERE player_id = ? AND source_key = ?").get(player.id, mail.rewardSourceKey), { mail_id: null })
    await importSave(player.id, pending)
    await load(player)
    assert.deepEqual(bonusMails(player.id), [])
    assert.deepEqual(db.prepare("SELECT mail_id FROM players_reward_mail_sources WHERE player_id = ? AND source_key = ?").get(player.id, mail.rewardSourceKey), { mail_id: null })
})

test("login integration: ordinary explicit mailbox replacement still applies beside retained rewards", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const { sendPlayerMailSync } = await import("../src/lib/mail")
    sendPlayerMailSync(player.id, { type: 8, number: 1, subject: "Original ordinary gift", description: "" })
    await load(player)
    const earned = bonusMails(player.id)[0]
    const imported = await save(player.id)
    imported.user_mail_list = imported.user_mail_list.filter((entry: { reason_id: number }) => entry.reason_id === 0)
    imported.user_mail_list[0].subject = "Uploaded ordinary gift"
    imported.user_mail_list[0].number = 2
    await importSave(player.id, imported)
    const ordinary = data.getPlayerAllMailSync(player.id).filter(mail => mail.reasonId === 0)
    assert.equal(ordinary.length, 1)
    assert.equal(ordinary[0].subject, "Uploaded ordinary gift")
    assert.equal(ordinary[0].number, 2)
    assert.equal(ordinary[0].rewardSourceKey, undefined)
    assert.deepEqual(bonusMails(player.id), [earned])
})

test("login integration: another player's exported reward source imports as ordinary mail", async () => {
    at("2025-01-03T12:00:00Z")
    const source = await newPlayer()
    const target = await newPlayer()
    await load(source)
    const sourceSave = await save(source.id)
    const targetSave = await save(target.id)
    const exportedGift = sourceSave.user_mail_list.find((entry: { reason_id: number }) => entry.reason_id === 55)
    assert.equal(typeof exportedGift.reward_source_key, "string")
    targetSave.user_mail_list = [exportedGift]
    await importSave(target.id, targetSave)
    assert.equal(bonusMails(target.id).length, 1)
    assert.equal(bonusMails(target.id)[0].rewardSourceKey, undefined)
    assert.deepEqual(db.prepare("SELECT source_key FROM players_reward_mail_sources WHERE player_id = ?").all(target.id), [])
    targetSave.user_mail_list = []
    await importSave(target.id, targetSave)
    assert.deepEqual(bonusMails(target.id), [])
})

test("login integration: source-link failure rolls back the actual mail insert", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const { sendPlayerMailSync } = await import("../src/lib/mail")
    const options = { type: 8, number: 1, subject: "Earned gift", description: "", durableReward: true }
    const before = data.getPlayerAllMailSync(player.id)
    db.exec(`CREATE TEMP TRIGGER review_source_failure BEFORE INSERT ON players_reward_mail_sources
        WHEN NEW.player_id = ${player.id} BEGIN SELECT RAISE(ABORT, 'source link failure'); END`)
    try {
        assert.throws(() => sendPlayerMailSync(player.id, options), /source link failure/)
        assert.deepEqual(data.getPlayerAllMailSync(player.id), before)
        assert.deepEqual(db.prepare("SELECT source_key FROM players_reward_mail_sources WHERE player_id = ?").all(player.id), [])
    } finally { db.exec("DROP TRIGGER review_source_failure") }
    const id = sendPlayerMailSync(player.id, options)
    assert.equal(typeof data.getPlayerMailSync(player.id, id)?.rewardSourceKey, "string")
})

test("login integration: reward source keys stay out of the game's gift box payload", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    await load(player)
    const mail = bonusMails(player.id)[0]
    assert.equal(typeof mail.rewardSourceKey, "string")
    const list = await post(player, "mail/index", { page: 1 })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(JSON.stringify(decodeGameBody(list.body)).includes(mail.rewardSourceKey!), false)
})

test("login integration: an omitted mailbox keeps mixed reward and ordinary history in receipt order", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const { sendPlayerMailSync } = await import("../src/lib/mail")
    await load(player)
    const earned = bonusMails(player.id)[0]
    const ordinaryId = sendPlayerMailSync(player.id, { type: 8, number: 1, subject: "Ordinary gift", description: "" })
    assert.equal((await post(player, "mail/receive", { mail_id: earned.id })).statusCode, 200)
    assert.equal((await post(player, "mail/receive", { mail_id: ordinaryId })).statusCode, 200)
    const before = data.getPlayerMailHistorySync(player.id, 0, 500)
    const older = await save(player.id)
    delete older.user_mail_list
    await importSave(player.id, older)
    assert.deepEqual(data.getPlayerMailHistorySync(player.id, 0, 500), before)
})

test("login integration: an unchanged explicit save keeps current-era ordinary history visible", async () => {
    at("2025-01-04T12:00:00Z")
    const player = await newPlayer()
    const { sendPlayerMailSync, listMailHistorySync } = await import("../src/lib/mail")
    await load(player)
    const earned = bonusMails(player.id)[0]
    assert.equal((await post(player, "mail/receive", { mail_id: earned.id })).statusCode, 200)
    // A received gift from before a clock rewind is the cutoff for the current history.
    at("2025-01-03T12:00:00Z")
    const ordinaryId = sendPlayerMailSync(player.id, { type: 8, number: 1, subject: "Current-era ordinary gift", description: "" })
    assert.equal((await post(player, "mail/receive", { mail_id: ordinaryId })).statusCode, 200)
    const before = listMailHistorySync(player.id, clock.getServerDate()).map(mail => mail.subject)
    assert.deepEqual(before, ["Current-era ordinary gift"])
    const document = await save(player.id)
    await importSave(player.id, document)
    assert.deepEqual(listMailHistorySync(player.id, clock.getServerDate()).map(mail => mail.subject), before)
})

test("login integration: upgrading existing mission mail preserves its gift when claims are retained", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const older = await save(player.id)
    // origin/develop's FT-2 engine sends this mail without a durable source identity.
    data.setPlayerClearedRegularMissionSync(player.id, 9, 1)
    const id = data.insertPlayerMailSync(player.id, {
        type: 4, typeId: null, number: 10, reasonId: 60,
        subject: "Mission Reward", description: "You have received the following mission reward(s).",
        createTime: clock.getServerDate(), receiveTime: null, rewardLimitTime: null
    })
    // Simulate starting the new server against a database which already held the earned FT-2 gift.
    const initialize = (await import("../src/data/initializers/wdfpData")).default
    db.exec("DROP TABLE players_reward_mail_sources")
    initialize(db, true)
    await importSave(player.id, older)
    assert.equal(data.getPlayerClearedRegularMissionListSync(player.id)["9"], 1)
    assert.ok(data.getPlayerMailSync(player.id, id), "the retained claim must retain its pre-upgrade pending gift")
})

test("login integration: legacy pending snapshots cannot reopen rewards after migration and history trim", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const legacyId = data.insertPlayerMailSync(player.id, {
        type: 4, typeId: null, number: 10, reasonId: 60,
        subject: "Mission Reward", description: "Legacy earned gift",
        createTime: clock.getServerDate(), receiveTime: null, rewardLimitTime: null
    })
    const legacySave = await save(player.id)
    assert.equal(legacySave.user_mail_list[0].reward_source_key, undefined)
    db.exec("DROP TABLE players_reward_mail_sources")
    const initialize = (await import("../src/data/initializers/wdfpData")).default
    initialize(db, true)
    const adopted = data.getPlayerMailSync(player.id, legacyId)!
    assert.equal(typeof adopted.rewardSourceKey, "string")
    assert.equal((await post(player, "mail/receive", { mail_id: legacyId })).statusCode, 200)
    data.trimPlayerMailHistorySync(player.id, 0)
    const fingerprint = db.prepare("SELECT content_fingerprint FROM players_reward_mail_sources WHERE player_id = ? AND source_key = ?").get(player.id, adopted.rewardSourceKey) as { content_fingerprint: string }
    assert.match(fingerprint.content_fingerprint, /^[a-f0-9]{64}$/)
    await importSave(player.id, legacySave)
    assert.deepEqual(data.getPlayerAllMailSync(player.id), [])
    assert.deepEqual(db.prepare("SELECT mail_id, content_fingerprint FROM players_reward_mail_sources WHERE player_id = ? AND source_key = ?").get(player.id, adopted.rewardSourceKey), { mail_id: null, content_fingerprint: fingerprint.content_fingerprint })
})

test("login integration: identical legacy gifts are matched as a multiset without reviving trimmed copies", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const ids = Array.from({ length: 2 }, () => data.insertPlayerMailSync(player.id, {
        type: 4, typeId: null, number: 10, reasonId: 60,
        subject: "Mission Reward", description: "Identical legacy gift",
        createTime: clock.getServerDate(), receiveTime: null, rewardLimitTime: null
    }))
    const legacySave = await save(player.id)
    db.exec("DROP TABLE players_reward_mail_sources")
    ;(await import("../src/data/initializers/wdfpData")).default(db, true)
    assert.equal((await post(player, "mail/receive", { mail_id: ids[0] })).statusCode, 200)
    data.trimPlayerMailHistorySync(player.id, 0)
    for (let attempt = 0; attempt < 2; attempt++) {
        await importSave(player.id, legacySave)
        const current = data.getPlayerAllMailSync(player.id)
        assert.equal(current.length, 1)
        assert.equal(current[0].id, ids[1])
        assert.equal(current[0].receiveTime, null)
    }
})

test("login integration: supplied foreign keys bypass legacy matching even for identical local contents", async () => {
    at("2025-01-03T12:00:00Z")
    const source = await newPlayer()
    const target = await newPlayer()
    await load(source)
    await load(target)
    const local = bonusMails(target.id)[0]
    const sourceGift = (await save(source.id)).user_mail_list.find((entry: { reason_id: number }) => entry.reason_id === 55)
    const document = await save(target.id)
    document.user_mail_list = [sourceGift]
    await importSave(target.id, document)
    const imported = bonusMails(target.id)
    assert.equal(imported.length, 2)
    assert.ok(imported.some(mail => mail.id === local.id && mail.rewardSourceKey === local.rewardSourceKey))
    assert.equal(imported.filter(mail => mail.rewardSourceKey === undefined).length, 1)
})

test("login integration: legacy identity is captured before future mail is rebased by clock travel", async () => {
    at("2025-01-04T12:00:00Z")
    const player = await newPlayer()
    const id = data.insertPlayerMailSync(player.id, {
        type: 4, typeId: null, number: 10, reasonId: 60,
        subject: "Mission Reward", description: "Future legacy gift",
        createTime: clock.getServerDate(), receiveTime: null, rewardLimitTime: null
    })
    const legacySave = await save(player.id)
    db.exec("DROP TABLE players_reward_mail_sources")
    ;(await import("../src/data/initializers/wdfpData")).default(db, true)
    at("2025-01-03T12:00:00Z")
    await importSave(player.id, legacySave)
    const current = data.getPlayerAllMailSync(player.id)
    assert.equal(current.length, 1)
    assert.equal(current[0].id, id)
    assert.equal(current[0].createTime.toISOString(), "2025-01-04T12:00:00.000Z")
})

test("login integration: retained title mission claims also retain their owned titles", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const older = await save(player.id)
    assert.deepEqual(older.user_degree_list, [])
    const earned = await post(player, "mission/update_mission_progress", { mission_param_list: [{ mission_pattern: "home_tap_town_character_count", progress_value: 5 }] })
    assert.equal(earned.statusCode, 200, earned.body)
    assert.ok(data.getPlayerDegreesSync(player.id).includes(49000))
    await importSave(player.id, older)
    assert.ok(data.getPlayerDegreesSync(player.id).includes(49000))
})

test("login integration: a reward received after a pending snapshot stays last in receipt order", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const { sendPlayerMailSync, listMailHistorySync } = await import("../src/lib/mail")
    await load(player)
    const earned = bonusMails(player.id)[0]
    const ordinaryId = sendPlayerMailSync(player.id, { type: 8, number: 1, subject: "Earlier ordinary gift", description: "" })
    assert.equal((await post(player, "mail/receive", { mail_id: ordinaryId })).statusCode, 200)
    const pendingSnapshot = await save(player.id)
    at("2025-01-04T12:00:00Z")
    assert.equal((await post(player, "mail/receive", { mail_id: earned.id })).statusCode, 200)
    const before = listMailHistorySync(player.id, clock.getServerDate()).map(mail => mail.subject)
    assert.deepEqual(before, ["Login Bonus", "Earlier ordinary gift"])
    await importSave(player.id, pendingSnapshot)
    assert.deepEqual(listMailHistorySync(player.id, clock.getServerDate()).map(mail => mail.subject), before)
})

test("login integration: explicit empty titles remove admin and imported titles without earned mission claims", async () => {
    at("2025-01-03T12:00:00Z")
    const player = await newPlayer()
    const { sendPlayerMailSync } = await import("../src/lib/mail")
    const mail = sendPlayerMailSync(player.id, { type: 13, typeId: 49000, number: 1, subject: "Admin title", description: "" })
    assert.equal((await post(player, "mail/receive", { mail_id: mail })).statusCode, 200)
    assert.ok(data.getPlayerDegreesSync(player.id).includes(49000))
    const document = await save(player.id)
    document.user_degree_list = [47000, 49000]
    await importSave(player.id, document)
    assert.deepEqual(data.getPlayerDegreesSync(player.id), [47000, 49000])
    assert.equal(data.getPlayerMissionsSync(player.id, 5).find(claim => claim.missionId === 47000)?.clearedStage ?? 0, 0)
    assert.equal(data.getPlayerMissionsSync(player.id, 5).find(claim => claim.missionId === 49000)?.clearedStage ?? 0, 0)
    document.user_degree_list = []
    await importSave(player.id, document)
    assert.deepEqual(data.getPlayerDegreesSync(player.id), [])
    const response = await post(player, "profile/get_degree_list")
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(decodeGameBody(response.body).data.degree_ids, [1])
})
