// SEC-18 phase 4, rule R8 `score` (src/lib/anticheatRules.ts): the final score formula recovered from the 0.0.81 bytecode,
// checked against the captured finishes and the honest emulator rounds of 2026-11-14, then the rule's three checks:
// above-max (hard), mates (hard, co-op: one phone's own score against its mates' in the same finish) and damage (soft).
// Last, through the co-op finish route in enforce mode: a finish R8 flags hard is kept off the boards at once, and a lie
// that agrees with itself is left to the co-op witness (R7).
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const QUEST = 1001001 // boss battle
const BOSS = 2 // QuestCategory.BOSS_BATTLE
const COMPANION = 11525449

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let anticheat: typeof import("../src/lib/anticheat")
let flagStore: typeof import("../src/data/anticheatData")
let witness: typeof import("../src/lib/anticheatCoopWitness")
let rooms: typeof import("../src/lib/coop/rooms")
let rules: typeof import("../src/lib/anticheatRules")
let giveCharacter: typeof import("../src/lib/character").givePlayerCharacterSync

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    anticheat = await import("../src/lib/anticheat")
    flagStore = await import("../src/data/anticheatData")
    witness = await import("../src/lib/anticheatCoopWitness")
    rooms = await import("../src/lib/coop/rooms")
    rules = await import("../src/lib/anticheatRules")
    giveCharacter = (await import("../src/lib/character")).givePlayerCharacterSync
})
afterEach(() => {
    witness.resetCoopWitness()
    anticheat.setAnticheatMode("log")
})
after(async () => {
    anticheat.setAnticheatMode(null)
    await cleanup()
})

// ---- the formula ----

/** The client's final score: floor((battle score + bonuses) × multiplier), as the final score class rounds it. */
const finalScore = (points: number, multiplier: number) => Math.floor(points * multiplier + 1e-10 + 1e-10)
const hundredths = (multiplier: number) => Math.round(multiplier * 100)

describe("the formula", () => {
    test("the time multiplier of the captured and emulator clear times", () => {
        // the emulator rounds: Whitetail Inter. and Adv., 600 s limits
        assert.equal(hundredths(rules.timeMultiplier(1972 / 600_000)), 399)
        assert.equal(hundredths(rules.timeMultiplier(59330 / 600_000)), 363)
        assert.equal(hundredths(rules.timeMultiplier(52054 / 600_000)), 371)
        // the co-op capture (quest 500009002, 900 s): the round's clear time and the host's own zone time agree
        assert.equal(hundredths(rules.timeMultiplier(42007 / 900_000)), 391)
        assert.equal(hundredths(rules.timeMultiplier(42517 / 900_000)), 391)
        // the solo capture (quest 2006, 1800 s)
        assert.equal(hundredths(rules.timeMultiplier(20995 / 1_800_000)), 399)
    })

    test("the time multiplier's pieces", () => {
        assert.equal(hundredths(rules.timeMultiplier(0)), 400, "an instant clear")
        assert.equal(hundredths(rules.timeMultiplier(0.1)), 362, "x = 0.9: 4 − 1.5 × 0.5², 3.625 rounded down")
        assert.equal(hundredths(rules.timeMultiplier(0.3)), 137, "x = 0.7: 1 + 1.5 × 0.5²")
        assert.equal(hundredths(rules.timeMultiplier(0.45)), 100, "x = 0.55: 1")
        assert.equal(hundredths(rules.timeMultiplier(0.7)), 21, "x = 0.3: 0.6³")
        assert.equal(hundredths(rules.timeMultiplier(0.95)), 1, "x = 0.05: the floor")
        assert.equal(hundredths(rules.timeMultiplier(1.5)), 1, "past the limit")
        assert.equal(hundredths(rules.timeMultiplier(0, true)), 800, "a solo boss play doubles it")
    })

    test("the co-op capture: one battle score, the bonuses apart, × 3.91", () => {
        const body = readCapturedRoute("multi_battle_quest_finish").requestBody
        // 2067364872 is the battle score plus the host's bonuses; its mates' bonuses are 1800 and 400 less
        assert.equal(finalScore(2067364872, 3.91), body.score)
        assert.equal(finalScore(2067364872 - 1800, 3.91), body.mate_player_result[0].score)
        assert.equal(finalScore(2067364872 - 400, 3.91), body.mate_player_result[1].score)
        // the battle score is within 23780 of the room's damage to the boss: the rest is healing, other enemies, bonuses
        assert.ok(2067364872 - body.statistics.zones[0].damage_to_boss_all < 25_000)
    })

    test("the emulator rounds: the own score adds its contribution bonus (5000 for the top, 1000 for the last) × the multiplier", () => {
        // [own score, what another phone saw for that player, multiplier, bonus]
        const pairs: [number, number, number, number][] = [
            [2031380, 2011430, 3.99, 5000], [2013824, 2009834, 3.99, 1000],
            [26962021, 26943871, 3.63, 5000], [26943871, 26940241, 3.63, 1000],
            [26774190, 26755640, 3.71, 5000], [26750817, 26747107, 3.71, 1000]
        ]
        for (const [own, seen, multiplier, bonus] of pairs) assert.equal(Math.round((own - seen) / multiplier), bonus, `${own} vs ${seen}`)
    })
})

