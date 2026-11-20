// FT-59: deleting a save from the game (tool/unregister) or the portal, and an admin restoring it
// (src/lib/saveDeletion.ts). The save goes, a copy is kept 30 days, the account and its login stay, so the next launch
// signs up and starts a new save; a restore puts the old one back under its player ID.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let deletion: typeof import("../src/lib/saveDeletion")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    deletion = await import("../src/lib/saveDeletion")
})

after(async () => {
    await cleanup()
})

beforeEach(async () => {
    (await import("../src/lib/portalAuth")).resetLoginFailures();
    (await import("../src/lib/deviceLink")).resetLinkFailures()
    for (const save of deletion.listKeptSavesSync()) (await import("../src/data/deletedSaves")).deleteDeletedSaveSync(save.id)
})

const PASSWORD = "correct horse battery"
const APP_ID = "561429"
const API = "/latest/api/index.php"
const ITEM = 1   // any item id: the restore must bring its count back
const DAY_MS = 24 * 60 * 60 * 1000

interface Device { whiteKey: string, udid: string, viewerId: number, zat: string }

function loginDevice(whiteKey: string) {
    const deviceId = randomUUID()
    return fastify.inject({
        method: "POST", url: "/openapi/service/v4/auth/loginDevice", headers: { "content-type": "application/json" },
        payload: { appId: APP_ID, deviceId, serialNo: deviceId, whiteKey }
    })
}

function game(device: Device, route: string, body: Record<string, unknown>) {
    return fastify.inject({ method: "POST", url: `${API}/${route}`, headers: gameHeaders(device.udid), payload: encodeGameBody({ ...body, viewer_id: device.viewerId }) })
}

/** A launch with no stored account: login, signup, first /load. */
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
    assert.equal((await game(device, "load", { ...captured, access_token: device.zat })).statusCode, 200)
    return device
}

async function playerOf(device: Device): Promise<{ accountId: number, playerId: number }> {
    const accountId = (await data.getSession(String(device.viewerId)))!.accountId
    return { accountId, playerId: data.getPlayerFromAccountIdSync(accountId)!.id }
}

/** A save worth restoring: a name and some of an item. */
function makeProgress(playerId: number, name: string) {
    data.updatePlayerSync({ id: playerId, name })
    data.givePlayerItemSync(playerId, ITEM, 7)
}

function adminPost(url: string) {
    return admin.inject({
        method: "POST", url, remoteAddress: "127.0.0.1",
        headers: { host: "localhost:8001", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:8001" },
        payload: ""
    })
}

function adminGet(url: string) {
    return admin.inject({ method: "GET", url, remoteAddress: "127.0.0.1", headers: { host: "localhost:8001" } })
}

test("the game's account deletion deletes the save and keeps a copy; the next launch starts a new save", async () => {
    const whiteKey = randomUUID()
    const device = await playOn(whiteKey)
    const { accountId, playerId } = await playerOf(device)
    makeProgress(playerId, "Deleted Dan")

    const response = await game(device, "tool/unregister", { idp_code: "zd3" })
    assert.equal(response.statusCode, 200, response.body)
    const body = decodeGameBody(response.body)
    assert.equal(typeof body.data.kakao_pid, "string")

    assert.equal(data.getPlayerSync(playerId), null, "the save is gone")
    assert.notEqual(data.getAccountSync(accountId), null, "the account stays")
    assert.equal(await data.getSession(String(device.viewerId)), null, "its sessions ended")
    const kept = deletion.listKeptSavesSync()
    assert.equal(kept.length, 1)
    assert.deepEqual([kept[0].accountId, kept[0].playerId, kept[0].name, kept[0].source], [accountId, playerId, "Deleted Dan", "game"])
    assert.equal(Math.round((kept[0].expiresAt.getTime() - kept[0].deletedAt.getTime()) / DAY_MS), 30)

    // the client restarts without its stored account: the same install signs up again, on the same account
    const again = await playOn(whiteKey)
    const next = await playerOf(again)
    assert.equal(next.accountId, accountId)
    assert.notEqual(next.playerId, playerId, "a new save")
    assert.notEqual(data.getPlayerSync(next.playerId)!.name, "Deleted Dan")
})

test("an admin restores a deleted save under its old ID, replacing the one started since", async () => {
    const whiteKey = randomUUID()
    const device = await playOn(whiteKey)
    const { accountId, playerId } = await playerOf(device)
    makeProgress(playerId, "Restored Rae")
    assert.equal((await game(device, "tool/unregister", { idp_code: "zd3" })).statusCode, 200)
    const since = await playerOf(await playOn(whiteKey))

    const page = await adminGet("/player")
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Deleted saves/)
    assert.match(page.body, /Restored Rae/)
    assert.match(page.body, new RegExp(`Replaces the save the account started since: .*\\(#${since.playerId}\\)`))

    const keptId = deletion.listKeptSavesSync()[0].id
    const restored = await adminPost(`/api/player/restoreDeleted?id=${keptId}`)
    assert.equal(restored.statusCode, 302, restored.body)
    assert.equal(restored.headers.location, "/player?message=restored")

    const player = data.getPlayerSync(playerId)
    assert.notEqual(player, null, "back under its old ID")
    assert.equal(player!.name, "Restored Rae")
    assert.equal(data.getPlayerItemSync(playerId, ITEM), 7)
    assert.equal(data.getPlayerFromAccountIdSync(accountId)!.id, playerId, "on its account")
    assert.equal(data.getPlayerSync(since.playerId), null, "the save started since is replaced")
    assert.equal(deletion.listKeptSavesSync().length, 0, "the copy is used up")

    assert.equal((await adminPost(`/api/player/restoreDeleted?id=${keptId}`)).headers.location, "/player?error=restore-missing")
})

