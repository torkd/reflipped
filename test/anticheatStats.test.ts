import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

// SEC-18 phase 4: the soft review rules R9–R12 (src/lib/anticheatStats.ts). R9 and R10 judge a finish against the
// server's own distributions once they hold enough finishes, and only honest-looking finishes feed them; R11 counts
// finishes per hour and long runs of play; R12 flags linked accounts that meet in a ranking event or a co-op room, once
// per pair. Every flag is soft, and the mode off writes nothing.

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let anticheat: typeof import("../src/lib/anticheat")
let flags: typeof import("../src/data/anticheatData")
let stats: typeof import("../src/lib/anticheatStats")
let statsData: typeof import("../src/data/anticheatStatsData")
let rooms: typeof import("../src/lib/coop/rooms")
let db: import("../src/data/sqlite").Database

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    anticheat = await import("../src/lib/anticheat")
    flags = await import("../src/data/anticheatData")
    stats = await import("../src/lib/anticheatStats")
    statsData = await import("../src/data/anticheatStatsData")
    rooms = await import("../src/lib/coop/rooms")
    const { default: getDatabase, Database } = await import("../src/data")
    db = getDatabase(Database.WDFP_DATA)
})
afterEach(() => {
    anticheat.setAnticheatMode(null)
    stats.resetAnticheatStatsMemory()
})
after(async () => {
    await cleanup()
})

const apiPrefix = "/latest/api/index.php"
const RANKING = 11
const HOUR = 3600_000
let clock = 1_900_000_000_000
/** A fresh real time for each test's finishes, far from the others', so R11's windows never overlap. */
const freshClock = () => (clock += 1000 * HOUR)

interface Player extends TestPlayer { playerId: number, accountId: number }

async function newPlayer(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId, accountId: session!.accountId }
}

let questSeq = 990_000
/** A quest id no other test uses, so each test starts with empty distributions. */
const newQuest = () => ++questSeq

interface FinishOptions {
    score?: number
    elapsedMs?: number
    accomplished?: boolean
    characters?: (number | null)[]
    damageMax?: number
    bossDamage?: number
}

function finishBody(options: FinishOptions = {}) {
    const elapsedMs = options.elapsedMs ?? 60_000
    return {
        score: options.score ?? 100_000, elapsed_time_ms: elapsedMs, is_accomplished: options.accomplished ?? true, is_restored: false,
        statistics: {
            party: { characters: (options.characters ?? [null, null, null]).map(id => id === null ? null : { id }),
                unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] },
            zones: [{ zone: 0, playthrough_ms: elapsedMs, playthrough_frame: Math.floor(elapsedMs / 17),
                damage_deal_total: Math.max(options.damageMax ?? 1000, options.bossDamage ?? 0), damage_deal_max: options.damageMax ?? 1000,
                boss_damage_deal_total: options.bossDamage ?? 0 }]
        }
    }
}

interface CheckOptions {
    category?: number
    coop?: boolean
    ip?: string
    hard?: boolean
    nowMs?: number
    autoStart?: boolean
}

function check(player: Player, questId: number, body: unknown, options: CheckOptions = {}) {
    return stats.checkFinishStatsSync({
        accountId: player.accountId, viewerId: player.viewerId, category: options.category ?? 1, coop: options.coop ?? false,
        body, ip: options.ip, ruleFlags: options.hard ? [{ severity: "hard" }] : [], nowMs: options.nowMs ?? freshClock(),
        autoStart: options.autoStart
    }, { playerId: player.playerId, questId, route: "single_battle_quest/finish" })
}

const stored = (playerId: number, rule: string) => flags.getPlayerAnticheatFlagsSync(playerId).filter(flag => flag.rule === rule)
const samples = (category: number, questId: number, metric: string, band = -1) =>
    statsData.getFinishStatsRowsSync(category, questId, false, band).find(row => row.metric === metric && row.band === band)?.samples ?? 0

