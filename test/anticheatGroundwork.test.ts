import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

// SEC-18 phase 0: the anti-cheat mode, the flag store, the facts a battle start records, the informational flag for
// imported saves, and developer-mode players kept off shared boards in every mode.

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
after(async () => {
    delete process.env.ANTICHEAT
    await cleanup()
})

const apiPrefix = "/latest/api/index.php"

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return fastify.inject({ method: "POST", url: `${apiPrefix}/${route}`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId }) })
}

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const loaded = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    assert.equal(loaded.statusCode, 200, loaded.body)
    return { ...player, playerId }
}

test("the mode: log by default, ANTICHEAT next, the admin's choice first, always off on the phone's server", () => {
    delete process.env.ANTICHEAT
    anticheat.setAnticheatMode(null)
    assert.equal(anticheat.anticheatMode(), "log")
    process.env.ANTICHEAT = "enforce"
    assert.equal(anticheat.anticheatMode(), "enforce")
    process.env.ANTICHEAT = "nonsense"
    assert.equal(anticheat.anticheatMode(), "log")
    anticheat.setAnticheatMode("off")
    assert.equal(anticheat.anticheatMode(), "off")
    assert.throws(() => anticheat.setAnticheatMode("loud" as never), RangeError)
    anticheat.setAnticheatMode(null)
    delete process.env.ANTICHEAT
    process.env.REFLIPPED_PROFILE = "local"
    try {
        assert.equal(anticheat.anticheatMode(), "off")
    } finally {
        delete process.env.REFLIPPED_PROFILE
    }
})

test("the stored mode is cached briefly; the admin's change is seen at once", async () => {
    const { setStoredText } = await import("../src/data/serverSettings")
    anticheat.setAnticheatMode("enforce")
    assert.equal(anticheat.anticheatMode(), "enforce")
    // a write that bypasses setAnticheatMode isn't read again on every call (a finish asks several times)
    setStoredText("anticheat.mode", "off")
    assert.equal(anticheat.anticheatMode(), "enforce", "served from the cache")
    anticheat.setAnticheatMode("log")
    assert.equal(anticheat.anticheatMode(), "log", "setAnticheatMode drops the cache")
    anticheat.setAnticheatMode(null)
    assert.equal(anticheat.anticheatMode(), "log")
})

test("flags are recorded unless the mode is off, and restriction is stored per player", async () => {
    const { playerId } = await newPlayer()
    anticheat.setAnticheatMode("off")
    assert.equal(anticheat.recordAnticheatFlag({ playerId, rule: "test", severity: "hard" }), null)
    anticheat.setAnticheatMode(null)
    const id = anticheat.recordAnticheatFlag({ playerId, rule: "wall-clock", severity: "hard", questId: 1002, details: { elapsedMs: 5 } })
    assert.ok(id !== null)
    const [flag] = flags.getPlayerAnticheatFlagsSync(playerId)
    assert.deepEqual({ rule: flag.rule, severity: flag.severity, questId: flag.questId, details: flag.details, status: flag.status },
        { rule: "wall-clock", severity: "hard", questId: 1002, details: { elapsedMs: 5 }, status: "open" })
    assert.equal(flags.countOpenAnticheatFlagsSync().get(playerId), 1)

    assert.equal(flags.isPlayerRestrictedSync(playerId), false)
    flags.setPlayerRestrictedSync(playerId, true, null)
    assert.equal(flags.isPlayerRestrictedSync(playerId), true)
    assert.ok(flags.getRestrictedPlayerIdsSync().includes(playerId))
    flags.setPlayerRestrictedSync(playerId, false, null)
    assert.equal(flags.isPlayerRestrictedSync(playerId), false)
})

test("a battle start records its real start time and party", async () => {
    const player = await newPlayer()
    const { getActiveQuest } = await import("../src/routes/api/singleBattleQuest")
    const before = Date.now()
    const started = await post(player, "single_battle_quest/start", { quest_id: 1002, category: 7, party_id: 1,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, play_id: "SEC18" })
    assert.equal(started.statusCode, 200, started.body)
    const quest = getActiveQuest(player.playerId)!
    assert.ok(quest.startedAtMs! >= before && quest.startedAtMs! <= Date.now())
    const party = data.getPlayerPartyBySlotSync(player.playerId, 1)
    assert.deepEqual(quest.startParty, party === null ? null : { slot: 1, characterIds: party.characterIds })
})

test("an imported save gets an informational flag", async () => {
    const { playerId } = await newPlayer()
    const { setRewardPolicy } = await import("../src/lib/rewardPolicy")
    const { importPlayerSave } = await import("../src/lib/playerSaveImport")
    const { getClientSerializedData } = await import("../src/data/utils")
    setRewardPolicy({ management: "managed" })
    const save = JSON.stringify(getClientSerializedData(playerId, { serializeRushEventData: true, serializeSaveData: true }))
    assert.equal(importPlayerSave(playerId, Buffer.from(save), fastify.log), "imported")
    const flag = flags.getPlayerAnticheatFlagsSync(playerId).find(candidate => candidate.rule === "imported-save")
    assert.equal(flag?.severity, "info")
    assert.equal(flags.countOpenAnticheatFlagsSync().get(playerId), undefined, "informational flags aren't open findings")
})

test("developer-mode players leave the shared boards and come back after the revert", async () => {
    const { developerModePlayers } = await import("../src/lib/developerModePlayers")
    const { unlockEverything, revertUnlock } = await import("../src/lib/developerMode")
    const honest = await newPlayer()
    const unlocked = await newPlayer()
    const party = { characterIds: [1, null, null] } as unknown as import("../src/data/wdfpData").RecentQuestParty
    data.upsertPlayerRecentQuestPartySync(honest.playerId, 7, 1002, party, new Date(1000))
    data.upsertPlayerRecentQuestPartySync(unlocked.playerId, 7, 1002, party, new Date(2000))
    const asker = await newPlayer()
    assert.equal(data.getRecentQuestPartiesSync(7, 1002, asker.playerId, 10).length, 2)

    assert.ok(unlockEverything(unlocked.playerId) !== null)
    assert.ok(developerModePlayers().has(unlocked.playerId))
    assert.equal(data.getRecentQuestPartiesSync(7, 1002, asker.playerId, 10, developerModePlayers()).length, 1)

    assert.equal(revertUnlock(unlocked.playerId), true)
    assert.equal(developerModePlayers().has(unlocked.playerId), false)
})
