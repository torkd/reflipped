import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { Database as SqliteDatabase } from "../src/data/sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, signedGameHeaders } from "./helpers";

// FIX-12: a device keeps the viewer ID its game signed up with when it changes accounts (the Reflipped app's Sign out
// keeps the game's local data) or servers, so /load sees an ID that isn't the account's. A free ID is taken, even when
// the account has a viewer session of its own; one another account holds is still refused, and the app then has its
// game sign up again (docs/accounts.md "Shell login").

const API = "/latest/api/index.php"
const APP_ID = "561429"
const PASSWORD = "correct horse battery"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let db: SqliteDatabase

before(async () => {
    // signatures are checked as on a real server, so a taken ID must be bound to the device's UDID
    ({ fastify, cleanup } = await createTestServer({ paramCheck: "enforce" }))
    const { default: getDatabase, Database } = await import("../src/data")
    db = getDatabase(Database.WDFP_DATA)
})

after(async () => {
    await cleanup()
})

/** One phone: its game's UDID and the viewer ID the game keeps in its local data (null: none, it signs up). */
interface Device {
    udid: string
    viewerId: number | null
}

function newDevice(): Device {
    return { udid: randomUUID().toUpperCase(), viewerId: null }
}

async function loginDevice(whiteKey: string): Promise<{ zat: string, accountId: number }> {
    const deviceId = randomUUID()
    const response = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json" },
        payload: { appId: APP_ID, deviceId, serialNo: deviceId, whiteKey }
    })
    assert.equal(response.statusCode, 200, response.body)
    return { zat: response.json().zat, accountId: Number(response.json().player.playerId) }
}

/**
 * A launch of the game with `whiteKey`: login, then tool/signup if the game keeps no viewer ID (its first run, or
 * after the app cleared it), then /load with the kept ID. Returns the /load reply.
 */
async function launch(device: Device, whiteKey: string): Promise<LightMyRequestResponse> {
    const { zat } = await loginDevice(whiteKey)
    if (device.viewerId === null) {
        const captured = readCapturedRoute("load").requestBody
        const signup = await fastify.inject({
            method: "POST",
            url: `${API}/tool/signup`,
            headers: gameHeaders(device.udid),
            payload: encodeGameBody({
                app_secret: captured.app_secret, access_token: zat, storage_directory_path: captured.storage_directory_path,
                app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
            })
        })
        assert.equal(signup.statusCode, 200, signup.body)
        device.viewerId = decodeGameBody(signup.body).data_headers.viewer_id
    }
    return fastify.inject({
        method: "POST",
        url: `${API}/load`,
        headers: gameHeaders(device.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: zat, viewer_id: device.viewerId })
    })
}

async function play(device: Device, whiteKey: string) {
    const loaded = await launch(device, whiteKey)
    assert.equal(loaded.statusCode, 200, loaded.body)
}

/** A signed game request after /load: proves the viewer session is bound to the device's UDID. */
async function signedRequest(device: Device) {
    const payload = encodeGameBody({ api_count: 1, option_params: {}, viewer_id: device.viewerId })
    return fastify.inject({
        method: "POST",
        url: `${API}/option/update`,
        headers: signedGameHeaders(device.udid, device.viewerId!, `${API}/option/update`, payload),
        payload
    })
}

function viewerIdsOf(accountId: number): number[] {
    return (db.prepare(`SELECT token FROM sessions WHERE account_id = ? AND type = 2`).all(accountId) as { token: string }[])
        .map(row => Number(row.token))
}

function holderOf(viewerId: number): number | null {
    const row = db.prepare(`SELECT account_id FROM sessions WHERE token = ?`).get(String(viewerId)) as { account_id: number } | undefined
    return row?.account_id ?? null
}

function form(url: string, body: Record<string, string>, cookie?: string) {
    return fastify.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
        payload: new URLSearchParams(body).toString()
    })
}

/** The shell's portal sign-in as `username` (registered first if `register`), traded for a device token with the guest key. */
async function signIn(username: string, guestKey: string, register = true): Promise<string> {
    const loggedIn = register
        ? await form("/portal/register?next=shell", { username, password: PASSWORD, confirm: PASSWORD })
        : await form("/portal/login?next=shell", { username, password: PASSWORD })
    assert.equal(loggedIn.headers.location, "/portal/shell")
    const setCookie = loggedIn.headers["set-cookie"]
    const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]
    const page = await fastify.inject({ method: "GET", url: "/portal/shell", headers: { cookie } })
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)![1]
    const code = String((await form("/portal/shell", { csrf }, cookie)).headers.location).split("code=")[1]
    const exchanged = await fastify.inject({
        method: "POST", url: "/portal/shell/token", headers: { "content-type": "application/json" },
        payload: { code, whiteKey: guestKey, appId: APP_ID }
    })
    assert.equal(exchanged.statusCode, 200, exchanged.body)
    return exchanged.json().deviceToken
}

