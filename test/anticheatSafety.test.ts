// SEC-18 QA (2026-11-14): anti-cheat must never cost a player their battle. With every anti-cheat table gone (a
// failed migration, a hand-edited database) finishes, honest or not, still succeed and the boards still load. Also
// the two exclusions phase 1 had no test for: in enforce mode an impossible finish leaves no suggested party and no
// rush endless best record, while an honest one does, and the endless run still advances.
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const MAIN = 1, MAIN_QUEST = 1001002
const RUSH = 22, RUSH_EVENT = 700001, ENDLESS_QUEST = 700001007

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let anticheat: typeof import("../src/lib/anticheat")
let flags: typeof import("../src/data/anticheatData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    anticheat = await import("../src/lib/anticheat")
    flags = await import("../src/data/anticheatData")
})
afterEach(() => anticheat.setAnticheatMode(null))
after(async () => { await cleanup() })

type Player = TestPlayer & { playerId: number }

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return fastify.inject({ method: "POST", url: `${apiPrefix}/${route}`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId }) })
}

async function newPlayer(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return { ...player, playerId: (await data.getAccountPlayers(session!.accountId))[0] }
}

/** A start and a finish; `honest` backdates the start by a minute, otherwise the clear is impossibly fast. */
async function battle(player: Player, questId: number, category: number, honest: boolean, elapsedMs = 30_000) {
    // a rush battle starts through its own route; the finish is the single battle's
    const started = category === RUSH
        ? await post(player, "event/rush/battle/start", { quest_id: questId, party_id: 1, is_auto_start_mode: false })
        : await post(player, "single_battle_quest/start", { quest_id: questId, category, party_id: 1,
            use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "QA" })
    assert.equal(started.statusCode, 200, started.body)
    const { getActiveQuest } = await import("../src/routes/api/singleBattleQuest")
    const active = getActiveQuest(player.playerId) as { startedAtMs?: number, startParty?: { characterIds: (number | null)[] } | null }
    if (honest) active.startedAtMs = Date.now() - 60_000
    const characters = active.startParty?.characterIds ?? [null, null, null]
    const frames = Math.floor(elapsedMs / 17)
    const finished = await post(player, "single_battle_quest/finish", {
        quest_id: questId, category, score: 1000, add_mana: 0, elapsed_time_ms: elapsedMs, is_accomplished: true,
        is_restored: false, continue_count: 0, api_count: 2, play_id: "QA",
        statistics: {
            clear_phase: 1,
            party: { characters: characters.map(id => id === null ? null : { id }), unison_characters: [null, null, null] },
            zones: [{ playthrough_ms: frames * 17, playthrough_frame: frames, damage_deal_total: 1000, damage_deal_max: 100 }]
        }
    })
    return finished
}

const hard = (playerId: number) => flags.getPlayerAnticheatFlagsSync(playerId).filter(flag => flag.severity === "hard")

async function suggestedPartyStored(playerId: number, category: number, questId: number): Promise<boolean> {
    const { default: getDatabase, Database } = await import("../src/data")
    return getDatabase(Database.WDFP_DATA).prepare(`SELECT 1 FROM players_recent_quest_parties WHERE player_id = ? AND category = ? AND quest_id = ?`)
        .get(playerId, category, questId) !== undefined
}

describe("exclusions in enforce mode", () => {
    test("an impossible finish leaves no suggested party; an honest one does", async () => {
        anticheat.setAnticheatMode("enforce")
        const cheat = await newPlayer()
        assert.equal((await battle(cheat, MAIN_QUEST, MAIN, false)).statusCode, 200)
        assert.ok(hard(cheat.playerId).length > 0, "the impossible finish is hard-flagged")
        assert.equal(await suggestedPartyStored(cheat.playerId, MAIN, MAIN_QUEST), false)

        const honest = await newPlayer()
        assert.equal((await battle(honest, MAIN_QUEST, MAIN, true)).statusCode, 200)
        assert.deepEqual(hard(honest.playerId), [])
        assert.equal(await suggestedPartyStored(honest.playerId, MAIN, MAIN_QUEST), true)
    })

    test("an impossible endless rush round advances the run but sets no best record; an honest one sets it", async () => {
        anticheat.setAnticheatMode("enforce")
        const cheat = await newPlayer()
        assert.equal((await post(cheat, "event/rush/summary", { event_id: RUSH_EVENT })).statusCode, 200, "the client opens the event first")
        const reply = await battle(cheat, ENDLESS_QUEST, RUSH, false)
        assert.equal(reply.statusCode, 200, reply.body)
        assert.ok(hard(cheat.playerId).length > 0)
        const cheatRush = data.getPlayerRushEventSync(cheat.playerId, RUSH_EVENT)
        assert.equal(cheatRush?.endlessBattleMaxRound ?? null, null, "no best record")
        assert.equal(data.getPlayerRushEventNextEndlessBattleRoundSync(cheat.playerId, RUSH_EVENT), 2, "the run still advances")

        const honest = await newPlayer()
        assert.equal((await post(honest, "event/rush/summary", { event_id: RUSH_EVENT })).statusCode, 200, "the client opens the event first")
        assert.equal((await battle(honest, ENDLESS_QUEST, RUSH, true)).statusCode, 200)
        assert.deepEqual(hard(honest.playerId), [])
        const honestRush = data.getPlayerRushEventSync(honest.playerId, RUSH_EVENT)
        assert.equal(honestRush?.endlessBattleMaxRound, 1)
        assert.equal(honestRush?.endlessBattleMaxRoundTime, 30_000)
    })
})

// last: it drops the anti-cheat tables for the rest of this file's database
describe("with the anti-cheat tables gone", () => {
    test("finishes still succeed in every mode, and the boards still load", async () => {
        const { default: getDatabase, Database } = await import("../src/data")
        const db = getDatabase(Database.WDFP_DATA)
        const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'anticheat%'`).all() as { name: string }[])
            .map(row => row.name)
        assert.ok(tables.length >= 6, `the anti-cheat tables exist: ${tables.join(", ")}`)
        db.pragma("foreign_keys = OFF")
        for (const table of tables) db.prepare(`DROP TABLE ${table}`).run()
        db.pragma("foreign_keys = ON")

        for (const mode of ["log", "enforce"] as const) {
            anticheat.setAnticheatMode(mode)
            const player = await newPlayer()
            for (const honest of [true, false]) {
                const reply = await battle(player, MAIN_QUEST, MAIN, honest)
                assert.equal(reply.statusCode, 200, `${mode}, ${honest ? "honest" : "impossible"}: ${reply.body}`)
                assert.ok(decodeGameBody(reply.body).data.user_info, "a full finish reply")
            }
            const rush = await battle(player, ENDLESS_QUEST, RUSH, true)
            assert.equal(rush.statusCode, 200, `${mode}, rush: ${rush.body}`)
            const ranking = await post(player, "ranking_event/get_summary", { ranking_event_id: 2, quest_kind: 8 })
            assert.ok(ranking.statusCode === 200, `${mode}, the ranking board: ${ranking.statusCode} ${ranking.body}`)
        }
    })
})