// ---- the rule ----

const NOW = 1_800_000_000_000
const solo = () => structuredClone(readCapturedRoute("single_battle_quest_finish").requestBody)
const coop = () => structuredClone(readCapturedRoute("multi_battle_quest_finish").requestBody)

type Judgement = Parameters<typeof import("../src/lib/anticheatRules").judgeFinish>[0]
/** R8's flags only (the other rules have their own tests); a minute of real time, no party snapshot. */
function scoreFlags(body: unknown, overrides: { start?: Partial<Judgement["start"]>, quest?: Partial<Judgement["quest"]> } = {}) {
    return rules.judgeFinish({
        start: { startedAtMs: NOW - 60_000, startParty: null, continues: 0, coop: false, ...overrides.start },
        body,
        quest: { category: 13, timeLimitMs: 1_800_000, ...overrides.quest },
        nowMs: NOW,
        wallClockSlackMs: 10_000
    }).filter(flag => flag.rule === "score")
}
const checks = (list: { severity: string, details: Record<string, unknown> }[]) => list.map(flag => `${flag.details.check}:${flag.severity}`)
const coopFlags = (body: unknown, category = 19) => scoreFlags(body, { start: { coop: true }, quest: { category, timeLimitMs: 900_000 } })

// the emulator rounds as finishes: each phone's own score, what it saw for the others, its clear time and damage
const EMULATOR_FINISHES: { score: number, seen: number[], elapsed: number, damageToBossAll: number, contribution: number }[] = [
    { score: 2031380, seen: [2009834, 2010632], elapsed: 1972, damageToBossAll: 389739, contribution: 487447 },
    { score: 2013824, seen: [2011430, 2010632], elapsed: 1972, damageToBossAll: 385012, contribution: 6167 },
    { score: 2028615, seen: [2017443, 2015847], elapsed: 1972, damageToBossAll: 391917, contribution: 31268 },
    { score: 26962021, seen: [26940241, 26947501], elapsed: 59330, damageToBossAll: 5188169, contribution: 3241292 },
    { score: 26943871, seen: [26943871, 26947501], elapsed: 59330, damageToBossAll: 5162096, contribution: 2023803 },
    { score: 27401534, seen: [27386288, 27387377], elapsed: 59415, damageToBossAll: 5172257, contribution: 3065453 },
    { score: 26750817, seen: [26755640, 26745994], elapsed: 52054, damageToBossAll: 5173182, contribution: 2036066 },
    { score: 26774190, seen: [26747107, 26745994], elapsed: 52054, damageToBossAll: 5158013, contribution: 2861714 },
    { score: 25541236, seen: [25529524, 25536112], elapsed: 56763, damageToBossAll: 5163189, contribution: 2210780 }
]
function emulatorFinish(finish: typeof EMULATOR_FINISHES[number]) {
    const body = coop()
    body.score = finish.score
    body.elapsed_time_ms = finish.elapsed
    body.mate_player_result = finish.seen.map((score, i) => ({ viewer_id: 100 + i, com_id: null, score, contribution_score: 1 }))
    // only what the witness log kept: the room's damage to the boss; the player's own damage stands in for the contribution
    body.statistics.zones = [{ ...body.statistics.zones[0], damage_to_boss_all: finish.damageToBossAll, damage_deal_total: finish.contribution, members: [] }]
    return body
}

