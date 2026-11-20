import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createTestServer } from "./helpers";

test("install-key logout releases a selected legacy duplicate and preserves every save and binding", async () => {
    const server = await createTestServer()
    try {
        const data = await import("../src/data/wdfpData")
        const users = await import("../src/data/users")
        const { SessionType } = await import("../src/data/types")
        const { hashDeviceSecret } = await import("../src/lib/deviceSecret")
        const { default: getDatabase, Database } = await import("../src/data")
        const db = getDatabase(Database.WDFP_DATA)
        const shared = randomUUID(), unrelated = randomUUID()
        const make = async (secret: string) => {
            const account = data.insertAccountSync({ appId: "561429", idpAlias: randomUUID(), idpCode: "zd3", idpId: randomUUID(), status: "normal" })
            data.setAccountDeviceSecretHashSync(account.id, hashDeviceSecret(secret))
            const player = data.insertDefaultPlayerSync(account.id)
            await data.insertSessionWithToken({ token: String(100000000 + account.id), expires: new Date(Date.now() + 60000), accountId: account.id, type: SessionType.VIEWER })
            return { account, player }
        }
        const first = await make(shared), selected = await make(shared), other = await make(unrelated)
        const owner = users.createUserSync({ username: "duplicateowner", passwordHash: "unused" })!
        users.setAccountUserSync(selected.account.id, owner.id)
        const login = await server.fastify.inject({ method: "POST", url: "/openapi/service/v4/auth/loginDevice",
            headers: { playerid: String(selected.account.id) },
            payload: { appId: "561429", deviceId: "test-device", serialNo: "test-serial", whiteKey: shared } })
        assert.equal(login.statusCode, 200, login.body)
        assert.equal(login.json().player.playerId, String(selected.account.id), "the active account need not be the first duplicate")
        const sessions = (id: number) => (db.prepare("SELECT count(*) AS n FROM sessions WHERE account_id = ?").get(id) as { n: number }).n
        assert.ok(sessions(selected.account.id) > 0)
        const otherSessions = sessions(other.account.id)
        const reply = await server.fastify.inject({ method: "POST", url: "/portal/shell/logout", payload: { whiteKey: shared } })
        assert.equal(reply.statusCode, 204)
        assert.equal(sessions(first.account.id), 0)
        assert.equal(sessions(selected.account.id), 0, "selected duplicate's viewer must be free for the next account")
        assert.equal(sessions(other.account.id), otherSessions)
        for (const entry of [first, selected, other]) {
            assert.equal(data.getAccountPlayersSync(entry.account.id)[0], entry.player.id)
            assert.equal(data.getAccountDeviceSecretHashSync(entry.account.id), hashDeviceSecret(entry === other ? unrelated : shared))
        }
        assert.equal(users.getAccountUserIdSync(selected.account.id), owner.id)
    } finally { await server.cleanup() }
})
