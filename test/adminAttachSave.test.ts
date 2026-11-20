import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

// ACC-7: an admin attaches a save (by its player ID) to a portal user, or detaches it (docs/accounts.md
// "Unlink and migration"). The device the user played on follows the user.

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let users: typeof import("../src/data/users")
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    users = await import("../src/data/users")
    data = await import("../src/data/wdfpData")
})

after(async () => {
    await cleanup()
})

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

/** The game's launch on a device that has played before: login with its secret, then /load. */
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

function ping(device: Device) {
    return game(device, "profile/get_degree_list", { api_count: 3 })
}

async function accountOf(device: Device): Promise<number> {
    return (await data.getSession(String(device.viewerId)))!.accountId
}

function playerOf(accountId: number): number {
    return data.getPlayerFromAccountIdSync(accountId)!.id
}

function newUser(username: string) {
    return users.createUserSync({ username, passwordHash: "x" })!
}

/** The admin site's form post. */
function adminPost(url: string, form: Record<string, string> = {}) {
    return admin.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded", host: "127.0.0.1:8001", "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:8001" },
        payload: new URLSearchParams(form).toString()
    })
}

function attach(userId: number, playerId: number | string) {
    return adminPost(`/api/user/save/attach?id=${userId}`, { playerId: String(playerId) })
}

function detach(userId: number) {
    return adminPost(`/api/user/save/detach?id=${userId}`)
}

function adminGet(url: string) {
    return admin.inject({ method: "GET", url, headers: { host: "127.0.0.1:8001" } })
}

/** A user whose save is played on a new device. */
async function userWithDevice(username: string) {
    const user = newUser(username)
    const device = await newDevice()
    const accountId = await accountOf(device)
    users.setAccountUserSync(accountId, user.id)
    return { user, device, accountId }
}

test("a user without a save takes the account, and its device keeps playing", async () => {
    const user = newUser("no-save")
    const device = await newDevice()
    const accountId = await accountOf(device)
    const secret = data.getAccountDeviceSecretHashSync(accountId)

    const reply = await attach(user.id, playerOf(accountId))
    assert.equal(reply.statusCode, 302)
    assert.equal(reply.headers.location, `/user/${user.id}?message=save-attached`)
    assert.equal(users.getAccountUserIdSync(accountId), user.id)
    assert.equal(data.getAccountDeviceSecretHashSync(accountId), secret, "the binding stays")
    assert.equal((await ping(device)).statusCode, 200, "no reload needed")

    // again: nothing changes
    const again = await attach(user.id, playerOf(accountId))
    assert.equal(again.headers.location, `/user/${user.id}?message=save-already`)
    assert.equal((await ping(device)).statusCode, 200)
})

test("another user's save is refused and stays where it is", async () => {
    const { user: owner, device, accountId } = await userWithDevice("owner")
    const other = newUser("other")
    const reply = await attach(other.id, playerOf(accountId))
    assert.equal(reply.headers.location, `/user/${other.id}?error=save-other-user`)
    assert.equal(users.getAccountUserIdSync(accountId), owner.id)
    assert.deepEqual(users.getUserAccountIdsSync(other.id), [])
    assert.equal((await ping(device)).statusCode, 200)
})

test("an unknown player, user or malformed ID changes nothing", async () => {
    const user = newUser("unknown-ids")
    assert.equal((await attach(user.id, 99999999)).headers.location, `/user/${user.id}?error=save-unknown`)
    assert.equal((await attach(99999999, 1)).headers.location, "/user")
    assert.equal((await attach(user.id, "abc")).statusCode, 400)
    assert.deepEqual(users.getUserAccountIdsSync(user.id), [])
})

test("a user with a save: the attached save replaces it and the user's device follows", async () => {
    const { user, device: userDevice, accountId: oldId } = await userWithDevice("replace")
    const guestDevice = await newDevice()
    const guestId = await accountOf(guestDevice)
    const userSecret = data.getAccountDeviceSecretHashSync(oldId)
    assert.notEqual(userSecret, null)

    const reply = await attach(user.id, playerOf(guestId))
    assert.equal(reply.headers.location, `/user/${user.id}?message=save-replaced`)

    assert.deepEqual(users.getUserAccountIdsSync(user.id), [guestId])
    assert.equal(users.getAccountUserIdSync(oldId), null, "the old save is a guest save")
    assert.equal(data.getAccountDeviceSecretHashSync(oldId), null, "with no device bound")
    assert.equal(data.getAccountDeviceSecretHashSync(guestId), userSecret, "the user's device moved to the attached save")

    // every session of both accounts ended
    assert.notEqual((await ping(userDevice)).statusCode, 200)
    assert.notEqual((await ping(guestDevice)).statusCode, 200)

    // the user's device loads the attached save, under the viewer ID its game kept
    const loaded = await relaunch(userDevice)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.equal(await accountOf(userDevice), guestId)

    // the device that played the attached save before starts a new guest
    const login = await loginDevice(guestDevice.whiteKey)
    assert.notEqual(Number(login.json().player.playerId), guestId)
    assert.notEqual(Number(login.json().player.playerId), oldId)
})