/** Feeds `count` honest finishes, from as many players as given (round robin), one a minute. */
function feed(players: Player[], questId: number, count: number, options: FinishOptions = {}, category = 1) {
    let now = freshClock()
    for (let index = 0; index < count; index++) {
        const raised = check(players[index % players.length], questId, finishBody(options), { category, nowMs: now += 60_000 })
        assert.deepEqual(raised, [], `honest finish ${index} raised nothing`)
    }
}

describe("the histogram", () => {
    test("bins are a quarter octave; the median's bin brackets the median; counts halve past the cap", () => {
        assert.equal(stats.binOf(1) + 4, stats.binOf(2))
        let row = { metric: "score", band: -1, samples: 0, bins: {} as Record<string, number> }
        for (const value of [100, 100, 100, 1000, 10]) row = stats.addSample(row, value)
        const [low, high] = stats.medianRange(row)!
        assert.ok(low <= 100 && 100 < high && high / low < 1.2, `${low}..${high}`)
        for (let index = 0; index < stats.DECAY_AT; index++) row = stats.addSample(row, 100)
        assert.ok(row.samples <= stats.DECAY_AT && row.samples > stats.DECAY_AT / 2 - 5, String(row.samples))
        assert.ok(Object.keys(row.bins).length <= 3)
    })
})

describe("R10 outlier", () => {
    test("no flag below the sample threshold, then a score 3× the median and a clear in a third of the time are flagged", async () => {
        const players = [await newPlayer(), await newPlayer(), await newPlayer()]
        const cheater = await newPlayer()
        const quest = newQuest()
        feed(players, quest, stats.MIN_SAMPLES - 1)
        assert.deepEqual(check(cheater, quest, finishBody({ score: 1_000_000 })), [], "29 samples judge nothing")
        assert.equal(samples(1, quest, "score"), stats.MIN_SAMPLES, "below the threshold nothing is judged, so the finish feeds")

        const raised = check(cheater, quest, finishBody({ score: 1_000_000 }))
        assert.deepEqual(raised.map(flag => flag.rule), ["outlier"])
        assert.equal(raised[0].details.score, 1_000_000)
        assert.equal(raised[0].details.scoreSamples, stats.MIN_SAMPLES)
        const [flag] = stored(cheater.playerId, "outlier")
        assert.equal(flag.severity, "soft")
        assert.equal(flag.questId, quest)

        const fast = check(cheater, quest, finishBody({ elapsedMs: 15_000 }))
        assert.deepEqual(fast.map(flag => flag.rule), ["outlier"])
        assert.equal(fast[0].details.clearTime, 15_000)
        assert.equal(fast[0].details.score, undefined)

        // within the bounds: nothing
        assert.deepEqual(check(cheater, quest, finishBody({ score: 250_000, elapsedMs: 25_000 })), [])
        // a lost battle has no metrics
        assert.deepEqual(check(cheater, quest, finishBody({ score: 10_000_000, accomplished: false })), [])
    })
})

describe("R9 damage ceiling", () => {
    test("the biggest hit and the boss damage per second, per party power point, far above the server's finishes", async () => {
        const player = await newPlayer()
        const owned = db.prepare(`SELECT id FROM players_characters WHERE player_id = ? ORDER BY id LIMIT 1`)
            .get(player.playerId) as { id: number } | undefined
        assert.ok(owned !== undefined, "a new player owns a unit")
        const party = [owned.id, null, null]
        const quest = newQuest()
        feed([player], quest, stats.MIN_SAMPLES, { characters: party, damageMax: 10_000, bossDamage: 600_000 })

        const big = check(player, quest, finishBody({ characters: party, damageMax: 60_000, bossDamage: 600_000 }))
        assert.deepEqual(big.map(flag => flag.rule), ["damage-ceiling"])
        assert.ok((big[0].details.power as number) > 0)
        assert.ok(typeof big[0].details.maxHitPerPower === "number")
        assert.equal(big[0].details.bossDpsPerPower, undefined)

        const dps = check(player, quest, finishBody({ characters: party, damageMax: 10_000, bossDamage: 2_400_000 }))
        assert.deepEqual(dps.map(flag => flag.rule), ["damage-ceiling"])
        assert.ok(typeof dps[0].details.bossDpsPerPower === "number")

        // a hit 4× the median is within R9's 5× bound for the biggest hit
        assert.deepEqual(check(player, quest, finishBody({ characters: party, damageMax: 40_000, bossDamage: 600_000 })), [])
    })
})

