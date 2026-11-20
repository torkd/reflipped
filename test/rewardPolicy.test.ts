import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let policy: typeof import("../src/lib/rewardPolicy")
let events: typeof import("../src/lib/eventPolicy")
let utils: typeof import("../src/utils")
let db: ReturnType<typeof import("../src/data").default>
const NOW = new Date("2025-01-03T12:00:00Z")
before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    policy = await import("../src/lib/rewardPolicy")
    events = await import("../src/lib/eventPolicy")
    utils = await import("../src/utils")
    db = (await import("../src/data")).default(0)
    utils.setServerTime(NOW)
})
afterEach(() => {
    policy.setRewardPolicy({ management: "managed", multiplierOverride: 1 })
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "classic" })
})
after(async () => { await cleanup?.() })
async function player() {
    const account = await createTestPlayer(fastify)
    const session = await data.getSession(String(account.viewerId))
    return { ...account, id: (await data.getAccountPlayers(session!.accountId))[0] }
}
function fillBox(id: number) {
    db.transaction(() => {
        for (let i = 0; i < 1000; i++) data.insertPlayerMailSync(id, {
            type: 8, typeId: null, number: 1, reasonId: 0, subject: "Filler", description: "",
            createTime: NOW, receiveTime: null, rewardLimitTime: null
        })
    })()
}
function freeSlot(id: number) {
    const mail = data.getPlayerReceivableMailListSync(id, NOW, 0, 1)[0]
    data.setPlayerMailReceivedSync(id, mail.id, NOW)
}

test("production profile defaults persist independently from Managed overrides", () => {
    assert.deepEqual(policy.setRewardPolicy({ management: "managed", multiplierOverride: null }), [])
    assert.equal(policy.getRewardPolicy().multiplier, 1)
    for (const mode of ["accelerated", "time-travel", "manual"] as const) {
        events.setEventPolicy({ ...events.getEventPolicy(), mode })
        assert.equal(policy.getRewardPolicy().multiplier, 1)
    }
    // Accelerated keeps the original amounts at any speed: its run progress counts the speed instead (FT-32)
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "accelerated", acceleration: 5 })
    assert.equal(policy.getRewardPolicy().multiplier, 1)
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "accelerated", acceleration: 2 })
    assert.deepEqual(policy.setRewardPolicy({ multiplierOverride: 3 }), [])
    events.setEventPolicy({ ...events.getEventPolicy(), mode: "accelerated" })
    assert.equal(policy.getRewardPolicy().multiplier, 3)
    assert.deepEqual(policy.setRewardPolicy({ management: "automatic" }), [])
    assert.equal(policy.getRewardPolicy().multiplier, 1)
    assert.equal(policy.getRewardPolicy().multiplierOverride, null)
    policy.setRewardPolicy({ management: "managed" })
    assert.equal(policy.getRewardPolicy().multiplier, 1, "switching back does not revive an old override")
})

test("invalid policy updates are atomic and Automatic rejects multiplier overrides", () => {
    policy.setRewardPolicy({ management: "managed", multiplierOverride: 2.5 })
    for (const multiplierOverride of [0, -1, Infinity, NaN, "bad", 10.1, {}, true]) {
        assert.deepEqual(policy.setRewardPolicy({ management: "automatic", multiplierOverride }), ["multiplierOverride"])
        assert.equal(policy.getRewardPolicy().management, "managed")
        assert.equal(policy.getRewardPolicy().multiplier, 2.5)
    }
    assert.deepEqual(policy.setRewardPolicy({ management: "bad", multiplierOverride: 2 }), ["management", "multiplierOverride"])
})

test("only explicit currencies scale; tickets, unique counters, units and armaments stay unchanged", () => {
    policy.setRewardPolicy({ multiplierOverride: 2 })
    assert.equal(policy.scaleEarnedAmount(5, "beads"), 10)
    assert.equal(policy.scaleEarnedAmount(5, "mana"), 10)
    assert.equal(policy.scaleEarnedAmount(5, "exp"), 10)
    assert.equal(policy.scaleEarnedAmount(5, "item", 40000), 10, "Boss Coin shop currency")
    assert.equal(policy.scaleEarnedAmount(5, "item", 100000), 10, "Wrightpieces")
    assert.equal(policy.scaleEarnedAmount(1, "item", 10001), 1, "summoning ticket")
    assert.equal(policy.scaleEarnedAmount(1, "item", 99999999), 1, "unknown unique item")
    assert.deepEqual(policy.scaleEarnedReward({ type: 1, id: 2010002, count: 1 } as any), { type: 1, id: 2010002, count: 1 })
    assert.deepEqual(policy.scaleEarnedReward({ type: 2, id: 1 } as any), { type: 2, id: 1 })
    policy.setRewardPolicy({ multiplierOverride: 1.5 })
    assert.equal(policy.scaleEarnedAmount(5, "beads"), 7, "round down once at each earning boundary")
})

