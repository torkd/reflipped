import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, readCapturedRoute } from "./helpers";
import { enterLobby, gameRequest as coopRequest, newViewer } from "./coopHelpers";

// SEC-16, second part: a server-wide hourly cap on new guest accounts, the cleanup of accounts that never signed up,
// and AI companions in a co-op lobby only as the server issued them.

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let db: import("../src/data/sqlite").Database

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    const { default: getDatabase, Database } = await import("../src/data")
    db = getDatabase(Database.WDFP_DATA)
})

after(async () => {
    delete process.env.NEW_ACCOUNTS_PER_HOUR
    await cleanup()
})

/** `loginDevice` as the client sends it on a device's first launch; the same `whiteKey` is the same device. */
function loginDevice(whiteKey = randomUUID()) {
    const deviceId = randomUUID()
    return fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json;charset=UTF-8" },
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey, accessToken: "" }
    })
}

const accountCount = () => (db.prepare(`SELECT COUNT(*) AS count FROM accounts`).get() as { count: number }).count

test("new guest accounts stop at the hourly cap; known devices still log in", async () => {
    const known = randomUUID()
    assert.equal((await loginDevice(known)).statusCode, 200)
    process.env.NEW_ACCOUNTS_PER_HOUR = String(accountCount() + 1)
    try {
        assert.equal((await loginDevice()).statusCode, 200, "one more fits")
        const refused = await loginDevice()
        assert.equal(refused.statusCode, 503)
        assert.match(refused.json().message, /Too many new accounts/)
        const before = accountCount()
        assert.equal((await loginDevice(known)).statusCode, 200, "a device with an account isn't new")
        assert.equal(accountCount(), before)

        process.env.NEW_ACCOUNTS_PER_HOUR = "0"
        assert.equal((await loginDevice()).statusCode, 200, "0 turns the cap off")
    } finally {
        process.env.NEW_ACCOUNTS_PER_HOUR = "0"
    }

    const { newAccountsPerHourFromEnv } = await import("../src/lib/accountLimits")
    assert.equal(newAccountsPerHourFromEnv(""), 600, "unset")
    assert.equal(newAccountsPerHourFromEnv("abc"), 600)
    assert.equal(newAccountsPerHourFromEnv("-3"), 600)
    assert.equal(newAccountsPerHourFromEnv("25"), 25)
})

test("the cleanup deletes old accounts that never signed up, and nothing else", async () => {
    const lastAccountId = () => (db.prepare(`SELECT MAX(id) AS id FROM accounts`).get() as { id: number }).id
    const age = (accountId: number) => db.prepare(`UPDATE accounts SET reg_time = ? WHERE id = ?`).run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), accountId)
    const exists = (accountId: number) => db.prepare(`SELECT 1 FROM accounts WHERE id = ?`).get(accountId) !== undefined

    // logged in once, never signed up, its tokens gone: deleted
    await loginDevice()
    const unused = lastAccountId()
    age(unused)
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(unused)

    // the same, but its refresh token still lives: kept until it expires
    await loginDevice()
    const recentLogin = lastAccountId()
    age(recentLogin)

    // signed up (a player), tokens gone: kept
    await newViewer(fastify)
    const signedUp = lastAccountId()
    age(signedUp)
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(signedUp)

    // a portal user's account: kept
    await loginDevice()
    const portal = lastAccountId()
    age(portal)
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(portal)
    const users = await import("../src/data/users")
    const user = users.createUserSync({ username: "keeper", passwordHash: "x" })!
    users.setAccountUserSync(portal, user.id)

    // never signed up but new: kept
    await loginDevice()
    const fresh = lastAccountId()
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(fresh)

    const { UNUSED_ACCOUNT_AGE_MS } = await import("../src/lib/accountLimits")
    assert.equal(data.deleteUnusedAccountsSync(new Date(Date.now() - UNUSED_ACCOUNT_AGE_MS)), 1)
    assert.ok(!exists(unused))
    for (const kept of [recentLogin, signedUp, portal, fresh]) assert.ok(exists(kept), `account ${kept}`)
})

test("a lobby takes AI companions only from its host and only as the server issued them", async (t) => {
    const { CoopSocketServer, setCoopSocketServer } = await import("../src/lib/coop/socketServer")
    const server = new CoopSocketServer({ log: () => { } })
    const port = await server.listen(0, "127.0.0.1")
    setCoopSocketServer(server)
    t.after(async () => {
        setCoopSocketServer(null)
        await server.close()
    })
    const request = (route: string, body: Record<string, unknown>) => coopRequest(fastify, route, body)

    const hostViewer = await newViewer(fastify)
    const roomNumber = (await request("multi_battle_quest/create_room", { viewer_id: hostViewer, quest_id: 1001001, party_id: 11, category: 2 })).data.room_number
    const host = await enterLobby(port, hostViewer, roomNumber, "Host")
    const guest = await enterLobby(port, await newViewer(fastify), roomNumber, "Guest")
    await host.client.next() // Mates: the guest joined

    // one free slot: the summon issues one companion
    const summoned = (await request("multi_battle_quest/summon", { viewer_id: hostViewer, category_id: 2, room_number: roomNumber, quest_id: 1001001 })).data
    assert.deepEqual(Object.keys(summoned), ["mate1"])
    const issued = summoned.mate1

    // a forged party and rank on the issued companion, a companion nobody issued, and the guest summoning
    const forgedParty = { characters: [[0, { id: 999999, evolution_level: 9, exp: 99_999_999, mana_node_ids: [], over_limit_step: 99, ex_boost: [1], illustration_settings: [1] }]], unison_characters: [], equipments: [], abilitySoulIds: [], options: null }
    guest.client.send([0, [10, [{ comId: issued.com_id, degreeId: 1, name: "Guest's", party: forgedParty, rank: 999 }]]])
    assert.ok(await host.client.silent(), "a guest's EnterComs adds nothing")

    host.client.send([0, [10, [
        { comId: 4242, degreeId: 1, name: "Stranger", party: forgedParty, rank: 999 },
        { comId: issued.com_id, degreeId: 1, name: "N".repeat(100), party: forgedParty, rank: 999 }
    ]]])
    const mates = (await host.client.next())[1][1]
    const companions = mates.filter((mate: any) => mate.comId !== null)
    assert.equal(companions.length, 1, "only the issued companion")
    const companion = companions[0]
    assert.equal(companion.comId, issued.com_id)
    assert.equal(companion.rank, issued.rank)
    assert.equal(companion.degreeId, issued.degree_id)
    assert.equal(companion.name, "N".repeat(32))
    assert.equal(companion.playerRoleKind, 99)
    const { toMateParty } = await import("../src/lib/coop/companions")
    assert.deepEqual(companion.party, toMateParty(issued.party), "the party the summon issued")

    // the same companion again: already in the lobby
    host.client.send([0, [10, [{ comId: issued.com_id, degreeId: 1, name: "Again", party: forgedParty, rank: 1 }]]])
    assert.ok(await host.client.silent())

    host.client.close()
    guest.client.close()
})