/** The shell's Sign out: a device token, or a guest's install key. */
async function signOut(secret: string) {
    const payload = secret.startsWith("rfp1.") ? { deviceToken: secret } : { whiteKey: secret }
    const response = await fastify.inject({ method: "POST", url: "/portal/shell/logout", headers: { "content-type": "application/json" }, payload })
    assert.equal(response.statusCode, 204, response.body)
}

test("a guest whose account already has a viewer ID loads with the free ID the game kept from a signed-out account", async () => {
    // the device played as a guest first: that guest account keeps its own viewer ID
    const phone = newDevice()
    const guestKey = randomUUID()
    await play(phone, guestKey)
    const guest = (await loginDevice(guestKey)).accountId
    const guestId = phone.viewerId!

    // later the game keeps another account's ID (here a second install key's guest, as after Recover original guest
    // or a return from another server), and that account signs out, which frees the ID
    phone.viewerId = null
    const otherKey = randomUUID()
    await play(phone, otherKey)
    const keptId = phone.viewerId!
    assert.notEqual(keptId, guestId)
    await signOut(otherKey)
    assert.equal(holderOf(keptId), null)

    // Play as guest: the guest account takes the kept ID (this was the H400), and its old one ends
    await play(phone, guestKey)
    assert.deepEqual(viewerIdsOf(guest), [keptId])
    assert.equal(holderOf(guestId), null)
    const signed = await signedRequest(phone)
    assert.equal(signed.statusCode, 200, signed.body)
})

test("an ID another account still holds is refused, and signing up again gives the device its own", async () => {
    // the device plays a signed-in account; the app forgets the sign-in without a server-side Sign out (another
    // server chosen) and the player picks guest: the account still holds the game's ID
    const phone = newDevice()
    const token = await signIn("still-holding", randomUUID())
    await play(phone, token)
    const accountId = (await loginDevice(token)).accountId
    const heldId = phone.viewerId!

    const guestKey = randomUUID()
    const refused = await launch(phone, guestKey)
    assert.equal(refused.statusCode, 400, refused.body)
    assert.equal(refused.json().message, "Invalid viewer ID provided.")
    assert.equal(holderOf(heldId), accountId, "never handed to another account")

    // the app clears the game's kept ID when the account changes, so the game signs up and gets the guest's own ID
    phone.viewerId = null
    await play(phone, guestKey)
    const guest = (await loginDevice(guestKey)).accountId
    assert.notEqual(phone.viewerId, heldId)
    assert.deepEqual(viewerIdsOf(guest), [phone.viewerId])
    assert.equal(holderOf(heldId), accountId)
    assert.equal((await signedRequest(phone)).statusCode, 200)

    // and back to the account, cleared again: signing up gives the account the ID it holds
    phone.viewerId = null
    await play(phone, token)
    assert.equal(phone.viewerId, heldId)
    assert.equal((await signedRequest(phone)).statusCode, 200)
})

test("Sign out then Play as guest, after the guest linked a save played on another phone", async () => {
    // a user's save, played on another phone
    const otherPhone = newDevice()
    const userToken = await signIn("linked", randomUUID())
    await play(otherPhone, userToken)
    const userAccount = (await loginDevice(userToken)).accountId

    // this phone plays as a guest, then signs in to that user: the guest's viewer ID comes along, the other phone's ends
    const phone = newDevice()
    const guestKey = randomUUID()
    await play(phone, guestKey)
    const guest = (await loginDevice(guestKey)).accountId
    const guestId = phone.viewerId!
    const token = await signIn("linked", guestKey, false)
    await play(phone, token)
    assert.deepEqual(viewerIdsOf(userAccount), [guestId])

    // Sign out, Play as guest: the guest takes the ID back, whether the app cleared it or not
    await signOut(token)
    await play(phone, guestKey)
    assert.deepEqual(viewerIdsOf(guest), [guestId])
    phone.viewerId = null
    await play(phone, guestKey)
    assert.deepEqual(viewerIdsOf(guest), [guestId], "signing up again keeps the guest's ID")
    assert.equal((await signedRequest(phone)).statusCode, 200)

    // signing in again: the account takes the guest's ID again and loads
    const again = await signIn("linked", guestKey, false)
    await play(phone, again)
    assert.deepEqual(viewerIdsOf(userAccount), [guestId])
})

test("only an ID of the kind the server hands out is taken", async () => {
    const phone = newDevice()
    const guestKey = randomUUID()
    await play(phone, guestKey)
    const guest = (await loginDevice(guestKey)).accountId
    const own = phone.viewerId!

    phone.viewerId = 12345
    const refused = await launch(phone, guestKey)
    assert.equal(refused.statusCode, 400)
    assert.deepEqual(viewerIdsOf(guest), [own], "the account's own ID stays")
})