test("Automatic blocks every admin reward-changing POST, while downloads and deletes remain available", async () => {
    const p = await player()
    policy.setRewardPolicy({ management: "automatic" })
    const balance = data.getPlayerSync(p.id)!.freeMana
    const mail = { type: 8, number: 5, subject: "Admin gift", description: "Gift" }
    for (const [url, payload] of [
        [`/api/player/mail?id=${p.id}`, mail], ["/api/player/mail/all", mail],
        [`/api/player/developer-mode?id=${p.id}&state=on`, undefined],
        [`/api/player/developer-mode?id=${p.id}&state=off`, undefined],
        [`/api/player/reset?id=${p.id}`, undefined], [`/api/player/save?id=${p.id}`, undefined]
    ] as const) {
        const result = await admin.inject({ method: "POST", url, payload })
        assert.equal(result.statusCode, 403, `${url}: ${result.body}`)
        assert.equal(result.json().code, "automatic-rewards")
    }
    assert.equal(data.getPlayerSync(p.id)!.freeMana, balance)
    assert.equal((await admin.inject({ method: "GET", url: `/api/player/save?id=${p.id}` })).statusCode, 200)
    assert.equal((await admin.inject({ method: "POST", url: `/api/player/delete?id=${p.id}` })).statusCode, 302)
    assert.equal(data.getPlayerSync(p.id), null)
})

test("generic purchase grants and admin mail remain unscaled while explicit quest grants scale once", async () => {
    const p = await player()
    const { givePlayerEarnedRewardSync, givePlayerRewardSync, givePlayerScoreRewardsSync } = await import("../src/lib/quest")
    const { receivePlayerMailsSync } = await import("../src/lib/mail")
    policy.setRewardPolicy({ multiplierOverride: 2 })
    const balance = data.getPlayerSync(p.id)!.freeVmoney
    givePlayerRewardSync(p.id, { type: 3, count: 5 } as any)
    givePlayerEarnedRewardSync(p.id, { type: 3, count: 5 } as any)
    assert.equal(data.getPlayerSync(p.id)!.freeVmoney - balance, 15)
    const coinsBefore = data.getPlayerItemSync(p.id, 40000) ?? 0
    const score = givePlayerScoreRewardsSync(p.id, 1, [{ name: "", type: 0, reward_type: 0, id: 40000, count: 5, field5: 1000 } as any], true)
    // 10 draws of a certain 5-coin drop, doubled by the boost point and again by the policy
    assert.equal(data.getPlayerItemSync(p.id, 40000)! - coinsBefore, 200)
    assert.equal(score.drop_score_reward_ids.length, 10)
    assert.equal(score.drop_score_reward_ids[0].number, 20)
    const sent = await admin.inject({ method: "POST", url: `/api/player/mail?id=${p.id}`, payload: { type: 8, number: 7, subject: "Gift", description: "" } })
    assert.equal(sent.statusCode, 200)
    const beforeMana = data.getPlayerSync(p.id)!.freeMana
    receivePlayerMailsSync(p.id, [sent.json().id])
    assert.equal(data.getPlayerSync(p.id)!.freeMana - beforeMana, 7)
})

test("login entitlements freeze their multiplier before a full gift box and are not scaled at receive", async () => {
    const p = await player()
    const { applyLoginBonuses } = await import("../src/lib/loginBonus")
    const { receivePlayerMailsSync } = await import("../src/lib/mail")
    fillBox(p.id)
    policy.setRewardPolicy({ multiplierOverride: 2 })
    applyLoginBonuses(p.id, NOW)
    policy.setRewardPolicy({ multiplierOverride: 4 })
    freeSlot(p.id)
    applyLoginBonuses(p.id, NOW)
    const mail = (db.prepare(`SELECT id, number FROM players_mail WHERE player_id = ? AND reason_id = 55`).get(p.id) as { id: number, number: number })
    assert.equal(mail.number, 100)
    const before = data.getPlayerSync(p.id)!.freeVmoney
    receivePlayerMailsSync(p.id, [mail.id])
    assert.equal(data.getPlayerSync(p.id)!.freeVmoney - before, 100)
})

test("mission entitlements retain earning-time rewards across daily reset and later claims", async () => {
    const p = await player()
    const missions = await import("../src/lib/missions")
    fillBox(p.id)
    policy.setRewardPolicy({ multiplierOverride: 2 })
    missions.updateMissionsSync(p.id, NOW, [{ pattern: 12, amount: 3, matches: mission => missions.missionMatchesQuest(mission, 1, 1001002) }])
    missions.updateMissionsSync(p.id, NOW, [{ pattern: 60, amount: 1 }])
    policy.setRewardPolicy({ multiplierOverride: 4 })
    missions.resetDailyMissionsSync(p.id)
    freeSlot(p.id)
    missions.drainPendingMissionRewardsSync(p.id, NOW)
    const reward = db.prepare(`SELECT number FROM players_mail WHERE player_id = ? AND reason_id = 60`).get(p.id) as { number: number }
    assert.equal(reward.number, 30, "15 beads were earned with the old 2x policy")
    const before = data.getPlayerSync(p.id)!.expPool
    missions.receiveActiveMissionsSync(p.id, [{ missionId: 11090, stages: [1] }], NOW)
    assert.equal(data.getPlayerSync(p.id)!.expPool - before, 2000, "Step Up's 1000 EXP snapshot predates the 4x policy")
})

