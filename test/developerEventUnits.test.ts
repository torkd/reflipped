import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"
import { createTestPlayer, createTestServer } from "./helpers"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
before(async () => { ({ fastify, cleanup } = await createTestServer()) })
after(async () => { await cleanup() })

test("developer mode grants skill-bearing event units and omits skill-less placeholders", async () => {
    const player = await createTestPlayer(fastify)
    const data = await import("../src/data/wdfpData")
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const { unlockEverything } = await import("../src/lib/developerMode")
    unlockEverything(playerId)
    // Independently checked against character, action skill, ability, leader ability and status master tables.
    const skillBearing = [700000, 700009, 700010, 700013, 700014, 700015, 700016, 700017, 700018, 700019]
    for (const id of skillBearing) {
        assert.notEqual(data.getPlayerCharacterSync(playerId, id), null, `event unit ${id}`)
        assert.ok(data.getPlayerCharacterManaNodesSync(playerId, id).length > 0, `mana nodes ${id}`)
    }
    for (const id of [700001, 700006, 700008, 700011, 700012]) {
        assert.equal(data.getPlayerCharacterSync(playerId, id), null, `skill-less unit ${id}`)
    }
})
