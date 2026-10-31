import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

// SEC-12: the admin site has no proxy in front, so forwarded headers must not change what it trusts, even when the
// game listener trusts a proxy (TRUST_PROXY=127.0.0.1 in the systemd unit). And player names go into its pages as text.

let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ admin, cleanup } = await createTestServer({ trustProxy: "127.0.0.1" }))
})

after(async () => {
    await cleanup()
})

test("X-Forwarded-Host doesn't pass the admin host check (DNS rebinding from the operator's browser)", async () => {
    const response = await admin.inject({
        method: "GET",
        url: "/api/player",
        remoteAddress: "127.0.0.1",
        headers: { host: "evil.example:8001", "x-forwarded-host": "localhost" }
    })
    assert.equal(response.statusCode, 403)
    const direct = await admin.inject({ method: "GET", url: "/api/player", remoteAddress: "127.0.0.1", headers: { host: "localhost:8001" } })
    assert.equal(direct.statusCode, 200)
})

test("a player name with $ replacement patterns is shown as typed", async () => {
    const { default: getDatabase, Database } = await import("../src/data")
    const data = await import("../src/data/wdfpData")
    const accountId = getDatabase(Database.WDFP_DATA).prepare(`INSERT INTO accounts (app_id, first_login_time, idp_alias, idp_code, idp_id, reg_time, last_login_time, status) VALUES ('a', 0, 'a', 'zd3', ?, 0, 0, 'n')`)
        .run(randomUUID()).lastInsertRowid as number
    data.insertDefaultPlayerSync(accountId)
    const player = data.getPlayerFromAccountIdSync(accountId)!
    data.updatePlayerSync({ id: player.id, name: "a$`b$&c" })

    for (const url of ["/player", `/player/${player.id}`]) {
        const page = await admin.inject({ method: "GET", url, headers: { host: "localhost:8001" } })
        assert.equal(page.statusCode, 200, url)
        assert.ok(page.body.includes("a$`b$&amp;c"), `${url} shows the name`)
        assert.equal(page.body.split("<html").length - 1, 1, `${url}: one document`)
        assert.ok(!page.body.includes("{{"), `${url}: no placeholder left`)
    }
})