test("all stages reached by one blocked action retain their original multiplier", async () => {
    const p = await player()
    const missions = await import("../src/lib/missions")
    fillBox(p.id)
    policy.setRewardPolicy({ multiplierOverride: 2 })
    missions.updateMissionsSync(p.id, NOW, [{ pattern: 28, value: 100 }])
    policy.setRewardPolicy({ multiplierOverride: 4 })
    for (let i = 0; i < 5; i++) freeSlot(p.id)
    missions.updateMissionsSync(p.id, NOW, [])
    const rewards = db.prepare(`SELECT number FROM players_mail WHERE player_id = ? AND reason_id = 60 ORDER BY id`).all(p.id) as { number: number }[]
    assert.deepEqual(rewards.map(row => row.number), [10, 10, 10, 10, 10])
})

test("a real battle response and balances use the same multiplier exactly once", async () => {
    const p = await player()
    const request = (route: string, body: object) => fastify.inject({ method: "POST", url: `/latest/api/index.php/single_battle_quest/${route}`,
        headers: gameHeaders(p.udid), payload: encodeGameBody({ viewer_id: p.viewerId, api_count: 1, quest_id: 1001002, category: 1, party_id: 1, ...body }) })
    policy.setRewardPolicy({ multiplierOverride: 2 })
    assert.equal((await request("start", { use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false })).statusCode, 200)
    const before = data.getPlayerSync(p.id)!
    policy.setRewardPolicy({ multiplierOverride: 4 })
    const finish = await request("finish", { score: 0, elapsed_time_ms: 10000, add_mana: 10, is_accomplished: true,
        statistics: { party: { characters: [{ id: 1 }], unison_characters: [] } } })
    assert.equal(finish.statusCode, 200, finish.body)
    const result = decodeGameBody(finish.body).data
    const { getQuestFromCategorySync } = await import("../src/lib/assets")
    const quest = getQuestFromCategorySync(1, 1001002) as import("../src/lib/types").BattleQuest
    assert.equal(result.rewards.reward_mana, quest.manaReward * 2)
    assert.equal(result.rewards.reward_pool_exp, quest.poolExpReward * 2)
    assert.equal(result.rewards.field_mana, 20)
    assert.equal(result.user_info.rank_point - before.rankPoint, quest.rankPointReward * 2)
    assert.equal(result.user_info.free_mana, data.getPlayerSync(p.id)!.freeMana)
})