describe("the rule", () => {
    test("the captured finishes and the emulator rounds raise nothing", () => {
        assert.deepEqual(scoreFlags(solo()), [])
        assert.deepEqual(coopFlags(coop()), [])
        for (const finish of EMULATOR_FINISHES) assert.deepEqual(coopFlags(emulatorFinish(finish), BOSS), [], `${finish.score}`)
    })

    test("above-max: the client never sends more than 99,999,999,999", () => {
        const body = solo()
        body.score = rules.MAX_SCORE
        assert.deepEqual(checks(scoreFlags(body)), ["damage:soft"], "the maximum itself is only far above the damage")
        body.score = rules.MAX_SCORE + 1
        assert.deepEqual(checks(scoreFlags(body)), ["above-max:hard"])
    })

    test("mates: an own score far from the mates' in the same co-op finish is hard, whichever side moved", () => {
        const doubled = coop()
        doubled.score *= 2
        const [flag] = coopFlags(doubled)
        assert.equal(flag.severity, "hard")
        assert.equal(flag.details.check, "mates")
        // the farthest mate is reported: the first one (8083389611)
        assert.equal(flag.details.mateScore, 8083389611)
        assert.equal(flag.details.gap, doubled.score - 8083389611)
        assert.equal(flag.details.mates, 2)

        const lowered = coop()
        lowered.score = 1
        assert.deepEqual(checks(coopFlags(lowered)), ["mates:hard"], "a lowered score too: the finish contradicts itself")
        const framed = coop()
        framed.mate_player_result[1].score = 1
        assert.deepEqual(checks(coopFlags(framed)), ["mates:hard"], "or a mate's")
    })

    test("mates: skipped for an isolated finish, soft for a lost one", () => {
        const isolated = coop()
        isolated.isolated = true
        isolated.mate_player_result[1].score = 1
        assert.deepEqual(coopFlags(isolated), [], "an isolated player's mates are stale")

        const lost = coop()
        lost.is_accomplished = false
        lost.mate_player_result[1].score = 1
        const [flag] = coopFlags(lost)
        assert.equal(flag.severity, "soft", "a wipe froze the own score")
        assert.equal(flag.details.check, "mates")
        assert.equal(flag.details.accomplished, false)
    })

    test("mates: the gap allows twice the bonuses (33,500 a player, achievements included) × 4, plus rounding", () => {
        assert.equal(rules.COOP_SCORE_GAP, 268_001)
        const body = coop()
        const farthest = 8083389611
        body.score = farthest + rules.COOP_SCORE_GAP
        assert.deepEqual(coopFlags(body), [])
        body.score = farthest + rules.COOP_SCORE_GAP + 1
        assert.deepEqual(checks(coopFlags(body)), ["mates:hard"])
        // below both mates, the higher one (8083395085) is the far one
        body.score = 8083395085 - rules.COOP_SCORE_GAP
        assert.deepEqual(coopFlags(body), [])
        body.score -= 1
        assert.equal(coopFlags(body)[0].details.mateScore, 8083395085)
    })

    test("mates: AI companions count (one battle score for all), entries without a score don't", () => {
        const body = coop()
        // both captured mates are AI companions (com_id set)
        assert.ok(body.mate_player_result.every((mate: { com_id: unknown }) => mate.com_id !== null))
        body.score += 1_000_000
        assert.deepEqual(checks(coopFlags(body)), ["mates:hard"])

        const partial = coop()
        partial.mate_player_result = [{ viewer_id: 1, com_id: null, score: null }, "junk", { viewer_id: 2, com_id: null, score: Infinity }]
        partial.score += 1_000_000
        assert.deepEqual(coopFlags(partial), [], "nothing to compare")
        partial.mate_player_result = []
        assert.deepEqual(coopFlags(partial), [])
    })

    test("damage: a score far beyond the reported damage and healing at the top multiplier is soft", () => {
        // the solo capture: 45428 damage, no healing; ceiling 4 × (2 × 45428 + 50000) = 563424
        const body = solo()
        body.score = 563_424
        assert.deepEqual(scoreFlags(body), [])
        body.score = 563_425
        const [flag] = scoreFlags(body)
        assert.equal(flag.severity, "soft")
        assert.deepEqual(flag.details, { check: "damage", score: 563_425, damage: 45428, healing: 0, multiplier: 4, ceiling: 563_424 })
        // the honest score at 2.5×; at 2× it would still pass (the rule's limit, documented)
        const raised = solo()
        raised.score = Math.round(raised.score * 2.5)
        assert.deepEqual(checks(scoreFlags(raised)), ["damage:soft"])
        raised.score = 241107 * 2
        assert.deepEqual(scoreFlags(raised), [])
    })

    test("damage: co-op counts the room's damage to the boss and the party's healing", () => {
        const body = coop()
        const zone = body.statistics.zones[0]
        const healing = zone.members.reduce((total: number, member: Record<string, number>) =>
            total + Math.max(member.heal_with_overheal ?? 0, member.heal_receive_value_with_overheal ?? 0), 0)
        assert.ok(healing > 0 && healing < 404 + 58 + 238 + 134, "a heal counts once, not as given and received")
        const ceiling = 4 * (2 * (zone.damage_to_boss_all + healing) + 50_000)
        body.score = ceiling + 1
        body.mate_player_result = []
        const [flag] = coopFlags(body)
        assert.deepEqual(flag.details, { check: "damage", score: ceiling + 1, damage: zone.damage_to_boss_all, healing, multiplier: 4, ceiling })
    })

    test("damage: a solo boss play may double the multiplier; co-op never does", () => {
        const body = solo()
        body.score = 1_000_000 // above 4 × 140856 = 563424, within 8 × 140856 = 1126848
        assert.deepEqual(scoreFlags(body, { quest: { category: BOSS } }), [], "×8 on a solo boss quest")
        assert.deepEqual(checks(scoreFlags(body)), ["damage:soft"], "×4 elsewhere")
        assert.deepEqual(checks(scoreFlags(body, { quest: { category: BOSS }, start: { coop: true } })), ["damage:soft"], "×4 in co-op")
    })

    test("damage: skipped for quest kinds with their own score and finishes without zones", () => {
        const body = solo()
        body.score *= 100
        for (const category of [11, 22, 25, 27]) assert.deepEqual(scoreFlags(body, { quest: { category } }), [], `category ${category}`)
        const noZones = solo()
        noZones.score *= 100
        noZones.statistics.zones = []
        assert.deepEqual(scoreFlags(noZones), [])
        delete noZones.statistics.zones
        assert.deepEqual(scoreFlags(noZones), [])
        // but above-max holds everywhere
        noZones.score = rules.MAX_SCORE * 2
        assert.deepEqual(checks(scoreFlags(noZones, { quest: { category: 11 } })), ["above-max:hard"])
    })

    test("no score, or not a number: nothing to judge", () => {
        for (const score of [undefined, null, "241107", NaN, Infinity]) {
            const body = solo()
            body.score = score
            assert.deepEqual(scoreFlags(body), [], String(score))
        }
        assert.deepEqual(scoreFlags(null), [])
    })
})

