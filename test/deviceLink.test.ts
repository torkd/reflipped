import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

// ACC-4: a device that plays as a guest moves to a portal user's save with a code from the portal, typed in the game
// as the profile comment (docs/accounts.md "Device linking").

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
const API = "/latest/api/index.php"

interface Device {
    whiteKey: string
    udid: string
    viewerId: number
    zat: string
}

function loginDevice(whiteKey: string) {
    const deviceId = randomUUID()
    return fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json" },
        payload: { appId: "561429", deviceId, serialNo: deviceId, whiteKey }
    })
}

/** A new install: guest login, signup and the first /load, as the game does. */
async function newDevice(): Promise<Device> {
    const whiteKey = randomUUID()
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

/** The game's launch on a device that has played before: login with its secret, then /load with the viewer ID it kept. */
async function relaunch(device: Device): Promise<LightMyRequestResponse> {
    const login = await loginDevice(device.whiteKey)
    assert.equal(login.statusCode, 200, login.body)
    device.zat = login.json().zat
    return load(device)
}

function load(device: Device) {
    return game(device, "load", { ...readCapturedRoute("load").requestBody, access_token: device.zat })
}

function game(device: Device, route: string, body: Record<string, unknown>) {
    return fastify.inject({
        method: "POST", url: `${API}/${route}`, headers: gameHeaders(device.udid),
        payload: encodeGameBody({ ...body, viewer_id: device.viewerId })
    })
}

function comment(device: Device, text: string) {
    return game(device, "profile/update_comment", { api_count: 2, comment: text })
}

async function accountOf(device: Device): Promise<number> {
    return (await data.getSession(String(device.viewerId)))!.accountId
}

function playerComment(accountId: number): string {
    return data.getPlayerFromAccountIdSync(accountId)!.comment
}

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

/** "Get a code" on the account page; returns the code as shown ("ABCD-EFGH"). */
async function linkCode(cookie: string): Promise<string> {
    const account = await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })
    assert.match(account.body, /action="\/portal\/link"/)
    const csrf = account.body.match(/name="csrf" value="([^"]+)"/)![1]
    const page = await postForm("/portal/link", { csrf }, cookie)
    assert.equal(page.statusCode, 200, page.body)
    return page.body.match(/class="link-code">([A-Z0-9]{4}-[A-Z0-9]{4})</)![1]
}

function resultCode(response: LightMyRequestResponse): number {
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data_headers.result_code
}

test("a plain comment is saved; a comment that isn't a code is never taken for one", async () => {
    const device = await newDevice()
    for (const text of ["Hello there!", "ABCD-EFG", "flipper fan 2025"]) {
        const reply = await comment(device, text)
        assert.equal(resultCode(reply), 1)
        assert.equal(decodeGameBody(reply.body).data.user_info.comment, text)
        assert.equal(playerComment(await accountOf(device)), text)
    }
})

test("a user without a save takes over the device's guest save, which keeps playing", async () => {
    const device = await newDevice()
    await comment(device, "my old comment")
    const cookie = await register("first-link")
    const code = await linkCode(cookie)

    // typed as players do: lower case, a space instead of the dash
    const reply = await comment(device, code.toLowerCase().replace("-", " "))
    assert.equal(resultCode(reply), 1)
    const accountId = await accountOf(device)
    assert.equal(users.getAccountUserIdSync(accountId), users.getUserByUsernameSync("first-link")!.id)
    assert.equal(playerComment(accountId), "my old comment", "the code isn't kept as the comment")
    assert.equal((await game(device, "profile/get_degree_list", { api_count: 3 })).statusCode, 200, "no reload needed")
    assert.equal(resultCode(await comment(device, code)), 207, "a code works once")
})

test("a user with a save: the linked device loads it from its next launch, and the device before starts over", async () => {
    const cookie = await register("mover")
    const first = await newDevice()
    await comment(first, await linkCode(cookie))
    const saveId = await accountOf(first)
    await comment(first, "played on the first phone")

    const second = await newDevice()
    const guestId = await accountOf(second)
    assert.equal(resultCode(await comment(second, await linkCode(cookie))), 1)

    // both games stop: their sessions ended
    assert.notEqual((await game(second, "profile/get_degree_list", { api_count: 3 })).statusCode, 200)
    assert.notEqual((await game(first, "profile/get_degree_list", { api_count: 3 })).statusCode, 200)

    // the second device's next launch loads the user's save under the viewer ID its game kept
    const loaded = await relaunch(second)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.equal(await accountOf(second), saveId)
    assert.equal(decodeGameBody(loaded.body).data.user_info.comment, "played on the first phone")

    // the guest save stays behind, unbound; the first device starts a new guest
    assert.equal(users.getAccountUserIdSync(guestId), null)
    assert.equal(data.getAccountDeviceSecretHashSync(guestId), null)
    const firstLogin = await loginDevice(first.whiteKey)
    assert.notEqual(Number(firstLogin.json().player.playerId), saveId)
})

test("a wrong or expired code is refused like a banned word and changes nothing", async () => {
    const device = await newDevice()
    await comment(device, "kept")
    assert.equal(resultCode(await comment(device, "2345-6789")), 207)
    assert.equal(playerComment(await accountOf(device)), "kept")

    const user = users.createUserSync({ username: "late", passwordHash: "x" })!
    const { code } = users.createLinkCodeSync(user.id, new Date(Date.now() - 11 * 60 * 1000))
    assert.equal(resultCode(await comment(device, code)), 207)
    assert.equal(users.getAccountUserIdSync(await accountOf(device)), null)
})

test("a device playing another user's save isn't moved with a code", async () => {
    const device = await newDevice()
    await comment(device, await linkCode(await register("owner-a")))
    const ownerA = users.getUserByUsernameSync("owner-a")!.id

    assert.equal(resultCode(await comment(device, await linkCode(await register("owner-b")))), 207)
    assert.equal(users.getAccountUserIdSync(await accountOf(device)), ownerA)

    // the same user's code again is harmless
    const login = await postForm("/portal/login", { username: "owner-a", password: PASSWORD })
    assert.equal(resultCode(await comment(device, await linkCode(cookieOf(login)))), 1)
})

test("after too many wrong codes, even a right one is refused for a while", async () => {
    const { LINK_FAILURE_LIMIT } = await import("../src/lib/deviceLink")
    const device = await newDevice()
    for (let i = 0; i < LINK_FAILURE_LIMIT; i++) assert.equal(resultCode(await comment(device, "2345-6789")), 207)
    const code = await linkCode(await register("patient"))
    assert.equal(resultCode(await comment(device, code)), 207)
    assert.equal(users.getAccountUserIdSync(await accountOf(device)), null)
})

test("getting a code needs the session's CSRF token, and a new code ends the earlier one", async () => {
    const cookie = await register("csrf-link")
    assert.equal((await postForm("/portal/link", { csrf: "forged" }, cookie)).statusCode, 403)
    assert.equal((await postForm("/portal/link", { csrf: "x" })).statusCode, 302, "logged out: to the login page")

    const earlier = await linkCode(cookie)
    const later = await linkCode(cookie)
    const device = await newDevice()
    assert.equal(resultCode(await comment(device, earlier)), 207)
    assert.equal(resultCode(await comment(device, later)), 1)
})