function withScheduledContent<T>(fn: () => T): T {
    const clock = process.env.SERVER_CLOCK
    const scheduling = process.env.EVENT_SCHEDULING
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
    try { return fn() } finally {
        if (clock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = clock
        if (scheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = scheduling
    }
}

test("co-op event objectives use the captured host occurrence and multiplier while daily progress stays with the guest", async () => {
    const p = await player()
    const missions = await import("../src/lib/missions")
    const schedule = await import("../src/lib/eventSchedule")
    policy.setRewardPolicy({ multiplierOverride: 4 })
    data.setPlayerResetsSync(p.id, { day: "2025-01-03", month: "2025-01" })
    data.setPlayerMissionSync(p.id, 2, { missionId: 6, progress: 2, clearedStage: 0 })
    const guest = { occurrenceKey: "guest-current", contentTime: NOW.getTime(), profile: "classic" as const }
    const host = { occurrenceKey: "host-earlier", contentTime: Date.parse("2021-10-20T12:00:00Z"), profile: "classic" as const, rewardMultiplier: 2 }
    withScheduledContent(() => schedule.runOnCapturedEventContext(guest, () => missions.updateMissionsSync(p.id, NOW, [
        { pattern: 35, amount: 50, matches: mission => mission.itemId === 80001 },
        { pattern: 12, amount: 1, matches: mission => missions.missionMatchesQuest(mission, 1, 1001002) }
    ], host)))
    assert.equal(data.getPlayerMissionsSync(p.id, 4).find(row => row.missionId === 1500)!.clearedStage, 1)
    assert.equal(data.getPlayerMissionsSync(p.id, 2).find(row => row.missionId === 6)!.progress, 3)
    assert.equal(data.getPlayerResetsSync(p.id)!.day, "2025-01-03")
    const mails = db.prepare(`SELECT type, number FROM players_mail WHERE player_id = ? AND reason_id = 60`).all(p.id) as { type: number, number: number }[]
    assert.ok(mails.some(mail => mail.type === 8 && mail.number === 20000), "host event reward keeps the room's 2x policy")
    assert.ok(mails.some(mail => mail.type === 4 && mail.number === 60), "guest daily reward uses the guest's current 4x policy")
})

test("event run histories repeat on a new occurrence and never regrant when revisiting an old room or time view", async () => {
    const p = await player()
    const missions = await import("../src/lib/missions")
    fillBox(p.id)
    const context = (occurrenceKey: string) => ({ occurrenceKey, contentTime: Date.parse("2021-10-20T12:00:00Z"), profile: "classic" as const, rewardMultiplier: 2 })
    const update = [{ pattern: 35, amount: 50, matches: (mission: import("../src/lib/missions").Mission) => mission.itemId === 80001 }]
    withScheduledContent(() => {
        missions.updateMissionsSync(p.id, NOW, update, context("run-a"))
        missions.updateMissionsSync(p.id, NOW, update, context("run-b"))
        missions.updateMissionsSync(p.id, NOW, update, context("run-a"))
        missions.updateMissionsSync(p.id, NOW, update, context("run-b"))
    })
    const pending = data.getPlayerMissionRewardBacklogSync(p.id).filter(row => row.category === 4 && row.missionId === 1500)
    assert.equal(pending.length, 2, "one entitlement per real server occurrence, despite repeated visits")
    assert.ok(pending.every(row => JSON.parse(row.rewardsJson!)[0].amount === 20000))
    const progress = data.getPlayerMissionsSync(p.id, 4).find(row => row.missionId === 1500)!
    assert.equal(progress.clearedStage, 1)
    assert.equal(progress.progress, 50)
})

test("limited login campaigns use content availability and server occurrences without moving real reward days", async () => {
    const p = await player()
    const { applyLoginBonuses } = await import("../src/lib/loginBonus")
    const { loginBonusGroups } = await import("../src/data/loginBonusData")
    const schedule = await import("../src/lib/eventSchedule")
    const group = loginBonusGroups.find(group => group.groupType === "Limited" && group.startDate !== null)!
    const contentTime = utils.masterDate(group.startDate!).getTime() + 1000
    withScheduledContent(() => {
        for (const occurrenceKey of ["login-run-a", "login-run-a", "login-run-b", "login-run-a"]) {
            schedule.runOnCapturedEventContext({ occurrenceKey, contentTime, profile: "classic" }, () => applyLoginBonuses(p.id, NOW))
        }
    })
    const receipts = db.prepare(`SELECT game_day, period_key FROM players_login_bonus_receipts WHERE player_id = ? AND group_id = ?`).all(p.id, group.id) as { game_day: string, period_key: string }[]
    assert.equal(receipts.length, 2)
    assert.ok(receipts.every(row => row.game_day.startsWith("2025-01-03")))
    assert.ok(receipts.some(row => row.period_key.endsWith(":run:login-run-a")))
    assert.ok(receipts.some(row => row.period_key.endsWith(":run:login-run-b")))
})

test("Automatic explains and disables player and broadcast reward forms without disabling downloads or deletes", async () => {
    const p = await player()
    policy.setRewardPolicy({ management: "automatic" })
    const detail = await admin.inject({ method: "GET", url: `/player/${p.id}` })
    assert.equal(detail.statusCode, 200)
    assert.match(detail.body, /Automatic reward management locks/)
    assert.match(detail.body, /href="\/settings"/)
    assert.match(detail.body, /class="file-input" disabled/)
    assert.match(detail.body, /disabled>Upload save/)
    assert.match(detail.body, /disabled>Turn on/)
    assert.match(detail.body, /disabled>Reset progress/)
    assert.doesNotMatch(detail.body, /disabled>Delete player/)
    assert.match(detail.body, /Download save<\/a>/)
    assert.match(detail.body, /<fieldset disabled/)
    const list = await admin.inject({ method: "GET", url: "/player" })
    assert.match(list.body, /data-player-id="all" data-reward-locked="true"/)
    assert.match(list.body, /<fieldset disabled/)
    policy.setRewardPolicy({ management: "managed" })
    const unlocked = await admin.inject({ method: "GET", url: `/player/${p.id}` })
    assert.doesNotMatch(unlocked.body, /Automatic reward management locks/)
    assert.doesNotMatch(unlocked.body, /<fieldset disabled/)
})

test("Managed save import retains unmailed entitlement snapshots rather than repricing them", async () => {
    const p = await player()
    const missions = await import("../src/lib/missions")
    const exported = await admin.inject({ method: "GET", url: `/api/player/save?id=${p.id}` })
    assert.equal(exported.statusCode, 200)
    fillBox(p.id)
    policy.setRewardPolicy({ multiplierOverride: 2 })
    missions.updateMissionsSync(p.id, NOW, [{ pattern: 28, value: 100 }])
    const boundary = "reward-policy-snapshot"
    const imported = await admin.inject({ method: "POST", url: `/api/player/save?id=${p.id}`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="save-data"; filename="save.json"\r\nContent-Type: application/json\r\n\r\n${exported.body}\r\n--${boundary}--\r\n` })
    assert.equal(imported.statusCode, 302)
    assert.equal(imported.headers.location, `/player/${p.id}?message=save-imported`)
    policy.setRewardPolicy({ multiplierOverride: 4 })
    missions.updateMissionsSync(p.id, NOW, [])
    const rewards = db.prepare(`SELECT number FROM players_mail WHERE player_id = ? AND reason_id = 60 ORDER BY id`).all(p.id) as { number: number }[]
    assert.deepEqual(rewards.map(row => row.number), [10, 10, 10, 10, 10])
})

test("earned batches cap the final paid-plus-free wallet, repeated item totals, units and armaments", async () => {
    const p = await player()
    const { playerLimits, getItemMaxCountSync } = await import("../src/lib/limits")
    const { givePlayerEarnedRewardsSync } = await import("../src/lib/quest")
    const { validateSaveData } = await import("../src/data/saveSchema")
    const coinMax = getItemMaxCountSync(40000)!
    data.updatePlayerSync({ id: p.id, vmoney: playerLimits.virtualMoney - 12, freeVmoney: 10,
        freeMana: playerLimits.mana - 5, expPool: playerLimits.expPool - 6 })
    data.givePlayerItemSync(p.id, 40000, coinMax - 3)
    data.updatePlayerCharacterSync(p.id, 1, { stack: playerLimits.unitCopies - 2 })
    data.givePlayerItemSync(p.id, 14002, getItemMaxCountSync(14002)!)
    data.insertPlayerEquipmentSync(p.id, 2010002, { enhancementLevel: 0, level: 1, protection: false, stack: playerLimits.equipmentCopies - 2 })
    policy.setRewardPolicy({ multiplierOverride: 2 })
    const rewards = givePlayerEarnedRewardsSync(p.id, [
        { type: 3, count: 5 }, { type: 3, count: 5 }, { type: 4, count: 2 }, { type: 4, count: 2 },
        { type: 5, count: 2 }, { type: 5, count: 2 }, { type: 0, id: 40000, count: 2 }, { type: 0, id: 40000, count: 2 },
        { type: 2, id: 1 }, { type: 2, id: 1 }, { type: 1, id: 2010002, count: 5 }
    ] as any[])!
    assert.deepEqual(rewards.user_info, { free_vmoney: 2, free_mana: 5, exp_pool: 6 })
    const final = data.getPlayerSync(p.id)!
    assert.equal(final.vmoney + final.freeVmoney, playerLimits.virtualMoney)
    assert.equal(final.freeMana, playerLimits.mana)
    assert.equal(final.expPool, playerLimits.expPool)
    assert.equal(rewards.items[40000], coinMax)
    assert.equal(data.getPlayerItemSync(p.id, 40000), coinMax)
    assert.equal(data.getPlayerItemSync(p.id, 14002), getItemMaxCountSync(14002))
    assert.equal(data.getPlayerCharacterSync(p.id, 1)!.stack + 1, playerLimits.unitCopies)
    assert.equal(data.getPlayerEquipmentSync(p.id, 2010002)!.stack + 1, playerLimits.equipmentCopies)
    const exported = await admin.inject({ method: "GET", url: `/api/player/save?id=${p.id}` })
    assert.doesNotThrow(() => validateSaveData(JSON.parse(exported.body)))
})

test("score reward response counts describe actual credits after common and rare pools hit caps", async () => {
    const p = await player()
    const { playerLimits, getItemMaxCountSync } = await import("../src/lib/limits")
    const { givePlayerScoreRewardsSync } = await import("../src/lib/quest")
    data.updatePlayerSync({ id: p.id, freeMana: playerLimits.mana - 7, expPool: playerLimits.expPool - 9 })
    data.givePlayerItemSync(p.id, 42, getItemMaxCountSync(42)! - 2)
    policy.setRewardPolicy({ multiplierOverride: 2 })
    const { scoreRewardDrops } = await import("../src/lib/quest")
    const saved = { ...scoreRewardDrops }
    // one draw per entry (weights 1000 each out of 3000), then the rare slot's chance and its pick
    const draws = [0.1, 0.5, 0.9, 0.5, 0.5]
    scoreRewardDrops.rolls = 3
    scoreRewardDrops.random = () => draws.shift()!
    let result: ReturnType<typeof givePlayerScoreRewardsSync>
    try {
        result = givePlayerScoreRewardsSync(p.id, 1, [
            { type: 0, reward_type: 0, id: 42, count: 2 },
            { type: 0, reward_type: 4, count: 4 }, { type: 0, reward_type: 5, count: 5 },
            { type: 1, id: 2101, rarity: 1 }
        ] as any[])
    } finally { Object.assign(scoreRewardDrops, saved) }
    assert.deepEqual(result.drop_score_reward_ids.map(row => row.number), [2, 7, 9])
    assert.equal(result.drop_rare_reward_ids[0].number, 0)
    assert.equal(result.items[42], getItemMaxCountSync(42))
    assert.deepEqual(result.user_info, { free_mana: 7, free_vmoney: 0, exp_pool: 9 })
})

test("base, field, clear, score and party-overflow earnings share final inventory capacity", async () => {
    const p = await player()
    const { playerLimits, getItemMaxCountSync } = await import("../src/lib/limits")
    const { characterExpCaps } = await import("../src/lib/character")
    const { validateSaveData } = await import("../src/data/saveSchema")
    const quests = require("../assets/main_quest.json") as Record<string, any>
    const clears = require("../assets/clear_reward.json") as Record<string, any>
    const scores = require("../assets/score_reward.json") as Record<string, any>
    // A deterministic authored quest exercises all earning boundaries in one real finish transaction.
    const questId = 1999002
    quests[questId] = { ...quests[1001002], clearRewardId: 9999991, sPlusRewardId: 9999992, scoreRewardGroup: 9999993, scoreRewardRolls: 4 }
    clears[9999991] = { type: 4, count: 10 }
    clears[9999992] = { type: 5, count: 10 }
    scores[9999993] = [ { type: 0, reward_type: 4, count: 10 }, { type: 0, reward_type: 5, count: 10 },
        { type: 0, reward_type: 0, id: 40000, count: 10 }, { type: 0, reward_type: 0, id: 40000, count: 10 } ]
    const { scoreRewardDrops } = await import("../src/lib/quest")
    const savedDrops = { ...scoreRewardDrops }
    // one draw per entry: the weights default to 1000 each, out of 4000
    const draws = [0.125, 0.375, 0.625, 0.875]
    scoreRewardDrops.rolls = 4
    scoreRewardDrops.random = () => draws.shift()!
    const request = (route: string, body: object) => fastify.inject({ method: "POST", url: `/latest/api/index.php/single_battle_quest/${route}`,
        headers: gameHeaders(p.udid), payload: encodeGameBody({ viewer_id: p.viewerId, api_count: 1, quest_id: questId, category: 1, party_id: 1, ...body }) })
    try {
        data.updatePlayerSync({ id: p.id, freeMana: playerLimits.mana - 85, expPool: playerLimits.expPool - 70, rankPoint: 2 ** 31 - 2 })
        data.updatePlayerCharacterSync(p.id, 1, { exp: characterExpCaps[4][0] })
        data.givePlayerItemSync(p.id, 40000, getItemMaxCountSync(40000)! - 25)
        policy.setRewardPolicy({ multiplierOverride: 2 })
        const started = await request("start", { use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false })
        assert.equal(started.statusCode, 200, started.body)
        const finish = await request("finish", { score: 0, elapsed_time_ms: 10000, add_mana: 10, is_accomplished: true,
            statistics: { party: { characters: [{ id: 1 }], unison_characters: [] } } })
        assert.equal(finish.statusCode, 200, finish.body)
        const result = decodeGameBody(finish.body).data
        assert.equal(result.user_info.rank_point, 2 ** 31 - 1)
        assert.equal(result.rewards.reward_mana, 40)
        assert.equal(result.rewards.field_mana, 20)
        assert.equal(result.rewards.reward_pool_exp, 26)
        assert.equal(result.rewards.overflow_pool_exp, 4)
        assert.equal(result.add_exp_list[0].add_exp, 0)
        assert.equal(result.add_exp_list[0].add_exp_pool, 4)
        assert.deepEqual(result.drop_score_reward_ids.map((row: { number: number }) => row.number), [5, 20, 20, 5])
        assert.equal(result.user_info.free_mana, playerLimits.mana)
        assert.equal(result.user_info.exp_pool, playerLimits.expPool)
        assert.equal(result.item_list[40000], getItemMaxCountSync(40000))
        assert.equal(data.getPlayerSync(p.id)!.freeMana, playerLimits.mana)
        assert.equal(data.getPlayerSync(p.id)!.expPool, playerLimits.expPool)
        assert.equal(data.getPlayerItemSync(p.id, 40000), getItemMaxCountSync(40000))
        const exported = await admin.inject({ method: "GET", url: `/api/player/save?id=${p.id}` })
        assert.doesNotThrow(() => validateSaveData(JSON.parse(exported.body)))
    } finally {
        delete quests[questId]; delete clears[9999991]; delete clears[9999992]; delete scores[9999993]
        Object.assign(scoreRewardDrops, savedDrops)
    }
})

test("annual login periods use the selected content year and preserve cross-year occurrence identity", async () => {
    const { loginBonusPeriod } = await import("../src/lib/loginBonus")
    const { loginBonusGroups } = await import("../src/data/loginBonusData")
    const schedule = await import("../src/lib/eventSchedule")
    const group = loginBonusGroups.find(group => group.id === "login_bonus_gw")!
    const realDate = new Date("2026-11-01T12:00:00Z")
    const atContent = (group: import("../src/data/loginBonusData").LoginBonusGroup, contentTime: string) => withScheduledContent(() => schedule.runOnCapturedEventContext({
        occurrenceKey: "annual-contract", contentTime: Date.parse(contentTime), profile: "classic"
    }, () => loginBonusPeriod(group, realDate)))
    assert.deepEqual(atContent(group, "2025-05-01T12:00:00Z"), { key: "annual:2025" })
    assert.equal(atContent(group, "2025-03-01T12:00:00Z"), null)
    const crossYear = { ...group, id: "cross-year-contract", startDate: null, endDate: null,
        annualStart: "12-28 12:00:00", annualEnd: "01-05 04:59:59" }
    assert.deepEqual(atContent(crossYear, "2024-12-30T12:00:00Z"), { key: "annual:2024" })
    assert.deepEqual(atContent(crossYear, "2025-01-02T12:00:00Z"), { key: "annual:2024" })
    assert.deepEqual(atContent(crossYear, "2025-12-30T12:00:00Z"), { key: "annual:2025" })
    assert.equal(atContent(crossYear, "2025-02-01T12:00:00Z"), null)
})

test("annual login boundaries project into the real clock consistently with full campaign periods", async () => {
    const { loginBonusPeriod } = await import("../src/lib/loginBonus")
    const { loginBonusGroups } = await import("../src/data/loginBonusData")
    const schedule = await import("../src/lib/eventSchedule")
    const storage = await import("../src/data/serverSettings")
    const storedWindows = storage.getStoredText("events.manual_windows")
    const oldPolicy = events.getEventPolicy()
    const anchor = Date.parse("2026-11-01T12:00:00Z")
    try {
        schedule.setManualWindows([{ from: "2025-04-01", to: "2025-05-31", label: "Annual contract" }])
        events.setEventPolicy({ ...oldPolicy, mode: "manual", anchor })
        const group = loginBonusGroups.find(group => group.id === "login_bonus_gw")!
        withScheduledContent(() => {
            const view = schedule.getEventScheduleView(anchor)
            const opens = schedule.scheduledMasterTime(utils.masterDate("2025-04-28 12:00:00").getTime(), view)
            const closes = schedule.scheduledMasterTime(utils.masterDate("2025-05-08 04:59:59").getTime(), view) + 1000
            assert.equal(loginBonusPeriod(group, new Date(opens - 1)), null)
            assert.deepEqual(loginBonusPeriod(group, new Date(opens)), { key: "annual:2025" })
            assert.deepEqual(loginBonusPeriod(group, new Date(closes - 1)), { key: "annual:2025" })
            assert.equal(loginBonusPeriod(group, new Date(closes)), null)
        })
    } finally {
        storage.setStoredText("events.manual_windows", storedWindows)
        events.setEventPolicy(oldPolicy)
    }
})

test("bosses have their own multiplier, the general one unless it is set", () => {
    assert.deepEqual(policy.setRewardPolicy({ management: "managed", multiplierOverride: 2, bossMultiplierOverride: null }), [])
    const general = policy.getRewardPolicy()
    assert.equal(general.bossMultiplierOverride, null)
    assert.equal(general.bossMultiplier, 2)
    const { QuestCategory } = require("../src/lib/types") as typeof import("../src/lib/types")
    const bossCategories = [QuestCategory.BOSS_BATTLE, QuestCategory.ADVENT_EVENT_MULTI, QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
        QuestCategory.RAID_EVENT, QuestCategory.HARD_MULTI_EVENT]
    for (const category of [...bossCategories, QuestCategory.MAIN, QuestCategory.STORY_EVENT_SINGLE]) {
        assert.equal(policy.multiplierForCategory(category), 2, `category ${category} before a boss multiplier`)
    }
    assert.deepEqual(policy.setRewardPolicy({ bossMultiplierOverride: 0.5 }), [])
    assert.equal(policy.getRewardPolicy().bossMultiplier, 0.5)
    assert.equal(policy.getRewardPolicy().multiplier, 2, "the general multiplier is untouched")
    for (const category of bossCategories) assert.equal(policy.multiplierForCategory(category), 0.5)
    for (const category of [QuestCategory.MAIN, QuestCategory.EX, QuestCategory.STORY_EVENT_SINGLE, QuestCategory.TOWER_DUNGEON_EVENT]) {
        assert.equal(policy.multiplierForCategory(category), 2)
    }
    // with no boss override, a later general change carries over to bosses
    assert.deepEqual(policy.setRewardPolicy({ bossMultiplierOverride: "" }), [])
    assert.deepEqual(policy.setRewardPolicy({ multiplierOverride: 4 }), [])
    assert.equal(policy.getRewardPolicy().bossMultiplier, 4)
    // out of range or Automatic: refused; Automatic drops the override and uses the profile for both
    for (const bad of [0, -1, 10.1, "bad", NaN]) assert.deepEqual(policy.setRewardPolicy({ bossMultiplierOverride: bad }), ["bossMultiplierOverride"])
    policy.setRewardPolicy({ bossMultiplierOverride: 3 })
    assert.deepEqual(policy.setRewardPolicy({ management: "automatic", bossMultiplierOverride: 3 }), ["bossMultiplierOverride"])
    assert.deepEqual(policy.setRewardPolicy({ management: "automatic" }), [])
    assert.equal(policy.getRewardPolicy().bossMultiplierOverride, null)
    assert.equal(policy.getRewardPolicy().bossMultiplier, policy.getRewardPolicy().profileMultiplier)
})

test("a boss battle earns at the boss multiplier and a main quest at the general one", async () => {
    const { getQuestFromCategorySync } = await import("../src/lib/assets")
    policy.setRewardPolicy({ management: "managed", multiplierOverride: 2, bossMultiplierOverride: 5 })
    for (const [category, questId, multiplier] of [[2, 1033001, 5], [1, 1001002, 2]] as const) {
        const p = await player()
        const request = (route: string, body: object) => fastify.inject({ method: "POST", url: `/latest/api/index.php/single_battle_quest/${route}`,
            headers: gameHeaders(p.udid), payload: encodeGameBody({ viewer_id: p.viewerId, api_count: 1, quest_id: questId, category, party_id: 1, ...body }) })
        assert.equal((await request("start", { use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false })).statusCode, 200)
        const finish = await request("finish", { score: 0, elapsed_time_ms: 10000, add_mana: 0, is_accomplished: true,
            statistics: { party: { characters: [{ id: 1 }], unison_characters: [] } } })
        assert.equal(finish.statusCode, 200, finish.body)
        const result = decodeGameBody(finish.body).data
        const quest = getQuestFromCategorySync(category, questId) as import("../src/lib/types").BattleQuest
        assert.equal(result.rewards.reward_mana, quest.manaReward * multiplier, `category ${category}`)
        assert.equal(result.rewards.reward_pool_exp, quest.poolExpReward * multiplier, `category ${category}`)
    }
    policy.setRewardPolicy({ bossMultiplierOverride: null })
})

test("the settings page works in percent: unchanged values stay, the default is followed, anything else is an override", async () => {
    const save = (body: Record<string, unknown>) => admin.inject({ method: "POST", url: "/api/server/events", payload: { mode: "classic", acceleration: 2, management: "managed", ...body } })
    // the event settings only render with scheduling on, which the tests' frozen clock turns off
    const clock = process.env.SERVER_CLOCK
    const scheduling = process.env.EVENT_SCHEDULING
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
    try {
        policy.setRewardPolicy({ management: "managed", multiplierOverride: null, bossMultiplierOverride: null })
        events.setEventPolicy({ ...events.getEventPolicy(), mode: "classic", acceleration: 2 })
        let page = (await admin.inject({ method: "GET", url: "/settings" })).body
        assert.match(page, /name="multiplierPercent"[^>]* value="100"/)
        assert.match(page, /name="bossMultiplierPercent"[^>]* value="100"/)
        // a page that shows 100 % and sends it back changes nothing
        assert.equal((await save({ multiplierPercent: 100, bossMultiplierPercent: 100 })).statusCode, 302)
        assert.equal(policy.getRewardPolicy().multiplierOverride, null)
        // 150 % is an override; the boss one follows it until it is set
        await save({ multiplierPercent: 150, bossMultiplierPercent: 100 })
        assert.equal(policy.getRewardPolicy().multiplierOverride, 1.5)
        assert.equal(policy.getRewardPolicy().bossMultiplier, 1.5)
        await save({ multiplierPercent: 150, bossMultiplierPercent: 300 })
        assert.equal(policy.getRewardPolicy().bossMultiplierOverride, 3)
        page = (await admin.inject({ method: "GET", url: "/settings" })).body
        assert.match(page, /name="multiplierPercent"[^>]* value="150"/)
        assert.match(page, /name="bossMultiplierPercent"[^>]* value="300"/)
        // setting the boss one to the general one clears it; the general one back to the default clears that
        await save({ multiplierPercent: 150, bossMultiplierPercent: 150 })
        assert.equal(policy.getRewardPolicy().bossMultiplierOverride, null)
        await save({ multiplierPercent: 100, bossMultiplierPercent: 150 })
        assert.equal(policy.getRewardPolicy().multiplierOverride, null)
        assert.equal(policy.getRewardPolicy().bossMultiplier, 1)
        // switching to Accelerated with the page's own, unchanged value keeps following the profile (100 % at any speed)
        const accelerated = await save({ mode: "accelerated", acceleration: 4, multiplierPercent: 100, bossMultiplierPercent: 100 })
        assert.equal(accelerated.statusCode, 302)
        assert.equal(policy.getRewardPolicy().multiplier, 1)
        assert.equal(policy.getRewardPolicy().multiplierOverride, null)
        // out of range and not a number are refused, and nothing is saved
        for (const bad of [5, 1001, "abc"]) {
            assert.equal((await save({ mode: "classic", multiplierPercent: bad })).statusCode, 400, String(bad))
        }
        assert.equal(events.getEventPolicy().mode, "accelerated")
        policy.setRewardPolicy({ management: "managed", multiplierOverride: null, bossMultiplierOverride: null })
        events.setEventPolicy({ ...events.getEventPolicy(), mode: "classic", acceleration: 2 })
    } finally {
        if (clock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = clock
        if (scheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = scheduling
    }
})