// ---- through the co-op finish route ----

type Player = TestPlayer & { playerId: number }

async function ok(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/${route}`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, `${route}: ${response.body}`)
    return decodeGameBody(response.body) as any
}

async function newPlayer(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    const playerId = data.getViewerPlayerIdSync(player.viewerId)!
    giveCharacter(playerId, 111001)
    return { ...player, playerId }
}

/** A room of these players, its round started two minutes ago in real time (so R1–R3 see a played battle). */
async function startedRoom(players: Player[]) {
    const roomNumber = (await ok(players[0], "multi_battle_quest/create_room", { quest_id: QUEST, category: BOSS, party_id: 1 })).data.room_number as string
    for (const guest of players.slice(1)) {
        await ok(guest, "multi_battle_quest/select_room", { room_number: roomNumber, category: BOSS, quest_id: QUEST, party_id: 1, accepted_type: 3 })
    }
    rooms.startRound(rooms.getRoom(roomNumber)!, players.map(player => player.viewerId))
    const { getActiveQuest } = await import("../src/routes/api/singleBattleQuest")
    for (const player of players) {
        await ok(player, "multi_battle_quest/start", {
            room_number: roomNumber, quest_id: QUEST, category: BOSS, party_id: 1, play_id: "SCORE",
            use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, mate_player_ids: []
        })
        const active = getActiveQuest(player.playerId) as { startedAtMs?: number } | undefined
        if (active !== undefined) active.startedAtMs = Date.now() - 2 * 60_000
    }
}

/** The captured finish with this player's score and what their game saw for the others (and an AI companion). */
function finishBody(score: number, mates: { viewerId: number, comId?: number, score: number }[]) {
    const captured = readCapturedRoute("multi_battle_quest_finish").requestBody
    return {
        ...captured, quest_id: QUEST, category: BOSS, score, contribution_score: 14667403,
        statistics: { ...captured.statistics, party: { characters: [{ id: 111001 }, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] } },
        mate_player_result: mates.map(mate => ({ viewer_id: mate.viewerId, com_id: mate.comId ?? null, score: mate.score, contribution_score: 14667403 }))
    }
}

const TRUTH = 8083390000
const storedParties = async () => {
    const { default: getDatabase, Database } = await import("../src/data")
    return (getDatabase(Database.WDFP_DATA).prepare(`SELECT player_id FROM players_recent_quest_parties WHERE category = ? AND quest_id = ?`)
        .all(BOSS, QUEST) as { player_id: number }[]).map(row => row.player_id)
}
const rulesOf = (player: Player) => flagStore.getPlayerAnticheatFlagsSync(player.playerId).map(flag => flag.rule).sort()

describe("the co-op finish route", () => {
    test("enforce: a finish whose score contradicts its mates' is flagged hard and never reaches the board", async () => {
        anticheat.setAnticheatMode("enforce")
        const players = [await newPlayer(), await newPlayer(), await newPlayer()]
        await startedRoom(players)
        const liar = players[0]
        for (const [i, player] of players.entries()) {
            const mates = [...players.filter(other => other !== player).map(other => ({ viewerId: other.viewerId, score: TRUTH + 1000 })),
                { viewerId: COMPANION, comId: COMPANION, score: TRUTH - 2000 }]
            await ok(player, "multi_battle_quest/finish", finishBody(player === liar ? TRUTH * 2 : TRUTH + i * 1000, mates))
        }
        const [flag] = flagStore.getPlayerAnticheatFlagsSync(liar.playerId).filter(candidate => candidate.rule === "score")
        assert.equal(flag.severity, "hard")
        assert.equal(flag.details.check, "mates")
        assert.equal(flag.details.excluded, true)
        const stored = await storedParties()
        assert.ok(!stored.includes(liar.playerId), "the liar's party was never stored")
        assert.ok(stored.includes(players[1].playerId) && stored.includes(players[2].playerId), "the honest players' parties are")
        assert.ok(!rulesOf(players[1]).includes("score") && !rulesOf(players[2]).includes("score"))
    })

    test("enforce: a lie that agrees with itself passes R8 and is left to the co-op witness, which takes it back", async () => {
        anticheat.setAnticheatMode("enforce")
        const players = [await newPlayer(), await newPlayer(), await newPlayer()]
        await startedRoom(players)
        const liar = players[1]
        const truth = new Map(players.map((player, i) => [player.viewerId, TRUTH + i * 1000]))
        for (const player of players) {
            // the liar lowers its own score and, to match, what it saw for the others
            const mates = players.filter(other => other !== player).map(other => ({ viewerId: other.viewerId, score: player === liar ? 1 : truth.get(other.viewerId)! }))
            await ok(player, "multi_battle_quest/finish", finishBody(player === liar ? 1 : truth.get(player.viewerId)!, mates))
        }
        for (const player of players) assert.ok(!rulesOf(player).includes("score"), "R8 sees nothing wrong in any one finish")
        const [flag] = flagStore.getPlayerAnticheatFlagsSync(liar.playerId).filter(candidate => candidate.rule === "coop-witness")
        assert.equal(flag.severity, "hard")
        assert.equal(flag.details.excluded, true)
        assert.deepEqual(flag.details.undone, ["suggested-party"])
        const stored = await storedParties()
        assert.ok(!stored.includes(liar.playerId), "the liar's party is off the board")
        assert.ok(stored.includes(players[0].playerId) && stored.includes(players[2].playerId), "the honest players' parties stay")
    })
})
