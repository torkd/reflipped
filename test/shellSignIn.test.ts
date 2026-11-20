import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { Database as SqliteDatabase } from "../src/data/sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

// ACC-3: the shell signs in through the portal and plays the user's one save on one device at a time
// (docs/accounts.md "Shell login").

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let db: SqliteDatabase
let users: typeof import("../src/data/users")
let signIns: typeof import("../src/data/shellSignIns")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    const { default: getDatabase, Database } = await import("../src/data")
    db = getDatabase(Database.WDFP_DATA)
    users = await import("../src/data/users")
    signIns = await import("../src/data/shellSignIns")
})

after(async () => {
    await cleanup()
})

beforeEach(async () => {
    (await import("../src/lib/portalAuth")).resetLoginFailures()
})

const PASSWORD = "correct horse battery"
const APP_ID = "561429"

function cookieOf(response: LightMyRequestResponse): string | undefined {
    const header = response.headers["set-cookie"]
    const value = Array.isArray(header) ? header[0] : header
    return value === undefined ? undefined : value.split(";")[0]
}

function postForm(url: string, form: Record<string, string>, cookie?: string) {
    return fastify.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
        payload: new URLSearchParams(form).toString()
    })
}

/** The shell's loginDevice with this device secret. */
function loginDevice(whiteKey: string) {
    const deviceId = randomUUID()
    return fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json" },
        payload: { appId: APP_ID, deviceId, serialNo: deviceId, whiteKey }
    })
}

async function accountOf(whiteKey: string): Promise<number> {
    const response = await loginDevice(whiteKey)
    assert.equal(response.statusCode, 200, response.body)
    return Number(response.json().player.playerId)
}

/** Logs a device in and signs it up, so it has a player and a viewer session. */
async function playOn(whiteKey: string): Promise<{ accountId: number, viewerId: number }> {
    const login = await loginDevice(whiteKey)
    assert.equal(login.statusCode, 200, login.body)
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/tool/signup",
        headers: gameHeaders(randomUUID().toUpperCase()),
        payload: encodeGameBody({
            app_secret: captured.app_secret, access_token: login.json().zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
        })
    })
    assert.equal(signup.statusCode, 200, signup.body)
    return { accountId: Number(login.json().player.playerId), viewerId: decodeGameBody(signup.body).data_headers.viewer_id }
}

