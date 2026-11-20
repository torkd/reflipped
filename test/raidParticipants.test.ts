// FT-75: in the automatic raid pool a player counts as a whole participant only after RAID_FULL_PARTICIPANT_KILLS
// kills, so throwaway accounts with one light kill each can't slow the server's kill tally (security review 2026-11-13).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";
import raidQuests from "../assets/raid_event_quest.json";

const EVENT = 1
const HELL = 1004, NOVICE = 1001
const weight = (questId: number) => (raidQuests as Record<string, { killWeight: number }>)[String(questId)].killWeight

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let raid: typeof import("../src/lib/raid")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    raid = await import("../src/lib/raid")
    raid.setRaidHpPolicy({ mode: "automatic", players: 1 })
})
after(async () => { await cleanup() })

async function playerWithKills(questId: number, kills: number): Promise<number> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.setPlayerRaidRecordSync(playerId, EVENT, { questId, killCount: kills, highScore: 0, party: [] } as never)
    return playerId
}

test("one-kill accounts count as a third of a participant each; three kills make a whole one", async () => {
    await playerWithKills(HELL, 30)
    for (let i = 0; i < 5; i++) await playerWithKills(NOVICE, 1)
    const damage = 30 * weight(HELL) + 5 * weight(NOVICE)
    const pool = raid.raidPoolSize(EVENT, 1 + 5 / 3)
    assert.ok(pool < raid.raidPoolSize(EVENT, 6), "the alts no longer add a full share each")
    assert.equal(raid.raidBossSync(EVENT).totalKills, Math.floor(damage / pool))

    await playerWithKills(NOVICE, 3)
    const fuller = raid.raidPoolSize(EVENT, 2 + 5 / 3)
    assert.equal(raid.raidBossSync(EVENT).totalKills, Math.floor((damage + 3 * weight(NOVICE)) / fuller))
})