describe("the distributions take only honest-looking finishes", () => {
    test("hard-flagged finishes, outliers, restricted players and lost battles don't feed them", async () => {
        const player = await newPlayer()
        const restricted = await newPlayer()
        const quest = newQuest()
        check(player, quest, finishBody(), { hard: true })
        assert.equal(samples(1, quest, "score"), 0, "a hard-flagged finish")
        check(player, quest, finishBody({ accomplished: false }))
        assert.equal(samples(1, quest, "score"), 0, "a lost battle")

        flags.setPlayerRestrictedSync(restricted.playerId, true, null)
        try {
            check(restricted, quest, finishBody())
            assert.equal(samples(1, quest, "score"), 0, "a restricted player")
        } finally {
            flags.setPlayerRestrictedSync(restricted.playerId, false, null)
        }

        check(player, quest, finishBody())
        assert.equal(samples(1, quest, "score"), 1, "an honest finish")
        assert.equal(samples(1, quest, "clearTime"), 1)

        feed([player], quest, stats.MIN_SAMPLES)
        const before = samples(1, quest, "score")
        assert.equal(check(player, quest, finishBody({ score: 1_000_000 })).length, 1)
        assert.equal(samples(1, quest, "score"), before, "an outlier")
        assert.equal(samples(1, quest, "clearTime"), before, "nothing of an outlying finish")
    })
})

describe("soft flags don't pile up", () => {
    test("R9/R10: one open flag per player, rule and quest counts the repeats; a resolved one makes room for a new one", async () => {
        const players = [await newPlayer(), await newPlayer(), await newPlayer()]
        const strong = await newPlayer()
        const quest = newQuest(), other = newQuest()
        feed(players, quest, stats.MIN_SAMPLES)
        feed(players, other, stats.MIN_SAMPLES)
        for (let index = 0; index < 3; index++) {
            assert.deepEqual(check(strong, quest, finishBody({ score: 1_000_000 })).map(flag => flag.rule), ["outlier"], "each finish is still judged")
        }
        const [flag, ...rest] = stored(strong.playerId, "outlier")
        assert.equal(rest.length, 0, "one stored flag")
        assert.equal(flag.details.repeats, 3)
        assert.equal(typeof flag.details.lastSeen, "string")
        check(strong, other, finishBody({ score: 1_000_000 }))
        assert.equal(stored(strong.playerId, "outlier").length, 2, "another quest has a flag of its own")

        flags.resolveAnticheatFlagSync(flag.id, "dismissed", null)
        check(strong, quest, finishBody({ score: 1_000_000 }))
        const after = stored(strong.playerId, "outlier").filter(entry => entry.questId === quest)
        assert.equal(after.length, 2, "a dismissed flag isn't reopened: a new one is recorded")
        assert.equal(after[0].status, "open")
        assert.equal(after[0].details.repeats, undefined)
    })

    test("resolved flags older than 180 days are pruned; open ones stay", async () => {
        const player = await newPlayer()
        const old = new Date(Date.now() - flags.RESOLVED_FLAG_RETENTION_MS - HOUR)
        const insert = (created: Date) => flags.insertAnticheatFlagSync({ playerId: player.playerId, rule: "outlier", severity: "soft",
            route: null, questId: null, details: {}, reqId: null, created })
        const oldResolved = insert(old), oldOpen = insert(old), recentResolved = insert(new Date())
        flags.resolveAnticheatFlagSync(oldResolved, "dismissed", null)
        flags.resolveAnticheatFlagSync(recentResolved, "actioned", null)
        assert.ok(flags.deleteResolvedAnticheatFlagsSync() >= 1)
        const ids = flags.getPlayerAnticheatFlagsSync(player.playerId).map(flag => flag.id).sort()
        assert.deepEqual(ids, [oldOpen, recentResolved].sort())
    })
})

