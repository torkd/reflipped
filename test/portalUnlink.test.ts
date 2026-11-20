import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

// ACC-6: the user unlinks the device their save is bound to from the portal (docs/accounts.md "Unlink and migration").

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let users: typeof import("../src/data/users")
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    users = await import("../src/data/users")
    data = await import("../src/data/wdfpData")
})

after(async () => {
    await cleanup()
})

beforeEach(async () => {
    (await import("../src/lib/portalAuth")).resetLoginFailures();
    (await import("../src/lib/deviceLink")).resetLinkFailures()
})

const PASSWORD = "correct horse battery"
const APP_ID = "561429"
const API = "/latest/api/index.php"

function cookieOf(response: LightMyRequestResponse): string {
    const header = response.headers["set-cookie"]
    return String(Array.isArray(header) ? header[0] : header).split(";")[0]
}

function postForm(url: string, form: Record<string, string>, cookie?: string) {
    return fastify.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
        payload: new URLSearchParams(form).toString()
    })
}

async function register(username: string): Promise<string> {
    const registered = await postForm("/portal/register", { username, password: PASSWORD, confirm: PASSWORD })
    assert.equal(registered.statusCode, 302, registered.body)
    return cookieOf(registered)
}

async function accountPage(cookie: string, query = ""): Promise<{ body: string, csrf: string }> {
    const page = await fastify.inject({ method: "GET", url: `/portal${query}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    return { body: page.body, csrf: page.body.match(/name="csrf" value="([^"]+)"/)![1] }
}

async function unlink(cookie: string, password: string) {
    return postForm("/portal/unlink", { csrf: (await accountPage(cookie)).csrf, password }, cookie)
}

function loginDevice(whiteKey: string) {
    const deviceId = randomUUID()
    return fastify.inject({
        method: "POST", url: "/openapi/service/v4/auth/loginDevice", headers: { "content-type": "application/json" },
        payload: { appId: APP_ID, deviceId, serialNo: deviceId, whiteKey }
    })
}

interface Device { whiteKey: string, udid: string, viewerId: number, zat: string }

function game(device: Device, route: string, body: Record<string, unknown>) {
    return fastify.inject({ method: "POST", url: `${API}/${route}`, headers: gameHeaders(device.udid), payload: encodeGameBody({ ...body, viewer_id: device.viewerId }) })
}

function load(device: Device) {
    return game(device, "load", { ...readCapturedRoute("load").requestBody, access_token: device.zat })
}

/** The game on a device with this secret: login, signup, first /load. */
async function playOn(whiteKey: string): Promise<Device> {
    const udid = randomUUID().toUpperCase()
    const login = await loginDevice(whiteKey)
    assert.equal(login.statusCode, 200, login.body)
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST", url: `${API}/tool/signup`, headers: gameHeaders(udid),
        payload: encodeGameBody({
            app_secret: captured.app_secret, access_token: login.json().zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
        })
    })
    assert.equal(signup.statusCode, 200, signup.body)
    const device = { whiteKey, udid, viewerId: decodeGameBody(signup.body).data_headers.viewer_id, zat: login.json().zat }
    assert.equal((await load(device)).statusCode, 200)
    return device
}

/** A launch on a device that played before. */
async function relaunch(device: Device): Promise<LightMyRequestResponse> {
    const login = await loginDevice(device.whiteKey)
    assert.equal(login.statusCode, 200, login.body)
    device.zat = login.json().zat
    return load(device)
}

function comment(device: Device, text: string) {
    return game(device, "profile/update_comment", { api_count: 2, comment: text })
}

function resultCode(response: LightMyRequestResponse): number {
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data_headers.result_code
}

async function accountOf(device: Device): Promise<number> {
    return (await data.getSession(String(device.viewerId)))!.accountId
}

/** The shell's sign-in with the portal session `cookie`: returns the device token. */
async function shellSignIn(cookie: string, guestKey: string): Promise<string> {
    const page = await fastify.inject({ method: "GET", url: "/portal/shell", headers: { cookie } })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)![1]
    const pressed = await postForm("/portal/shell", { csrf }, cookie)
    const code = String(pressed.headers.location).split("code=")[1]
    const response = await fastify.inject({
        method: "POST", url: "/portal/shell/token", headers: { "content-type": "application/json" },
        payload: { code, whiteKey: guestKey, appId: APP_ID }
    })
    assert.equal(response.statusCode, 200, response.body)
    return response.json().deviceToken
}

async function linkCode(cookie: string): Promise<string> {
    const page = await postForm("/portal/link", { csrf: (await accountPage(cookie)).csrf }, cookie)
    assert.equal(page.statusCode, 200, page.body)
    return page.body.match(/class="link-code">([A-Z0-9]{4}-[A-Z0-9]{4})</)![1]
}

function savedComment(accountId: number): string {
    return data.getPlayerFromAccountIdSync(accountId)!.comment
}

test("the account page tells a user without a save, with a save and without a device apart", async () => {
    const cookie = await register("cardholder")
    let page = await accountPage(cookie)
    assert.match(page.body, /You have no save yet/)
    assert.doesNotMatch(page.body, /action="\/portal\/unlink"/)

    await playOn(await shellSignIn(cookie, randomUUID()))
    page = await accountPage(cookie)
    assert.match(page.body, /A device plays your save\. If you lost it/)
    assert.match(page.body, /action="\/portal\/unlink"/)

    assert.equal((await unlink(cookie, PASSWORD)).headers.location, "/portal?message=unlinked")
    page = await accountPage(cookie)
    assert.match(page.body, /No device plays your save/)
    assert.doesNotMatch(page.body, /action="\/portal\/unlink"/)
})

test("unlinking a signed-in shell: its game stops, its token is signed out, and the save stays", async () => {
    const cookie = await register("lost-shell")
    const token = await shellSignIn(cookie, randomUUID())
    const device = await playOn(token)
    const accountId = await accountOf(device)
    await comment(device, "my progress")

    assert.equal((await unlink(cookie, PASSWORD)).headers.location, "/portal?message=unlinked")
    assert.match((await accountPage(cookie, "?message=unlinked")).body, /Device unlinked/)

    // the running game fails at its next request, and the device is signed out at its next launch
    assert.notEqual((await game(device, "profile/get_degree_list", { api_count: 3 })).statusCode, 200)
    const refused = await loginDevice(token)
    assert.equal(refused.statusCode, 401)
    assert.equal(refused.json().code, "signed-out")

    // the save is untouched and still the user's
    assert.equal(users.getAccountUserIdSync(accountId), users.getUserByUsernameSync("lost-shell")!.id)
    assert.equal(savedComment(accountId), "my progress")
    assert.equal(data.getAccountDeviceSecretHashSync(accountId), null)

    // a new sign-in (another phone) plays it again
    const again = await shellSignIn(cookie, randomUUID())
    const login = await loginDevice(again)
    assert.equal(Number(login.json().player.playerId), accountId)
    const second = { whiteKey: again, udid: randomUUID().toUpperCase(), viewerId: device.viewerId, zat: login.json().zat }
    const loaded = await load(second)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.equal(decodeGameBody(loaded.body).data.user_info.comment, "my progress")
})

test("unlinking a guest device linked with a code: it starts a new guest, and a code binds the save again", async () => {
    const cookie = await register("lost-guest")
    const first = await playOn(randomUUID())
    assert.equal(resultCode(await comment(first, await linkCode(cookie))), 1)
    const accountId = await accountOf(first)
    await comment(first, "guest progress")

    assert.equal((await unlink(cookie, PASSWORD)).headers.location, "/portal?message=unlinked")
    assert.notEqual((await game(first, "profile/get_degree_list", { api_count: 3 })).statusCode, 200)
    const newGuest = await loginDevice(first.whiteKey)
    assert.equal(newGuest.statusCode, 200)
    assert.notEqual(Number(newGuest.json().player.playerId), accountId, "the old key starts a new guest")
    assert.equal(users.getAccountUserIdSync(accountId), users.getUserByUsernameSync("lost-guest")!.id)
    assert.equal(savedComment(accountId), "guest progress")

    // another guest device takes the save with a code
    const second = await playOn(randomUUID())
    assert.equal(resultCode(await comment(second, await linkCode(cookie))), 1)
    const loaded = await relaunch(second)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.equal(decodeGameBody(loaded.body).data.user_info.comment, "guest progress")
})

test("a wrong password changes nothing", async () => {
    const cookie = await register("careful")
    const token = await shellSignIn(cookie, randomUUID())
    const device = await playOn(token)
    const accountId = await accountOf(device)

    const refused = await unlink(cookie, "not the password")
    assert.equal(refused.headers.location, "/portal?error=unlink-password-wrong")
    assert.match((await accountPage(cookie, "?error=unlink-password-wrong")).body, /Wrong password\. The device is still linked/)
    assert.notEqual(data.getAccountDeviceSecretHashSync(accountId), null)
    assert.equal((await game(device, "profile/get_degree_list", { api_count: 2 })).statusCode, 200)
    assert.equal((await loginDevice(token)).statusCode, 200)
})

test("a forged or missing CSRF token is refused, a logged-out request goes to the login page", async () => {
    const cookie = await register("csrf-unlink")
    const device = await playOn(await shellSignIn(cookie, randomUUID()))
    const accountId = await accountOf(device)

    assert.equal((await postForm("/portal/unlink", { csrf: "forged", password: PASSWORD }, cookie)).statusCode, 403)
    assert.equal((await postForm("/portal/unlink", { password: PASSWORD }, cookie)).statusCode, 400)
    const loggedOut = await postForm("/portal/unlink", { csrf: "x", password: PASSWORD })
    assert.equal(loggedOut.statusCode, 302)
    assert.match(String(loggedOut.headers.location), /^\/portal\/login/)
    assert.notEqual(data.getAccountDeviceSecretHashSync(accountId), null)
})

test("unlinking without a save or a device is harmless", async () => {
    const cookie = await register("nothing-to-unlink")
    assert.equal((await unlink(cookie, PASSWORD)).headers.location, "/portal?message=unlinked")
    assert.deepEqual(users.getUserAccountIdsSync(users.getUserByUsernameSync("nothing-to-unlink")!.id), [])
})

test("only the user's own accounts let go of a shared guest key", async () => {
    const cookie = await register("sharer")
    const device = await playOn(randomUUID())
    await comment(device, await linkCode(cookie))
    const accountId = await accountOf(device)
    // an older guest account from before SEC-5 holding the same secret
    const hash = data.getAccountDeviceSecretHashSync(accountId)!
    const other = data.insertAccountSync({ appId: APP_ID, idpAlias: `${APP_ID}:dup`, idpCode: "zd3", idpId: "dup-guest", status: "normal" }).id
    data.setAccountDeviceSecretHashSync(other, hash)

    await unlink(cookie, PASSWORD)
    assert.equal(data.getAccountDeviceSecretHashSync(accountId), null)
    assert.equal(data.getAccountDeviceSecretHashSync(other), hash, "an account of nobody's keeps its secret")
})
