// New SH-14 coverage only: isolated database, no live server or device.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { createTestServer, encodeGameBody, decodeGameBody, gameHeaders, readCapturedRoute } from "./helpers"

let game: FastifyInstance, admin: FastifyInstance, cleanup: () => Promise<void>
let users: typeof import("../src/data/users")
let data: typeof import("../src/data/wdfpData")
const apiToken = "sh14-test-admin-token-".repeat(3)
const oldEnv = { ...process.env }
before(async () => {
    process.env.SERVER_NAME = "Default server"
    process.env.ADMIN_AUTH = "on"
    process.env.ADMIN_HOST = "127.0.0.1"
    delete process.env.ADMIN_PORT
    delete process.env.SHELL_ADMIN_URL
    ;({ fastify: game, admin, cleanup } = await createTestServer({ adminAuth: true, adminApiToken: apiToken }))
    users = await import("../src/data/users")
    data = await import("../src/data/wdfpData")
})
after(async () => { await cleanup(); for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k]; Object.assign(process.env, oldEnv) })
const save = (payload: Record<string, unknown>) => admin.inject({ method: "POST", url: "/api/server/settings", headers: { authorization: `Bearer ${apiToken}` }, payload })
const session = (whiteKey: string, headers: Record<string, string> = {}) => game.inject({ method: "POST", url: "/shell/session", headers, payload: { whiteKey } })
async function device(whiteKey: string) {
    const id = randomUUID()
    const response = await game.inject({ method: "POST", url: "/openapi/service/v4/auth/loginDevice", payload: { appId: "561429", deviceId: id, serialNo: id, whiteKey } })
    assert.equal(response.statusCode, 200, response.body)
    return response.json()
}

test("server identity persists atomically with numeric settings and stays out of presets", async () => {
    const settings = await import("../src/data/serverSettings")
    const config = (await game.inject({ method: "GET", url: "/shell/config" })).json()
    assert.equal(config.name, "Default server")
    assert.equal(config.reflipped, 1)
    assert.equal(config.portal, 1)
    assert.equal(typeof config.version, "string")
    assert.deepEqual(config.login, { account: true, guest: true, local: false })
    assert.equal(config.isAdmin, undefined)
    assert.equal(config.adminUrl, undefined)
    assert.equal((await save({ "server.name": "  My <server> & friends  ", "coop.companion_delay_seconds": 27 })).headers.location, "/settings?message=settings_saved")
    assert.equal(settings.getStoredText("server.name"), "My <server> & friends")
    process.env.SERVER_NAME = "Different environment"
    assert.equal(settings.getTextSetting("server.name"), "My <server> & friends")
    for (const invalid of ["", " ", "line\nline", "bad\u0000name", "x".repeat(65)]) {
        await save({ "server.name": invalid, "coop.companion_delay_seconds": 30 })
        assert.equal(settings.getTextSetting("server.name"), "My <server> & friends")
        assert.equal(settings.getSetting("coop.companion_delay_seconds"), 27)
    }
    await save({ "server.name": "Must roll back", "coop.companion_delay_seconds": 601 })
    assert.equal(settings.getTextSetting("server.name"), "My <server> & friends")
    assert.equal(settings.applyPreset("responsive"), true)
    assert.equal(settings.getTextSetting("server.name"), "My <server> & friends")
    assert.ok(!settings.presetKeys().includes("server.name" as never))
    const { adminSessions } = await import("../src/data/adminSessions")
    const boss = users.createUserSync({ username: "settingsadmin", passwordHash: "unused", role: "admin" })!
    const login = adminSessions.create(boss.id)
    const page = await admin.inject({ method: "GET", url: "/settings", headers: { cookie: `reflipped_admin=${login.token}` } })
    assert.match(page.body, /name="server.name" type="text"/)
    assert.match(page.body, /My &lt;server&gt; &amp; friends/)
    assert.equal((await game.inject({ method: "GET", url: "/shell/config" })).json().name, "My <server> & friends")
    settings.resetSettings()
    assert.equal(settings.getTextSetting("server.name"), "Different environment")
})