describe("R11 play rate", () => {
    test("a flag notes whether the finish was an auto-repeat battle", async () => {
        const player = await newPlayer()
        const quest = newQuest()
        const start = Math.ceil(freshClock() / HOUR) * HOUR
        for (let index = 0; index < stats.MAX_FINISHES_PER_HOUR; index++) check(player, quest, {}, { nowMs: start + index * 20_000, autoStart: true })
        const [flag] = stored(player.playerId, "play-rate")
        assert.equal(flag.details.check, "battles-per-hour")
        assert.equal(flag.details.autoStart, true)
        assert.equal(flag.severity, "soft")
    })

    test("120 finishes in one hour are flagged once; the next hour starts again", async () => {
        const player = await newPlayer()
        const quest = newQuest()
        const start = Math.ceil(freshClock() / HOUR) * HOUR
        const raised: string[] = []
        for (let index = 0; index < stats.MAX_FINISHES_PER_HOUR + 10; index++) {
            raised.push(...check(player, quest, {}, { nowMs: start + index * 20_000 }).map(flag => `${index}:${flag.details.check}`))
        }
        assert.deepEqual(raised, [`${stats.MAX_FINISHES_PER_HOUR - 1}:battles-per-hour`])
        const [flag] = stored(player.playerId, "play-rate")
        assert.equal(flag.details.battles, stats.MAX_FINISHES_PER_HOUR)
        assert.equal(flag.severity, "soft")
        // the next hour: 10 more finishes raise nothing
        for (let index = 0; index < 10; index++) assert.deepEqual(check(player, quest, {}, { nowMs: start + HOUR + index * 1000 }), [])
    })

    test("twelve hours without an hour's break are flagged once per run of play; a break starts a new run", async () => {
        const player = await newPlayer()
        const quest = newQuest()
        let now = freshClock()
        const run = (hours: number) => {
            const raised: string[] = []
            for (let minute = 0; minute <= hours * 60; minute += 50) raised.push(...check(player, quest, {}, { nowMs: now + minute * 60_000 }).map(flag => String(flag.details.check)))
            now += hours * 60 * 60_000
            return raised
        }
        assert.deepEqual(run(11), [], "eleven hours")
        now = freshClock()
        assert.deepEqual(run(14), ["long-play"], "fourteen hours: once")
        now += 61 * 60_000
        assert.deepEqual(run(11), [], "after an hour's break, a new run")
    })
})