test("a copy is kept 30 days, then gone", async () => {
    const device = await playOn(randomUUID())
    const { playerId } = await playerOf(device)
    const id = deletion.deleteSaveSync(playerId, "game", Date.now() - 31 * DAY_MS)
    assert.notEqual(id, null)
    assert.equal(deletion.listKeptSavesSync().length, 0)
    assert.equal(deletion.restoreDeletedSaveSync(id!), "missing")
})

// --- the portal ---

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

async function accountPage(cookie: string): Promise<{ body: string, csrf: string }> {
    const page = await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })
    assert.equal(page.statusCode, 200)
    return { body: page.body, csrf: page.body.match(/name="csrf" value="([^"]+)"/)![1] }
}

test("the portal deletes the user's save, with the password and the box ticked; the login stays", async () => {
    const registered = await postForm("/portal/register", { username: "deleter", password: PASSWORD, confirm: PASSWORD })
    assert.equal(registered.statusCode, 302, registered.body)
    const cookie = cookieOf(registered)
    assert.doesNotMatch((await accountPage(cookie)).body, /Delete your save/, "no save yet, no card")

    // a guest's save linked to the user with a code typed as the profile comment (ACC-4)
    const device = await playOn(randomUUID())
    const { accountId, playerId } = await playerOf(device)
    const linked = await postForm("/portal/link", { csrf: (await accountPage(cookie)).csrf }, cookie)
    const code = linked.body.match(/class="link-code">([A-Z0-9]{4}-[A-Z0-9]{4})</)![1]
    assert.equal((await game(device, "profile/update_comment", { api_count: 2, comment: code })).statusCode, 200)
    makeProgress(playerId, "Portal Pat")
    const users = await import("../src/data/users")
    const user = users.getUserByUsernameSync("deleter")!
    assert.deepEqual(users.getUserAccountIdsSync(user.id), [accountId])

    const page = await accountPage(cookie)
    assert.match(page.body, /Delete your save/)
    const wrong = await postForm("/portal/save/delete", { csrf: page.csrf, password: "wrong password!", confirm: "1" }, cookie)
    assert.equal(wrong.headers.location, "/portal?error=delete-password-wrong")
    const unticked = await postForm("/portal/save/delete", { csrf: page.csrf, password: PASSWORD }, cookie)
    assert.equal(unticked.headers.location, "/portal?error=delete-confirm")
    assert.notEqual(data.getPlayerSync(playerId), null, "nothing deleted yet")

    const deleted = await postForm("/portal/save/delete", { csrf: page.csrf, password: PASSWORD, confirm: "1" }, cookie)
    assert.equal(deleted.headers.location, "/portal?message=save-deleted")
    assert.equal(data.getPlayerSync(playerId), null)
    assert.deepEqual(users.getUserAccountIdsSync(user.id), [accountId], "the account stays the user's")
    const kept = deletion.listKeptSavesSync()
    assert.deepEqual([kept[0].name, kept[0].source], ["Portal Pat", "portal"])
    assert.doesNotMatch((await accountPage(cookie)).body, /Delete your save/, "nothing left to delete")
})