test("a user whose old save has no device: the attached save keeps its own", async () => {
    const user = newUser("unbound-old")
    const oldDevice = await newDevice()
    const oldId = await accountOf(oldDevice)
    users.setAccountUserSync(oldId, user.id)
    data.setAccountDeviceSecretHashSync(oldId, null)

    const guestDevice = await newDevice()
    const guestId = await accountOf(guestDevice)
    const guestSecret = data.getAccountDeviceSecretHashSync(guestId)

    const reply = await attach(user.id, playerOf(guestId))
    assert.equal(reply.headers.location, `/user/${user.id}?message=save-replaced`)
    assert.deepEqual(users.getUserAccountIdsSync(user.id), [guestId])
    assert.equal(users.getAccountUserIdSync(oldId), null)
    assert.equal(data.getAccountDeviceSecretHashSync(oldId), null)
    assert.equal(data.getAccountDeviceSecretHashSync(guestId), guestSecret)

    assert.notEqual((await ping(guestDevice)).statusCode, 200, "sessions ended")
    const loaded = await relaunch(guestDevice)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.equal(await accountOf(guestDevice), guestId)
})

test("an attached guest save with no device still replaces the save and takes the user's device", async () => {
    const { user, device, accountId: oldId } = await userWithDevice("to-unbound")
    const spare = newUser("spare-holder")
    const spareDevice = await newDevice()
    const spareId = await accountOf(spareDevice)
    users.setAccountUserSync(spareId, spare.id)
    // detach it by the admin: it stays bound; unbind it to be a left-over save
    assert.equal((await detach(spare.id)).headers.location, `/user/${spare.id}?message=save-detached`)
    data.setAccountDeviceSecretHashSync(spareId, null)

    assert.equal((await attach(user.id, playerOf(spareId))).headers.location, `/user/${user.id}?message=save-replaced`)
    assert.deepEqual(users.getUserAccountIdsSync(user.id), [spareId])
    assert.equal((await relaunch(device)).statusCode, 200)
    assert.equal(await accountOf(device), spareId)
    assert.equal(users.getAccountUserIdSync(oldId), null)
})

test("detaching makes the save a guest save; its device keeps it and the game reloads", async () => {
    const { user, device, accountId } = await userWithDevice("detach-me")
    const secret = data.getAccountDeviceSecretHashSync(accountId)

    const reply = await detach(user.id)
    assert.equal(reply.headers.location, `/user/${user.id}?message=save-detached`)
    assert.equal(users.getAccountUserIdSync(accountId), null)
    assert.equal(data.getAccountDeviceSecretHashSync(accountId), secret, "the binding stays")
    assert.notEqual((await ping(device)).statusCode, 200, "sessions ended")

    const loaded = await relaunch(device)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.equal(await accountOf(device), accountId, "the same save, as a guest")

    // nothing left to detach
    assert.equal((await detach(user.id)).headers.location, `/user/${user.id}?error=save-none`)
    assert.equal((await detach(99999999)).headers.location, "/user")
})

test("a detached save can be attached to another user", async () => {
    const { user, accountId } = await userWithDevice("first-owner")
    await detach(user.id)
    const next = newUser("second-owner")
    assert.equal((await attach(next.id, playerOf(accountId))).headers.location, `/user/${next.id}?message=save-attached`)
    assert.equal(users.getAccountUserIdSync(accountId), next.id)
})

test("the pages show who owns a save", async () => {
    const { user, accountId } = await userWithDevice("shown-owner")
    const playerId = playerOf(accountId)

    const userPage = await adminGet(`/user/${user.id}`)
    assert.equal(userPage.statusCode, 200)
    assert.match(userPage.body, new RegExp(`Player #${playerId} `))
    assert.match(userPage.body, new RegExp(`href="/player/${playerId}"`))
    assert.match(userPage.body, new RegExp(`action="/user/${user.id}/attach"`))

    const playerPage = await adminGet(`/player/${playerId}`)
    assert.match(playerPage.body, new RegExp(`href="/user/${user.id}">shown-owner</a>`))

    await detach(user.id)
    assert.match((await adminGet(`/player/${playerId}`)).body, /A guest save, not tied to a user/)
    assert.match((await adminGet(`/user/${user.id}?message=save-replaced`)).body, /Save attached in place/)
})