describe("R12 linked accounts", () => {
    const EVENT = 77
    const rankingQuest = EVENT * 1000 + 1
    const record = (playerId: number) => data.setPlayerRankingRecordSync(playerId, EVENT, {
        accomplished: true, elapsedTimeMs: 60_000, score: 1000, leaderCharacterId: 1, rewarded: false
    } as Parameters<typeof data.setPlayerRankingRecordSync>[2])

    test("a shared device in the same ranking event: both flagged, once per pair", async () => {
        const main = await newPlayer()
        const alt = await newPlayer()
        const stranger = await newPlayer()
        data.setAccountDeviceSecretHashSync(alt.accountId, data.getAccountDeviceSecretHashSync(main.accountId))
        check(main, rankingQuest, {}, { category: RANKING })
        record(main.playerId)
        record(stranger.playerId)

        const raised = check(alt, rankingQuest, {}, { category: RANKING })
        assert.deepEqual(raised.map(flag => [flag.rule, flag.playerId, flag.details.linkedPlayerId, flag.details.links, flag.details.where]), [
            ["linked-accounts", alt.playerId, main.playerId, "device", "ranking-event"],
            ["linked-accounts", main.playerId, alt.playerId, "device", "ranking-event"]
        ])
        assert.equal(stored(main.playerId, "linked-accounts")[0].severity, "soft")
        assert.equal(stored(stranger.playerId, "linked-accounts").length, 0)
        record(alt.playerId)
        assert.deepEqual(check(alt, rankingQuest, {}, { category: RANKING }), [], "once per pair")
        assert.deepEqual(check(main, rankingQuest, {}, { category: RANKING }), [], "either way round")
        // the device key is a hash of the hash: the table never holds what logins are looked up by
        const keys = db.prepare(`SELECT device_key FROM anticheat_device_keys WHERE player_id = ?`).all(main.playerId) as { device_key: string }[]
        assert.deepEqual(keys.map(row => row.device_key), [stats.deviceKey(data.getAccountDeviceSecretHashSync(main.accountId)!)])
        assert.notEqual(keys[0].device_key, data.getAccountDeviceSecretHashSync(main.accountId))
    })

    test("accounts of one portal user in the same ranking event", async () => {
        const { createUserSync, setAccountUserSync } = await import("../src/data/users")
        const user = createUserSync({ username: `linked${Date.now()}`, passwordHash: "x" })!
        const first = await newPlayer()
        const second = await newPlayer()
        setAccountUserSync(first.accountId, user.id)
        setAccountUserSync(second.accountId, user.id)
        assert.deepEqual(check(second, rankingQuest, {}, { category: RANKING }).filter(flag => flag.details.linkedPlayerId === first.playerId), [],
            "no meeting before the other has a record")
        record(first.playerId)
        const raised = check(second, rankingQuest, {}, { category: RANKING })
        assert.deepEqual(raised.filter(flag => flag.playerId === second.playerId).map(flag => [flag.details.linkedPlayerId, flag.details.links]),
            [[first.playerId, "portal-user"]])
    })

    test("a shared network in the same co-op round; loopback and crowded addresses link nobody", async () => {
        const host = await newPlayer()
        const guest = await newPlayer()
        const quest = newQuest()
        const now = freshClock()
        const room = rooms.createRoom(host.viewerId, quest, 19)
        try {
            rooms.startRound(room, [host.viewerId, guest.viewerId])
            // loopback (the co-op finish's inner request, a proxy without TRUST_PROXY) is ignored
            stats.noteFinishAddress(host.playerId, "127.0.0.1", now)
            stats.noteFinishAddress(guest.playerId, "::ffff:127.0.0.1", now)
            stats.noteFinishAddress(guest.playerId, "::1", now)
            assert.deepEqual(check(guest, quest, {}, { coop: true, category: 19, nowMs: now }), [])

            // the same IPv6 /64, two addresses
            stats.noteFinishAddress(host.playerId, "2001:db8:1:2::10", now)
            stats.noteFinishAddress(guest.playerId, "2001:db8:1:2:abcd::99", now + 60_000)
            const raised = check(guest, quest, {}, { coop: true, category: 19, nowMs: now + 120_000 })
            assert.deepEqual(raised.map(flag => [flag.playerId, flag.details.linkedPlayerId, flag.details.links, flag.details.where]), [
                [guest.playerId, host.playerId, "network", "coop-room"],
                [host.playerId, guest.playerId, "network", "coop-room"]
            ])
            // the details hold no address
            assert.ok(!JSON.stringify(stored(guest.playerId, "linked-accounts")).includes("2001"))
        } finally {
            rooms.deleteRoom(room.roomNumber)
        }

        // an address shared by more than NETWORK_MAX_PLAYERS players is a proxy or a carrier's: no link
        const crowd = [await newPlayer(), await newPlayer()]
        const quest2 = newQuest()
        const room2 = rooms.createRoom(crowd[0].viewerId, quest2, 19)
        try {
            rooms.startRound(room2, crowd.map(player => player.viewerId))
            for (const player of crowd) stats.noteFinishAddress(player.playerId, "198.51.100.7", now)
            for (let other = 0; other < stats.NETWORK_MAX_PLAYERS; other++) stats.noteFinishAddress(1_000_000 + other, "198.51.100.7", now)
            assert.deepEqual(check(crowd[1], quest2, {}, { coop: true, category: 19, nowMs: now }), [])
            // past the retention the keys link nobody either
            stats.resetAnticheatStatsMemory()
            for (const player of crowd) stats.noteFinishAddress(player.playerId, "198.51.100.8", now)
            assert.deepEqual(check(crowd[1], quest2, {}, { coop: true, category: 19, nowMs: now + stats.NETWORK_RETENTION_MS + 1 }), [])
            assert.equal(check(crowd[1], quest2, {}, { coop: true, category: 19, nowMs: now + 1000 }).length, 2, "within it they do")
        } finally {
            rooms.deleteRoom(room2.roomNumber)
        }
    })
})