test("shell role comes only from a current device binding and never authenticates the admin browser", async () => {
    const key = randomUUID(), otherKey = randomUUID()
    const logged = await device(key), other = await device(otherKey)
    const boss = users.createUserSync({ username: "shelladmin", passwordHash: "unused", role: "admin" })!
    users.setAccountUserSync(Number(logged.player.playerId), boss.id)
    assert.deepEqual((await session(otherKey, { playerid: logged.player.playerId })).json(), { account: false, isAdmin: false, adminUrl: null })
    assert.deepEqual((await session(randomUUID())).json(), { account: false, isAdmin: false, adminUrl: null })
    assert.deepEqual((await session(key)).json(), { account: true, isAdmin: true, adminUrl: "http://localhost:8001/" })
    const { createPortalSessionSync } = await import("../src/data/portalSessions")
    const portal = createPortalSessionSync(boss.id)
    assert.equal((await admin.inject({ method: "GET", url: "/", headers: { cookie: `reflipped_portal=${portal.token}`, authorization: `Bearer ${key}` } })).headers.location, "/login")
    assert.equal((await game.inject({ method: "GET", url: "/api/server/clock" })).statusCode, 404)
    assert.equal((await session(key, { origin: "https://elsewhere.example" })).statusCode, 403)
    process.env.SHELL_ADMIN_URL = "https://admin.example.test/"
    assert.equal((await session(key)).json().adminUrl, "https://admin.example.test/")
    for (const invalid of ["javascript:alert(1)", "https://user:pass@admin.example.test/", "https://admin.example.test/?token=bad", "http://public.example.test/"]) {
        process.env.SHELL_ADMIN_URL = invalid
        assert.equal((await session(key)).json().adminUrl, null)
    }
    delete process.env.SHELL_ADMIN_URL
    process.env.ADMIN_AUTH = "off"
    assert.equal((await session(key)).json().adminUrl, null)
    process.env.ADMIN_AUTH = "on"
    process.env.ADMIN_PORT = "0"
    assert.equal((await session(key)).json().adminUrl, null)
    delete process.env.ADMIN_PORT
    users.setUserRoleSync(boss.id, "player")
    assert.deepEqual((await session(key)).json(), { account: true, isAdmin: false, adminUrl: null })
    // Changing the binding invalidates the prior device's capability immediately.
    data.setAccountDeviceSecretHashSync(Number(logged.player.playerId), (await import("../src/lib/deviceSecret")).hashDeviceSecret(randomUUID()))
    assert.deepEqual((await session(key)).json(), { account: false, isAdmin: false, adminUrl: null })
    users.setUserRoleSync(boss.id, "admin")
    const currentHash = (await import("../src/lib/deviceSecret")).hashDeviceSecret(otherKey)
    data.setAccountDeviceSecretHashSync(Number(logged.player.playerId), currentHash)
    assert.deepEqual((await session(otherKey)).json(), { account: false, isAdmin: false, adminUrl: null }, "ambiguous legacy secrets confer no role")
    assert.equal(Number(other.player.playerId) > 0, true)
})

test("admin URL hints respect bind scope and never use forwarded hosts", async () => {
    const { shellAdminUrl } = await import("../src/lib/shellSession")
    const request = (host: string) => ({ headers: { host, "x-forwarded-host": "attacker.example" } } as never)
    assert.equal(shellAdminUrl(request("192.168.1.2:8000")), null, "loopback-only admin is not remotely reachable")
    process.env.ADMIN_HOST = "0.0.0.0"
    assert.equal(shellAdminUrl(request("192.168.1.2:8000")), "http://192.168.1.2:8001/")
    assert.equal(shellAdminUrl(request("public.example:8000")), null)
    assert.equal(shellAdminUrl(request("evil@localhost:8000")), null)
    assert.equal(shellAdminUrl(request("localhost:8000/path")), null)
    assert.equal(shellAdminUrl(request("[::1]:8000")), "http://[::1]:8001/")
    assert.equal(shellAdminUrl(request("localhost:8000")), "http://localhost:8001/")
    process.env.ADMIN_PORT = "8000"
    assert.equal(shellAdminUrl(request("localhost:8000")), null, "admin cannot share game port")
    delete process.env.ADMIN_PORT
    process.env.ADMIN_HOST = "127.0.0.1"
})

