import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { LoginBonusGroup } from "../src/data/loginBonusData";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let bonus: typeof import("../src/lib/loginBonus")
let utils: typeof import("../src/utils")
let db: ReturnType<typeof import("../src/data").default>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    bonus = await import("../src/lib/loginBonus")
    utils = await import("../src/utils")
    const database = await import("../src/data")
    db = database.default(0)
})

after(async () => { await cleanup?.() })

async function newPlayer(): Promise<{ player: TestPlayer, id: number }> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return { player, id: (await data.getAccountPlayers(session!.accountId))[0] }
}

function at(time: string): Date {
    const date = new Date(time)
    utils.setServerTime(date)
    return date
}

function mails(id: number) {
    return db.prepare(`SELECT * FROM players_mail WHERE player_id = ? AND reason_id = 55 ORDER BY id`).all(id) as {
        id: number, type: number, type_id: number | null, number: number
    }[]
}

async function request(player: TestPlayer, route: string, body: Record<string, unknown> = {}) {
    const response = await fastify.inject({
        method: "POST", url: `/latest/api/index.php/${route}`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ api_count: 5, ...body, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body)
}

test("login bonuses: /load grants once, stays pending until shown, and isolates players", async () => {
    at("2025-01-03T12:00:00Z")
    const first = await newPlayer()
    const second = await newPlayer()
    const loadBody = { ...readCapturedRoute("load").requestBody, access_token: first.player.zat }
    const loaded = (await request(first.player, "load", loadBody)).data
    assert.deepEqual(loaded.bonus_index_list, [{ bonus_group_id: "normal_2022", bonus_group_type: "Normal", index: 1 }])
    assert.equal(loaded.login_bonus_received_at, 1735905600)
    assert.equal(loaded.mail_arrived, true)
    assert.deepEqual(mails(first.id).map(mail => [mail.type, mail.number]), [[4, 50]])
    const repeated = (await request(first.player, "load", loadBody)).data
    assert.deepEqual(repeated.bonus_index_list, loaded.bonus_index_list)
    assert.equal(mails(first.id).length, 1)
    bonus.applyLoginBonuses(second.id)
    assert.deepEqual((await request(first.player, "bonus/shown")).data, [])
    assert.deepEqual((await request(first.player, "bonus/shown", { retry_count: 1 })).data, [])
    assert.deepEqual(bonus.applyLoginBonuses(first.id).bonusIndexList, [])
    assert.equal(bonus.applyLoginBonuses(second.id).bonusIndexList.length, 1)
    assert.equal(mails(first.id).length, 1)
})

test("login bonuses: game-day boundary, four-entry wrap, missed days, and clock revisit", async () => {
    const { id } = await newPlayer()
    const first = bonus.applyLoginBonuses(id, at("2025-01-03T19:59:59Z"))
    assert.equal(first.bonusIndexList[0].index, 1)
    bonus.acknowledgeLoginBonuses(id)
    assert.equal(bonus.applyLoginBonuses(id, at("2025-01-03T20:00:00Z")).bonusIndexList[0].index, 2)
    bonus.acknowledgeLoginBonuses(id)
    assert.equal(bonus.applyLoginBonuses(id, at("2025-01-20T12:00:00Z")).bonusIndexList[0].index, 3, "no offline backfill")
    bonus.acknowledgeLoginBonuses(id)
    assert.equal(bonus.applyLoginBonuses(id, at("2025-01-21T12:00:00Z")).bonusIndexList[0].index, 4)
    bonus.acknowledgeLoginBonuses(id)
    assert.equal(bonus.applyLoginBonuses(id, at("2025-01-22T12:00:00Z")).bonusIndexList[0].index, 1)
    bonus.acknowledgeLoginBonuses(id)
    assert.deepEqual(bonus.applyLoginBonuses(id, at("2025-01-03T19:59:59Z")).bonusIndexList, [])
    assert.deepEqual(bonus.applyLoginBonuses(id, at("2025-01-22T12:00:00Z")).bonusIndexList, [])
    assert.deepEqual(mails(id).map(mail => [mail.type, mail.type_id, mail.number]), [
        [4, null, 50], [1, 101, 6], [8, null, 1500], [9, null, 5000], [1, 100000, 25], [1, 10001, 1], [4, null, 50]
    ])
})

test("login bonuses: full gift box queues every earned day and later flushes exactly once", async () => {
    const { id } = await newPlayer()
    at("2025-01-03T12:00:00Z")
    db.transaction(() => {
        for (let i = 0; i < 1000; i++) data.insertPlayerMailSync(id, {
            type: 8, typeId: null, number: 1, reasonId: 0, subject: "Gift", description: "",
            createTime: utils.getServerDate(), receiveTime: null, rewardLimitTime: null
        })
    })()
    assert.equal(bonus.applyLoginBonuses(id).bonusIndexList[0].index, 1)
    assert.equal(mails(id).length, 0)
    bonus.acknowledgeLoginBonuses(id)
    bonus.applyLoginBonuses(id, at("2025-01-04T12:00:00Z"))
    assert.equal(mails(id).length, 0)
    const filler = db.prepare(`SELECT id FROM players_mail WHERE player_id = ? ORDER BY id LIMIT 2`).all(id) as { id: number }[]
    for (const mail of filler) data.setPlayerMailReceivedSync(id, mail.id, utils.getServerDate())
    assert.equal(bonus.applyLoginBonuses(id).mailArrived, true)
    assert.deepEqual(mails(id).map(mail => [mail.type, mail.number]), [[4, 50], [1, 6]])
    bonus.applyLoginBonuses(id)
    assert.equal(mails(id).length, 2)
})

test("login bonuses: mail failures roll back the durable receipt and retry remains eligible", async () => {
    const { id } = await newPlayer()
    at("2025-01-03T12:00:00Z")
    db.exec(`CREATE TEMP TRIGGER login_bonus_test_failure BEFORE INSERT ON players_mail
        WHEN NEW.player_id = ${id} BEGIN SELECT RAISE(ABORT, 'test delivery failure'); END`)
    assert.throws(() => bonus.applyLoginBonuses(id), /test delivery failure/)
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM players_login_bonus_receipts WHERE player_id = ?`).get(id) as { n: number }).n, 0)
    db.exec(`DROP TRIGGER login_bonus_test_failure`)
    assert.equal(bonus.applyLoginBonuses(id).bonusIndexList[0].index, 1)
    assert.equal(mails(id).length, 1)
})

test("login bonuses: a partly delivered day resumes with its remaining reward slots", async () => {
    const { id } = await newPlayer()
    bonus.applyLoginBonuses(id, at("2025-01-03T12:00:00Z"))
    bonus.applyLoginBonuses(id, at("2025-01-04T12:00:00Z"))
    for (const mail of mails(id)) data.setPlayerMailReceivedSync(id, mail.id, utils.getServerDate())
    db.transaction(() => {
        for (let i = 0; i < 999; i++) data.insertPlayerMailSync(id, {
            type: 8, typeId: null, number: 1, reasonId: 0, subject: "Gift", description: "",
            createTime: utils.getServerDate(), receiveTime: null, rewardLimitTime: null
        })
    })()
    bonus.applyLoginBonuses(id, at("2025-01-05T12:00:00Z"))
    assert.deepEqual(mails(id).slice(2).map(mail => [mail.type, mail.number]), [[8, 1500]])
    const filler = db.prepare(`SELECT id FROM players_mail WHERE player_id = ? AND reason_id = 0 LIMIT 2`).all(id) as { id: number }[]
    for (const mail of filler) data.setPlayerMailReceivedSync(id, mail.id, utils.getServerDate())
    bonus.applyLoginBonuses(id)
    bonus.applyLoginBonuses(id)
    assert.deepEqual(mails(id).slice(2).map(mail => [mail.type, mail.number]), [[8, 1500], [9, 5000], [1, 25]])
})

test("login bonuses: a separate server process sees the same pending receipt and does not redeliver", async (t) => {
    const { id } = await newPlayer()
    const date = at("2025-01-03T12:00:00Z")
    const expected = bonus.applyLoginBonuses(id, date)
    const script = `const {setServerTime}=require('./src/utils.ts');setServerTime(new Date('${date.toISOString()}'));
        const {applyLoginBonuses}=require('./src/lib/loginBonus.ts');console.log(JSON.stringify(applyLoginBonuses(${id})));`
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env: process.env, encoding: "utf8" })
    // The managed development sandbox forbids child exec; normal CI executes this restart check.
    if ((child.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
        t.skip("Child process execution is unavailable in this sandbox")
        return
    }
    assert.ifError(child.error)
    assert.equal(child.status, 0, child.stderr)
    const replayed = JSON.parse(child.stdout.trim())
    assert.deepEqual(replayed.bonusIndexList, expected.bonusIndexList)
    assert.equal(replayed.loginBonusReceivedAt, expected.loginBonusReceivedAt)
    assert.equal(replayed.mailArrived, false)
    assert.equal(mails(id).length, 1)
})

test("login bonuses: finite campaigns exhaust, close, and annual seasons reset independently", async () => {
    const { id } = await newPlayer()
    for (let day = 24; day <= 27; day++) {
        const result = bonus.applyLoginBonuses(id, at(`2023-06-${day}T06:00:00Z`))
        assert.equal(result.bonusIndexList.find(entry => entry.bonus_group_id === "hw_v21_02")?.index, day - 23)
        bonus.acknowledgeLoginBonuses(id)
    }
    assert.equal(bonus.applyLoginBonuses(id).bonusIndexList.some(entry => entry.bonus_group_id === "hw_v21_02"), false)
    const { id: seasonal } = await newPlayer()
    assert.equal(bonus.applyLoginBonuses(seasonal, at("2025-04-28T03:00:00Z")).bonusIndexList.find(entry => entry.bonus_group_id === "login_bonus_gw")?.index, 1)
    bonus.acknowledgeLoginBonuses(seasonal)
    assert.equal(bonus.applyLoginBonuses(seasonal, at("2025-04-29T03:00:00Z")).bonusIndexList.find(entry => entry.bonus_group_id === "login_bonus_gw")?.index, 2)
    const closed = bonus.applyLoginBonuses(seasonal, at("2025-05-07T20:00:00Z"))
    assert.equal(closed.bonusIndexList.some(entry => entry.bonus_group_id === "login_bonus_gw"), false)
    assert.equal(bonus.applyLoginBonuses(seasonal, at("2026-04-28T03:00:00Z")).bonusIndexList.find(entry => entry.bonus_group_id === "login_bonus_gw")?.index, 1)
    bonus.acknowledgeLoginBonuses(seasonal)
    assert.equal(bonus.applyLoginBonuses(seasonal, at("2025-04-28T03:00:00Z")).bonusIndexList.some(entry => entry.bonus_group_id === "login_bonus_gw"), false, "old season receipt is not earned again")
})

test("login bonuses: Japan-time period boundaries and a season crossing New Year", async () => {
    const { loginBonusGroups } = await import("../src/data/loginBonusData")
    const normal = loginBonusGroups.find(group => group.id === "normal_2022")!
    assert.equal(bonus.loginBonusPeriod(normal, new Date("2024-01-16T19:59:59Z")), null)
    assert.ok(bonus.loginBonusPeriod(normal, new Date("2024-01-16T20:00:00Z")))
    const annual: LoginBonusGroup = { ...normal, startDate: null, endDate: null, annualStart: "12-25 05:00:00", annualEnd: "01-05 04:59:59" }
    assert.deepEqual(bonus.loginBonusPeriod(annual, new Date("2025-01-01T00:00:00Z")), { key: "annual:2024" })
    assert.ok(bonus.loginBonusPeriod(annual, new Date("2025-01-04T19:59:59.999Z")))
    assert.equal(bonus.loginBonusPeriod(annual, new Date("2025-01-04T20:00:00Z")), null)
})

test("login bonuses: every enabled master reward fits a supported gift-box grant", async () => {
    const { loginBonusGroups } = await import("../src/data/loginBonusData")
    const { maxMailNumber } = await import("../src/lib/mail")
    const { getPlayableCharacterIds } = await import("../src/lib/catalog")
    const playable = new Set(getPlayableCharacterIds())
    for (const group of loginBonusGroups.filter(group => group.groupType === "Normal" || group.groupType === "Limited")) {
        for (const day of group.days) {
            assert.ok(day.index >= 1, group.id)
            for (const reward of day.rewards) {
                const type = [4, 1, 5, 8, 9][reward.kind]
                const typeId = reward.kind === 1 ? reward.itemId! : reward.kind === 2 ? reward.characterId! : null
                assert.ok(Number.isInteger(reward.amount) && reward.amount > 0, `${group.id}/${day.index}`)
                assert.ok(reward.amount <= maxMailNumber(type, typeId), `${group.id}/${day.index}: gift type/id/amount`)
                if (reward.kind === 2) assert.ok(playable.has(typeId!), `${group.id}/${day.index}: playable unit`)
            }
        }
    }
})

test("login bonuses: a repeated calendar day in a new era advances the normal calendar once", async () => {
    const { id } = await newPlayer()
    const date = at("2025-01-03T12:00:00Z")
    const { runOnClock } = await import("../src/lib/serverClock")
    assert.equal(bonus.applyLoginBonuses(id, date).bonusIndexList[0].index, 1)
    bonus.acknowledgeLoginBonuses(id)
    runOnClock({ offsetMs: 0, era: 1 }, () => {
        assert.equal(bonus.applyLoginBonuses(id, date).bonusIndexList[0].index, 2)
        bonus.acknowledgeLoginBonuses(id)
        assert.deepEqual(bonus.applyLoginBonuses(id, date).bonusIndexList, [])
    })
    assert.deepEqual(bonus.applyLoginBonuses(id, date).bonusIndexList, [])
    assert.equal(mails(id).length, 2, "one reward for each earned day, with no duplicate day")
})

test("login bonuses: /load earns the player's clock day without changing another player's calendar", async () => {
    at("2025-01-03T12:00:00Z")
    const first = await newPlayer()
    const second = await newPlayer()
    const { setPlayerClockSync } = await import("../src/lib/playerClock")
    setPlayerClockSync(first.id, new Date("2025-01-13T12:00:00Z"))
    const firstLoad = (await request(first.player, "load", { access_token: first.player.zat })).data
    const secondLoad = (await request(second.player, "load", { access_token: second.player.zat })).data
    assert.equal(firstLoad.login_bonus_received_at, Date.parse("2025-01-13T12:00:00Z") / 1000)
    assert.equal(secondLoad.login_bonus_received_at, Date.parse("2025-01-03T12:00:00Z") / 1000)
    assert.equal(firstLoad.bonus_index_list[0].index, 1)
    assert.equal(secondLoad.bonus_index_list[0].index, 1)
    await request(first.player, "bonus/shown")
    setPlayerClockSync(first.id, new Date("2025-01-14T12:00:00Z"))
    assert.equal((await request(first.player, "load", { access_token: first.player.zat })).data.bonus_index_list[0].index, 2)
    assert.equal((await request(second.player, "load", { access_token: second.player.zat })).data.bonus_index_list[0].index, 1)
})

test("login bonuses: an older queued snapshot still delivers source-owned mail", async () => {
    const { id } = await newPlayer()
    const date = at("2025-01-03T12:00:00Z")
    const ids: number[] = []
    db.transaction(() => {
        for (let i = 0; i < 1000; i++) ids.push(data.insertPlayerMailSync(id, {
            type: 8, typeId: null, number: 1, reasonId: 0, subject: "Filler", description: "",
            createTime: date, receiveTime: null, rewardLimitTime: null
        }))
    })()
    bonus.applyLoginBonuses(id, date)
    const receipt = db.prepare("SELECT id, reward_json FROM players_login_bonus_receipts WHERE player_id = ?").get(id) as { id: number, reward_json: string }
    const oldSnapshot = JSON.parse(receipt.reward_json).map(({ durableReward: _, ...mail }: { durableReward?: boolean }) => mail)
    db.prepare("UPDATE players_login_bonus_receipts SET reward_json = ? WHERE id = ?").run(JSON.stringify(oldSnapshot), receipt.id)
    data.setPlayerMailReceivedSync(id, ids[0], date)
    bonus.applyLoginBonuses(id, date)
    const gift = mails(id)[0]
    assert.ok(gift)
    assert.ok(db.prepare("SELECT source_key FROM players_reward_mail_sources WHERE player_id = ? AND mail_id = ?").get(id, gift.id))
})
