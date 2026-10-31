import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

// Save import on the admin page (SEC-9): size limit, schema check, one transaction.

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

/** The admin page's "Upload save" form: one multipart file field. */
function uploadSave(playerId: number, content: string | Buffer) {
    const boundary = "----save"
    const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="save-data"; filename="save.json"\r\nContent-Type: application/json\r\n\r\n`),
        Buffer.isBuffer(content) ? content : Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
    return admin.inject({
        method: "POST",
        url: `/api/player/save?id=${playerId}`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload
    })
}

async function newPlayer(): Promise<number> {
    await createTestPlayer(fastify)
    const { getAllPlayersSync } = await import("../src/data/wdfpData")
    const players = getAllPlayersSync()
    return players[players.length - 1].id
}

async function exportSave(playerId: number): Promise<any> {
    const response = await admin.inject({ method: "GET", url: `/api/player/save?id=${playerId}` })
    assert.equal(response.statusCode, 200)
    return response.json()
}

test("an exported save imports back, including a developer-mode save", async () => {
    const data = await import("../src/data/wdfpData")
    const playerId = await newPlayer()
    const ownSave = await exportSave(playerId)

    await admin.inject({ method: "POST", url: `/api/player/developer-mode?id=${playerId}&state=on`, headers: { "content-type": "multipart/form-data; boundary=----form" }, payload: "------form--\r\n" })
    const unlockedSave = await exportSave(playerId)
    const unlockedCharacters = Object.keys(data.getPlayerCharactersSync(playerId)).length

    // the own save replaces the unlocked one...
    const restored = await uploadSave(playerId, JSON.stringify(ownSave))
    assert.equal(restored.statusCode, 302)
    assert.equal(restored.headers.location, `/player/${playerId}?message=save-imported`)
    assert.equal(Object.keys(data.getPlayerCharactersSync(playerId)).length, Object.keys(ownSave.user_character_list).length)

    // ...and the big developer-mode save (wrapped like the game's /load) goes back in too
    const reimported = await uploadSave(playerId, JSON.stringify({ data: unlockedSave }))
    assert.equal(reimported.headers.location, `/player/${playerId}?message=save-imported`)
    assert.equal(Object.keys(data.getPlayerCharactersSync(playerId)).length, unlockedCharacters)
})

test("an invalid save is refused with a fixed message and the old data is kept", async () => {
    const data = await import("../src/data/wdfpData")
    const playerId = await newPlayer()
    const save = await exportSave(playerId)
    const before = data.getPlayerSync(playerId)

    const bad = [
        "not json",
        JSON.stringify([]),
        JSON.stringify({ ...save, user_info: { ...save.user_info, stamina: "<script>alert(1)</script>" } }),
        JSON.stringify({ ...save, user_info: { ...save.user_info, free_vmoney: -5 } }),
        JSON.stringify({ ...save, user_info: { ...save.user_info, name: "x".repeat(1000) } }),
        JSON.stringify({ ...save, item_list: { "abc": 1 } }),
        JSON.stringify({ ...save, user_rush_event_list: { "1": { player_id: 2 } } }),
        JSON.stringify({ ...save, user_character_list: { "999999999": Object.values(save.user_character_list)[0] } }),
        JSON.stringify((({ user_info, ...rest }) => rest)(save))
    ]
    for (const content of bad) {
        const response = await uploadSave(playerId, content)
        assert.equal(response.statusCode, 302, content.slice(0, 60))
        assert.equal(response.headers.location, `/player/${playerId}?error=save-invalid`, content.slice(0, 60))
    }
    assert.deepEqual(data.getPlayerSync(playerId), before)

    // the page shows a fixed text for the code, never the file's content or an exception message
    const page = await admin.inject({ method: "GET", url: `/player/${playerId}?error=save-invalid` })
    assert.match(page.body, /That file is not a valid save\. Nothing was changed/)
})

test("a file over the size limit is refused", async () => {
    const { maxSaveFileBytes } = await import("../src/data/saveSchema")
    const playerId = await newPlayer()
    const response = await uploadSave(playerId, Buffer.alloc(maxSaveFileBytes + 1, " "))
    assert.equal(response.statusCode, 302)
    assert.equal(response.headers.location, `/player/${playerId}?error=save-too-large`)
})

test("an import that fails in the database is rolled back and leaves the old save intact", async () => {
    const data = await import("../src/data/wdfpData")
    const playerId = await newPlayer()
    const save = await exportSave(playerId)
    const before = {
        player: data.getPlayerSync(playerId),
        characters: data.getPlayerCharactersSync(playerId),
        items: data.getPlayerItemsSync(playerId)
    }

    // passes the schema, but mana nodes for a character the save doesn't own break a foreign key mid-insert
    const broken = { ...save, user_info: { ...save.user_info, free_vmoney: 12345 }, user_character_mana_node_list: { "111001": [1, 2] } }
    assert.equal(save.user_character_list["111001"], undefined)
    const response = await uploadSave(playerId, JSON.stringify(broken))
    assert.equal(response.statusCode, 302)
    assert.equal(response.headers.location, `/player/${playerId}?error=save-failed`)

    assert.deepEqual(data.getPlayerSync(playerId), before.player, "player row restored")
    assert.deepEqual(data.getPlayerCharactersSync(playerId), before.characters)
    assert.deepEqual(data.getPlayerItemsSync(playerId), before.items)
})

test("unknown notice codes and raw text in ?error= are not shown", async () => {
    const playerId = await newPlayer()
    for (const query of ["error=%3Cb%3Ehello%3C%2Fb%3E", "message=Your%20server%20was%20hacked", "error=constructor", "message=__proto__"]) {
        const page = await admin.inject({ method: "GET", url: `/player/${playerId}?${query}` })
        assert.equal(page.statusCode, 200, query)
        assert.doesNotMatch(page.body, /notice-(error|info)|hello|hacked/, query)
    }
})
