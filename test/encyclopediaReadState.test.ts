import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
const ENTRY = 133100501
const OTHER = 100000101
before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})
after(async () => { await cleanup() })
async function post(player: TestPlayer, route: string, ids?: number[]) {
    const response = await fastify.inject({
        method: "POST", url: `/latest/api/index.php/encyclopedia/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, ...(ids === undefined ? {} : { encyclopedia_ids: ids }) })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null }
}

test("read history survives a new request and fresh process, and belongs only to its player", async () => {
    const alice = await createTestPlayer(fastify)
    const bob = await createTestPlayer(fastify)
    assert.deepEqual((await post(alice, "index")).body.data.encyclopedia_list[ENTRY], { read: false })
    assert.deepEqual((await post(alice, "unlock_keyword", [ENTRY, ENTRY])).body.data.encyclopedia_list, { [ENTRY]: { read: false } })
    assert.deepEqual((await post(alice, "read_keyword", [ENTRY])).body.data.encyclopedia_list, { [ENTRY]: { read: true } })
    assert.deepEqual((await post(alice, "index")).body.data.encyclopedia_list[ENTRY], { read: true })
    assert.deepEqual((await post(bob, "index")).body.data.encyclopedia_list[ENTRY], { read: false })
    // A client retry or repeated unlock must not turn a read entry unread again.
    assert.deepEqual((await post(alice, "unlock_keyword", [ENTRY])).body.data.encyclopedia_list, { [ENTRY]: { read: true } })
    const playerId = data.getViewerPlayerIdSync(alice.viewerId)!
    const output = execFileSync(process.execPath, ["--import", "tsx", "-e",
        `const { getPlayerEncyclopediaSync } = require('./src/data/encyclopedia.ts'); console.log(getPlayerEncyclopediaSync(${playerId})[${ENTRY}].read)`],
        { env: { ...process.env }, encoding: "utf8" })
    assert.equal(output.trim(), "true")
})

test("invalid batches write nothing; duplicate and empty batches are harmless", async () => {
    const player = await createTestPlayer(fastify)
    for (const route of ["read_keyword", "unlock_keyword"]) {
        assert.equal((await post(player, route, [OTHER, -1])).status, 400)
        assert.equal((await post(player, route, [1e100])).status, 400)
        assert.deepEqual((await post(player, route, [])).body.data.encyclopedia_list, {})
    }
    assert.deepEqual((await post(player, "index")).body.data.encyclopedia_list[OTHER], { read: false })
    const db = (await import("../src/data")).default((await import("../src/data")).Database.WDFP_DATA)
    const playerId = data.getViewerPlayerIdSync(player.viewerId)!
    assert.equal((db.prepare('SELECT count(*) AS n FROM players_encyclopedia WHERE player_id = ?').get(playerId) as { n: number }).n, 0)
    assert.equal((await post(player, "read_keyword", [OTHER, OTHER])).status, 200)
    assert.equal((db.prepare('SELECT count(*) AS n FROM players_encyclopedia WHERE player_id = ?').get(playerId) as { n: number }).n, 1)
})

test("save replacement preserves history; developer backup restoration restores its own history; deletion cascades", async () => {
    const player = await createTestPlayer(fastify)
    const playerId = data.getViewerPlayerIdSync(player.viewerId)!
    const { getClientSerializedData, deserializePlayerData } = await import("../src/data/utils")
    const originalSave = getClientSerializedData(playerId, { serializeSaveData: true, serializeRushEventData: true })
    assert.ok(originalSave)
    await post(player, "read_keyword", [ENTRY])
    const backupRecords = data.getPlayerProgressRecordsSync(playerId)
    data.replacePlayerDataSync(deserializePlayerData(playerId, originalSave))
    assert.deepEqual((await post(player, "index")).body.data.encyclopedia_list[ENTRY], { read: true })
    await post(player, "read_keyword", [OTHER])
    data.replacePlayerDataSync(deserializePlayerData(playerId, originalSave), { progressRecords: backupRecords })
    const list = (await post(player, "index")).body.data.encyclopedia_list
    assert.deepEqual(list[ENTRY], { read: true })
    assert.deepEqual(list[OTHER], { read: false })
    data.deletePlayerSync(playerId)
    const db = (await import("../src/data")).default((await import("../src/data")).Database.WDFP_DATA)
    assert.equal((db.prepare('SELECT count(*) AS n FROM players_encyclopedia WHERE player_id = ?').get(playerId) as { n: number }).n, 0)
})
