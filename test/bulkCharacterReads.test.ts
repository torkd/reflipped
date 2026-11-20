import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestServer } from "./helpers";

test("character payload reads use three bulk queries regardless of collection size", async () => {
    const server = await createTestServer()
    try {
        const data = await import("../src/data/wdfpData")
        const { default: getDatabase, Database } = await import("../src/data")
        const db = getDatabase(Database.WDFP_DATA)
        const account = data.insertAccountSync({ appId: "test", idpAlias: "test", idpCode: "test", idpId: "bulk", status: "ok" })
        const player = data.insertDefaultPlayerSync(account.id)
        for (let id = 900001; id <= 900100; id++) data.insertDefaultPlayerCharacterSync(player.id, id)
        data.updatePlayerCharacterSync(player.id, 900001, { exBoost: { statusId: 12, abilityIdList: [34, 56] } })
        data.insertPlayerCharacterManaNodesSync(player.id, 900001, [1, 2])

        let reads = 0
        const originalPrepare = db.prepare
        db.prepare = ((sql: string) => {
            const statement = originalPrepare.call(db, sql)
            if (/SELECT[\s\S]*FROM players_characters(?:\s|_)/.test(sql)) {
                const get = statement.get.bind(statement)
                statement.get = (...params: unknown[]) => { reads++; return (get as (...args: unknown[]) => unknown)(...params) }
                const all = statement.all.bind(statement)
                statement.all = (...params: unknown[]) => { reads++; return (all as (...args: unknown[]) => unknown[])(...params) }
            }
            return statement
        }) as typeof db.prepare
        try {
            for (let run = 0; run < 2; run++) {
                const characters = data.getPlayerCharactersSync(player.id)
                const nodes = data.getPlayerCharactersManaNodesSync(player.id)
                assert.ok(Object.keys(characters).length >= 100)
                assert.deepEqual(characters[900001].exBoost, { statusId: 12, abilityIdList: [34, 56] })
                assert.deepEqual(characters[900001].bondTokenList, [{ manaBoardIndex: 1, status: 0 }, { manaBoardIndex: 2, status: 0 }])
                assert.deepEqual(nodes[900001], [1, 2])
                assert.equal(reads, (run + 1) * 3)
            }
        } finally { db.prepare = originalPrepare }
    } finally { await server.cleanup() }
})
