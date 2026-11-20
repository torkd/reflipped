// SEC-18 phase 3, rule R7 `coop-witness`: a co-op round's finishes are compared once they are all in. Each member's own
// score and contribution against what the other humans' games computed for them (`mate_player_result`), and the round's
// clear time and accomplishment between members. With 3+ humans the odd one out is flagged hard; two who disagree are
// both flagged soft; AI companions are no witnesses; a member who never finishes doesn't hold the round up for good.
import { after, afterEach, before, test } from "node:test";
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
let giveCharacter: typeof import("../src/lib/character").givePlayerCharacterSync

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    anticheat = await import("../src/lib/anticheat")
    flagStore = await import("../src/data/anticheatData")
    witness = await import("../src/lib/anticheatCoopWitness")
    rooms = await import("../src/lib/coop/rooms")
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

/** A room hosted by the first player, joined by the others, its round started with all of them. */
async function room(players: Player[]): Promise<{ roomNumber: string, room: import("../src/lib/coop/rooms").CoopRoom }> {
    const roomNumber = (await ok(players[0], "multi_battle_quest/create_room", { quest_id: QUEST, category: BOSS, party_id: 1 })).data.room_number as string
    for (const guest of players.slice(1)) {
        await ok(guest, "multi_battle_quest/select_room", { room_number: roomNumber, category: BOSS, quest_id: QUEST, party_id: 1, accepted_type: 3 })
    }
    const coopRoom = rooms.getRoom(roomNumber)!
    return { roomNumber, room: coopRoom }
}

async function startRound(players: Player[], target: { roomNumber: string, room: import("../src/lib/coop/rooms").CoopRoom }) {
    rooms.startRound(target.room, players.map(player => player.viewerId))
    for (const player of players) {
        await ok(player, "multi_battle_quest/start", {
            room_number: target.roomNumber, quest_id: QUEST, category: BOSS, party_id: 1, play_id: "WITNESS",
            use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, mate_player_ids: []
        })
        // the battle started two minutes ago in real time, so phase 1's speed and instant-finish rules (R1–R3) see the
        // captured 42 s finish as played, and only R7 judges these rounds
        const { getActiveQuest } = await import("../src/routes/api/singleBattleQuest")
        const active = getActiveQuest(player.playerId) as { startedAtMs?: number } | undefined
        if (active !== undefined) active.startedAtMs = Date.now() - 2 * 60_000
    }
}

interface Result { score: number, contribution: number }

/** A finish: the captured one with this player's own result and what their game saw for the others. */
type Claim = Result & { elapsed?: number, accomplished?: boolean, isolated?: boolean }
function finishBody(own: Claim, mates: { viewerId: number, comId?: number | null, result: Result }[]) {
    const captured = readCapturedRoute("multi_battle_quest_finish").requestBody
    return {
        ...captured, quest_id: QUEST, category: BOSS,
        score: own.score, contribution_score: own.contribution,
        elapsed_time_ms: own.elapsed ?? 42007, is_accomplished: own.accomplished ?? true, isolated: own.isolated ?? false,
        statistics: { ...captured.statistics, party: { characters: [{ id: 111001 }, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] } },
        mate_player_result: mates.map(mate => ({
            viewer_id: mate.viewerId, com_id: mate.comId ?? null, score: mate.result.score, contribution_score: mate.result.contribution
        }))
    }
}

/** Each player finishes, reporting the truth about the others unless `seen` says otherwise. */
async function finishAll(players: Player[], truth: Map<number, Result>, claims = new Map<number, Claim>(),
    seen = new Map<number, Map<number, Result>>(), companions = true) {
    for (const player of players) {
        const mates: { viewerId: number, comId?: number | null, result: Result }[] = players.filter(other => other !== player).map(other => ({
            viewerId: other.viewerId, result: seen.get(player.viewerId)?.get(other.viewerId) ?? truth.get(other.viewerId)!
        }))
        // the companion's score near the humans': one finish's scores share the battle score (R8 flags them far apart)
        if (companions) mates.push({ viewerId: COMPANION, comId: COMPANION, result: { score: 8083389000, contribution: 1 } })
        await ok(player, "multi_battle_quest/finish", finishBody(claims.get(player.viewerId) ?? truth.get(player.viewerId)!, mates))
    }
}

const witnessFlags = (player: Player) => flagStore.getPlayerAnticheatFlagsSync(player.playerId).filter(flag => flag.rule === "coop-witness")