test("guest signout releases viewer sessions and preserves the save and device identity", async () => {
    const key = randomUUID(), otherKey = randomUUID()
    const logged = await device(key), other = await device(otherKey)
    const captured = readCapturedRoute("load").requestBody
    const signup = await game.inject({ method: "POST", url: "/latest/api/index.php/tool/signup", headers: gameHeaders(randomUUID()),
        payload: encodeGameBody({ app_secret: captured.app_secret, access_token: logged.zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3" }) })
    assert.equal(signup.statusCode, 200, signup.body)
    assert.ok(decodeGameBody(signup.body).data_headers.viewer_id)
    const accountId = Number(logged.player.playerId), playerId = data.getAccountPlayersSync(accountId)[0]
    const { default: getDatabase, Database } = await import("../src/data")
    const db = getDatabase(Database.WDFP_DATA)
    const count = (id: number) => (db.prepare("SELECT count(*) AS n FROM sessions WHERE account_id = ?").get(id) as { n: number }).n
    assert.ok(count(accountId) > 0)
    const otherCount = count(Number(other.player.playerId))
    const logout = () => game.inject({ method: "POST", url: "/portal/shell/logout", payload: { whiteKey: key } })
    assert.equal((await logout()).statusCode, 204)
    assert.equal(count(accountId), 0)
    assert.equal(count(Number(other.player.playerId)), otherCount)
    assert.equal(data.getAccountPlayersSync(accountId)[0], playerId)
    assert.equal(Number((await device(key)).player.playerId), accountId)
    assert.equal((await logout()).statusCode, 204)
    assert.equal((await game.inject({ method: "POST", url: "/portal/shell/logout", payload: {} })).statusCode, 400)
    assert.equal((await game.inject({ method: "POST", url: "/portal/shell/logout", payload: { deviceToken: "rfp1.unknown" } })).statusCode, 204)
})

test("logout accepts a legacy linked install key and portal token without affecting unrelated accounts", async () => {
    const key = randomUUID(), otherKey = randomUUID()
    const linked = await device(key), other = await device(otherKey)
    const owner = users.createUserSync({ username: "legacyowner", passwordHash: "unused" })!
    const linkedId = Number(linked.player.playerId), otherId = Number(other.player.playerId)
    users.setAccountUserSync(linkedId, owner.id)
    const { default: getDatabase, Database } = await import("../src/data")
    const db = getDatabase(Database.WDFP_DATA)
    const count = (id: number) => (db.prepare("SELECT count(*) AS n FROM sessions WHERE account_id = ?").get(id) as { n: number }).n
    const otherCount = count(otherId)
    assert.ok(count(linkedId) > 0)
    assert.equal((await game.inject({ method: "POST", url: "/portal/shell/logout", payload: { whiteKey: randomUUID() } })).statusCode, 204)
    assert.ok(count(linkedId) > 0)
    assert.equal((await game.inject({ method: "POST", url: "/portal/shell/logout", payload: { whiteKey: key } })).statusCode, 204)
    assert.equal(count(linkedId), 0)
    assert.equal(users.getAccountUserIdSync(linkedId), owner.id)
    assert.equal(Number((await device(key)).player.playerId), linkedId)
    const { signInDeviceSync } = await import("../src/lib/shellSignIn")
    const signed = signInDeviceSync(owner.id, null, "561429")
    await device(signed.token)
    assert.ok(count(linkedId) > 0)
    assert.equal((await game.inject({ method: "POST", url: "/portal/shell/logout", payload: { whiteKey: signed.token } })).statusCode, 204)
    assert.ok(count(linkedId) > 0, "portal token must use its existing field")
    assert.equal((await game.inject({ method: "POST", url: "/portal/shell/logout", payload: { deviceToken: signed.token } })).statusCode, 204)
    assert.equal(count(linkedId), 0)
    assert.equal(count(otherId), otherCount)
    assert.equal(Number((await device(signed.token)).player.playerId), linkedId, "existing token contract retains binding")
})

test("shell portal chain is styled and named, while the account portal and security stay intact", async () => {
    for (const url of ["/portal/login?next=shell", "/portal/register?next=shell"]) {
        const page = await game.inject({ method: "GET", url })
        assert.equal(page.statusCode, 200)
        assert.match(page.body, /shell-portal.css/)
        assert.match(page.body, /shell-server-name/)
        assert.match(page.body, /next=shell/)
        assert.match(String(page.headers["content-security-policy"]), /form-action 'self'/)
    }
    const plain = await game.inject({ method: "GET", url: "/portal/login" })
    assert.doesNotMatch(plain.body, /shell-portal.css/)
    for (const path of ["/game/support", "/game/terms", "/game/privacy", "/game/credits"]) {
        const page = await game.inject({ method: "GET", url: path })
        assert.equal(page.statusCode, 200)
        assert.match(page.body, /Different environment/)
        assert.equal(page.headers["cache-control"], "no-store")
    }
})