describe("mode off", () => {
    test("reads and writes nothing", async () => {
        const main = await newPlayer()
        const alt = await newPlayer()
        const quest = newQuest()
        feed([main], quest, stats.MIN_SAMPLES)
        const before = samples(1, quest, "score")
        data.setAccountDeviceSecretHashSync(alt.accountId, data.getAccountDeviceSecretHashSync(main.accountId))
        record(main.playerId)
        const playRate = statsData.getPlayRateSync(main.playerId)

        anticheat.setAnticheatMode("off")
        assert.deepEqual(check(main, quest, finishBody({ score: 10_000_000 })), [])
        assert.deepEqual(check(alt, 77001, {}, { category: RANKING, ip: "203.0.113.9" }), [])
        stats.noteFinishAddress(alt.playerId, "203.0.113.9")
        assert.equal(samples(1, quest, "score"), before)
        assert.deepEqual(statsData.getPlayRateSync(main.playerId), playRate)
        assert.equal(statsData.getPlayRateSync(alt.playerId), null)
        assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM anticheat_device_keys WHERE player_id = ?`).get(alt.playerId) as { n: number }).n, 0)
        assert.deepEqual(flags.getPlayerAnticheatFlagsSync(main.playerId), [])
        assert.deepEqual(flags.getPlayerAnticheatFlagsSync(alt.playerId), [])
    })

    function record(playerId: number) {
        data.setPlayerRankingRecordSync(playerId, 77, {
            accomplished: true, elapsedTimeMs: 60_000, score: 1000, leaderCharacterId: 1, rewarded: false
        } as Parameters<typeof data.setPlayerRankingRecordSync>[2])
    }
})

describe("the finish route", () => {
    test("runs the rules on a finish: its play rate is counted", async () => {
        const player = await newPlayer()
        const post = (route: string, body: Record<string, unknown>) => fastify.inject({ method: "POST", url: `${apiPrefix}/${route}`,
            headers: gameHeaders(player.udid), payload: encodeGameBody({ ...body, viewer_id: player.viewerId }) })
        const started = await post("single_battle_quest/start", { quest_id: 1001002, category: 1, party_id: 1, use_boost_point: false,
            use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "SEC18" })
        assert.equal(started.statusCode, 200, started.body)
        const { getActiveQuest } = await import("../src/routes/api/singleBattleQuest")
        const active = getActiveQuest(player.playerId) as { startedAtMs?: number, startParty?: { characterIds: (number | null)[] } | null }
        active.startedAtMs = Date.now() - 60_000
        const finished = await post("single_battle_quest/finish", { quest_id: 1001002, category: 1, add_mana: 0, continue_count: 0,
            api_count: 2, play_id: "SEC18", ...finishBody({ elapsedMs: 30_000, characters: active.startParty?.characterIds ?? [null, null, null] }) })
        assert.equal(finished.statusCode, 200, finished.body)
        assert.equal(statsData.getPlayRateSync(player.playerId)?.hourCount, 1)
        const fed = db.prepare(`SELECT SUM(samples) AS n FROM anticheat_finish_stats WHERE category = 1 AND quest_id = 1001002 AND metric = 'clearTime'`)
            .get() as { n: number | null }
        assert.equal(fed.n, 1, "the honest clear feeds the quest's distribution")
        assert.deepEqual(flags.getPlayerAnticheatFlagsSync(player.playerId), [])
    })
})