function truthFor(players: Player[]): Map<number, Result> {
    return new Map(players.map((player, i) => [player.viewerId, { score: 8083390000 + i * 1000, contribution: 14667403 + i * 7 }]))
}

test("an honest three-player round raises no flag, and nothing is left waiting", async () => {
    anticheat.setAnticheatMode("log")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    // clear times a little apart (UpdateTime syncs) are still the same round
    const truth = truthFor(players)
    const claims = new Map(players.map((player, i) => [player.viewerId, { ...truth.get(player.viewerId)!, elapsed: 42007 + i * 900 }]))
    await finishAll(players, truth, claims)
    assert.equal(witness.pendingCoopWitnessRounds(), 0)
    for (const player of players) assert.deepEqual(witnessFlags(player), [])
})

test("three humans: the one who inflates their own score is the odd one out, a hard flag; the others none", async () => {
    anticheat.setAnticheatMode("log")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    const liar = players[2]
    await finishAll(players, truth, new Map([[liar.viewerId, { score: 99999999999, contribution: truth.get(liar.viewerId)!.contribution }]]))

    assert.deepEqual(witnessFlags(players[0]), [])
    assert.deepEqual(witnessFlags(players[1]), [])
    const [flag] = witnessFlags(liar)
    assert.equal(flag.severity, "hard")
    assert.equal(flag.route, "multi_battle_quest/finish")
    assert.equal(flag.questId, QUEST)
    assert.equal(flag.details.round, 1)
    assert.equal(flag.details.members, 3)
    assert.equal(flag.details.finishers, 3)
    assert.equal(flag.details.excluded, undefined, "log mode excludes nothing")
    const [disagreement] = flag.details.disagreements as any[]
    assert.equal(disagreement.field, "score")
    assert.equal(disagreement.about, liar.playerId)
    assert.equal(disagreement.severity, "hard")
    assert.equal(disagreement.majority, truth.get(liar.viewerId)!.score)
    assert.deepEqual(disagreement.values.find((value: any) => value.by === liar.playerId).value, 99999999999)
})

test("three humans: a witness who lies about another member is the odd one out", async () => {
    anticheat.setAnticheatMode("log")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    const framer = players[1]
    await finishAll(players, truth, undefined, new Map([[framer.viewerId, new Map([[players[0].viewerId, { score: 5, contribution: 5 }]])]]))
    assert.deepEqual(witnessFlags(players[0]), [], "the member lied about is not flagged")
    assert.deepEqual(witnessFlags(players[2]), [])
    const [flag] = witnessFlags(framer)
    assert.equal(flag.severity, "hard")
    assert.deepEqual((flag.details.disagreements as any[]).map(item => item.field).sort(), ["contribution_score", "score"])
})