function viewerSessions(accountId: number): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE account_id = ? AND type = 2`).get(accountId) as { count: number }).count
}

/** What the shell's WebView does: register (in the shell flow) and press Play; returns the portal cookie and the code. */
async function registerAndPlay(username: string): Promise<{ cookie: string, code: string }> {
    const registered = await postForm("/portal/register?next=shell", { username, password: PASSWORD, confirm: PASSWORD })
    assert.equal(registered.headers.location, "/portal/shell")
    const cookie = cookieOf(registered)!
    return { cookie, code: await play(cookie) }
}

async function play(cookie: string): Promise<string> {
    const page = await fastify.inject({ method: "GET", url: "/portal/shell", headers: { cookie } })
    assert.equal(page.statusCode, 200)
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)![1]
    const pressed = await postForm("/portal/shell", { csrf }, cookie)
    const location = String(pressed.headers.location)
    assert.match(location, /^\/portal\/shell\/done\?code=[A-Za-z0-9_-]{43}$/)
    return location.split("code=")[1]
}

/** The shell's trade of the code for a device token. */
function exchange(code: string, whiteKey: string) {
    return fastify.inject({ method: "POST", url: "/portal/shell/token", headers: { "content-type": "application/json" }, payload: { code, whiteKey, appId: APP_ID } })
}

test("the shell's page sends a logged-out player to the login page, which comes back to it", async () => {
    const page = await fastify.inject({ method: "GET", url: "/portal/shell" })
    assert.equal(page.headers.location, "/portal/login?next=shell")
    const login = await fastify.inject({ method: "GET", url: "/portal/login?next=shell" })
    assert.match(login.body, /action="\/portal\/login\?next=shell"/)
    assert.match(login.body, /href="\/portal\/register\?next=shell"/)
    assert.match(login.body, /href="\/portal\/shell\/done\?guest=1"/, "the shell's way out")
    assert.doesNotMatch((await fastify.inject({ method: "GET", url: "/portal/login" })).body, /guest=1/)

    users.createUserSync({ username: "returning", passwordHash: await (await import("../src/lib/password")).hashPassword(PASSWORD) })
    assert.equal((await postForm("/portal/login?next=shell", { username: "returning", password: "wrong password!" })).headers.location, "/portal/login?error=invalid&next=shell")
    assert.equal((await postForm("/portal/login?next=shell", { username: "returning", password: PASSWORD })).headers.location, "/portal/shell")
    // only `shell` is a destination
    assert.equal((await postForm("/portal/login?next=https://evil.example", { username: "returning", password: PASSWORD })).headers.location, "/portal")
})

test("the first sign-in takes over the device's guest save; the guest key then reaches it no more", async () => {
    const guestKey = randomUUID()
    const guest = await playOn(guestKey)
    const { code } = await registerAndPlay("claimer")

    const response = await exchange(code, guestKey)
    assert.equal(response.statusCode, 200, response.body)
    const { deviceToken, playerId } = response.json()
    assert.match(deviceToken, /^rfp1\.[A-Za-z0-9_-]{43}$/)
    assert.equal(Number(playerId), guest.accountId)
    assert.equal(users.getAccountUserIdSync(guest.accountId), users.getUserByUsernameSync("claimer")!.id)

    assert.equal(await accountOf(deviceToken), guest.accountId)
    assert.notEqual(await accountOf(guestKey), guest.accountId, "the old guest key starts a new guest")
    assert.equal((await exchange(code, guestKey)).statusCode, 400, "a code works once")
})

test("signing in on a second device moves the save there and signs the first one out", async () => {
    const first = await registerAndPlay("mover")
    const firstToken = (await exchange(first.code, randomUUID())).json().deviceToken as string
    const played = await playOn(firstToken)
    assert.equal(viewerSessions(played.accountId), 1)

    const secondToken = (await exchange(await play(first.cookie), randomUUID())).json().deviceToken as string
    assert.equal(viewerSessions(played.accountId), 0, "the first device's game session ended")

    const refused = await loginDevice(firstToken)
    assert.equal(refused.statusCode, 401)
    assert.equal(refused.json().code, "signed-out")
    assert.equal(await accountOf(secondToken), played.accountId, "the same save on the second device")

    // a resume with the first device's old zat and token gets nothing either
    const resume = await fastify.inject({
        method: "POST", url: "/openapi/service/v3/zat/login", headers: { "content-type": "application/json" },
        payload: { zat: "expired-or-revoked", playerId: String(played.accountId), whiteKey: firstToken, lang: "en" }
    })
    assert.equal(resume.statusCode, 400)
})

/** The game's first request of a launch, with the zat from a login and the viewer ID the game kept. */
async function load(whiteKey: string, viewerId: number) {
    const login = await loginDevice(whiteKey)
    assert.equal(login.statusCode, 200, login.body)
    return fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/load",
        headers: gameHeaders(randomUUID().toUpperCase()),
        payload: encodeGameBody({ access_token: login.json().zat, viewer_id: viewerId })
    })
}

test("a second device that played as a guest keeps its viewer ID and loads the user's save", async () => {
    // the save is played on a first device
    const first = await registerAndPlay("two-phones")
    const firstToken = (await exchange(first.code, randomUUID())).json().deviceToken as string
    const played = await playOn(firstToken)

    // the second device played as a guest before; its game keeps that guest's viewer ID
    const guestKey = randomUUID()
    const guest = await playOn(guestKey)
    const response = await exchange(await play(first.cookie), guestKey)
    assert.equal(Number(response.json().playerId), played.accountId)

    const loaded = await load(response.json().deviceToken, guest.viewerId)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.equal(viewerSessions(played.accountId), 1)
    assert.equal(viewerSessions(guest.accountId), 0, "the guest save stays behind without a session")
    assert.equal(users.getAccountUserIdSync(guest.accountId), null)
})

test("/load refuses a viewer ID another account holds instead of failing", async () => {
    const holder = await playOn(randomUUID())
    db.prepare(`UPDATE sessions SET expires = ? WHERE token = ?`).run(new Date(0).toISOString(), String(holder.viewerId))
    const { code } = await registerAndPlay("borrower")
    const loaded = await load((await exchange(code, randomUUID())).json().deviceToken, holder.viewerId)
    assert.equal(loaded.statusCode, 400, loaded.body)
})

function logOut(deviceToken: string) {
    return fastify.inject({ method: "POST", url: "/portal/shell/logout", headers: { "content-type": "application/json" }, payload: { deviceToken } })
}

test("after a log out, the device's game keeps its viewer ID with another account or as a guest", async () => {
    // a device plays a user's save; its game keeps that save's viewer ID
    const guestKey = randomUUID()
    const first = await registerAndPlay("leaving")
    const token = (await exchange(first.code, guestKey)).json().deviceToken as string
    const played = await playOn(token)

    assert.equal((await logOut(token)).statusCode, 204)
    assert.equal(viewerSessions(played.accountId), 0, "the account let go of the viewer ID")

    // another user signs in on the device: /load takes the same viewer ID for that user's save
    const other = await registerAndPlay("arriving")
    const otherToken = (await exchange(other.code, guestKey)).json().deviceToken as string
    const loaded = await load(otherToken, played.viewerId)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.equal(users.getAccountUserIdSync(viewerAccount(played.viewerId)), users.getUserByUsernameSync("arriving")!.id)

    // that user logs out too and the device plays without an account: a guest takes the ID
    await logOut(otherToken)
    const asGuest = await load(guestKey, played.viewerId)
    assert.equal(asGuest.statusCode, 200, asGuest.body)
    assert.equal(users.getAccountUserIdSync(viewerAccount(played.viewerId)), null)

    // the first user's save is still there for a sign-in
    assert.equal(await accountOf((await exchange(await play(first.cookie), randomUUID())).json().deviceToken), played.accountId)
})

test("log out with an unknown or malformed token changes nothing", async () => {
    const { code } = await registerAndPlay("staying")
    const token = (await exchange(code, randomUUID())).json().deviceToken as string
    const played = await playOn(token)
    assert.equal((await logOut("rfp1." + "B".repeat(43))).statusCode, 204)
    assert.equal((await logOut("not-a-token")).statusCode, 204)
    assert.equal((await fastify.inject({ method: "POST", url: "/portal/shell/logout", headers: { "content-type": "application/json" }, payload: {} })).statusCode, 400)
    assert.equal(viewerSessions(played.accountId), 1)
})

function viewerAccount(viewerId: number): number {
    return (db.prepare(`SELECT account_id FROM sessions WHERE token = ? AND type = 2`).get(String(viewerId)) as { account_id: number }).account_id
}

test("a user without a save and a device without a guest account get a new account", async () => {
    const { code } = await registerAndPlay("newcomer")
    const response = await exchange(code, randomUUID())
    const accountId = Number(response.json().playerId)
    assert.equal(users.getAccountUserIdSync(accountId), users.getUserByUsernameSync("newcomer")!.id)
    assert.equal(await accountOf(response.json().deviceToken), accountId)
})

test("a guest account that already belongs to a user isn't taken over by another", async () => {
    const guestKey = randomUUID()
    const guest = await playOn(guestKey)
    const owner = users.createUserSync({ username: "owner", passwordHash: "x" })!
    users.setAccountUserSync(guest.accountId, owner.id)

    const { code } = await registerAndPlay("intruder")
    const response = await exchange(code, guestKey)
    assert.notEqual(Number(response.json().playerId), guest.accountId)
    assert.equal(users.getAccountUserIdSync(guest.accountId), owner.id)
})

test("an unknown, expired or malformed code is refused", async () => {
    assert.equal((await exchange("not-a-code", randomUUID())).json().code, "invalid-code")
    const user = users.createUserSync({ username: "late", passwordHash: "x" })!
    const code = signIns.createShellSignInSync(user.id, new Date(Date.now() - signIns.SHELL_SIGN_IN_LIFETIME_MS - 1000))
    assert.equal((await exchange(code, randomUUID())).statusCode, 400)
    assert.ok(signIns.deleteExpiredShellSignInsSync() >= 1)
    assert.equal((await fastify.inject({ method: "POST", url: "/portal/shell/token", headers: { "content-type": "application/json" }, payload: {} })).statusCode, 400)
})

test("Play needs the session's CSRF token", async () => {
    const registered = await postForm("/portal/register?next=shell", { username: "csrf-check", password: PASSWORD, confirm: PASSWORD })
    const response = await postForm("/portal/shell", { csrf: "forged" }, cookieOf(registered))
    assert.equal(response.statusCode, 403)
})

test("an unknown device token is refused instead of starting a guest, and a guest key still starts one", async () => {
    const before = (db.prepare(`SELECT COUNT(*) AS count FROM accounts`).get() as { count: number }).count
    const refused = await loginDevice("rfp1." + "A".repeat(43))
    assert.equal(refused.statusCode, 401)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM accounts`).get() as { count: number }).count, before)
    assert.equal((await loginDevice(randomUUID())).statusCode, 200)
})

test("a deleted user's device keeps playing its save as a guest", async () => {
    const { code } = await registerAndPlay("leaver")
    const response = await exchange(code, randomUUID())
    const accountId = Number(response.json().playerId)
    users.deleteUserSync(users.getUserByUsernameSync("leaver")!.id)
    assert.equal(users.getAccountUserIdSync(accountId), null)
    assert.equal(await accountOf(response.json().deviceToken), accountId)
})

test("the done page is a plain page for a browser that isn't the shell", async () => {
    const page = await fastify.inject({ method: "GET", url: "/portal/shell/done?guest=1" })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Back to the app/)
})