test("two humans who disagree are both flagged soft, since who lied is unknown", async () => {
    anticheat.setAnticheatMode("enforce")
    const players = [await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    await finishAll(players, truth, new Map([[players[1].viewerId, { ...truth.get(players[1].viewerId)!, score: 1 }]]))
    for (const player of players) {
        const [flag] = witnessFlags(player)
        assert.equal(flag.severity, "soft")
        assert.equal(flag.details.excluded, undefined, "a soft flag excludes nothing, even in enforce")
        assert.equal((flag.details.disagreements as any[])[0].field, "score")
        assert.equal((flag.details.disagreements as any[])[0].about, players[1].playerId)
    }
})

test("AI companions are no witnesses: their entries are ignored", async () => {
    anticheat.setAnticheatMode("log")
    const players = [await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    // each game reports the companions with another score (and one with a human's viewer id but a com_id)
    for (const [i, player] of players.entries()) {
        const other = players[1 - i]
        await ok(player, "multi_battle_quest/finish", finishBody(truth.get(player.viewerId)!, [
            { viewerId: other.viewerId, result: truth.get(other.viewerId)! },
            { viewerId: COMPANION, comId: COMPANION, result: { score: 100 + i, contribution: 7 + i } },
            { viewerId: other.viewerId + 1_000_000, comId: COMPANION + 1, result: { score: i, contribution: i } }
        ]))
    }
    for (const player of players) assert.deepEqual(witnessFlags(player), [])
})

test("a member who never finishes: the others are judged once the wait is over", async () => {
    anticheat.setAnticheatMode("log")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    const finishers = players.slice(0, 2)
    for (const player of finishers) {
        const other = finishers.find(mate => mate !== player)!
        const score = player === finishers[0] ? 1234 : truth.get(player.viewerId)!.score
        await ok(player, "multi_battle_quest/finish", finishBody({ ...truth.get(player.viewerId)!, score }, [
            { viewerId: other.viewerId, result: truth.get(other.viewerId)! },
            { viewerId: players[2].viewerId, result: truth.get(players[2].viewerId)! }
        ]))
    }
    assert.equal(witness.pendingCoopWitnessRounds(), 1, "waits for the third player")
    for (const player of finishers) assert.deepEqual(witnessFlags(player), [])

    witness.sweep(Date.now() + witness.WITNESS_TIMEOUT_MS + 1)
    assert.equal(witness.pendingCoopWitnessRounds(), 0)
    // only two reports on each item: both sides soft
    for (const player of finishers) assert.equal(witnessFlags(player)[0]?.severity, "soft")
    assert.deepEqual(witnessFlags(players[2]), [])
})

test("an abort ends a member's part: the round is judged without waiting", async () => {
    anticheat.setAnticheatMode("log")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    await finishAll(players.slice(0, 2), truth, new Map([[players[0].viewerId, { ...truth.get(players[0].viewerId)!, elapsed: 1000 }]]), undefined, false)
    assert.equal(witness.pendingCoopWitnessRounds(), 1)
    await ok(players[2], "multi_battle_quest/abort", { category: BOSS, room_number: target.roomNumber, quest_id: QUEST, play_id: "WITNESS", finish_kind: 1, statistics: {} })
    assert.equal(witness.pendingCoopWitnessRounds(), 0)
    assert.equal(witnessFlags(players[0])[0]?.severity, "soft")
    assert.equal((witnessFlags(players[0])[0]?.details.disagreements as any[])[0].field, "elapsed_time_ms")
})

test("Return to Room: each round is judged on its own", async () => {
    anticheat.setAnticheatMode("log")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    const truth = truthFor(players)
    await startRound(players, target)
    await finishAll(players, truth)
    rooms.openRound(target.room)

    await startRound(players, target)
    assert.equal(target.room.round, 2)
    const liar = players[0]
    await finishAll(players, truth, new Map([[liar.viewerId, { ...truth.get(liar.viewerId)!, score: truth.get(liar.viewerId)!.score * 2 }]]))
    const flags = witnessFlags(liar)
    assert.equal(flags.length, 1)
    assert.equal(flags[0].details.round, 2)
    assert.equal(flags[0].severity, "hard")
    assert.deepEqual(witnessFlags(players[1]), [])
})

test("a guest who crashed in an older room is judged in the round they finish: the newest of the finish's quest", async () => {
    anticheat.setAnticheatMode("log")
    const guest = await newPlayer()
    // room A's round started with the guest, who crashed: still in battle there, no end reported
    const crashed = await room([await newPlayer(), guest])
    rooms.startRound(crashed.room, [crashed.room.hostViewerId, guest.viewerId])

    const players = [await newPlayer(), await newPlayer(), guest]
    const target = await room(players)
    await startRound(players, target)
    assert.ok((target.room.roundStartedAtMs ?? 0) >= (crashed.room.roundStartedAtMs ?? 0))
    assert.equal(rooms.finishingRoundOf(guest.viewerId, QUEST, BOSS), target.room)
    assert.equal(rooms.finishingRoundOf(guest.viewerId, QUEST + 1, BOSS), undefined, "the quest must match")

    const truth = truthFor(players)
    await finishAll(players, truth, new Map([[guest.viewerId, { ...truth.get(guest.viewerId)!, score: 99999999999 }]]))
    const [flag] = witnessFlags(guest)
    assert.equal(flag.severity, "hard", "judged in room B's round, by its two other players")
    assert.equal(flag.details.members, 3)
    assert.equal(witness.pendingCoopWitnessRounds(), 0, "nothing was collected into room A's round")
})

test("contribution and clear time only ever raise soft flags: an honest phone can drift from the others", async () => {
    anticheat.setAnticheatMode("enforce")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    const odd = players[2]
    await finishAll(players, truth, new Map([[odd.viewerId, { ...truth.get(odd.viewerId)!, contribution: 1, elapsed: 120_000 }]]))
    const [flag] = witnessFlags(odd)
    assert.equal(flag.severity, "soft")
    assert.equal(flag.details.excluded, undefined)
    assert.deepEqual((flag.details.disagreements as any[]).map(item => item.field).sort(), ["contribution_score", "elapsed_time_ms"])
    assert.deepEqual(witnessFlags(players[0]), [], "the majority is not flagged")
})

const hardFlags = (player: Player) => flagStore.getPlayerAnticheatFlagsSync(player.playerId).filter(flag => flag.severity === "hard")

test("a player wiped out while the others clear: their frozen numbers raise soft flags only", async () => {
    anticheat.setAnticheatMode("enforce")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    const wiped = players[2]
    // a co-op boss event (HARD_MULTI_EVENT) pays a lost finish: the wiped player's score and their views of the others
    // froze at the wipe. The boss battle quest here refuses a lost finish, so the finishes go to the witness directly.
    const frozen = { score: 3_000_000_000, contribution: 5_000_000 }
    truth.set(wiped.viewerId, frozen)
    for (const player of players) {
        const own: Claim = player === wiped ? { ...frozen, elapsed: 30_000, accomplished: false } : truth.get(player.viewerId)!
        const mates = players.filter(other => other !== player).map(other => ({ viewerId: other.viewerId, result: player === wiped ? frozen : truth.get(other.viewerId)! }))
        const started = witness.beginCoopWitnessFinish(player.viewerId, player.playerId, QUEST, BOSS)
        assert.notEqual(started, null)
        witness.collectCoopFinish(started, finishBody(own, mates))
        rooms.noteRoundEnded(player.viewerId)
        witness.coopWitnessRoundEnded(player.viewerId)
    }
    assert.equal(witness.pendingCoopWitnessRounds(), 0)

    for (const player of players) assert.deepEqual(hardFlags(player), [], "no hard flag for anyone")
    assert.deepEqual(witnessFlags(players[0]), [])
    assert.deepEqual(witnessFlags(players[1]), [])
    const [flag] = witnessFlags(wiped)
    assert.equal(flag.severity, "soft")
    assert.equal(flag.details.excluded, undefined)
    assert.equal(flag.details.lost, 1)
    assert.equal((flag.details.claimed as any).is_accomplished, false)
    assert.ok((flag.details.disagreements as any[]).every(item => item.severity === "soft"))
    assert.ok((flag.details.disagreements as any[]).some(item => item.field === "is_accomplished"), "the split is noted")
})

test("an isolated player's finish casts no vote and isn't judged", async () => {
    anticheat.setAnticheatMode("enforce")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    const isolated = players[2]
    // it lost the connection and played on alone: its own battle and its views of the others went another way
    const alone = { score: 5_000_000_000, contribution: 3_000_000 }
    const seen = new Map([[isolated.viewerId, new Map(players.filter(other => other !== isolated).map(other => [other.viewerId, alone]))]])
    await finishAll(players, truth, new Map([[isolated.viewerId, { ...alone, isolated: true }]]), seen, false)

    assert.equal(witness.pendingCoopWitnessRounds(), 0, "the isolated finish ends the round for them")
    for (const player of players) {
        assert.deepEqual(witnessFlags(player), [])
        assert.deepEqual(hardFlags(player), [])
    }
})

test("enforce: a hard flag takes the finish's suggested party back off the board; the others' stay", async () => {
    anticheat.setAnticheatMode("enforce")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    const liar = players[1]
    // the liar lowers what it saw for the others too, so its finish agrees with itself: R8 (which would keep a finish whose
    // own and mates' scores are far apart off the board at once) lets it through, and R7 takes it back
    const lowered = new Map(players.filter(other => other !== liar).map(other => [other.viewerId, { ...truth.get(other.viewerId)!, score: 1 }]))
    await finishAll(players, truth, new Map([[liar.viewerId, { ...truth.get(liar.viewerId)!, score: 1 }]]), new Map([[liar.viewerId, lowered]]), false)

    const [flag] = witnessFlags(liar)
    assert.equal(flag.severity, "hard")
    assert.equal(flag.details.excluded, true)
    assert.deepEqual(flag.details.undone, ["suggested-party"])
    const { default: getDatabase, Database } = await import("../src/data")
    const stored = (getDatabase(Database.WDFP_DATA).prepare(`SELECT player_id FROM players_recent_quest_parties WHERE category = ? AND quest_id = ?`)
        .all(BOSS, QUEST) as { player_id: number }[]).map(row => row.player_id)
    assert.ok(!stored.includes(liar.playerId), "the liar's party is off the board")
    assert.ok(stored.includes(players[0].playerId) && stored.includes(players[2].playerId), "the honest players' parties stay")
})

test("mode off: nothing is collected or flagged", async () => {
    anticheat.setAnticheatMode("off")
    const players = [await newPlayer(), await newPlayer(), await newPlayer()]
    const target = await room(players)
    await startRound(players, target)
    const truth = truthFor(players)
    const liar = players[0]
    await finishAll(players, truth, new Map([[liar.viewerId, { ...truth.get(liar.viewerId)!, score: 1 }]]))
    assert.equal(witness.pendingCoopWitnessRounds(), 0)
    anticheat.setAnticheatMode("log")
    witness.sweep(Date.now() + witness.WITNESS_TIMEOUT_MS + 1)
    assert.deepEqual(witnessFlags(liar), [])
})

test("judgeVotes: majorities, splits and tolerances", () => {
    const by = (id: number) => ({ playerId: id, viewerId: id }) as never
    const exact = { abs: 0, rel: 0 }
    assert.equal(witness.judgeVotes([{ by: by(1), value: 5 }], exact), null, "one report proves nothing")
    assert.equal(witness.judgeVotes([{ by: by(1), value: 5 }, { by: by(2), value: 6 }], { abs: 1, rel: 0 }), null, "within the tolerance")
    assert.equal(witness.judgeVotes([{ by: by(1), value: 1000 }, { by: by(2), value: 1090 }], { abs: 0, rel: 0.1 }), null, "within the relative tolerance")
    const split = witness.judgeVotes([{ by: by(1), value: 5 }, { by: by(2), value: 9 }, { by: by(3), value: 20 }], { abs: 1, rel: 0 })!
    assert.equal(split.severity, "soft")
    assert.equal(split.flagged.length, 3, "three different values: no majority, everyone soft")
    const odd = witness.judgeVotes([{ by: by(1), value: true }, { by: by(2), value: true }, { by: by(3), value: false }], exact)!
    assert.equal(odd.severity, "hard")
    assert.deepEqual(odd.flagged, [by(3)])
})

// What each phone sent in the honest emulator rounds (2026-11-14): its own score, contribution and clear time, and what
// it saw for the other two. Players in the order of the device test's 17, 19 and 18; the third phone drifted from the
// others in the two long rounds.
const s = (score: number, contribution: number): Result => ({ score, contribution })
const EMULATOR_ROUNDS: { name: string, own: (Result & { elapsed: number })[], seen: (Result | null)[][] }[] = [
    {
        name: "Whitetail Inter., 2 s",
        own: [{ ...s(2031380, 487447), elapsed: 1972 }, { ...s(2013824, 6167), elapsed: 1972 }, { ...s(2028615, 31268), elapsed: 1972 }],
        seen: [[null, s(2009834, 6167), s(2010632, 29761)], [s(2011430, 487447), null, s(2010632, 29761)], [s(2017443, 487447), s(2015847, 6167), null]]
    },
    {
        name: "Whitetail Adv., 59 s",
        own: [{ ...s(26962021, 3241292), elapsed: 59330 }, { ...s(26943871, 2023803), elapsed: 59330 }, { ...s(27401534, 3065453), elapsed: 59415 }],
        seen: [[null, s(26940241, 2023803), s(26947501, 2215595)], [s(26943871, 3241292), null, s(26947501, 2215595)], [s(27386288, 2533331), s(27387377, 2004084), null]]
    },
    {
        name: "Whitetail Adv. after Return to Room, 52 s",
        own: [{ ...s(26750817, 2036066), elapsed: 52054 }, { ...s(26774190, 2861714), elapsed: 52054 }, { ...s(25541236, 2210780), elapsed: 56763 }],
        seen: [[null, s(26755640, 2861714), s(26745994, 2342389)], [s(26747107, 2036066), null, s(26745994, 2342389)], [s(25529524, 2799745), s(25536112, 2009615), null]]
    }
]

for (const round of EMULATOR_ROUNDS) {
    test(`the figures of an honest emulator round raise no flag: ${round.name}`, async () => {
        anticheat.setAnticheatMode("log")
        const players = [await newPlayer(), await newPlayer(), await newPlayer()]
        const target = await room(players)
        await startRound(players, target)
        for (const [i, player] of players.entries()) {
            const mates = players.flatMap((other, j) => round.seen[i][j] === null ? [] : [{ viewerId: other.viewerId, result: round.seen[i][j]! }])
            await ok(player, "multi_battle_quest/finish", finishBody(round.own[i], mates))
        }
        assert.equal(witness.pendingCoopWitnessRounds(), 0)
        for (const player of players) assert.deepEqual(witnessFlags(player), [])
    })
}
